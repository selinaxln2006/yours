/* llm-adapter.js — LLM 协议差异全封装（宿主无关）
   AgentLoop 只处理统一的 {content, toolCalls} 事件，协议细节全在这：
   - OpenAI：tool 消息带 tool_call_id（宽松）
   - Anthropic：tool_result 必须紧跟 assistant 的 tool_use，相邻同 role 消息要合并（严格）
   循环是协议无关的，差异被推到边缘——新增 Provider 只改这里。
   config = {provider, apiUrl, apiKey, model}，由宿主注入（CLI 读配置/环境变量，UI 读 aiConfig）。 */
export function createLLMAdapter(config, skills) {
  const cfg = config || {};
  return {
    async chat(msgs, opts) {
      opts = opts || {};
      if (cfg.provider === 'anthropic') return this._anthropic(msgs, cfg, opts);
      return this._openai(msgs, cfg, opts);
    },
    /* 工具结果消息（协议相关，必须放这） */
    toolMsg(id, content) {
      if (cfg.provider === 'anthropic') {
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(content) }] };
      }
      return { role: 'tool', tool_call_id: id, content: String(content) };
    },
    async _openai(msgs, c, opts) {
      const body = { model: c.model || 'gpt-4o-mini', messages: msgs, max_tokens: opts.maxTokens || 1500 };
      if (!opts.noTools) { body.tools = skills.openaiTools(); body.tool_choice = 'auto'; }
      const r = await fetch(c.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (c.apiKey || '') },
        body: JSON.stringify(body),
        signal: opts.signal
      });
      if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 80));
      const j = await r.json();
      const m = j.choices[0].message;
      const toolCalls = (m.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, argsJson: tc.function.arguments }));
      let content = m.content || '';
      if (j.choices && j.choices[0] && j.choices[0].finish_reason === 'length') content += '\n\n⚠ 回复达到长度上限已截断（建议把需求拆小再问）。';
      return { content, toolCalls, rawAssistant: m };
    },
    async _anthropic(msgs, c, opts) {
      const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
      const conv = [];
      msgs.filter(m => m.role !== 'system').forEach(m => {
        if (m.role === 'tool') {
          conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content) }] });
        } else if (m.role === 'assistant' && m.tool_calls) {
          const blocks = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          m.tool_calls.forEach(tc => {
            let input = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          });
          conv.push({ role: 'assistant', content: blocks });
        } else {
          conv.push({ role: m.role, content: [{ type: 'text', text: String(m.content) }] });
        }
      });
      /* Anthropic 要求相邻同 role 消息合并 */
      const merged = [];
      conv.forEach(m => {
        const last = merged[merged.length - 1];
        if (last && last.role === m.role && Array.isArray(last.content) && Array.isArray(m.content)) last.content = last.content.concat(m.content);
        else merged.push(m);
      });
      const url = (c.apiUrl && c.apiUrl.indexOf('/messages') >= 0) ? c.apiUrl : 'https://api.anthropic.com/v1/messages';
      const body = { model: c.model || 'claude-sonnet-4-20250514', system: sys, messages: merged, max_tokens: opts.maxTokens || 1500 };
      if (!opts.noTools) body.tools = skills.anthropicTools();
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: opts.signal
      });
      if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 80));
      const j = await r.json();
      const blocks = j.content || [];
      let text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input || {}) }));
      if (j.stop_reason === 'max_tokens') text += '\n\n⚠ 回复达到长度上限已截断（建议把需求拆小再问）。';
      const rawAssistant = { role: 'assistant', content: text, tool_calls: toolCalls.map(tc => ({ id: tc.id, function: { name: tc.name, arguments: tc.argsJson } })) };
      return { content: text, toolCalls, rawAssistant };
    }
  };
}
