// ============================================================
// 券商只读接入（可选，配置了才启用）
// - IBKR：Flex Web Service（只读报表接口，token + 查询号，不需要 OAuth、不能下单）
// - moomoo / 富途：经本机 OpenD + moomoo-api-mcp（MCP server），只调用读取类工具
// 同步结果写成一个 source=ibkr|moomoo 的券商账户（现金 + 持仓，价格用券商给的现价）
// ============================================================

import type { Account, Holding } from './assets.ts';
import { futuToYahoo, MARKET_CCY } from './assets.ts';
import type { McpClient } from '../core/mcp-client.ts';

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ---- IBKR Flex ----

const FLEX_SEND = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const FLEX_GET = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';

const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]?.trim();

/** <Elem a="1" b="2" /> → 属性表（只取指定元素） */
export function xmlElements(xml: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${name}\\s([^>]*?)/?>`, 'g');
  for (const m of xml.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    out.push(attrs);
  }
  return out;
}

export interface BrokerSnapshot {
  name: string;
  currency: string;
  cash: Array<{ currency: string; amount: number }>;
  holdings: Holding[];
}

/** Flex 报表 XML → 现金（按币种）+ 持仓（价格用报表里的 markPrice） */
export function parseFlexStatement(xml: string): BrokerSnapshot {
  if (!/<FlexQueryResponse|<FlexStatement/.test(xml)) throw new Error('不是 Flex 报表');
  const stmt = xmlElements(xml, 'FlexStatement')[0] ?? {};
  const info = xmlElements(xml, 'AccountInformation')[0] ?? {};
  const baseCcy = (info.currency || '').toUpperCase() || 'USD';
  const holdings: Holding[] = [];
  for (const p of xmlElements(xml, 'OpenPosition')) {
    if (p.levelOfDetail && p.levelOfDetail !== 'SUMMARY') continue;
    const qty = Number(p.position);
    const price = Number(p.markPrice);
    if (!p.symbol || !Number.isFinite(qty) || qty === 0) continue;
    holdings.push({ symbol: p.symbol.replace(/\s+/g, '.').toUpperCase().slice(0, 20), qty, name: p.description?.slice(0, 60), currency: (p.currency || baseCcy).toUpperCase(), ...(Number.isFinite(price) ? { price } : {}) });
  }
  const cash = xmlElements(xml, 'CashReportCurrency')
    .filter((c) => c.currency && c.currency !== 'BASE_SUMMARY')
    .map((c) => ({ currency: c.currency.toUpperCase(), amount: Number(c.endingCash ?? c.endingSettledCash ?? 0) }))
    .filter((c) => Number.isFinite(c.amount) && c.amount !== 0);
  return { name: `IBKR ${stmt.accountId ?? info.accountId ?? ''}`.trim(), currency: baseCcy, cash, holdings };
}

export async function fetchIbkr(f: FetchLike, token: string, queryId: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<BrokerSnapshot> {
  if (!/^\d{6,30}$/.test(token) || !/^\d{3,20}$/.test(queryId)) throw new Error('IBKR token 或查询号格式不对（都应是数字）');
  const headers = { 'User-Agent': 'Yours/0.4' };
  const r = await f(`${FLEX_SEND}?t=${token}&q=${queryId}&v=3`, { headers, signal: AbortSignal.timeout(15000) });
  const x = await r.text();
  if (tag(x, 'Status') !== 'Success') throw new Error(`IBKR 拒绝请求：${tag(x, 'ErrorMessage') ?? `HTTP ${r.status}`}`);
  const ref = tag(x, 'ReferenceCode');
  const url = tag(x, 'Url') || FLEX_GET;
  if (!ref) throw new Error('IBKR 没给报表编号');
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 2000 : 4000);
    const s = await f(`${url}?t=${token}&q=${ref}&v=3`, { headers, signal: AbortSignal.timeout(20000) });
    const body = await s.text();
    if (/<FlexQueryResponse|<FlexStatement\b/.test(body)) return parseFlexStatement(body);
    // 1019 = 报表生成中，等一会再取
    if (tag(body, 'ErrorCode') !== '1019') throw new Error(`IBKR 取报表失败：${tag(body, 'ErrorMessage') ?? `HTTP ${s.status}`}`);
  }
  throw new Error('IBKR 报表生成超时，稍后再试');
}

// ---- moomoo / 富途（经 MCP）----

/** MCP 工具返回的文本 → JSON（整体是 JSON，或每行一个 JSON，或 {result: ...}） */
export function parseMcpJson(text: string): unknown {
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = tryParse(text.trim());
  if (v === undefined) {
    const parts = text.split('\n').map((l) => tryParse(l.trim())).filter((x) => x !== undefined);
    v = parts.length === 1 ? parts[0] : parts;
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && 'result' in (v as Record<string, unknown>) && Object.keys(v as object).length === 1) v = (v as { result: unknown }).result;
  return v;
}

/** 只用这几个读取类工具 */
export const MOOMOO_READ_TOOLS = ['get_accounts', 'get_assets', 'get_positions', 'get_account_summary', 'get_stock_quote', 'get_market_snapshot', 'get_historical_klines', 'get_cash_flow', 'check_health'];

export function moomooToSnapshot(assets: unknown, positions: unknown, label = 'moomoo'): BrokerSnapshot {
  const a = (assets && typeof assets === 'object' && !Array.isArray(assets) ? assets : {}) as Record<string, unknown>;
  const ccy = typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'USD';
  const cashAmt = Number(a.cash ?? 0);
  const holdings: Holding[] = [];
  for (const p of Array.isArray(positions) ? positions : []) {
    const r = p as Record<string, unknown>;
    const code = String(r.code ?? '');
    const qty = Number(r.qty ?? 0);
    if (!code || !Number.isFinite(qty) || qty === 0) continue;
    const mkt = code.split('.')[0].toUpperCase();
    const price = Number(r.nominal_price ?? (Number(r.market_val) / qty));
    holdings.push({
      symbol: futuToYahoo(code),
      qty,
      name: typeof r.stock_name === 'string' ? r.stock_name.slice(0, 60) : undefined,
      currency: typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : MARKET_CCY[mkt] ?? ccy,
      ...(Number.isFinite(price) ? { price } : {}),
    });
  }
  return { name: label, currency: ccy, cash: Number.isFinite(cashAmt) && cashAmt !== 0 ? [{ currency: ccy, amount: cashAmt }] : [], holdings };
}

export async function fetchMoomoo(client: McpClient, trdEnv: 'REAL' | 'SIMULATE', accId?: string): Promise<BrokerSnapshot> {
  let acc = accId;
  if (!acc) {
    const list = parseMcpJson(await client.callTool('get_accounts', {}));
    const arr = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
    const pick = arr.find((x) => String(x.trd_env ?? '').toUpperCase() === trdEnv) ?? arr[0];
    acc = pick ? String(pick.acc_id ?? '0') : '0';
  }
  const assets = parseMcpJson(await client.callTool('get_assets', { trd_env: trdEnv, acc_id: acc }));
  const positions = parseMcpJson(await client.callTool('get_positions', { trd_env: trdEnv, acc_id: acc }));
  return moomooToSnapshot(assets, positions, `moomoo${trdEnv === 'SIMULATE' ? '（模拟）' : ''}`);
}

/** 同步结果并进账户列表：同来源的旧账户整体替换；主币种现金进主账户，其他币种现金各单列一个账户 */
export function mergeBroker(accounts: Account[], source: 'ibkr' | 'moomoo', snap: BrokerSnapshot, now: number): Account[] {
  const keep = accounts.filter((a) => a.source !== source);
  const main = snap.cash.find((c) => c.currency === snap.currency)?.amount ?? 0;
  const out: Account[] = [{ id: `${source}-main`, name: snap.name, kind: 'broker', currency: snap.currency, balance: main, holdings: snap.holdings, source, syncedAt: now }];
  for (const c of snap.cash.filter((x) => x.currency !== snap.currency)) {
    out.push({ id: `${source}-cash-${c.currency}`, name: `${snap.name} · ${c.currency} 现金`, kind: 'broker', currency: c.currency, balance: c.amount, source, syncedAt: now });
  }
  return [...keep, ...out];
}
