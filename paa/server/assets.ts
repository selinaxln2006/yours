// ============================================================
// 资产（PRD v0.4）：多账户、多币种、持仓自动估值、月度快照
// - 账户手动建：银行 / 定期 / 券商 / 电子钱包 / 现金 / 其他；每个账户一个币种
// - 券商账户可填持仓（代码 + 数量），每天取一次收盘价；汇率用欧央行公开汇率（frankfurter）
// - 联网只发币种和股票代码，不发金额
// - 数据在 data/assets.json（不入库）；券商令牌只存本机、不回传前端
// 纯函数做估值（可测），AssetsStore 负责持久化与刷新
// ============================================================

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export type AccountKind = 'bank' | 'deposit' | 'broker' | 'wallet' | 'cash' | 'other';
export const ACCOUNT_KINDS: AccountKind[] = ['bank', 'deposit', 'broker', 'wallet', 'cash', 'other'];

export interface Holding {
  symbol: string; // Yahoo 风格：AAPL / 0700.HK / D05.SI / 600519.SS
  qty: number;
  name?: string;
  currency?: string; // 不填则用行情返回的币种
  /** 手动价格（或券商同步来的现价）；有它就不去联网取 */
  price?: number;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  /** 现金部分（券商账户 = 现金余额；其他账户 = 余额） */
  balance: number;
  holdings?: Holding[];
  /** 定期：年化利率（%）和到期日 */
  rate?: number;
  maturity?: string;
  note?: string;
  source?: 'manual' | 'ibkr' | 'moomoo';
  syncedAt?: number;
}

export interface Snapshot {
  month: string; // YYYY-MM
  date: string; // YYYY-MM-DD（当月最后一次估值）
  base: string;
  total: number;
  byKind: Partial<Record<AccountKind, number>>;
}

export interface Quote { price: number; currency: string; at: number }
export interface FxTable { date: string; at: number; perEur: Record<string, number> }

export interface Connectors {
  ibkr?: { token: string; queryId: string };
  moomoo?: { server: string; trdEnv: 'REAL' | 'SIMULATE'; accId?: string };
}

export interface AssetsFile {
  baseCurrency: string;
  accounts: Account[];
  snapshots: Snapshot[];
  quotes: Record<string, Quote>;
  fx: FxTable | null;
  connectors: Connectors;
}

export const emptyAssets = (): AssetsFile => ({ baseCurrency: 'SGD', accounts: [], snapshots: [], quotes: {}, fx: null, connectors: {} });

const CUR_RE = /^[A-Z]{3}$/;
const SYM_RE = /^[A-Za-z0-9.^=\-]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const cur = (v: unknown, d = 'SGD'): string => (typeof v === 'string' && CUR_RE.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : d);

export function normalizeHolding(raw: unknown): Holding | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
  if (!SYM_RE.test(symbol)) return null;
  const h: Holding = { symbol, qty: num(r.qty) };
  if (typeof r.name === 'string' && r.name.trim()) h.name = r.name.trim().slice(0, 60);
  if (typeof r.currency === 'string' && CUR_RE.test(r.currency.trim().toUpperCase())) h.currency = r.currency.trim().toUpperCase();
  if (r.price !== undefined && r.price !== null && r.price !== '' && num(r.price, NaN) >= 0) h.price = num(r.price);
  return h;
}

export function normalizeAccount(raw: unknown, i = 0): Account | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
  if (!name) return null;
  const kind = ACCOUNT_KINDS.find((k) => k === r.kind) ?? 'other';
  const a: Account = {
    id: typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : `a${Date.now().toString(36)}${i}`,
    name,
    kind,
    currency: cur(r.currency),
    balance: num(r.balance),
  };
  if (Array.isArray(r.holdings)) {
    const hs = r.holdings.map(normalizeHolding).filter((h): h is Holding => !!h).slice(0, 200);
    if (hs.length) a.holdings = hs;
  }
  if (r.rate !== undefined && r.rate !== '' && Number.isFinite(num(r.rate, NaN))) a.rate = num(r.rate);
  if (typeof r.maturity === 'string' && DATE_RE.test(r.maturity)) a.maturity = r.maturity;
  if (typeof r.note === 'string' && r.note.trim()) a.note = r.note.trim().slice(0, 200);
  if (r.source === 'ibkr' || r.source === 'moomoo') a.source = r.source;
  if (typeof r.syncedAt === 'number') a.syncedAt = r.syncedAt;
  return a;
}

