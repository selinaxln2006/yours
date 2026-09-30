// ============================================================
// 请求来源门禁（防跨站请求 / 跨站 WebSocket 劫持 / DNS rebinding）
// 背景：server 监听 127.0.0.1 不等于只有本机"用户"能访问——用户浏览器里打开的
// 任意网页都能向 http://127.0.0.1:8765 发 text/plain POST（不触发 CORS 预检），
// 也能直接 new WebSocket('ws://127.0.0.1:8765/ws')（WS 不受同源策略限制），
// 进而改生活数据、调 Autonomy 级别、替用户在确认卡上点"允许"。
// 规则：
//   · Origin 头存在 → 必须与 Host 同源（浏览器跨站请求一定带 Origin；同源页面/CLI/curl 要么同源要么不带）
//   · 非 LAN 模式 → Host 必须是回环地址（挡 DNS rebinding：evil.com 解析到 127.0.0.1 时 Host 仍是 evil.com）
//   · LAN 模式 → 必须有 accessToken（无令牌时由 server 自动生成，绝不裸奔 0.0.0.0）
// ============================================================

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * 判定请求来源是否可信。返回 null = 放行；返回字符串 = 拒绝原因（只用于日志）。
 * @param lan LAN 模式下不校验 Host（手机用局域网 IP 访问），改由 accessToken 兜底
 */
export function checkRequestSource(
  headers: Pick<IncomingMessage['headers'], 'host' | 'origin'>,
  lan: boolean,
): string | null {
  const host = headers.host;
  if (!host) return 'missing Host header';
  if (!lan) {
    const name = hostnameOf(host);
    if (!name || !LOOPBACK_HOSTNAMES.has(name)) return `non-loopback Host: ${host}`;
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    // "null" 来自沙箱 iframe / file:// / 跨站重定向，一律视为跨站
    let originHost: string | null = null;
    try {
      originHost = origin === 'null' ? null : new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host) return `cross-origin request from ${origin}`;
  }
  return null;
}

/** 常量时间比较访问令牌（避免按字节提前返回泄露令牌前缀） */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 生成新的 LAN 访问令牌（32 字符 base64url，≈192 bit） */
export function generateAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 日志用：把 query 里的 token 参数打码，避免令牌落进终端/日志文件 */
export function redactSearch(search: string): string {
  return search.replace(/([?&]token=)[^&]*/gi, '$1***');
}
