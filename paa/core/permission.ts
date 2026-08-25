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
  /** 禁止名单（G5 三级权限第三维：FORBID）。命中直接 deny，任何 Autonomy 级别都不可放行 */
  private forbidden = new Set<string>();

  constructor(level: AutonomyLevel = 2) {
    this.globalLevel = level;
  }

  setLevel(level: AutonomyLevel): void {
    this.globalLevel = level;
  }

  get level(): AutonomyLevel {
    return this.globalLevel;
  }

  /** 禁止某个工具（按全名）。幂等。来源：用户 config.forbiddenTools / pkg manifest.permissions.forbid */
  forbid(name: string): void {
    this.forbidden.add(name);
  }

  /** 解除禁止。幂等 */
  unforbid(name: string): void {
    this.forbidden.delete(name);
  }

  get forbiddenTools(): string[] {
    return [...this.forbidden];
  }

  isForbidden(name: string): boolean {
    return this.forbidden.has(name);
  }

  /**
   * 权限判定。优先级：FORBID → ask(risk 4 危险操作永远确认) → Autonomy 分级。
   * 返回 ask 时由宿主（CLI）交互确认；deny = 硬拒绝（工具被 FORBID），宿主不可绕过。
   */
  check(tool: ToolDefinition, levelOverride?: AutonomyLevel): Decision {
    if (this.forbidden.has(tool.name)) return 'deny';
    const level = levelOverride ?? this.globalLevel;
    const need = RISK_NEED_LEVEL[tool.risk];
    if (need >= 99) return 'ask'; // 危险操作永远 ask，宿主侧不可降级
    return level >= need ? 'allow' : 'ask';
  }
}
