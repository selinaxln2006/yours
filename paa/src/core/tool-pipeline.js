/* tool-pipeline.js — 工具执行管道（autonomy gate → execute → audit）
   gate(skill, args) → auto | confirm | block
   - read/low → auto（任何 Level）
   - medium → L2+ auto / L1 confirm
   - high → L3+ auto / L1-L2 confirm
   - blocked → 永远 block（硬底线）
   auto 执行的写操作回调 onAudit（写审计行到 daily log）。
   钩子已留好——P3 挂外部 ToolPkg/MCP 时循环本体不用改。 */
export function createToolPipeline(skills, opts) {
  opts = opts || {};
  const autonomy = opts.autonomy || { level: 1, tools: {} };
  const onAudit = opts.onAudit || (() => {});

  function gate(tool, args) {
    /* 优先级：用户 override > 工具 risk 声明 > readOnly 推断 */
    const override = autonomy.tools && autonomy.tools[tool.id];
    const risk = override || tool.risk || (tool.readOnly ? 'read' : 'high');
    if (risk === 'blocked') return 'block';
    if (risk === 'read' || risk === 'low') return 'auto';
    const level = autonomy.level || 1;
    if (risk === 'medium') return level >= 2 ? 'auto' : 'confirm';
    if (risk === 'high') return level >= 3 ? 'auto' : 'confirm';
    return 'confirm';
  }

  return {
    gate,
    run(fn, args) {
      const tool = skills.allTools().find(x => x.id === fn);
      if (!tool) return { ok: false, pending: false, error: '工具「' + fn + '」未注册' };
      const decision = gate(tool, args);
      if (decision === 'block') return { ok: false, pending: false, error: '操作被自主级拦截（blocked 风险级，任何 Level 都不放行）' };
      if (decision === 'auto') {
        const r = skills.dispatch(fn, args);
        /* 审计：auto 执行的写操作（非 readOnly）写日志 */
        if (!tool.readOnly && r.ok) onAudit({ tool: fn, args, result: r.result });
        return { ok: r.ok, pending: false, result: r.ok ? r.result : r.error };
      }
      /* confirm */
      return { ok: true, pending: true, result: '已加入执行计划，等待用户确认' };
    }
  };
}
