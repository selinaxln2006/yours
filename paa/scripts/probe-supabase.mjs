// 临时探测：Supabase 表是否已建（S2 前置检查）
// 不打印密钥；只探测 life_sync / session_events 两表存在性（匿名 RLS 下返回 [] = 存在）
import { readFile } from 'node:fs/promises';

const c = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const { url, publishableKey } = c.supabase;
if (!url || !publishableKey) throw new Error('config.json 缺 supabase.url/publishableKey');

async function probe(table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` },
  });
  const body = await res.text().catch(() => '');
  console.log(`${table}: HTTP ${res.status} | ${body.slice(0, 120)}`);
  return res.ok || res.status === 404 ? res.status === 200 : false;
}

const ok1 = await probe('life_sync');
const ok2 = await probe('session_events');
console.log(ok1 && ok2 ? '✅ 两张表已就绪' : '⚠️ 表缺失：先在 Supabase SQL Editor 跑 docs/SUPABASE-SETUP.md Step 5 的 SQL');
