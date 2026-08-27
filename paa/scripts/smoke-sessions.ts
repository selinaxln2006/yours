// t5 全链路验证：新建会话→发消息→切换会话→重启→读回（真实 HTTP + 真实 LLM）
// 运行：node paa/scripts/smoke-sessions.ts（项目根）
// 说明：spawn 真实 server（独立端口 8770）→ 走 /api/sessions* REST → kill 重启 → 读回验证持久化
import { spawn } from 'node:child_process';

const PORT = 8770;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const srv = spawn(process.execPath, ['paa/server/main.ts', '--port', String(PORT)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PAA_MAX_ROUNDS: '2' }, // 限制 LLM 轮数，加快验证
  });
  let errBuf = '';
  srv.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
  return { srv, errBuf: () => errBuf };
}

async function waitReady(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

async function req(path: string, opts?: RequestInit) {
  const res = await fetch(base + path, opts);
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

const results: Record<string, unknown> = {};
const fails: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  results[name] = cond ? 'PASS' : 'FAIL';
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  // ---- 第一次启动 ----
  let { srv, errBuf } = startServer();
  try {
    if (!(await waitReady())) { check('启动就绪', false, 'server 未就绪'); }
    else check('启动就绪', true);

    // 1) 新建会话 A
    const cA = await req('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't5-会话A' }),
    });
    const idA = (cA.json as any)?.session?.id as string | undefined;
    check('新建会话A', cA.status === 201 && !!idA, `status=${cA.status}`);

    // 2) A 发消息（真实 LLM）
    const mA = await req(`/api/sessions/${idA}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '只回复四个字：测试通过' }),
    });
    const mAjson = mA.json as any;
    check('A发消息', mA.status === 200 && !!mAjson?.answer, `status=${mA.status}`);
    results['A回复'] = mAjson?.answer;

    // 3) 新建会话 B 并发消息
    const cB = await req('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't5-会话B' }),
    });
    const idB = (cB.json as any)?.session?.id as string | undefined;
    check('新建会话B', cB.status === 201 && !!idB, `status=${cB.status}`);
    const mB = await req(`/api/sessions/${idB}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '只回复四个字：验证通过' }),
    });
    check('B发消息', mB.status === 200 && !!((mB.json as any)?.answer), `status=${mB.status}`);
    results['B回复'] = (mB.json as any)?.answer;

    // 4) 切换会话：列表应含 A、B；读回 A 详情
    const list = await req('/api/sessions');
    const ids = (list.json as any)?.sessions?.map((s: any) => s.id) ?? [];
    check('列表含A、B', ids.length >= 2 && ids.includes(idA) && ids.includes(idB), `ids=${ids.join(',')}`);
    const getA = await req(`/api/sessions/${idA}`);
    const msgA = (getA.json as any)?.session?.messages ?? [];
    check('切回A读消息', getA.status === 200 && msgA.length >= 2, `msgs=${msgA.length}`);

    results['会话A_id'] = idA;
    results['会话B_id'] = idB;
    results['重启前_会话数'] = ids.length;
  } finally {
    srv.kill();
    await sleep(400);
  }

  // ---- 重启（第二次启动，同端口）----
  const srv2 = startServer();
  const { srv: srv2proc } = srv2;
  try {
    if (!(await waitReady())) { check('重启就绪', false, '重启后未就绪'); }
    else check('重启就绪', true);

    const list2 = await req('/api/sessions');
    const ids2 = (list2.json as any)?.sessions?.map((s: any) => s.id) ?? [];
    const idA2 = (results['会话A_id'] as string) ?? '';
    const idB2 = (results['会话B_id'] as string) ?? '';
    check('重启后列表含A、B', ids2.includes(idA2) && ids2.includes(idB2), `ids=${ids2.join(',')}`);
    results['重启后_会话数'] = ids2.length;

    // 读回 A 完整消息（持久化验证）
    const getA2 = await req(`/api/sessions/${idA2}`);
    const a2 = getA2.json as any;
    const msgA2 = a2?.session?.messages ?? [];
    check('重启后A消息保留', getA2.status === 200 && msgA2.length >= 2, `msgs=${msgA2.length}`);
    check('重启后A标题保留', (a2?.session?.title ?? '').includes('t5-会话A'), `title=${a2?.session?.title}`);
    results['重启后_A首条user'] = msgA2[0]?.content;
  } finally {
    srv2proc.kill();
    await sleep(400);
  }

  console.log(JSON.stringify(results, null, 2));
  if (fails.length) {
    console.error('\n❌ FAILED:', fails.join(' | '));
    process.exitCode = 1;
  } else {
    console.log('\n✅ t5 全链路验证全部通过');
  }
})().catch((e) => { console.error('SMOKE ERROR:', e); process.exitCode = 1; });