/** 金额换算（汇率表以 EUR 为基准）；缺汇率返回 null */
export function convert(amount: number, from: string, to: string, fx: FxTable | null): number | null {
  if (from === to) return amount;
  if (!fx) return null;
  const rate = (c: string): number | undefined => (c === 'EUR' ? 1 : fx.perEur[c]);
  const a = rate(from), b = rate(to);
  if (!a || !b) return null;
  return (amount / a) * b;
}

export interface HoldingValue extends Holding { price?: number; value?: number; valueBase?: number; stale?: boolean; missing?: boolean }
export interface AccountValue { id: string; name: string; kind: AccountKind; currency: string; cash: number; value: number | null; valueBase: number | null; holdings: HoldingValue[]; missing: string[] }
export interface Valuation {
  base: string;
  total: number;
  complete: boolean;
  byKind: Partial<Record<AccountKind, number>>;
  byCurrency: Record<string, number>;
  accounts: AccountValue[];
  missing: string[];
  fxDate: string | null;
}

const STALE_MS = 4 * 86_400_000;

export function valueAccounts(f: AssetsFile, now = Date.now()): Valuation {
  const base = f.baseCurrency;
  const out: Valuation = { base, total: 0, complete: true, byKind: {}, byCurrency: {}, accounts: [], missing: [], fxDate: f.fx?.date ?? null };
  for (const a of f.accounts) {
    const av: AccountValue = { id: a.id, name: a.name, kind: a.kind, currency: a.currency, cash: a.balance, value: a.balance, valueBase: null, holdings: [], missing: [] };
    let baseSum: number | null = convert(a.balance, a.currency, base, f.fx);
    if (baseSum === null) av.missing.push(`汇率 ${a.currency}`);
    out.byCurrency[a.currency] = (out.byCurrency[a.currency] ?? 0) + a.balance;
    for (const h of a.holdings ?? []) {
      const q = f.quotes[h.symbol];
      const price = h.price ?? q?.price;
      const hc = h.currency ?? q?.currency ?? a.currency;
      const hv: HoldingValue = { ...h, currency: hc };
      if (price === undefined) {
        hv.missing = true;
        av.missing.push(`价格 ${h.symbol}`);
      } else {
        hv.price = price;
        hv.value = price * h.qty;
        hv.stale = h.price === undefined && !!q && now - q.at > STALE_MS;
        out.byCurrency[hc] = (out.byCurrency[hc] ?? 0) + hv.value;
        const inAcc = convert(hv.value, hc, a.currency, f.fx);
        if (av.value !== null) av.value = inAcc === null ? null : av.value + inAcc;
        const inBase = convert(hv.value, hc, base, f.fx);
        hv.valueBase = inBase ?? undefined;
        if (inBase === null) av.missing.push(`汇率 ${hc}`);
        else if (baseSum !== null) baseSum += inBase;
      }
      av.holdings.push(hv);
    }
    av.valueBase = av.missing.length ? null : baseSum;
    if (av.valueBase !== null) {
      out.total += av.valueBase;
      out.byKind[a.kind] = (out.byKind[a.kind] ?? 0) + av.valueBase;
    } else {
      out.complete = false;
      out.missing.push(...av.missing.map((m) => `${a.name}：${m}`));
    }
    out.accounts.push(av);
  }
  return out;
}

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 本月快照：同月覆盖为最新一次估值；只在估值完整时记；最多留 60 个月 */
export function upsertSnapshot(list: Snapshot[], v: Valuation, now: Date): Snapshot[] {
  if (!v.complete || !v.accounts.length) return list;
  const month = ymd(now).slice(0, 7);
  const s: Snapshot = { month, date: ymd(now), base: v.base, total: Math.round(v.total * 100) / 100, byKind: Object.fromEntries(Object.entries(v.byKind).map(([k, x]) => [k, Math.round((x ?? 0) * 100) / 100])) };
  return [...list.filter((x) => x.month !== month), s].sort((a, b) => a.month.localeCompare(b.month)).slice(-60);
}

/** N 天内到期的定期 */
export function maturing(accounts: Account[], now: Date, days = 30): Array<{ id: string; name: string; maturity: string; inDays: number }> {
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return accounts
    .filter((a) => a.maturity)
    .map((a) => ({ id: a.id, name: a.name, maturity: a.maturity as string, inDays: Math.round((new Date(a.maturity + 'T00:00:00').getTime() - t0) / 86_400_000) }))
    .filter((x) => x.inDays >= 0 && x.inDays <= days)
    .sort((a, b) => a.inDays - b.inDays);
}

// ---- 联网：汇率与行情 ----

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function fetchFx(f: FetchLike, now: Date): Promise<FxTable> {
  const r = await f('https://api.frankfurter.dev/v1/latest?base=EUR', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`汇率 HTTP ${r.status}`);
  const j = (await r.json()) as { date?: string; rates?: Record<string, number> };
  if (!j.rates || typeof j.rates !== 'object') throw new Error('汇率数据格式不对');
  return { date: typeof j.date === 'string' ? j.date : ymd(now), at: now.getTime(), perEur: { ...j.rates, EUR: 1 } };
}

