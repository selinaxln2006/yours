// ============================================================
// S1 — Supabase Auth 客户端（GitHub OAuth，PKCE，零依赖）
//
// 流程：浏览器 → /api/auth/login（302 跳 Supabase authorize，PKCE S256）
//      → GitHub → Supabase /auth/v1/callback → 回到本 server /api/auth/callback
//      → code + code_verifier 换 token → 会话落盘 data/auth/sessions/<sid>.json
//      → httpOnly cookie `paa_session` → /api/auth/me 查询 + 自动 refresh
//
// 数据主权：token 只落本地文件，浏览器只拿到 httpOnly cookie（JS 不可读）
// ============================================================
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

export interface AuthUser {
  id: string;
  email?: string;
  name: string;
  avatar?: string;
  provider: string;
}

export interface AuthSession {
  sid: string;
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  /** 过期时刻（ms） */
  expiresAt: number;
  createdAt: number;
}

export interface UserRec {
  user: AuthUser;
  firstSeen: number;
  lastSeen: number;
  logins: number;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface SupabaseTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: {
    id?: string;
    email?: string;
    user_metadata?: { user_name?: string; avatar_url?: string; name?: string; full_name?: string };
    app_metadata?: { provider?: string };
  };
  error?: string;
  error_description?: string;
}

/** 授权流程有效期：10 分钟 */
const AUTH_TTL_MS = 10 * 60_000;

export class SupabaseAuth {
  /** 最近一次授权流程的 verifier（单槽：本地单用户，登录流程一次一个） */
  private pending: { verifier: string; ts: number } | null = null;
  /** 依赖注入配置（Node type stripping 不支持参数属性，用显式赋值） */
  private opts: {
    projectUrl: string;
    publishableKey: string;
    /** 必须与 Supabase Redirect URLs 完全一致 */
    callbackUrl: string;
    sessionDir: string;
    userDir: string;
  };

  constructor(opts: {
    projectUrl: string;
    publishableKey: string;
    callbackUrl: string;
    sessionDir: string;
    userDir: string;
  }) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    await mkdir(this.opts.sessionDir, { recursive: true });
    await mkdir(this.opts.userDir, { recursive: true });
  }

  /** 生成 GitHub 授权跳转 URL（PKCE S256）
   *
   *  ⚠️ 不要传 state 参数！GoTrue 服务端会用自己生成的 flow_state UUID 作为
   *  state（external.go 注释："The flow state ID is used as the state parameter"）。
   *  客户端传 state 会被 AuthCodeURL 覆盖到 GitHub URL → 回调时 GoTrue 查
   *  flow_state 表找不到（表里只有它自己生成的 UUID）→ bad_oauth_state。
   *  官方客户端 supabase-js 同样不传 state。CSRF 由 GoTrue 自己保证。 */
  buildLoginUrl(): string {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending = { verifier, ts: Date.now() };
    const u = new URL(`${this.opts.projectUrl}/auth/v1/authorize`);
    u.searchParams.set('provider', 'github');
    u.searchParams.set('redirect_to', this.opts.callbackUrl);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /** callback：code → 换 token → 构建会话（未落盘，由调用方 save） */
  async exchangeCode(code: string): Promise<AuthSession> {
    const p = this.pending;
    this.pending = null; // 一次性：防重放
    if (!p) throw new AuthError('授权流程不存在，请重新登录');
    if (Date.now() - p.ts > AUTH_TTL_MS) throw new AuthError('授权流程超时，请重新登录');
    // 注意：Supabase PKCE 的 grant_type 是 pkce（不是 authorization_code，
    // 后者 GoTrue 直接回 unsupported_grant_type——token.go 只有 case "pkce"）
    const res = await fetch(`${this.opts.projectUrl}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.opts.publishableKey },
      // 注意：Supabase PKCE 换 token 的字段名是 auth_code（不是 code）——用 code 会 400 invalid_request
      body: JSON.stringify({ auth_code: code, code_verifier: p.verifier }),
    });
    const data = (await res.json().catch(() => ({}))) as SupabaseTokenResponse;
    if (!res.ok || !data.access_token) {
      throw new AuthError(`Supabase 换 token 失败: ${data.error_description ?? data.error ?? res.status}`, 502);
    }
    return this.buildSession(data);
  }

  private buildSession(data: SupabaseTokenResponse): AuthSession {
    const um = data.user?.user_metadata ?? {};
    const email = data.user?.email;
    const name =
      um.user_name ?? um.name ?? um.full_name ?? (email ? email.split('@')[0] : 'user') ?? 'user';
    return {
      sid: randomBytes(16).toString('hex'),
      user: {
        id: data.user?.id ?? 'anon',
        email,
        name,
        avatar: um.avatar_url,
        provider: data.user?.app_metadata?.provider ?? 'github',
      },
      accessToken: data.access_token ?? '',
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      createdAt: Date.now(),
    };
  }

  /** 会话 + 用户标记落盘 */
  async save(s: AuthSession): Promise<void> {
    await writeFile(path.join(this.opts.sessionDir, `${s.sid}.json`), JSON.stringify(s, null, 2), 'utf8');
    await this.touchUser(s.user);
  }

  async get(sid: string): Promise<AuthSession | null> {
    if (!/^[a-f0-9]{32}$/.test(sid)) return null;
    try {
      const s = JSON.parse(await readFile(path.join(this.opts.sessionDir, `${sid}.json`), 'utf8')) as AuthSession;
      return s && typeof s.user?.id === 'string' && typeof s.accessToken === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  async remove(sid: string): Promise<void> {
    try {
      await rm(path.join(this.opts.sessionDir, `${sid}.json`));
    } catch {
      /* 不存在即无 */
    }
  }

  /** user_id 落盘：data/auth/users/<uid>.json（首登/登录次数/最后活跃） */
  async touchUser(user: AuthUser): Promise<UserRec> {
    const file = path.join(this.opts.userDir, `${user.id}.json`);
    let rec: UserRec = { user, firstSeen: Date.now(), lastSeen: Date.now(), logins: 1 };
    try {
      const prev = JSON.parse(await readFile(file, 'utf8')) as UserRec;
      rec = {
        user,
        firstSeen: prev.firstSeen ?? Date.now(),
        lastSeen: Date.now(),
        logins: (prev.logins ?? 0) + 1,
      };
    } catch {
      /* 首登 */
    }
    await writeFile(file, JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  async getUserRec(userId: string): Promise<UserRec | null> {
    try {
      return JSON.parse(await readFile(path.join(this.opts.userDir, `${userId}.json`), 'utf8')) as UserRec;
    } catch {
      return null;
    }
  }

  /** access_token 距过期 <60s 且可刷新 → 刷新并更新文件；否则返回 null */
  async refreshIfNeeded(s: AuthSession): Promise<AuthSession | null> {
    if (Date.now() < s.expiresAt - 60_000 || !s.refreshToken) return null;
    const res = await fetch(`${this.opts.projectUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.opts.publishableKey },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    const data = (await res.json().catch(() => ({}))) as SupabaseTokenResponse;
    if (!res.ok || !data.access_token) return null; // refresh 失败 → 前端重新登录
    const ns = this.buildSession(data);
    ns.sid = s.sid; // 保留原 sid
    ns.createdAt = s.createdAt;
    await this.save(ns);
    return ns;
  }
}
