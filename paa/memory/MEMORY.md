# PAA Memory Index

<!-- 索引层：≤200行/25KB，只存不可推导信息（决策背景/方法论/已知约定） -->

## 架构约定

- [index.html G4 实战](details/index-freeze.md) -- v18 基线已解冻，G4 自修改闭环靶子（方案二止血：getDay() 归一到 1-7）
- [PAA Core 宿主分离](details/paa-architecture.md) -- 大脑层在 paa/ 包，CLI 宿主通过 fs.read 从外部读 index.html 分析
- [Autonomy 分级](details/autonomy-design.md) -- 全局 Level 0-4 + 每工具 override，有效级=min(全局,工具cap)

## 已知 Bug（index.html，冻结不动）

- [rruleDays 编码不一致](details/rrule-bug.md) -- skill schema 用 1-7（1=周一…7=周日），expandRecurring 用 getDay() 0-6，周日事件永不展开
- [系统提示词同源问题](details/rrule-bug.md) -- index.html 1377行提示词也用 1-7 引导 agent，完整传播链：提示词→schema→handler→展开
- [skill enum 死代码](details/skill-enum-deadcode.md) -- schema rrule 只有 none/daily/weekly，handler 有 biweekly/monthly 分支（LLM 传不出来）
- [category 不一致](details/category-mismatch.md) -- skill 用 life/study/work/health/finance，UI 用 quant/study/fitness/work/life/other
