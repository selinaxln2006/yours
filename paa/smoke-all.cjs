// 一体化冒烟：spawn 服务 → 轮询 health → 断言 API/静态 → kill
const { spawn } = require('node:child_process');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitHealth(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('server not healthy after ' + tries + ' tries');
}

async function main() {
  const child = spawn('node', ['server/main.ts'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  let failed = false;
  try {
    const health = await waitHealth();
    console.log('PASS health ok=', health.ok, 'tools=', health.tools?.length, 'pkgs=', health.pkgs?.join(','));

    const d = await fetch(`${BASE}/api/data`);
    const data = await d.json();
    console.log('PASS data keys=', Object.keys(data).length, 'profile.height=', data.profile?.height);

    const c = await fetch(`${BASE}/`);
    const html = await c.text();
    const need = ['<title>', 'id="stream"', 'id="panelBody"', 'id="overlay"', 'connect()', 'fetchData'];
    const missing = need.filter(k => !html.includes(k));
    if (c.status !== 200 || missing.length) throw new Error('console 不完整: status=' + c.status + ' missing=' + missing.join(','));
    console.log('PASS console status=', c.status, 'len=', html.length, 'elements=OK');

    const app = await fetch(`${BASE}/app`);
    const appText = await app.text();
    console.log('PASS app status=', app.status, 'isPWA=', appText.includes('shu_wb_v1'), 'len=', appText.length);
  } catch (e) {
    failed = true;
    console.error('SMOKE FAIL:', e.message);
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
    console.log('--- server stdout ---');
    console.log(out.slice(0, 800));
    console.log('--- server stderr ---');
    console.log(err.slice(0, 800));
    process.exit(failed ? 1 : 0);
  }
}
main();
