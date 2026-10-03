// 资产：估值 / 换汇 / 快照 / 到期 / 刷新（假 fetch）/ 券商解析 / MCP 白名单
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, valueAccounts, upsertSnapshot, maturing, normalizeAccount, futuToYahoo, AssetsStore, emptyAssets, type AssetsFile } from '../server/assets.ts';
import { parseFlexStatement, parseMcpJson, moomooToSnapshot, mergeBroker, fetchIbkr } from '../server/asset-connectors.ts';
import { parseMcpServers, mcpToolDefinitions, connectMcpServers } from '../server/mcp.ts';

const FX = { date: '2026-10-02', at: Date.now(), perEur: { EUR: 1, USD: 1.1, SGD: 1.4, CNY: 7.7, HKD: 8.8 } };

test('convert：同币种原样；交叉汇率；缺汇率 null', () => {
  assert.equal(convert(100, 'SGD', 'SGD', null), 100);
  assert.ok(Math.abs((convert(110, 'USD', 'SGD', FX) as number) - 140) < 1e-9);
  assert.ok(Math.abs((convert(77, 'CNY', 'EUR', FX) as number) - 10) < 1e-9);
  assert.equal(convert(1, 'JPY', 'SGD', FX), null);
  assert.equal(convert(1, 'USD', 'SGD', null), null);
});

test('valueAccounts：多币种现金 + 持仓（行情 / 手动价），按主币种汇总；缺价格时标出且不计入总额', () => {
  const f: AssetsFile = { ...emptyAssets(), baseCurrency: 'SGD', fx: FX, quotes: { AAPL: { price: 200, currency: 'USD', at: Date.now() } }, accounts: [
    { id: 'a', name: '银行', kind: 'bank', currency: 'SGD', balance: 1000 },
    { id: 'b', name: '招行', kind: 'bank', currency: 'CNY', balance: 770 },
    { id: 'c', name: '券商', kind: 'broker', currency: 'USD', balance: 110, holdings: [{ symbol: 'AAPL', qty: 1.1 }, { symbol: 'X', qty: 10, price: 11, currency: 'USD' }] },
  ] };
  const v = valueAccounts(f);
  assert.equal(v.complete, true);
  // 1000 + 770/7.7*1.4=140 + (110 + 220 + 110)/1.1*1.4 = 560 → 1700
  assert.ok(Math.abs(v.total - 1700) < 1e-6, String(v.total));
  assert.ok(Math.abs((v.byKind.broker ?? 0) - 560) < 1e-6);
  assert.equal(v.accounts[2].value, 440);
  assert.equal(v.byCurrency.USD, 440);
  f.accounts[2].holdings!.push({ symbol: 'NOPE', qty: 1 });
  const v2 = valueAccounts(f);
  assert.equal(v2.complete, false);
  assert.match(v2.missing[0], /券商：价格 NOPE/);
  assert.ok(Math.abs(v2.total - 1140) < 1e-6, '缺价的账户整个不计入');
});

test('upsertSnapshot：同月覆盖、不完整不记、按月排序', () => {
  const v = { base: 'SGD', total: 1234.567, complete: true, byKind: { bank: 1234.567 }, byCurrency: {}, accounts: [{} as never], missing: [], fxDate: null };
  let s = upsertSnapshot([], v, new Date(2026, 9, 2));
  s = upsertSnapshot(s, { ...v, total: 2000 }, new Date(2026, 9, 20));
  s = upsertSnapshot(s, v, new Date(2026, 8, 30));
  assert.deepEqual(s.map((x) => [x.month, x.total]), [['2026-09', 1234.57], ['2026-10', 2000]]);
  assert.equal(upsertSnapshot(s, { ...v, complete: false }, new Date(2026, 10, 1)), s);
});

test('maturing / normalizeAccount / futuToYahoo', () => {
  const now = new Date(2026, 9, 2);
  const m = maturing([{ id: 'a', name: '定期', kind: 'deposit', currency: 'SGD', balance: 1, maturity: '2026-10-20' }, { id: 'b', name: '远', kind: 'deposit', currency: 'SGD', balance: 1, maturity: '2027-01-01' }], now);
  assert.deepEqual(m, [{ id: 'a', name: '定期', maturity: '2026-10-20', inDays: 18 }]);
  assert.equal(normalizeAccount({ name: '' }), null);
  const a = normalizeAccount({ name: ' X ', kind: 'nope', currency: 'usd', balance: '12.5', holdings: [{ symbol: 'aapl', qty: '2' }, { symbol: 'bad sym' }], maturity: 'tomorrow' });
  assert.deepEqual({ ...a, id: '' }, { id: '', name: 'X', kind: 'other', currency: 'USD', balance: 12.5, holdings: [{ symbol: 'AAPL', qty: 2 }] });
  assert.equal(futuToYahoo('US.AAPL'), 'AAPL');
  assert.equal(futuToYahoo('HK.00700'), '0700.HK');
  assert.equal(futuToYahoo('SG.D05'), 'D05.SI');
  assert.equal(futuToYahoo('SH.600519'), '600519.SS');
});

