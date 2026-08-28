// S3 Realtime 订阅测试（无网络，FakeWS 注入）：
// join 帧构造 / postgres_changes 去抖合并 / 断线重连+补拉信号 / join 失败重连 / 无 token 停止 / 心跳帧
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRealtime, type WebSocketLike } from '../core/realtime.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假 WebSocket：记录发送帧，可手动触发 open/message/close */
class FakeWS implements WebSocketLike {
  url = '';
  sent: Array<{ topic: string; event: string; payload: Record<string, unknown>; ref?: string }> = [];
  closed = false;
  closeReason = '';
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = `${code ?? ''} ${reason ?? ''}`;
    this.emit('close', {});
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: never) => void): void {
    (this.listeners[type] ??= []).push(cb as (ev: unknown) => void);
  }

  emit(type: 'open' | 'message' | 'close' | 'error', ev: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }

  /** 服务端推一条 postgres_changes 事件 */
  pushChange(): void {
    this.emit('message', {
      data: JSON.stringify({ topic: 'realtime:public:life_sync', event: 'postgres_changes', payload: { data: { type: 'UPDATE', table: 'life_sync' } } }),
    });
  }
}

interface Harness {
  fakes: FakeWS[];
  changes: string[];
  sub: SupabaseRealtime;
}

function makeHarness(opts?: Partial<{ token: string | null }>): Harness {
  const token = opts && 'token' in opts ? opts.token : 'tok-1';
  const fakes: FakeWS[] = [];
  const changes: string[] = [];
  const sub = new SupabaseRealtime({
    projectUrl: 'https://test.supabase.co',
    publishableKey: 'pk-test',
    tables: ['life_sync'],
    getAccessToken: async () => token,
    onServerChange: (why) => changes.push(why),
    wsFactory: (u: string) => {
      const f = new FakeWS();
      f.url = u;
      fakes.push(f);
      return f;
    },
    debounceMs: 20,
    reconnectBaseMs: 5,
    reconnectMaxMs: 50,
    heartbeatMs: 10_000,
  });
  return { fakes, changes, sub };
}

test('连接：URL 构造 + join 帧带 token 与 postgres_changes 配置', async () => {
  const h = makeHarness();
  h.sub.start();
  await sleep(5);
  assert.equal(h.fakes.length, 1, '应创建 1 个 WS');
  assert.ok(h.fakes[0].url.startsWith('wss://test.supabase.co/realtime/v1/websocket?apikey=pk-test&vsn=1.0.0'), 'URL 协议换 wss + apikey');
  h.fakes[0].emit('open');
  const joins = h.fakes[0].sent.filter((m) => m.event === 'phx_join');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].topic, 'realtime:public:life_sync');
  assert.equal(joins[0].payload.access_token, 'tok-1');
  const cfg = joins[0].payload.config as { postgres_changes: Array<{ event: string; schema: string; table: string }> };
  assert.deepEqual(cfg.postgres_changes, [{ event: '*', schema: 'public', table: 'life_sync' }]);
  h.sub.stop();
});

test('postgres_changes 事件：窗口内多次合并为一次回调（去抖）', async () => {
  const h = makeHarness();
  h.sub.start();
  await sleep(5);
  h.fakes[0].emit('open');
  h.fakes[0].pushChange();
  h.fakes[0].pushChange();
  h.fakes[0].pushChange();
  assert.equal(h.changes.length, 0, '去抖窗口内不触发');
  await sleep(40);
  assert.deepEqual(h.changes, ['event'], '3 次事件合并为 1 次回调');
  h.sub.stop();
});

test('断线重连：close → 指数退避重连 → 重连成功触发补拉信号', async () => {
  const h = makeHarness();
  h.sub.start();
  await sleep(5);
  h.fakes[0].emit('open');
  assert.equal(h.changes.length, 0, '首次连接不触发补拉（由 initialSync 负责）');
  h.fakes[0].emit('close');
  assert.equal(h.sub.currentState, 'reconnecting');
  await sleep(30);
  assert.equal(h.fakes.length, 2, '重连创建新 WS');
  h.fakes[1].emit('open');
  assert.deepEqual(h.changes, ['reconnect'], '重连成功 → 离线补拉信号');
  h.sub.stop();
});

test('join 失败（token 过期）：phx_reply error → 主动断开 → 重连', async () => {
  const h = makeHarness();
  h.sub.start();
  await sleep(5);
  h.fakes[0].emit('open');
  h.fakes[0].emit('message', {
    data: JSON.stringify({ topic: 'realtime:public:life_sync', event: 'phx_reply', payload: { status: 'error', response: {} }, ref: 'join:life_sync' }),
  });
  assert.ok(h.fakes[0].closed, 'join error 应主动 close');
  await sleep(30);
  assert.equal(h.fakes.length, 2, 'close 后重连');
  h.sub.stop();
});

test('无 token：直接 stopped，不创建 WS', async () => {
  const h = makeHarness({ token: null });
  h.sub.start();
  await sleep(5);
  assert.equal(h.sub.currentState, 'stopped');
  assert.equal(h.fakes.length, 0);
});

test('心跳：连接后周期发 heartbeat 帧；phoenix 回复刷新存活', async () => {
  const fakes: FakeWS[] = [];
  const changes: string[] = [];
  const sub = new SupabaseRealtime({
    projectUrl: 'https://test.supabase.co',
    publishableKey: 'pk',
    tables: ['life_sync'],
    getAccessToken: async () => 'tok',
    onServerChange: (w) => changes.push(w),
    wsFactory: (u) => {
      const f = new FakeWS();
      f.url = u;
      fakes.push(f);
      return f;
    },
    heartbeatMs: 20,
    heartbeatGraceMs: 10,
    debounceMs: 20,
    reconnectBaseMs: 5,
    reconnectMaxMs: 50,
  });
  sub.start();
  await sleep(5);
  fakes[0].emit('open');
  await sleep(150);
  const hbs = fakes[0].sent.filter((m) => m.event === 'heartbeat');
  assert.ok(hbs.length >= 1, '应发出心跳帧');
  assert.ok(hbs.every((m) => m.topic === 'phoenix'), '心跳走 phoenix topic');
  // 心跳无回复 → 超时判死（阈值 = 20*2+10 = 50ms）→ 重连
  assert.equal(fakes.length, 2, '心跳超时应断开并重连');
  sub.stop();
});
