// 临时冒烟：health + data + 静态 console.html（用后即删）
async function main() {
  const h = await fetch('http://127.0.0.1:8765/api/health');
  const health = await h.json();
  console.log('health.status=', h.status, 'ok=', health.ok, 'tools=', health.tools?.length, 'pkgs=', health.pkgs?.join(','));

  const d = await fetch('http://127.0.0.1:8765/api/data');
  const data = await d.json();
  console.log('data.status=', d.status, 'keys=', Object.keys(data).length, 'profile.height=', data.profile?.height);

  const c = await fetch('http://127.0.0.1:8765/');
  const html = await c.text();
  console.log('console.status=', c.status, 'len=', html.length, 'hasTitle=', html.includes('<title>'));

  const app = await fetch('http://127.0.0.1:8765/app');
  console.log('app.status=', app.status, 'isPWA=', (await app.text()).includes('shu_wb_v1'));
}
main().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