export async function fetchQuote(f: FetchLike, symbol: string, now: Date): Promise<Quote> {
  if (!SYM_RE.test(symbol)) throw new Error('代码不合法');
  const r = await f(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Yours personal agent)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`行情 ${symbol} HTTP ${r.status}`);
  const j = (await r.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; currency?: string } }> } };
  const m = j.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') throw new Error(`没找到 ${symbol} 的行情`);
  return { price: m.regularMarketPrice, currency: cur(m.currency, 'USD'), at: now.getTime() };
}

/** moomoo / 富途代码 → Yahoo 代码（US.AAPL → AAPL；HK.00700 → 0700.HK；SG.D05 → D05.SI；SH/SZ → .SS/.SZ） */
export function futuToYahoo(code: string): string {
  const [mkt, sym = ''] = String(code).toUpperCase().split('.', 2);
  if (!sym) return mkt;
  if (mkt === 'US') return sym;
  if (mkt === 'HK') return `${sym.replace(/^0+(?=\d{4})/, '')}.HK`;
  if (mkt === 'SG') return `${sym}.SI`;
  if (mkt === 'SH') return `${sym}.SS`;
  if (mkt === 'SZ') return `${sym}.SZ`;
  if (mkt === 'JP') return `${sym}.T`;
  return sym;
}
export const MARKET_CCY: Record<string, string> = { US: 'USD', HK: 'HKD', SG: 'SGD', SH: 'CNY', SZ: 'CNY', JP: 'JPY' };

// ---- 持久化 ----

export class AssetsStore {
  data: AssetsFile = emptyAssets();
  private file: string;
  private fetchImpl: FetchLike;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, fetchImpl?: FetchLike) {
    this.file = path.join(dataDir, 'assets.json');
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AssetsFile>;
      this.data = {
        ...emptyAssets(),
        ...raw,
        baseCurrency: cur(raw.baseCurrency),
        accounts: Array.isArray(raw.accounts) ? raw.accounts.map(normalizeAccount).filter((a): a is Account => !!a) : [],
        snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
        quotes: raw.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
        connectors: raw.connectors && typeof raw.connectors === 'object' ? raw.connectors : {},
      };
    } catch {
      this.data = emptyAssets();
    }
  }

  save(): Promise<void> {
    const next = this.chain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(tmp, this.file);
    });
    this.chain = next;
    return next;
  }

  /** 估值 + 顺手记本月快照 */
  async valuation(now = new Date()): Promise<Valuation> {
    const v = valueAccounts(this.data, now.getTime());
    const snaps = upsertSnapshot(this.data.snapshots, v, now);
    if (snaps !== this.data.snapshots) {
      this.data.snapshots = snaps;
      await this.save();
    }
    return v;
  }

  /** 刷新汇率（每天一次）和行情（超过 12 小时的）；返回出错信息，不抛 */
  async refresh(now = new Date(), force = false): Promise<string[]> {
    const errors: string[] = [];
    // ECB 周末不更新，所以按"日期变了且距上次超过 6 小时"判断，避免周末每次都请求
    if (force || !this.data.fx || (this.data.fx.date !== ymd(now) && now.getTime() - this.data.fx.at > 6 * 3600_000)) {
      try { this.data.fx = await fetchFx(this.fetchImpl, now); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    const syms = [...new Set(this.data.accounts.flatMap((a) => (a.holdings ?? []).filter((h) => h.price === undefined).map((h) => h.symbol)))];
    const due = syms.filter((s) => force || !this.data.quotes[s] || now.getTime() - this.data.quotes[s].at > 12 * 3600_000);
    for (let i = 0; i < due.length; i += 4) {
      await Promise.all(due.slice(i, i + 4).map(async (s) => {
        try { this.data.quotes[s] = await fetchQuote(this.fetchImpl, s, now); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
      }));
    }
    await this.save();
    return errors;
  }

  /** 前端看的连接器状态：令牌不出去 */
  connectorView(): { ibkr: { configured: boolean; queryId?: string }; moomoo: { configured: boolean; server?: string; trdEnv?: string } } {
    const c = this.data.connectors;
    return {
      ibkr: c.ibkr ? { configured: true, queryId: c.ibkr.queryId } : { configured: false },
      moomoo: c.moomoo ? { configured: true, server: c.moomoo.server, trdEnv: c.moomoo.trdEnv } : { configured: false },
    };
  }
}
