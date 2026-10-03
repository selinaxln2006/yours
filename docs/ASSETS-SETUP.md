# 资产：怎么用、怎么接券商

控制台 → 侧栏「资产」（也可以用顶栏 + 把它加成 tab）。

## 1. 手动账户（不需要任何配置）

- **＋ 账户**：银行、定期、券商、电子钱包、现金、其他；每个账户选一个币种
- **定期**：可以填年化利率和到期日。30 天内到期的，会在资产页最上面提醒
- **券商账户**：点「＋ 持仓」，填代码和数量。代码写法：

| 市场 | 写法 |
|---|---|
| 美股 | `AAPL` |
| 港股 | `0700.HK` |
| 新加坡 | `D05.SI` |
| A 股 | `600519.SS`（上海）/ `000001.SZ`（深圳） |

价格留空就每天自动取一次收盘价；填了就一直用你填的价格。

- **显示币种**：右上角选择。所有账户按当天汇率折算成这个币种
- **走势**：每月自动记一次总额（取当月最后一次估值）
- **联网**：汇率用欧央行公开汇率（[frankfurter](https://frankfurter.dev)），股价用公开行情接口。只发送币种和股票代码，不发送金额
- **Yours 能看到你的资产，但改不了**：对话里的 `assets_summary` 工具是只读的。你可以问它「我现在总共有多少钱」「储蓄目标还差多少」
- **数据位置**：`paa/data/assets.json`，不进仓库

## 2. IBKR（盈透）只读接入

IBKR 提供 **Flex Web Service**，是一个只读的报表接口：用一串 token 加一个查询号就能拉持仓和现金，不能下单，也不需要 OAuth。

1. 登录 IBKR 网页后台（Client Portal）→ **Performance & Reports → Flex Queries**
2. 新建一个 **Activity Flex Query**：
   - Sections 勾选 **Open Positions**（Options 选 Summary）和 **Cash Report**
   - Format 选 **XML**，Period 选 **Last Business Day**
   - 保存后记下 **Query ID**（一串数字）
3. 同一页面右上角 **Flex Web Service Configuration** → 启用 → 生成 **Token**（一串数字，可设有效期）
4. Yours 资产页 → **连接券商** → 填 token 和查询号 → 保存 → **同步券商**

同步后会出现一个「IBKR U1234567」账户，价格用报表里的收盘价。其他币种的现金会各单列一个账户。

- token 只存在本机 `paa/data/assets.json`，不会发给前端
- 我没有 IBKR 账户，这部分只用样例报表测过。**第一次同步如果报错，把错误信息发给我**

## 3. moomoo / 富途（经 OpenD）只读接入

用开源的 [moomoo-api-mcp](https://github.com/Litash/moomoo-api-mcp)（Apache-2.0）。它通过你本机的 **moomoo OpenD** 读取账户。

> ⚠️ 这个 MCP server 本身带下单工具（`place_order` 等）。下面的配置用 `tools` 白名单，**只把读取类工具注册给 Yours**，下单工具根本不会出现。请保留这份白名单。

1. 启动 moomoo OpenD 并登录（默认端口 11111）
2. 安装 [uv](https://docs.astral.sh/uv/)（用来运行这个 Python 写的 MCP server）
3. 在 `paa/config.json` 的 `mcpServers` 里加：

```json
{
  "name": "moomoo",
  "command": "uvx",
  "args": ["moomoo-api-mcp"],
  "env": {
    "MOOMOO_SECURITY_FIRM": "FUTUSG",
    "MOOMOO_TRADE_PASSWORD": "你的交易密码"
  },
  "tools": ["get_accounts", "get_assets", "get_positions", "get_account_summary", "get_stock_quote", "get_market_snapshot", "get_cash_flow", "check_health"],
  "readOnly": true
}
```

- `MOOMOO_SECURITY_FIRM`：新加坡账户填 `FUTUSG`，美国填 `FUTUINC`，香港填 `FUTUSECURITIES`
- **交易密码**：OpenD 读取真实账户需要先「解锁交易」，所以要填。密码只在你本机的 `config.json` 里（不进仓库）。要注意，解锁会作用于你的 OpenD 会话。如果介意，可以不填密码，只接模拟账户
- `tools` + `readOnly`：只暴露这几个读取工具，按只读（risk 1）处理

4. 重启 server。启动信息里出现 `MCP moomoo(8)` 就说明连上了
5. 资产页 → **连接券商** → moomoo server 名填 `moomoo`，账户选「真实账户」→ 保存 → **同步券商**

## 4. 支付宝 / 微信

支付宝和微信都**没有给个人用的只读 API**（它们的开放平台面向商户）。可行的路是**导入账单**（下一轮做）：

- 支付宝：我的 → 账单 → 开具交易流水证明 → 用于个人对账 → 发到邮箱（CSV）
- 微信：我 → 服务 → 钱包 → 账单 → 下载账单 → 用于个人对账（xlsx）

账单格式可以参考开源项目 [double-entry-generator](https://github.com/deb-sig/double-entry-generator)，它解析的正是这两种账单。余额宝、零钱这类余额，先在资产页手动建「电子钱包」账户。
