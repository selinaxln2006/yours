// 测试用 mock MCP server（JSON-RPC 2.0 over stdio，newline-delimited）
// 行为对齐真实 MCP server：initialize 握手 → tools/list → tools/call
// 提供 3 个工具：echo（文本回显）/ add（两数相加）/ fail（故意 isError）
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-server', version: '1.0.0' } } });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'echo', description: '回显输入文本', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } }, required: ['text'] } },
          { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
          { name: 'fail', description: '故意返回错误', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
    } else if (name === 'add') {
      const sum = Number(args.a) + Number(args.b);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(sum) }] } });
    } else if (name === 'fail') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'boom: 故意的失败' }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } });
    }
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } });
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleRequest(JSON.parse(trimmed));
  } catch {
    // 非法 JSON 忽略
  }
});
