// ============================================================
// 演示模式（node server/main.ts --demo）
// 不需要 config.json / API key：脚本化的"假模型"理解几类生活记录的说法，
// 发出真实的工具调用（走真实的权限门、确认卡、LifeStore 写回），
// 数据落在临时目录并预置示例数据，不碰用户真实的 paa/data。
// ============================================================

import type { ChatMessage, ToolCall } from '../core/types.ts';
import type { ChatOptions, LLMAdapter, StreamCallbacks } from '../core/llm-adapter.ts';
import type { LifeStore } from '../core/life-store.ts';

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/** 常见食物的粗略热量（kcal/份），只用于演示 */
const FOOD_KCAL: Array<[RegExp, number]> = [
  [/饭团/, 420], [/拿铁|latte/i, 190], [/美式|咖啡|coffee/i, 10], [/沙拉|salad/i, 350],
  [/三明治|sandwich/i, 350], [/米饭|饭/, 230], [/面|粉/, 450], [/鸡胸/, 200], [/酸奶|yogurt/i, 150],
  [/燕麦|oat/i, 180], [/苹果|apple/i, 80], [/香蕉|banana/i, 100], [/巧克力|chocolate/i, 250],
  [/鸡蛋|蛋|egg/i, 75], [/牛奶|milk/i, 130], [/寿司|sushi/i, 400], [/披萨|pizza/i, 600],
];

interface Intent {
  call: Omit<ToolCall, 'id'>;
  say: string;
}

