// S1 auth 冒烟测试：spawn 真实 server（8766）→ 验证四端点 → kill
// 运行：node paa/scripts/smoke-auth.ts（项目根）
// 注意：放 scripts/ 而非 test/ —— node --test 会自动发现 test/ 下所有文件，
// 本脚本 spawn server + 外部网络请求，不能被测试套件误收。
import { spawn } from 'node:child_process';

const PORT = 8766;
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['paa/server/main.ts', '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let errBuf = '';
srv.stderr.on('data', (d: Buffer) => {
  errBuf += d.toString();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(path: string, opts?: RequestInit) {
  try {
    const res = await fetch(base + path, opts);
    const loc = res.headers.get('location');
    const body = await res.text();
    return { status: res.status, loc: loc ? loc.slice(0, 120) : null, body: body.slice(0, 160) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const results: Record<string, unknown> = {};
try {
  await sleep(2500);
  results.login = await req('/api/auth/login');
  results.me_noCookie = await req('/api/auth/me');
  results.callback_badState = await req('/api/auth/callback?code=x&state=y');
  results.logout = await req('/api/auth/logout', { method: 'POST' });
  results.health = await req('/api/health');
} finally {
  srv.kill();
  await sleep(300);
}
console.log(JSON.stringify(results, null, 2));
if (errBuf) console.log('SERVER STDERR:\n' + errBuf.slice(-800));