test('AssetsStore.refresh：取汇率与缺失行情；出错只记录不抛；手动价不联网；令牌不出现在前端视图', async () => {
  const urls: string[] = [];
  const fake = async (url: string) => {
    urls.push(url);
    if (url.includes('frankfurter')) return { ok: true, status: 200, json: async () => ({ date: '2026-10-02', rates: { USD: 1.1, SGD: 1.4 } }), text: async () => '' };
    if (url.includes('/AAPL')) return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 200, currency: 'USD' } }] } }), text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const s = new AssetsStore(mkdtempSync(path.join(tmpdir(), 'paa-assets-')), fake);
  await s.init();
  s.data.accounts = [{ id: 'c', name: '券商', kind: 'broker', currency: 'USD', balance: 0, holdings: [{ symbol: 'AAPL', qty: 1 }, { symbol: 'ZZZZ', qty: 1 }, { symbol: 'M', qty: 1, price: 5 }] }];
  s.data.connectors = { ibkr: { token: '123456789', queryId: '1234' } };
  const errs = await s.refresh(new Date(), true);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /ZZZZ/);
  assert.ok(!urls.some((u) => u.includes('/M?')), '手动价不取行情');
  assert.equal(s.data.quotes.AAPL.price, 200);
  assert.equal(s.data.fx?.perEur.EUR, 1);
  assert.ok(!JSON.stringify(s.connectorView()).includes('123456789'));
  const s2 = new AssetsStore(path.dirname((s as unknown as { file: string }).file));
  await s2.init();
  assert.equal(s2.data.accounts[0].holdings?.length, 3, '落盘后读回');
});

const FLEX = `<FlexQueryResponse queryName="pos" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1234567" fromDate="20261001" toDate="20261001">
<AccountInformation accountId="U1234567" currency="USD" />
<OpenPositions><OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="AAPL" description="APPLE INC" position="10" markPrice="231.5" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="HKD" assetCategory="STK" symbol="700" description="TENCENT &amp; CO" position="100" markPrice="421.2" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="USD" symbol="AAPL" position="10" markPrice="231.5" levelOfDetail="LOT" /></OpenPositions>
<CashReport><CashReportCurrency currency="BASE_SUMMARY" endingCash="999" /><CashReportCurrency currency="USD" endingCash="1500.5" /><CashReportCurrency currency="SGD" endingCash="300" /><CashReportCurrency currency="HKD" endingCash="0" /></CashReport>
</FlexStatement></FlexStatements></FlexQueryResponse>`;

test('IBKR Flex：解析持仓（跳过 LOT 明细）与多币种现金；合并成账户；拉取流程含"生成中"重试', async () => {
  const snap = parseFlexStatement(FLEX);
  assert.equal(snap.name, 'IBKR U1234567');
  assert.deepEqual(snap.holdings.map((h) => [h.symbol, h.qty, h.price, h.currency]), [['AAPL', 10, 231.5, 'USD'], ['700', 100, 421.2, 'HKD']]);
  assert.equal(snap.holdings[1].name, 'TENCENT & CO');
  assert.deepEqual(snap.cash, [{ currency: 'USD', amount: 1500.5 }, { currency: 'SGD', amount: 300 }]);
  const merged = mergeBroker([{ id: 'x', name: '手动', kind: 'bank', currency: 'SGD', balance: 1 }, { id: 'old', name: '旧', kind: 'broker', currency: 'USD', balance: 0, source: 'ibkr' }], 'ibkr', snap, 1);
  assert.deepEqual(merged.map((a) => [a.id, a.currency, a.balance]), [['x', 'SGD', 1], ['ibkr-main', 'USD', 1500.5], ['ibkr-cash-SGD', 'SGD', 300]]);
  assert.throws(() => parseFlexStatement('<html>'), /不是 Flex/);
  let n = 0;
  const f = async (url: string) => ({ ok: true, status: 200, text: async () => {
    if (url.includes('SendRequest')) return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>42</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>';
    n++;
    return n < 2 ? '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>' : FLEX;
  } });
  const got = await fetchIbkr(f, '1234567890', '987654', async () => {});
  assert.equal(got.holdings.length, 2);
  await assert.rejects(fetchIbkr(f, 'abc', '1', async () => {}), /格式不对/);
});

test('moomoo：MCP 返回解析（整体 / 逐行 / {result}）+ 转成账户', () => {
  assert.deepEqual(parseMcpJson('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseMcpJson('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseMcpJson('{"result":[1,2]}'), [1, 2]);
  const snap = moomooToSnapshot({ cash: 520.5, currency: 'USD', total_assets: 9999 }, [
    { code: 'US.AAPL', stock_name: 'Apple', qty: 12, nominal_price: 231.5 },
    { code: 'HK.00700', stock_name: '腾讯控股', qty: 100, market_val: 42120 },
    { code: 'US.ZERO', qty: 0 },
  ]);
  assert.deepEqual(snap.holdings.map((h) => [h.symbol, h.qty, h.price, h.currency]), [['AAPL', 12, 231.5, 'USD'], ['0700.HK', 100, 421.2, 'HKD']]);
  assert.deepEqual(snap.cash, [{ currency: 'USD', amount: 520.5 }]);
});

test('MCP 白名单：只注册列出的工具；readOnly 时按 risk 1', async () => {
  const cfg = parseMcpServers([{ name: 'cal', command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'demo-calendar.mjs')], tools: ['list-events', 'delete-event', 7], readOnly: true }]);
  assert.deepEqual(cfg[0].tools, ['list-events', 'delete-event']);
  const { clients } = await connectMcpServers(cfg);
  try {
    const defs = mcpToolDefinitions(clients[0], undefined, cfg[0]);
    assert.deepEqual(defs.map((d) => [d.name, d.risk]), [['mcp_cal_list-events', 1], ['mcp_cal_delete-event', 1]]);
    const noRo = mcpToolDefinitions(clients[0], undefined, { tools: ['delete-event'] });
    assert.deepEqual(noRo.map((d) => [d.name, d.risk]), [['mcp_cal_delete-event', 4]], '不是 readOnly 就按 annotations');
    assert.equal(parseMcpServers([{ name: 'x', command: 'y', readOnly: true }])[0].readOnly, undefined, '没有白名单时 readOnly 不生效');
  } finally {
    for (const c of clients) c.close();
  }
});
