// Compactor（A2 上下文压缩）测试：预算检查 / 摘要替换 / 原文保留 / 降级
import assert from 'node:assert/strict';
import { Compactor, SUMMARY_MARKER } from '../core/compactor.ts';
import type { ChatMessage } from '../core/types.ts';
import type { LLMAdapter, ChatOptions } from '../core/llm-adapter.ts';

class MockAdapter implements LLMAdapter {
  provider = 'mock';
  summaryText = '【做了什么】读了 a.txt【发现】变量名 foo【当前状态】进行中【待办/关键数据】port=8765';
  failSummarize = false;
  calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatMessage> {
    this.calls.push({ messages, opts });
    const sys = messages[0]?.content ?? '';
    if (sys.includes('上下文压缩器')) {
      if (this.failSummarize) throw new Error('summary api down');
      return { role: 'assistant', content: this.summaryText };
    }
    return { role: 'assistant', content: 'ok' };
  }
}

/** 构造一轮 = assistant（带 toolCalls）+ tool 结果（big 字符） */
function round(id: string, big = 0): ChatMessage[] {
  return [
    { role: 'assistant', content: `调用${id}`, toolCalls: [{ id, name: 'fs_read', arguments: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: id, name: 'fs_read', content: 'x'.repeat(big) },
  ];
}

async function main() {
  // ── 用例 1：不超预算不触发（原样返回，同一引用）──
  {
    const adapter = new MockAdapter();
    const comp = new Compactor(adapter, { budgetChars: 10000, minTailRounds: 2, batchRounds: 2 });
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: '指令' }, ...round('a', 10)];
    const r = await comp.maybeCompact(msgs);
    assert.equal(r.stats.triggered, false, '未超预算不应触发');
    assert.equal(r.messages, msgs, '未触发应原引用返回');
    assert.equal(adapter.calls.length, 0, '未触发不应调用 LLM');
  }

  // ── 用例 2：超预算触发摘要替换（最早轮进摘要、user 指令保留、尾部保留）──
  {
    const adapter = new MockAdapter();
    const comp = new Compactor(adapter, { budgetChars: 1000, minTailRounds: 2, batchRounds: 2 });
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys'.repeat(20) },
      { role: 'user', content: '重要指令：写文件到 out.txt' },
      ...round('a', 600),
      ...round('b', 600),
      ...round('c', 600),
    ];
    const r = await comp.maybeCompact(msgs);
    assert.equal(r.stats.triggered, true);
    assert.equal(r.stats.compactedRounds, 1, '3 轮可压缩（3-2 尾部）→ 一批压 1 轮');
    const texts = r.messages.map((m) => m.content ?? '');
    assert.ok(texts.some((t) => t.startsWith(SUMMARY_MARKER)), '应出现摘要消息');
    assert.ok(texts.some((t) => t.includes('重要指令')), 'user 指令必须保留');
    assert.ok(!texts.some((t) => t.includes('调用a')), '最早轮 a 的内容应被压缩掉');
    assert.ok(texts.some((t) => t.includes('调用b')), '轮 b 应在（尾部保留）');
    assert.ok(texts.some((t) => t.includes('调用c')), '轮 c 应在（尾部保留）');
    assert.ok(r.stats.afterChars < r.stats.totalChars, '压缩后应显著变小');
  }

  // ── 用例 3：摘要调用格式正确（压缩器 prompt + 低温）──
  {
    const adapter = new MockAdapter();
    const comp = new Compactor(adapter, { budgetChars: 1000, minTailRounds: 1, batchRounds: 1 });
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, ...round('a', 800), ...round('b', 800)];
    await comp.maybeCompact(msgs);
    const summaryCall = adapter.calls.find((c) => (c.messages[0]?.content ?? '').includes('上下文压缩器'));
    assert.ok(summaryCall, '应有一次摘要调用');
    assert.equal(summaryCall!.opts?.temperature, 0.1, '摘要应低温');
    assert.ok(summaryCall!.opts?.maxTokens && summaryCall!.opts.maxTokens > 0, '摘要应限 maxTokens');
  }

  // ── 用例 4：轮间夹 user 消息（prior 交错）→ user 指令保留、只压轮 ──
  {
    const adapter = new MockAdapter();
    const comp = new Compactor(adapter, { budgetChars: 1000, minTailRounds: 1, batchRounds: 3 });
    const msgs: ChatMessage[] = [
      { role: 'system', content: 's' },
      ...round('a', 600),                                  // 轮 a
      { role: 'user', content: '中间的指令不能丢' },          // 轮间 user
      ...round('b', 600),                                  // 轮 b
      ...round('c', 600),                                  // 轮 c
    ];
    const r = await comp.maybeCompact(msgs);
    assert.equal(r.stats.compactedRounds, 2, '4 轮-1 尾部 = 可压 2 批(3,2) → 压 2 轮');
    const texts = r.messages.map((m) => m.content ?? '');
    assert.ok(texts.some((t) => t.includes('中间的指令不能丢')), '轮间 user 指令必须保留');
    assert.ok(!texts.some((t) => t.includes('调用a')), '轮 a 应被压缩');
    assert.ok(!texts.some((t) => t.includes('调用b')), '轮 b 应被压缩');
    assert.ok(texts.some((t) => t.includes('调用c')), '轮 c 应保留（尾部）');
  }

  // ── 用例 5：已有摘要继续压缩（摘要累积）──
  {
    const adapter = new MockAdapter();
    const comp = new Compactor(adapter, { budgetChars: 1000, minTailRounds: 1, batchRounds: 2 });
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, ...round('a', 800), ...round('b', 800), ...round('c', 800)];
    const r1 = await comp.maybeCompact(msgs);
    assert.ok(r1.messages.some((m) => (m.content ?? '').startsWith(SUMMARY_MARKER)));
    // 第二轮：新的大轮追加后再次超预算
    const msgs2 = [...r1.messages, ...round('d', 800)];
    const r2 = await comp.maybeCompact(msgs2);
    assert.equal(r2.stats.triggered, true, '二次超预算应再触发');
    const summaries = r2.messages.filter((m) => (m.content ?? '').startsWith(SUMMARY_MARKER));
    assert.ok(summaries.length >= 1, '应有摘要（可累积）');
  }

  // ── 用例 6：摘要失败保守降级（原样返回，不破坏执行）──
  {
    const adapter = new MockAdapter();
    adapter.failSummarize = true;
    const comp = new Compactor(adapter, { budgetChars: 1000, minTailRounds: 1, batchRounds: 2 });
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, ...round('a', 800), ...round('b', 800)];
    const r = await comp.maybeCompact(msgs);
    assert.equal(r.stats.triggered, true, '超预算仍标记触发（统计口径）');
    assert.equal(r.stats.compactedRounds, 0, '摘要失败 → 0 轮压缩');
    assert.equal(r.messages, msgs, '失败应原样返回');
  }

  console.log('✅ Compactor 测试通过（预算/摘要替换/user 保留/累积/降级 6 用例）');
}

main().catch((e) => {
  console.error('❌ Compactor 测试失败:', e);
  process.exit(1);
});
