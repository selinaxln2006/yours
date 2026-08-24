// ============================================================
// ToolPipeline — 工具流转管道
// 参考：DSH waterfall 工具管道思想 + Operit AIToolHandler Hook 思想
// before(权限+审计) → execute(handler) → after(审计+格式化)
// ============================================================

import type {
  ExecContext,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types.ts';
import { Permission } from './permission.ts';

export class ToolPipeline {
  private registry = new Map<string, ToolDefinition>();
  private permission: Permission;

  constructor(permission: Permission) {
    this.permission = permission;
  }

  register(tool: ToolDefinition): void {
    if (this.registry.has(tool.name)) {
      throw new Error(`工具重复注册: ${tool.name}`);
    }
    this.registry.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.registry.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.registry.values()];
  }

  /** 执行一次工具调用：权限门 → 执行 → 审计 */
  async run(call: ToolCall, ctx: ExecContext): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return { ok: false, error: `未知工具: ${call.name}` };
    }

    // before：权限门
    const decision = this.permission.check(tool);
    if (decision === 'ask') {
      const ok = await ctx.ask(
        `允许执行 [${tool.name}]？\n  参数: ${JSON.stringify(call.arguments)}`,
        tool.name,
      );
      if (!ok) {
        ctx.audit(`[AUTO] ${tool.name} 被用户拒绝`);
        return { ok: false, error: '用户拒绝执行' };
      }
    }
    ctx.audit(`[AUTO] ${tool.name}(${JSON.stringify(call.arguments)})`);

    // execute
    try {
      const data = await tool.handler(call.arguments, ctx);
      return { ok: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.audit(`[AUTO] ${tool.name} 失败: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}
