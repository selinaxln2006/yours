/* tool-pipeline.js — 工具执行管道（before 权限 → execute → after 格式化）
   readOnly 工具自动执行；写操作进 pending（待宿主确认，CLI 打印动作，UI 出计划卡）。
   钩子已留好——P1 挂权限分级、P3 挂外部 ToolPkg/MCP 时循环本体不用改。 */
export function createToolPipeline(skills) {
  return {
    run(fn, args) {
      const tool = skills.allTools().find(x => x.id === fn);
      if (!tool) return { ok: false, pending: false, error: '工具「' + fn + '」未注册' };
      /* before：权限检查（P0 只分读写；P1 挂三级权限） */
      if (!tool.readOnly) return { ok: true, pending: true, result: '已加入执行计划，等待用户确认' };
      /* execute */
      const r = skills.dispatch(fn, args);
      /* after：统一返回结构 */
      return { ok: r.ok, pending: false, result: r.ok ? r.result : r.error };
    }
  };
}
