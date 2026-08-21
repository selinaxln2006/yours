# rruleDays 编码不一致

## 诊断来源
- 2026-08-21 G3 第一次闭环（deepseek-chat + fs__read 整读）
- 2026-08-21 G3 第二次闭环（deepseek-chat + fs__grep + 切片读）

## 问题
- skill `add_schedule` 的 schema（index.html ~1201行）声明 rruleDays 为 1=周一…7=周日
- handler（~1202行）直接 `.map(Number)` 存入，不归一化
- `expandRecurring`（~981行）用 `getDay()` 返回 0-6（0=周日）
- agent 通过 skill 创建的"每周日"事件（rruleDays=[7]）在 expandRecurring 中永不匹配 getDay()=0 → 永不展开

## 传播链（第二次 G3 新发现）
- index.html ~1377行系统提示词也用"1=周一…7=周日"引导 agent
- 完整链：提示词 → schema → handler 落库 → expandRecurring 不匹配

## 修复方案（第二次 G3 收敛）
- 一处收敛：handler 落库处做 7→0 归一化 + 同步 schema/提示词文案
- 存量数据不动

## 被推翻的诊断
- 第一次 G3 说"weekly 逐日遍历是性能 bug" → 第二次推翻：weekly 支持多日选择（周一+周三），逐日遍历是必要设计，不是 bug
