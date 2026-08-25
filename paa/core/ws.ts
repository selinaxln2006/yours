// ============================================================
// WS — 极简 WebSocket 服务端（RFC6455 子集，console-v1）
// 零 npm 依赖：握手（sha1+GUID）+ 文本帧编解码 + ping/pong + close
// 支持范围：单帧文本消息（长度 ≤ 2^31）、客户端掩码帧解析、
// 服务端不掩码发送、协议层 ping/pong 保活。
// 不支持：分片 continuation、二进制帧（本场景只需 JSON 文本）。
// ============================================================

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export class WsConnection {
  readonly socket: Duplex;
  private alive = true;
  /** 消息回调（已解析的 JSON；非 JSON 原样传 {type:'__raw__'}） */
  onMessage: ((msg: WsMessage) => void) | null = null;
  onClose: (() => void) | null = null;
  private buffer = Buffer.alloc(0);

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    const end = (): void => this.close();
    socket.on('close', end);
    socket.on('error', end);
    socket.on('end', end);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** 协议层 ping（保活探测） */
  ping(): void {
    if (this.alive) this.writeFrame(0x9, Buffer.alloc(0));
  }

  send(text: string): void {
    if (this.alive) this.writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendJson(obj: unknown): void {
    this.send(JSON.stringify(obj));
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      // opcode 8 = close，payload 前 2 字节状态码 1000
      this.socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    } catch {
      // socket 已断
    }
    try {
      this.socket.end();
    } catch {
      // 忽略
    }
    this.onClose?.();
  }

  // ---- 帧解析 ----
  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 循环取完整帧（可能粘包）
    for (;;) {
      const frame = this.tryParseFrame();
      if (!frame) break;
      this.handleFrame(frame);
      if (!this.alive) break;
    }
  }

  private tryParseFrame(): { opcode: number; payload: Buffer } | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(0x7fffffff)) {
        this.close();
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buffer = buf.subarray(offset + maskLen + len);
    if (!fin) {
      // 分片不支持：直接关闭（本场景客户端库均单帧发送）
      this.close();
      return null;
    }
    return { opcode, payload };
  }

  private handleFrame(frame: { opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case 0x1: {
        // 文本
        const text = frame.payload.toString('utf8');
        let msg: WsMessage;
        try {
          msg = JSON.parse(text) as WsMessage;
        } catch {
          msg = { type: '__raw__', text };
        }
        this.onMessage?.(msg);
        break;
      }
      case 0x8:
        this.close();
        break;
      case 0x9:
        // ping → pong
        this.writeFrame(0xa, frame.payload);
        break;
      case 0xa:
        // pong：保活成功（标记由外部 ping 检查使用）
        break;
      default:
        // 二进制等不支持
        this.close();
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.close();
    }
  }
}

/** 完成 WS 握手（http server 的 upgrade 事件里调用）；失败返回 null */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  socket.setNoDelay(true);
  return new WsConnection(socket);
}