/** 从一句话里抽取生活记录意图（覆盖演示用的常见说法，不追求完备） */
export function parseIntents(text: string, now = new Date()): Intent[] {
  const out: Intent[] = [];
  const t = text.replace(/\s+/g, ' ');

  // 饮食："午饭吃了 A 和 B" / "早上吃了燕麦 300 卡"
  const eat = /(早餐|早饭|早上|午餐|午饭|中午|晚餐|晚饭|晚上|夜宵|加餐|零食)?[^，。,.]*?吃了([^，。,.；;]+)/.exec(t);
  if (eat) {
    const when = eat[1] ?? '';
    const hour = now.getHours();
    const mealType = /早/.test(when) ? 'breakfast' : /午|中午/.test(when) ? 'lunch' : /晚|夜宵/.test(when) ? 'dinner'
      : /加餐|零食/.test(when) ? 'snack' : hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 21 ? 'dinner' : 'snack';
    const explicit = /(\d{2,4})\s*(千卡|大卡|kcal|卡)/i.exec(eat[2]);
    const items = eat[2].replace(/(\d{2,4})\s*(千卡|大卡|kcal|卡)/gi, '').split(/和|、|跟|还有|加上|\+|,|，|and/).map((s) => s.replace(/^[一两个份杯碗些点]+|[，。]$/g, '').trim()).filter(Boolean);
    for (const name of items.slice(0, 4)) {
      const kcal = items.length === 1 && explicit ? Number(explicit[1]) : (FOOD_KCAL.find(([re]) => re.test(name))?.[1] ?? 300);
      out.push({ call: { name: 'life_add_meal', arguments: { name, calories: kcal, mealType } }, say: `${name}（约 ${kcal} kcal）` });
    }
  }

  // 饮水："喝了 500ml 水" / "喝了两杯水"
  const ml = /喝了?\s*(\d{2,4})\s*(ml|毫升)/i.exec(t);
  const cups = /喝了?\s*([一二两三四五\d])\s*杯水/.exec(t);
  const cupN: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
  if (ml || cups) {
    const amount = ml ? Number(ml[1]) : 250 * (cupN[cups![1]] ?? Number(cups![1]));
    out.push({ call: { name: 'life_add_water', arguments: { amount } }, say: `饮水 ${amount} ml` });
  }

  // 睡眠："睡了 7.5 小时"
  const sl = /睡了?\s*(\d+(?:\.\d+)?)\s*(个)?(小时|h)/i.exec(t);
  if (sl) {
    const date = /昨/.test(t) ? dayOffset(-1) : ymd(now);
    out.push({ call: { name: 'life_add_sleep', arguments: { hours: Number(sl[1]), date } }, say: `睡眠 ${sl[1]} 小时` });
  }

  // 运动："跑了 5 公里" / "游泳 40 分钟" / "打了一小时网球"
  const ex = /(跑步|跑了|游泳|游了|网球|健身|骑车|走路|瑜伽)[^\d一两]*(\d+(?:\.\d+)?|一|两)\s*(公里|km|分钟|min|小时)/i.exec(t);
  if (ex && !/想|要|打算|计划/.test(t.slice(Math.max(0, ex.index - 3), ex.index + 1))) {
    const name = /跑/.test(ex[1]) ? '跑步' : /游/.test(ex[1]) ? '游泳' : ex[1];
    const n = ex[2] === '一' ? 1 : ex[2] === '两' ? 2 : Number(ex[2]);
    const duration = /公里|km/i.test(ex[3]) ? Math.round(n * 6) : /小时/.test(ex[3]) ? n * 60 : n;
    out.push({ call: { name: 'life_add_exercise', arguments: { name, duration } }, say: `${name} ${duration} 分钟` });
  }

  // 日程："明天下午 3 点开组会" / "晚上 7 点半想去跑步"
  const tm = /(今天|明天|后天)?\s*(早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*[:点：](\s*(\d{2})|半)?/.exec(t);
  if (tm && /开会|会议|组会|见|约|提醒|安排|上课|考试|去|想/.test(t)) {
    let h = Number(tm[3]);
    if (/下午|晚上/.test(tm[2] ?? '') && h < 12) h += 12;
    const m = tm[4]?.includes('半') ? '30' : (tm[5] ?? '00');
    const date = tm[1] === '明天' ? dayOffset(1) : tm[1] === '后天' ? dayOffset(2) : ymd(now);
    const title = t.slice(tm.index + tm[0].length).replace(/^[\s,，的]*(想|要|去|开|有)?/, '').replace(/[，。,.!！]+.*$/, '').trim().slice(0, 20) || '日程';
    out.push({ call: { name: 'life_add_schedule', arguments: { title, date, startTime: `${String(h).padStart(2, '0')}:${m}` } }, say: `日程「${title}」${date.slice(5)} ${String(h).padStart(2, '0')}:${m}` });
  }

  // 花钱："午饭花了 12 块" / "买书花了 30"
  const sp = /(花了|付了|消费了?)\s*(\d+(?:\.\d+)?)\s*(元|块|刀|新币|sgd|\$)?/i.exec(t);
  if (sp) {
    const amount = Number(sp[2]);
    const category = /饭|吃|咖啡|奶茶|餐/.test(t) ? '餐饮' : /车|地铁|打车|grab|mrt/i.test(t) ? '交通' : /书|课/.test(t) ? '学习' : '其他';
    out.push({ call: { name: 'life_add_transaction', arguments: { type: 'expense', amount, category, note: t.slice(0, Math.max(0, sp.index)).replace(/[，,]/g, '').trim().slice(-12) || category } }, say: `支出 ${amount}（${category}）` });
  }

  // 待办："记得交作业" / "待办：复习第三章"
  const td = /(?:记得|别忘了|待办[:：]?|要记得)\s*([^，。,.]+)/.exec(t);
  if (td) out.push({ call: { name: 'life_add_todo', arguments: { title: td[1].trim().slice(0, 30), priority: /考试|ddl|截止|明天/.test(t) ? 'high' : 'mid' } }, say: `待办「${td[1].trim().slice(0, 30)}」` });

  return out;
}

const HELP = [
  '这是**演示模式**：回复由脚本生成，不连任何模型；数据只存在临时目录，关掉就没了。',
  '',
  '我能听懂这些说法（会走真实的确认流程和数据写回）：',
  '- 「午饭吃了三文鱼饭团和一杯拿铁」',
  '- 「今天喝了 500ml 水」「昨晚睡了 7 小时」',
  '- 「游泳 40 分钟」「跑了 5 公里」',
  '- 「明天下午 3 点开组会」',
  '- 「咖啡花了 6 块」「记得交概率论作业」',
  '',
  '想用真实模型：填好 `paa/config.json` 后去掉 `--demo` 重新启动。',
].join('\n');

let callSeq = 0;

/** 脚本化适配器：本轮用户话 → 工具调用；工具结果回来 → 总结 */
export class DemoAdapter implements LLMAdapter {
  readonly provider = 'demo';

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatMessage> {
    return this.reply(messages, opts);
  }

  async chatStream(messages: ChatMessage[], opts: ChatOptions, cb: StreamCallbacks): Promise<ChatMessage> {
    const msg = this.reply(messages, opts);
    // 打字机效果：按小块推送文本
    const text = msg.content ?? '';
    for (let i = 0; i < text.length; i += 3) {
      cb.onText?.(text.slice(i, i + 3));
      await new Promise((r) => setTimeout(r, 12));
    }
    return msg;
  }

  private reply(messages: ChatMessage[], opts: ChatOptions): ChatMessage {
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const turn = messages.slice(lastUser);
    const userText = messages[lastUser]?.content ?? '';
    const available = new Set((opts.tools ?? []).map((t) => t.name));

    // 本轮已经调过工具 → 总结结果
    const results = turn.filter((m) => m.role === 'tool');
    if (results.length) {
      const failed = results.filter((m) => /"ok"\s*:\s*false/.test(m.content ?? ''));
      const done = results.length - failed.length;
      const lines = [done ? `记好了 ✅ 共 ${done} 项，右边「今天」已经更新。` : '这次什么都没记下。'];
      if (failed.length) lines.push(`有 ${failed.length} 项没执行（被拒绝或失败），需要的话换个说法再试。`);
      return { role: 'assistant', content: lines.join('\n') };
    }

    const intents = parseIntents(userText).filter((i) => available.has(i.call.name));
    if (!intents.length) return { role: 'assistant', content: HELP };
    const toolCalls: ToolCall[] = intents.map((i) => ({ ...i.call, id: `demo_${++callSeq}` }));
    return { role: 'assistant', content: `好的，我来记一下：${intents.map((i) => i.say).join('、')}。`, toolCalls };
  }
}

/** 预置示例数据（相对今天的日期），让"今天"和各面板一打开就有内容 */
export async function seedDemoData(store: LifeStore): Promise<void> {
  const d = dayOffset;
  await store.tx((data) => {
    const w = data as Record<string, unknown>;
    w.profile = { name: '', height: 165, age: 21, targetWeight: 55, dailyCalorieTarget: 1600, dailyBudget: 40, targetWater: 2000, activityLevel: 1.4 };
    w.sleep = [{ date: d(-2), hours: 6.5, quality: 3 }, { date: d(-1), hours: 7, quality: 4 }, { date: d(0), hours: 7.5, quality: 4 }];
    w.water = [{ date: d(0), amount: 500, ts: 1 }, { date: d(0), amount: 250, ts: 2 }];
    w.meals = [
      { date: d(0), name: '燕麦酸奶', calories: 330, mealType: 'breakfast' },
      { date: d(-1), name: '鸡胸肉沙拉', calories: 420, mealType: 'lunch' },
    ];
    w.transactions = [
      { id: 'demo-t1', date: d(0), type: 'expense', amount: 6.5, category: '餐饮', note: '早餐' },
      { id: 'demo-t2', date: d(0), type: 'expense', amount: 2.1, category: '交通', note: 'MRT' },
      { id: 'demo-t3', date: d(-1), type: 'expense', amount: 18, category: '学习', note: '教材' },
    ];
    w.weights = [{ date: d(-14), weight: 57.4 }, { date: d(-7), weight: 57 }, { date: d(0), weight: 56.6 }];
    w.exerciseLog = [{ date: d(-1), name: '游泳', duration: 40, calories: 320 }, { date: d(-3), name: '网球', duration: 60, calories: 420 }];
    w.schedule = [
      { id: 'demo-s1', title: '概率论', date: d(0), startTime: '10:00', endTime: '12:00', category: 'study', rrule: 'none' },
      { id: 'demo-s2', title: '组会', date: d(0), startTime: '15:00', endTime: '16:00', category: 'work', note: 'COM1', rrule: 'none' },
      { id: 'demo-s3', title: '网球', date: d(-7), startTime: '19:00', category: 'health', rrule: 'weekly' },
      { id: 'demo-s4', title: '期中考试', date: d(3), startTime: '09:00', category: 'study', rrule: 'none' },
    ];
    w.todos = [
      { id: 'demo-d1', title: '复习随机过程第 4 章', priority: 'high', done: false },
      { id: 'demo-d2', title: '投实习简历', priority: 'mid', done: false },
      { id: 'demo-d3', title: '买网球', priority: 'low', done: false },
      { id: 'demo-d4', title: '交作业 3', priority: 'mid', done: true },
    ];
    w.goals = [{ id: 'demo-g1', title: '期末前体重到 55kg', type: 'weight', target: 55, startValue: 57.4, endDate: d(60), createdAt: Date.now(), milestones: [] }];
  }, { source: 'demo' });
}
