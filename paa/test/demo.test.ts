// 演示模式：脚本化假模型的意图解析与多轮行为（不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoAdapter, parseIntents } from '../server/demo.ts';
import type { ChatMessage, ToolDefinition } from '../core/types.ts';

const names = (text: string): string[] => parseIntents(text, new Date(2026, 8, 30, 12, 0)).map((i) => i.call.name);

test('饮食：多个食物拆开，按已知食物估热量，按词判断餐次', () => {
  const r = parseIntents('午饭吃了三文鱼饭团和一杯拿铁', new Date(2026, 8, 30, 20, 0));
  assert.deepEqual(r.map((i) => i.call.arguments), [
    { name: '三文鱼饭团', calories: 420, mealType: 'lunch' },
    { name: '拿铁', calories: 190, mealType: 'lunch' },
  ]);
  assert.equal(parseIntents('早上吃了燕麦 300 卡')[0].call.arguments.calories, 300);
});

test('饮水 / 睡眠 / 运动 / 日程 / 花钱 / 待办', () => {
  assert.deepEqual(names('今天喝了 500ml 水'), ['life_add_water']);
  assert.equal(parseIntents('喝了两杯水')[0].call.arguments.amount, 500);
  assert.deepEqual(names('昨晚睡了 7.5 小时'), ['life_add_sleep']);
  assert.equal(parseIntents('游泳 40 分钟')[0].call.arguments.duration, 40);
  assert.equal(parseIntents('跑了 5 公里')[0].call.arguments.duration, 30);
  const sch = parseIntents('明天下午 3 点开组会', new Date(2026, 8, 30, 12, 0))[0].call.arguments;
  assert.deepEqual(sch, { title: '组会', date: '2026-10-01', startTime: '15:00' });
  assert.deepEqual(names('咖啡花了 6 块'), ['life_add_transaction']);
  assert.equal(parseIntents('记得交概率论作业')[0].call.arguments.title, '交概率论作业');
  assert.deepEqual(names('你好'), []);
});

test('"想跑 5 公里"是计划不是已完成的运动', () => {
  assert.ok(!names('晚上想跑 5 公里').includes('life_add_exercise'));
});

test('适配器：先发工具调用，工具结果回来后总结；没识别出意图时给帮助', async () => {
  const tools = ['life_add_meal', 'life_add_water'].map((name) => ({ name } as ToolDefinition));
  const a = new DemoAdapter();
  const m1 = await a.chat([{ role: 'user', content: '喝了 300ml 水' }], { tools });
  assert.equal(m1.toolCalls?.[0].name, 'life_add_water');
  const history: ChatMessage[] = [
    { role: 'user', content: '喝了 300ml 水' }, m1,
    { role: 'tool', toolCallId: m1.toolCalls![0].id, name: 'life_add_water', content: '{"ok":true,"data":{}}' },
  ];
  const m2 = await a.chat(history, { tools });
  assert.equal(m2.toolCalls, undefined);
  assert.match(m2.content ?? '', /记好了/);
  const m3 = await a.chat([{ role: 'user', content: '你是谁' }], { tools });
  assert.match(m3.content ?? '', /演示模式/);
  // 工具不可用（如被 FORBID）时不发调用
  const m4 = await a.chat([{ role: 'user', content: '喝了 300ml 水' }], { tools: [] });
  assert.equal(m4.toolCalls, undefined);
});

test('拆解目标：一次给出 5 天的建议计划，带目标 id，日期从今天起', () => {
  const r = parseIntents('帮我把目标「准备量化面试」（id: demo-g2）拆成这周每天的参考计划', new Date(2026, 9, 2, 20, 0));
  assert.equal(r.length, 1);
  assert.equal(r[0].call.name, 'life_suggest_plan');
  const a = r[0].call.arguments as { goalId: string; items: Array<{ dueDate: string }> };
  assert.equal(a.goalId, 'demo-g2');
  assert.deepEqual(a.items.map((x) => x.dueDate), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
});
