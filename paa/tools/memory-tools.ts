// ============================================================
// 记忆工具集（P1 v1.1，C4 支柱）
// 命名纪律：工具名只允许 [a-zA-Z0-9_-]（LLM function calling 硬约束），
//           因此用下划线而非点号：memory_search 而非 memory.search
// 权限设计（内部动作大胆、结构动作谨慎）：
//   memory_search / list → risk 1 读，自动放行
//   memory_save          → risk 2 普通，L2+ 自动（记忆是内部动作，不打断）
//   memory_consolidate   → risk 3 写+结构变化，默认确认
//   memory_forget        → risk 4 永远确认，不可降级（设计红线）
// ============================================================

import type { ExecContext, MemoryProvider, ToolDefinition } from '../core/types.ts';

export function createMemoryTools(provider: MemoryProvider): ToolDefinition[] {
  return [
    {
      name: 'memory_search',
      desc: '检索记忆（分层：L3 画像常驻 → L2 场景块 → L1 事实；L0 原文永不返回）。返回相关记忆列表',
      params: {
        query: { type: 'string', desc: '检索关键词（会与标签+内容匹配）' },
        topN: { type: 'number', desc: '返回条数，默认 5', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const query = String(args.query ?? '');
        const topN = Number(args.topN ?? 5);
        const mems = await provider.search(query, topN);
        return { count: mems.length, memories: mems };
      },
    },
    {
      name: 'memory_list',
      desc: '列出记忆（可按类型/层级过滤；含已失效记录，limit 取最新 N 条）',
      params: {
        type: {
          type: 'string',
          desc: '过滤类型：fact/preference/episodic/skill-note/persona',
          required: false,
        },
        layer: { type: 'string', desc: '过滤层级：L0/L1/L2/L3', required: false },
        limit: { type: 'number', desc: '最多返回条数，默认 20', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const mems = await provider.list({
          type: args.type as never,
          layer: args.layer as never,
          limit: args.limit === undefined ? 20 : Number(args.limit),
        });
        return { count: mems.length, memories: mems };
      },
    },
    {
      name: 'memory_save',
      desc: '保存一条记忆。type: fact/preference/episodic/skill-note；layer 默认 L1（事实层）；同 tag+type 的旧记录自动失效。对话中的重要事实/偏好/决策应主动存',
      params: {
        type: { type: 'string', desc: '记忆类型：fact/preference/episodic/skill-note' },
        content: { type: 'string', desc: '记忆内容（一句话，可含上下文）' },
        tags: { type: 'array', desc: '标签数组，如 ["fitness","goal"]', required: false },
        layer: { type: 'string', desc: '层级 L0-L3，默认 L1。L0=原文快照（永不注入），L3=画像（谨慎，通常由 consolidate 生成）', required: false },
      },
      risk: 2,
      handler: async (args: Record<string, unknown>, ctx: ExecContext) => {
        const layer = (args.layer as string | undefined) ?? 'L1';
        if (!['L0', 'L1', 'L2', 'L3'].includes(layer)) {
          throw new Error(`非法层级: ${layer}（应为 L0/L1/L2/L3）`);
        }
        const type = String(args.type ?? 'fact');
        if (!['fact', 'preference', 'episodic', 'skill-note', 'persona'].includes(type)) {
          throw new Error(`非法类型: ${type}`);
        }
        const rec = await provider.save({
          layer: layer as never,
          type: type as never,
          content: String(args.content ?? ''),
          tags: Array.isArray(args.tags) ? (args.tags as string[]).map(String) : [],
          source: 'agent',
          sourceRef: { sessionId: ctx.sessionId },
        });
        ctx.audit(`[AUTO] memory.save -> ${rec.id} (${rec.layer}/${rec.type})`);
        return { saved: rec };
      },
    },
    {
      name: 'memory_consolidate',
      desc: '聚合精炼：把多条零散记忆聚合为一条 L2 场景块或更新 L3 画像。summary 由你（agent）总结，sourceIds 指定的源记忆会被标记失效。写操作需确认',
      params: {
        summary: { type: 'string', desc: '聚合后的精炼摘要（一句话覆盖要点）' },
        layer: { type: 'string', desc: '目标层级：L2（场景块）或 L3（画像）' },
        type: { type: 'string', desc: '类型，默认 episodic', required: false },
        tags: { type: 'array', desc: '聚合块的标签', required: false },
        sourceIds: { type: 'array', desc: '被聚合的源记忆 id 列表（将被标记失效）', required: false },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>, ctx: ExecContext) => {
        const layer = String(args.layer);
        if (layer !== 'L2' && layer !== 'L3') {
          throw new Error('consolidate 目标层级只能是 L2 或 L3');
        }
        const rec = await provider.consolidate(String(args.summary ?? ''), {
          layer: layer as 'L2' | 'L3',
          type: (args.type as never) ?? 'episodic',
          tags: Array.isArray(args.tags) ? (args.tags as string[]).map(String) : [],
          sourceIds: Array.isArray(args.sourceIds) ? (args.sourceIds as string[]).map(String) : [],
        });
        ctx.audit(`[AUTO] memory.consolidate -> ${rec.id} (${rec.layer}), 失效 ${(args.sourceIds as string[] | undefined)?.length ?? 0} 条源记忆`);
        return { consolidated: rec };
      },
    },
    {
      name: 'memory_forget',
      desc: '遗忘一条记忆（软删：标记失效，不再被检索到；不可撤销，永远需要确认）',
      params: {
        id: { type: 'string', desc: '记忆 id（用 memory_list 查）' },
      },
      risk: 4,
      handler: async (args: Record<string, unknown>, ctx: ExecContext) => {
        const ok = await provider.forget(String(args.id ?? ''));
        if (!ok) throw new Error(`未找到记忆: ${args.id}`);
        ctx.audit(`[AUTO] memory.forget -> ${String(args.id)}`);
        return { forgotten: String(args.id) };
      },
    },
  ];
}
