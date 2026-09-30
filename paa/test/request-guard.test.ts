// 请求来源门禁测试：跨站 Origin / DNS rebinding Host / LAN 模式 / 令牌比较 / 日志打码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequestSource, generateAccessToken, redactSearch, tokenMatches } from '../server/request-guard.ts';

test('本机同源请求放行（console.html fetch / WS 同源、CLI 与 curl 不带 Origin）', () => {
  assert.equal(checkRequestSource({ host: '127.0.0.1:8765' }, false), null);
  assert.equal(checkRequestSource({ host: 'localhost:8765', origin: 'http://localhost:8765' }, false), null);
  assert.equal(checkRequestSource({ host: '[::1]:8765', origin: 'http://[::1]:8765' }, false), null);
});

test('跨站网页发来的请求被拒（CSRF / 跨站 WebSocket 劫持）', () => {
  assert.match(checkRequestSource({ host: '127.0.0.1:8765', origin: 'https://evil.example' }, false) ?? '', /cross-origin/);
  // 同主机不同端口也是跨源
  assert.match(checkRequestSource({ host: '127.0.0.1:8765', origin: 'http://127.0.0.1:3000' }, false) ?? '', /cross-origin/);
  // 沙箱 iframe / file:// 的 Origin 为 "null"
  assert.match(checkRequestSource({ host: '127.0.0.1:8765', origin: 'null' }, false) ?? '', /cross-origin/);
  assert.match(checkRequestSource({ host: '127.0.0.1:8765', origin: 'not a url' }, false) ?? '', /cross-origin/);
});

test('非 LAN 模式拒绝非回环 Host（DNS rebinding）', () => {
  assert.match(checkRequestSource({ host: 'evil.example:8765' }, false) ?? '', /non-loopback/);
  assert.match(checkRequestSource({ host: 'evil.example:8765', origin: 'http://evil.example:8765' }, false) ?? '', /non-loopback/);
  assert.match(checkRequestSource({}, false) ?? '', /missing Host/);
});

test('LAN 模式允许局域网 IP 访问，但仍拒跨站 Origin', () => {
  assert.equal(checkRequestSource({ host: '192.168.1.20:8765', origin: 'http://192.168.1.20:8765' }, true), null);
  assert.match(checkRequestSource({ host: '192.168.1.20:8765', origin: 'https://evil.example' }, true) ?? '', /cross-origin/);
});

test('令牌比较：完全一致才通过，空期望值永不通过', () => {
  const t = generateAccessToken();
  assert.equal(t.length, 32);
  assert.notEqual(generateAccessToken(), t);
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t.slice(0, -1), t), false);
  assert.equal(tokenMatches(t + 'x', t), false);
  assert.equal(tokenMatches(undefined, t), false);
  assert.equal(tokenMatches(['a'], t), false);
  assert.equal(tokenMatches('', ''), false);
});

test('日志打码 token 参数', () => {
  assert.equal(redactSearch('?token=abc&x=1'), '?token=***&x=1');
  assert.equal(redactSearch('?x=1&TOKEN=abc'), '?x=1&TOKEN=***');
  assert.equal(redactSearch('?x=1'), '?x=1');
});
