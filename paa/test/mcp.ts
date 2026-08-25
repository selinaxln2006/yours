// G5 MCP client 测试：真实 spawn mock server（JSON-RPC over stdio 全链路）
// 握手 / tools/list / 工具映射 / call（文本+数字+错误） / 关闭
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, createMcpToolDefinitions, sanitizeServerName } from '../core/mcp-client.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const MOCK_SERVER = path.join(FIXTURES, 'mcp-mock.mjs');

function makeClient(opts?: { risk?: 1 | 2 | 3 }): McpClient {
  return new McpClient({
    name: 'mock-server',
    command: process.execPath, // node 可执行路径（跨平台，避开 .cmd 问题）
    args: [MOCK_SERVER],
    risk: opts?.risk,
  });
}

test('sanitizeServerName：非法字符合法化', () => {
  assert.equal(sanitizeServerName('my-server'), 'my_server');
  assert.equal(sanitizeServerName('123abc'), 'abc');
  assert.equal(sanitizeServerName('!!!'), 'server');
  assert.equal(sanitizeServerName('GitHub API'), 'github_api');
});

test('握手 + tools/list：3 个工具齐全，工具映射全名与 risk 正确', async () => {
  const c = makeClient();
  await c.connect();
  try {
    assert.ok(c.isConnected);
    assert.equal(c.tools.length, 3);
    const names = c.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add', 'echo', 'fail']);

    const defs = createMcpToolDefinitions(c);
    assert.equal(defs.length, 3);
    const fullNames = defs.map((d) => d.name).sort();
    assert.deepEqual(fullNames, ['mcp_mock_server_add', 'mcp_mock_server_echo', 'mcp_mock_server_fail']);
    assert.ok(defs.every((d) => d.risk === 2), '默认 risk 应为 2');

    // inputSchema → params 映射
    const echo = defs.find((d) => d.name === 'mcp_mock_server_echo');
    assert.deepEqual(echo?.params, { text: { type: 'string', desc: '要回显的文本', required: true } });
  } finally {
    c.close();
  }
});

test('risk 覆盖：config.risk=1 时工具 risk 为 1', async () => {
  const c = makeClient({ risk: 1 });
  await c.connect();
  try {
    const defs = createMcpToolDefinitions(c, { risk: 1 });
    assert.ok(defs.every((d) => d.risk === 1));
  } finally {
    c.close();
  }
});

test('callTool：echo 文本 + add 数字正确返回', async () => {
  const c = makeClient();
  await c.connect();
  try {
    const echoText = await c.callTool('echo', { text: 'hello G5' });
    assert.equal(echoText, 'echo: hello G5');

    const sum = await c.callTool('add', { a: 20, b: 22 });
    assert.equal(sum, '42');
  } finally {
    c.close();
  }
});

test('callTool：isError 时抛错且带内容', async () => {
  const c = makeClient();
  await c.connect();
  try {
    await assert.rejects(() => c.callTool('fail', {}), /故意的失败/);
  } finally {
    c.close();
  }
});

test('未知工具：server 返回 JSON-RPC error', async () => {
  const c = makeClient();
  await c.connect();
  try {
    await assert.rejects(() => c.callTool('nope', {}), /未知工具/);
  } finally {
    c.close();
  }
});

test('close 后不可调用；重复 close 幂等', async () => {
  const c = makeClient();
  await c.connect();
  c.close();
  c.close(); // 幂等
  await assert.rejects(() => c.callTool('echo', { text: 'x' }), /未连接|已关闭/);
});

test('连接不存在的 server：明确报错', async () => {
  const c = new McpClient({
    name: 'ghost',
    command: process.execPath,
    args: [path.join(FIXTURES, 'no-such-mcp.mjs')],
  });
  await assert.rejects(() => c.connect(), /握手失败|进程退出/);
});
