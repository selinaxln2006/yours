/* agent-loop.js — 健壮循环引擎（宿主无关）
   三重终止保险：① maxRounds（默认 10）② 重复调用指纹检测 ③ abort() 外部中断
   中断语义（DSH 合成结果思路的简化版）：
   - LLM 请求中 abort → AbortError 捕获，返回 aborted=true
   - 工具执行中 → 已入队的动作保留，未执行的不会幻觉「已执行」
   依赖注入：{llm, pipeline, today, labelFn} —— 宿主提供，循环本体不碰任何全局。 */
export function createAgentLoop(deps) {
  const { llm, pipeline, today, labelFn } = deps;
  const loop = {
    config: { maxRounds: 10, repeatLimit: 3 },
    active: null,
    async run(text, opts) {
      opts = opts || {};
      const cfg = { ...this.config, ...(opts.config || {}) };
      const ac = new AbortController();
      const st = { actions: [], reply: '', aborted: false, round: 0, lastCall: null, repeat: 0, texts: [] };
      /* requiredTool 机械强制：提示词里的「硬纪律」模型可能跳过（G3 实测 DeepSeek 概率性无视第 7 步），
         循环层补位才算真「硬」。done=已调用过，nagged=已提醒过（只提醒一次，避免死循环）。 */
      const required = { done: false, nagged: false };
      this.active = { ac, st };
      /* 超时兜底：请求挂住时自动 abort（默认 90s） */
      const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, opts.timeoutMs || 90000);
      const sys = opts.sys || ('你是「枢」，用户的 AI 助手。今天是 ' + (today ? today() : '') + '。工作流程：1) 先调用只读工具了解现状；2) 根据需求调用多个工具完成拆解；3) 结束时用一两句中文总结。写操作会先经用户确认再执行，你只管返回工具调用。');
      const msgs = [{ role: 'system', content: sys }, { role: 'user', content: text }];
      try {
        for (; st.round < cfg.maxRounds; st.round++) {
          if (st.aborted) break;
          const r = await llm.chat(msgs, { signal: ac.signal, maxTokens: opts.maxTokens });
          if (r && r.toolCalls && r.toolCalls.length) {
            /* 累积每轮文本：模型常「说一句→调工具→再说→再调」，中间文本不能丢 */
            if (r.content) st.texts.push(r.content);
            msgs.push(r.rawAssistant);
            for (const tc of r.toolCalls) {
              if (opts.requiredTool && tc.name === opts.requiredTool) required.done = true;
              /* 重复调用检测：连续 N 次相同 tool+args 指纹 → 强制终止（防模型死循环） */
              const fp = tc.name + '|' + String(tc.argsJson || '');
              if (st.lastCall === fp) { st.repeat++; } else { st.repeat = 0; st.lastCall = fp; }
              if (st.repeat >= cfg.repeatLimit) {
                st.texts.push('检测到重复调用工具「' + tc.name + '」已自动停止。建议换个方式描述需求，或检查之前的执行结果。');
                st.aborted = true; break;
              }
              let args = {};
              try { args = JSON.parse(tc.argsJson || '{}'); } catch (e) {}
              const res = pipeline.run(tc.name, args);
              if (res.pending) {
                st.actions.push({ tool: tc.name, args });
                msgs.push(llm.toolMsg(tc.id, res.result));
              } else {
                msgs.push(llm.toolMsg(tc.id, String(res.ok ? res.result : res.error)));
              }
            }
            if (st.aborted) break;
          } else {
            if (r && r.content) st.texts.push(r.content);
            /* requiredTool 机械强制：模型给最终回复但没调用必需工具 → 注入提醒再追一轮（只追一次） */
            if (opts.requiredTool && !required.done && !required.nagged && !st.aborted) {
              required.nagged = true;
              cfg.maxRounds += 1; /* 追加的这轮不计入原预算 */
              msgs.push((r && r.rawAssistant) || { role: 'assistant', content: (r && r.content) || '' });
              msgs.push({ role: 'user', content: opts.requiredReminder || ('系统提醒：你还没有调用工具 ' + opts.requiredTool + '（硬纪律）。请立即调用它完成必要记录，然后给出最终总结。') });
              continue;
            }
            st.reply = (r && r.content) || '';
            break;
          }
        }
        /* 兜底总结：模型调了工具但没给收尾文本时，用实际动作动态生成，绝不硬编码空泛文案 */
        let reply = st.texts.join('\n\n') || st.reply;
        if (!reply && st.actions.length) {
          const labels = st.actions.map(a => (labelFn ? labelFn(a.tool) : a.tool));
          reply = '已为你规划 ' + st.actions.length + ' 项操作：' + labels.join('、') + '。请确认后执行。';
        }
        return { reply, actions: st.actions, aborted: st.aborted, rounds: st.round };
      } catch (e) {
        if (e && (e.name === 'AbortError' || ac.signal.aborted)) {
          st.aborted = true;
          const reply = st.texts.join('\n\n');
          return { reply: reply || '⏱ 请求超时或被中断，请重试。', actions: st.actions, aborted: true, rounds: st.round };
        }
        throw e;
      } finally {
        clearTimeout(timer);
        this.active = null;
      }
    },
    abort() {
      const a = this.active;
      if (a) { a.st.aborted = true; try { a.ac.abort(); } catch (e) {} }
    }
  };
  return loop;
}
