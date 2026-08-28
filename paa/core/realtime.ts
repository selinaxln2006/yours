// ============================================================
// S3 — Supabase Realtime 订阅（云端变更 → 本地感知）
// 协议：Phoenix Channels over WebSocket（零依赖，Node 24 原生 WebSocket）
//   · 连接：wss://<project>.supabase.co/realtime/v1/websocket?apikey=<key>&vsn=1.0.0
//   · 加入频道：topic = realtime:public:<table>，payload 带 postgres_changes 配置 + access_token（RLS 按 token 过滤行）
//   · 心跳：topic = phoenix，event = heartbeat，每 30s；超 2 个周期无回复 → 判死 → 重连
//   · 云端事件：event = postgres_changes → 去抖回调（批量合并）
//   · 断线重连：指数退避（1s→2s→…→30s 封顶）；重连成功后立即触发一次 catch-up 拉取（离线补同步）
// 设计原则：本类只负责「云端有变化」的信号，不碰 SyncEngine —— 拉取合并仍由 syncOnce 统一做
// ============================================================

/** 可注入的最小 WebSocket 接口（生产 = Node 原生 WebSocket，测试 = FakeWS） */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', cb: (ev: unknown) => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
}

export type RealtimeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface SupabaseRealtimeDeps {
  /** Supabase 项目 URL（https://xxx.supabase.co） */
  projectUrl: string;
  publishableKey: string;
  /** 订阅的表（每表一个 channel） */
  tables: string[];
  /** 惰性取当前 access_token（登录态由调用方管理，取不到返回 null = 停止） */
  getAccessToken(): Promise<string | null>;
  /** 云端有变更（或重连成功需补拉）→ 调用方执行 syncOnce */
  onServerChange(reason: 'event' | 'reconnect'): void;
  /** 状态变化（health 上报用） */
  onStateChange?(state: RealtimeState, detail?: string): void;
  /** 测试注入 */
  wsFactory?(url: string): WebSocketLike;
  heartbeatMs?: number;
  heartbeatGraceMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  debounceMs?: number;
}

interface PhxMessage {
  topic: string;
  event: string;
  payload: {
    status?: string;
    response?: unknown;
    data?: { type?: string; table?: string };
  };
  ref?: string;
}

export class SupabaseRealtime {
  private deps: SupabaseRealtimeDeps;
  private ws: WebSocketLike | null = null;
  private state: RealtimeState = 'idle';
  private started = false;
  private attempt = 0; // 重连次数（成功清零）
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hbSeq = 0;
  private lastHbAck = 0;

  constructor(deps: SupabaseRealtimeDeps) {
    this.deps = deps;
  }

  get currentState(): RealtimeState {
    return this.state;
  }

  private setState(s: RealtimeState, detail?: string): void {
    this.state = s;
    this.deps.onStateChange?.(s, detail);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client-stop');
      } catch {
        // 忽略关闭异常
      }
      this.ws = null;
    }
    this.setState('stopped');
  }

  private clearTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.hbTimer = null;
    this.reconnectTimer = null;
    this.debounceTimer = null;
  }

  private async connect(): Promise<void> {
    if (!this.started) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let token: string | null = null;
    try {
      token = await this.deps.getAccessToken();
    } catch {
      token = null;
    }
    if (!token) {
      // 登录态没了 → 停（调用方 logout 也会显式 stop）
      this.started = false;
      this.setState('stopped', 'no-token');
      return;
    }
    const base = this.deps.projectUrl.replace(/^http/, 'ws');
    const url = `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(this.deps.publishableKey)}&vsn=1.0.0`;
    const factory = this.deps.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    let ws: WebSocketLike;
    try {
      ws = factory(url);
    } catch (e) {
      this.scheduleReconnect(e instanceof Error ? e.message : String(e));
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.lastHbAck = Date.now();
      // 逐表加入 channel（RLS 按 access_token 过滤行）
      for (const table of this.deps.tables) {
        this.send({
          topic: `realtime:public:${table}`,
          event: 'phx_join',
          payload: {
            config: { postgres_changes: [{ event: '*', schema: 'public', table }] },
            access_token: token,
          },
          ref: `join:${table}`,
        });
      }
      this.startHeartbeat();
      this.attempt = 0;
      this.setState('connected');
      // 重连成功 → 立即补拉（离线期间的云端变更）
      if (this.lastWasReconnect) this.deps.onServerChange('reconnect');
      this.lastWasReconnect = true;
    });

    ws.addEventListener('message', (ev) => {
      this.handleMessage(ev.data);
    });

    ws.addEventListener('close', () => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.started) this.scheduleReconnect('closed');
    });

    ws.addEventListener('error', () => {
      // error 后必有 close，交给 close 处理重连
    });
  }

  private lastWasReconnect = false;

  private send(msg: PhxMessage): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // 发送失败 → close 钩子兜底重连
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: PhxMessage;
    try {
      msg = JSON.parse(raw) as PhxMessage;
    } catch {
      return;
    }
    if (msg.topic === 'phoenix') {
      this.lastHbAck = Date.now();
      return;
    }
    if (msg.event === 'phx_reply') {
      if (msg.payload?.status === 'error' && msg.ref?.startsWith('join:')) {
        // join 失败（token 过期 / RLS 拒绝）→ 重连换新 token
        this.forceClose('join-error');
      }
      return;
    }
    if (msg.event === 'postgres_changes') {
      this.scheduleDebouncedChange();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.deps.heartbeatMs ?? 30_000;
    this.hbTimer = setInterval(() => {
      if (Date.now() - this.lastHbAck > interval * 2 + (this.deps.heartbeatGraceMs ?? 5_000)) {
        this.forceClose('heartbeat-timeout');
        return;
      }
      this.hbSeq += 1;
      this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: `hb:${this.hbSeq}` });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  private forceClose(reason: string): void {
    try {
      this.ws?.close(4000, reason);
    } catch {
      // 忽略
    }
  }

  private scheduleDebouncedChange(): void {
    if (this.debounceTimer) return; // 已排队 → 合并
    const ms = this.deps.debounceMs ?? 1_500;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.deps.onServerChange('event');
    }, ms);
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.reconnectTimer) return;
    const base = this.deps.reconnectBaseMs ?? 1_000;
    const max = this.deps.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.attempt, max);
    this.attempt += 1;
    this.setState('reconnecting', `${reason}（第 ${this.attempt} 次，${delay}ms 后重试）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
