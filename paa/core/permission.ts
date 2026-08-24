// ============================================================
// 权限模型（P0 初版）
// 参考：Operit 三级权限思想 + DSH guard 思想；权限表格式为 v2 自研
// 红线：risk 4（危险执行）永远确认，不可被 Autonomy 降级
// ============================================================

import type { ToolDefinition } from './types.ts';

export type Decision = 'allow' | 'ask' | 'deny';

/** Autonomy 分级（L0-L4，对齐记忆中的分级设计） */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

/**
 * L0 全问 / L1 读放行 / L2 普通放行 / L3 写放行 / L4 全放行（除危险）
 * risk 分级：1 读 / 2 普通 / 3 写 / 4 危险
 */
const RISK_NEED_LEVEL: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 99, // 危险：永不自动放行
};

export class Permission {
  private globalLevel: AutonomyLevel;

  constructor(level: AutonomyLevel = 2) {
    this.globalLevel = level;
  }

  setLevel(level: AutonomyLevel): void {
    this.globalLevel = level;
  }

  get level(): AutonomyLevel {
    return this.globalLevel;
  }

  /**
   * 权限判定。返回 ask 时由宿主（CLI）交互确认；
   * deny 仅出现在工具自身拒绝（如 shell 黑名单命中，见 tools/）。
   */
  check(tool: ToolDefinition, levelOverride?: AutonomyLevel): Decision {
    const level = levelOverride ?? this.globalLevel;
    const need = RISK_NEED_LEVEL[tool.risk];
    if (need >= 99) return 'ask'; // 危险操作永远 ask，宿主侧不可降级
    return level >= need ? 'allow' : 'ask';
  }
}
