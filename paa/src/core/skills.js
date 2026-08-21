/* skills.js — Skill 插件系统（可插拔 Agent 工具层）
   每个 Skill = {id,name,desc,tools:[{name,desc,params(JSON Schema),handler}]}
   宿主无关：注册/查询/派发纯逻辑，不碰任何全局状态。
   未来外部技能包（股票/邮件/远端下载）只需 register() 即可挂载。 */
export function createSkills() {
  const registry = [];
  return {
    registry,
    register(s) {
      if (s && s.id && !registry.find(x => x.id === s.id)) registry.push(s);
    },
    list() { return registry; },
    allTools() {
      const out = [];
      registry.forEach(s => (s.tools || []).forEach(t => out.push({
        id: s.id + '__' + t.name,
        desc: t.desc,
        params: t.params,
        readOnly: !!t.readOnly
      })));
      return out;
    },
    dispatch(fn, args) {
      const i = fn.indexOf('__');
      if (i < 0) return { ok: false, error: '工具名无效' };
      const sid = fn.slice(0, i), tn = fn.slice(i + 2);
      const s = registry.find(x => x.id === sid);
      if (!s) return { ok: false, error: 'skill「' + sid + '」未注册' };
      const t = (s.tools || []).find(x => x.name === tn);
      if (!t) return { ok: false, error: '工具「' + tn + '」不存在' };
      try {
        const r = t.handler(args || {});
        return { ok: true, result: r == null ? 'ok' : r };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    openaiTools() {
      return this.allTools().map(t => ({ type: 'function', function: { name: t.id, description: t.desc, parameters: t.params } }));
    },
    anthropicTools() {
      return this.allTools().map(t => ({ name: t.id, description: t.desc, input_schema: t.params }));
    }
  };
}
