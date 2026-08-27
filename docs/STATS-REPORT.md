# PAA 仓库统计报告

> 生成日期：2026-08-27 ｜ 脚本：`paa/scripts/stats.cjs`（v2）｜ 口径：见 t1 结论
> 主范围 `paa/`（核心代码+测试+工具包+记忆/数据），扩展参考 `docs/`（文档规模，不混入代码统计）。

## 一、核心数字

| 范围 | 文件数 | 总行数 | 净代码行数 | 测试用例数 | TODO | FIXME |
|------|-------:|-------:|-----------:|-----------:|-----:|------:|
| **paa/（主）** | 78 | 8074 | 6511 | 52 | 0 | 0 |
| docs/（参考） | 11 | 2379 | 135 | 0 | 0 | 0 |

**净代码行数** = 去空行/整行注释后，仅统计代码文件（.ts/.js/.json/.mjs/.cjs/.html/.css）。

## 二、paa/ 文件类型分布

| 类型 | 文件数 | 行数 |
|------|-------:|-----:|
| .ts | 30 | 5891 |
| .js | 8 | 959 |
| .json | 26 | 463 |
| .mjs | 3 | 333 |
| .md | 8 | 329 |
| .cjs | 3 | 99 |

TypeScript 占绝对主体（5891/8074 ≈ 73%），核心逻辑全部 TS 化。

## 三、paa/ 行数 Top 文件

| 行数 | 文件 |
|-----:|------|
| 604 | server/main.ts |
| 439 | cli/main.ts |
| 322 | core/planner.ts |
| 318 | core/memory-provider.ts |
| 299 | core/chat-session-store.ts |
| 287 | core/pkg-loader.ts |
| 272 | src/cli.js |
| 258 | pkgs/life/impl.mjs |
| 257 | core/life-store.ts |
| 257 | core/llm-adapter.ts |
| 246 | src/tools/fs-tools.js |
| 239 | core/agent-loop.ts |
| 237 | tools/core-tools.ts |
| 231 | core/mcp-client.ts |
| 214 | test/memory.ts |

## 四、docs/ 文档规模

| 文件 | 行数 |
|------|-----:|
| architecture/paa-design-v2.md | 391 |
| architecture/shu-project-proposal.md | 321 |
| DEVLOG.md | 320 |
| ROADMAP.md | 290 |
| architecture/paa-host-evolution-v1.md | 229 |
| architecture/c4-memory-and-autonomy-design.md | 213 |
| architecture/memory-landscape-research.md | 163 |
| architecture/paa-dev-process.md | 161 |
| architecture/paa-architecture-overview.html | 150 |
| architecture/console-v1.md | 79 |
| TAURI_ROADMAP.md | 62 |

## 五、结论

1. **代码规模健康**：paa/ 净代码约 6500 行，核心四件套 + 记忆/产物系统已具完整骨架，无超大单体文件（最大 server/main.ts 604 行），模块拆分合理。
2. **测试覆盖有基础**：52 个 test/it 用例，覆盖 agent-loop、memory、life-store、pkg、mcp、artifact 等核心模块（见 `paa/test/`）。
3. **代码卫生良好**：TODO/FIXME 均为 0，无遗留待办标记。
4. **类型化程度高**：73% 代码为 TypeScript，文档配套完整（docs/ 2300+ 行规划文档），契合架构优先的开发路线。

## 六、验证

关键数字与 t3 抽查交叉比对，误差 0：
- 测试用例数：grep 实测 52 = 脚本 `tests.count=52`
- `core/planner.ts` 行数：fs_read 实测 322 = 脚本 top 文件 322
- core/tools/src 子目录文件结构与脚本输出一致

原始输出存档：`artifacts/repo-stats.txt`（paa/ 口径）、`artifacts/repo-stats.json`。
