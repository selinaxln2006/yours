// ============================================================
// life ToolPkg 实现 — 生活工作台全模块读写（console-v1 路线 2）
// 业务逻辑从 index.html 内置技能逐条移植（create_goal 分解 / add_schedule
// count→rruleUntil / add_sleep 按日期 upsert 语义完全一致）
// 数据访问：宿主注入的 lifeStore（LifeStore 单例），走 tx 事务写入
// ============================================================

// ---- 自包含工具函数（包不依赖宿主模块） ----
function uid() {
  // crypto.randomUUID 在 Node >=16 ESM 可直接用
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(base, n) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---- 目标分解（移植自 index.html M.goals._decompose） ----
function decompose(g) {
  const ms = [];
  if (g.type === 'weight') {
    const start = g.startVal || 60;
    const diff = start - g.target;
    if (diff <= 0) return [];
    const steps = Math.min(Math.ceil(diff), 5);
    const stepVal = diff / steps;
    for (let i = 1; i <= steps; i++) {
      const t = parseFloat((start - stepVal * i).toFixed(1));
      const days = Math.round((90 * i) / steps);
      ms.push({ id: uid(), title: `体重达到 ${t}kg`, target: t, done: false, date: addDays(today(), days) });
    }
  } else if (g.type === 'saving') {
    const steps = Math.min(4, Math.ceil(g.target / 2500));
    const stepVal = g.target / steps;
    for (let i = 1; i <= steps; i++) {
      const days = Math.round((180 * i) / steps);
      ms.push({ id: uid(), title: `存满 ${Math.round(stepVal * i)}`, target: stepVal * i, done: false, date: addDays(today(), days) });
    }
  } else if (g.type === 'habit') {
    const total = g.target || 30;
    const steps = Math.min(Math.ceil(total / 7), 5);
    const stepVal = Math.ceil(total / steps);
    let acc = 0;
    for (let i = 1; i <= steps; i++) {
      acc += stepVal;
      if (acc > total) acc = total;
      const days = Math.round((total * i) / steps);
      ms.push({ id: uid(), title: `连续打卡 ${acc} 天`, target: acc, done: false, date: addDays(today(), days) });
    }
  } else {
    ms.push({ id: uid(), title: '完成第1步', done: false, date: addDays(today(), 7) });
    ms.push({ id: uid(), title: '完成第2步', done: false, date: addDays(today(), 14) });
    ms.push({ id: uid(), title: '达成目标', done: false, date: g.endDate });
  }
  return ms;
}

// ---- 目标配套待办（移植自 index.html M.goals._genTodos） ----
function genTodos(g) {
  const todos = [];
  const t = today();
  if (g.type === 'weight') {
    todos.push({ id: uid(), title: '制定每周运动计划（4天/周）', priority: 'high', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 2), category: '健身' });
    todos.push({ id: uid(), title: '每日记录饮食热量', priority: 'mid', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 1), category: '健身' });
    todos.push({ id: uid(), title: '每周称重并记录', priority: 'mid', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 7), category: '健身' });
  } else if (g.type === 'saving') {
    todos.push({ id: uid(), title: '制定月度预算计划', priority: 'high', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 3), category: '理财' });
    todos.push({ id: uid(), title: '每周记账复盘', priority: 'mid', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 7), category: '理财' });
    todos.push({ id: uid(), title: '设置自动转账到储蓄账户', priority: 'mid', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 5), category: '理财' });
  } else if (g.type === 'habit') {
    todos.push({ id: uid(), title: '设置每日打卡提醒', priority: 'high', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 1), category: '习惯' });
    todos.push({ id: uid(), title: '选择固定时间段执行', priority: 'mid', done: false, plan: 'suggested', goalId: g.id, dueDate: addDays(t, 2), category: '习惯' });
  }
  return todos;
}

export function createPkgTools(env) {
    const store = env.services.lifeStore;

    // 单键追加 helper：push 后走事务（保证原子写 + change 事件）
    async function appendItem(key, item) {
      const id = item.id || uid();
      await store.tx((d) => {
        d[key].push({ ...item, id });
      }, { source: 'agent' });
      return id;
    }

    return {
      // 读取摘要（移植自 index.html query_summary handler）
      async query_summary() {
        const d = store.getAll();
        const t = today();
        return JSON.stringify({
          today: t,
          profile: {
            height: d.profile.height, age: d.profile.age, targetWeight: d.profile.targetWeight,
            dailyCalorieTarget: d.profile.dailyCalorieTarget, dailyBudget: d.profile.dailyBudget, targetWater: d.profile.targetWater,
          },
          latestWeight: d.weights.length ? d.weights[d.weights.length - 1].weight : null,
          todayMeals: d.meals.filter((m) => m.date === t).map((m) => ({ name: m.name, cal: m.calories, type: m.mealType })),
          todayExercise: d.exerciseLog.filter((e) => e.date === t).map((e) => ({ name: e.name, min: e.duration })),
          todayWaterMl: d.water.filter((w) => w.date === t).reduce((s, w) => s + w.amount, 0),
          lastSleep: d.sleep.find((s) => s.date === t) || null,
          activeGoals: (d.goals || []).filter((g) => g.status !== 'done').map((g) => ({ id: g.id, title: g.title, type: g.type, target: g.target, unit: g.unit, endDate: g.endDate })),
          // 承诺 = 用户自己定下要做的；建议 = AI 拆出来的参考计划（不提醒、不算"没完成"）
          pendingTodoCount: d.todos.filter((x) => !x.done && x.plan !== 'suggested').length,
          pendingTodos: d.todos.filter((x) => !x.done && x.plan !== 'suggested').slice(0, 10).map((x) => ({ title: x.title, due: x.dueDate, atHome: !!x.atHome })),
          suggestedTodos: d.todos.filter((x) => !x.done && x.plan === 'suggested' && x.dueDate >= t).slice(0, 15).map((x) => ({ title: x.title, due: x.dueDate, goalId: x.goalId || null })),
          totalAssets: d.investments.reduce((s, i) => s + (i.amount || 0), 0),
        });
      },

      // 创建目标（移植自 index.html create_goal handler：跨键事务 goals+todos）
      async create_goal(a) {
        if (!a.title || !a.type || !(a.target > 0 || a.target === 0)) {
          throw new Error('create_goal 需要 title / type / target');
        }
        if (!['weight', 'saving', 'habit', 'custom'].includes(a.type)) {
          throw new Error('type 必须是 weight | saving | habit | custom');
        }
        let goalId = null;
        let milestones = 0;
        let autoTodos = 0;
        await store.tx((d) => {
          const g = {
            id: uid(),
            title: a.title, type: a.type, target: +a.target || 0,
            unit: a.unit || (a.type === 'weight' ? 'kg' : a.type === 'habit' ? '天' : ''),
            startDate: today(), endDate: a.endDate || addDays(today(), 90),
            status: 'active', milestones: [],
          };
          if (a.type === 'weight') g.startVal = d.weights.length ? d.weights[d.weights.length - 1].weight : 0;
          if (a.type === 'habit') g.habitField = a.habitField || 'stretching';
          g.milestones = decompose(g);
          const todos = genTodos(g);
          d.goals.push(g);
          if (todos.length) d.todos.push(...todos);
          goalId = g.id; milestones = g.milestones.length; autoTodos = todos.length;
        }, { source: 'agent' });
        return { goalId, milestones, autoTodos };
      },

      async add_weight(a) {
        if (!(a.weight > 0)) throw new Error('weight 必须是正数(kg)');
        const id = await appendItem('weights', { weight: +a.weight, date: a.date || today() });
        return { ok: true, id, weight: +a.weight, date: a.date || today() };
      },

      async add_meal(a) {
        if (!a.name) throw new Error('name 必填');
        const id = await appendItem('meals', {
          name: a.name, calories: +a.calories || 300, mealType: a.mealType || 'lunch',
          date: a.date || today(), note: a.note || '',
        });
        return { ok: true, id };
      },

      async add_exercise(a) {
        if (!a.name) throw new Error('name 必填');
        const id = await appendItem('exerciseLog', {
          name: a.name, duration: +a.duration || 30, calories: +a.calories || 0, date: a.date || today(),
        });
        return { ok: true, id };
      },

      async add_water(a) {
        if (!(a.amount > 0)) throw new Error('amount 必须是正数(ml)');
        const id = await appendItem('water', { amount: +a.amount, date: a.date || today(), note: a.note || '' });
        return { ok: true, id, amount: +a.amount };
      },

      // 按日期 upsert（移植自 index.html add_sleep handler）
      async add_sleep(a) {
        if (!(a.hours > 0)) throw new Error('hours 必须是正数');
        const d0 = a.date || today();
        let rid = null;
        await store.tx((d) => {
          const i = d.sleep.findIndex((x) => x.date === d0);
          const r = {
            id: i >= 0 ? d.sleep[i].id : uid(),
            hours: +a.hours, quality: +a.quality || 3,
            bedtime: a.bedtime || '23:30', wakeTime: a.wakeTime || '07:00', date: d0,
          };
          if (i >= 0) d.sleep[i] = r; else d.sleep.push(r);
          rid = r.id;
        }, { source: 'agent' });
        return { ok: true, id: rid, date: d0 };
      },

      async add_stretch(a) {
        if (!(a.duration > 0)) throw new Error('duration 必须是正数(分钟)');
        const id = await appendItem('stretching', { type: a.type || '拉伸', duration: +a.duration, date: a.date || today() });
        return { ok: true, id };
      },

      async add_beauty(a) {
        const id = await appendItem('beauty', { type: a.type || '护肤', date: a.date || today() });
        return { ok: true, id };
      },

      async add_meditation(a) {
        if (!(a.duration > 0)) throw new Error('duration 必须是正数(分钟)');
        const id = await appendItem('meditation', { duration: +a.duration, type: a.type || '正念冥想', date: a.date || today() });
        return { ok: true, id };
      },

      async add_todo(a) {
        if (!a.title) throw new Error('title 必填');
        const id = await appendItem('todos', {
          title: a.title, priority: a.priority || 'mid', done: false,
          dueDate: a.dueDate || today(), category: a.category || '',
          ...(a.atHome ? { atHome: true } : {}),
          ...(a.goalId ? { goalId: String(a.goalId) } : {}),
        });
        return { ok: true, id };
      },

      // 把目标拆成参考计划：一次写入一整份「建议」待办（不提醒、不算没完成；用户点「今天做」才变承诺）
      // 同一目标重新拆解时，替换该目标下尚未承诺、未完成的旧建议
      async suggest_plan(a) {
        const items = Array.isArray(a.items) ? a.items : [];
        if (!items.length) throw new Error('items 不能为空：[{ title, dueDate, priority? }]');
        if (items.length > 40) throw new Error('一次最多 40 条建议，计划宜少不宜多');
        const goalId = a.goalId ? String(a.goalId) : '';
        const t = today();
        const clean = [];
        for (const x of items) {
          const title = typeof x?.title === 'string' ? x.title.trim().slice(0, 80) : '';
          if (!title) continue;
          const due = typeof x.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate) ? x.dueDate : t;
          clean.push({
            id: uid(), title, done: false, plan: 'suggested',
            priority: ['high', 'mid', 'low'].includes(x.priority) ? x.priority : 'mid',
            dueDate: due < t ? t : due, category: typeof x.category === 'string' ? x.category.slice(0, 20) : '',
            ...(goalId ? { goalId } : {}),
          });
        }
        if (!clean.length) throw new Error('没有有效的建议条目（每条需要 title）');
        let replaced = 0;
        await store.tx((d) => {
          if (goalId) {
            const before = d.todos.length;
            d.todos = d.todos.filter((x) => !(x.goalId === goalId && x.plan === 'suggested' && !x.done));
            replaced = before - d.todos.length;
          }
          d.todos.push(...clean);
        }, { source: 'agent' });
        const days = [...new Set(clean.map((x) => x.dueDate))].sort();
        return { ok: true, added: clean.length, replaced, days, note: '已写入为「建议」。用户在「今天」里点「今天做」才会变成承诺并参与提醒。' };
      },

      // count → rruleUntil 换算（移植自 index.html add_schedule handler）
      async add_schedule(a) {
        if (!a.title || !a.startTime) throw new Error('title 和 startTime 必填');
        let until = a.rruleUntil || '';
        const rrule = a.rrule && a.rrule !== 'none' ? a.rrule : '';
        if (!until && a.count && rrule) {
          const d = new Date((a.date || today()) + 'T00:00:00');
          const n = Math.max(1, Math.floor(+a.count || 1));
          if (rrule === 'weekly') d.setDate(d.getDate() + (n - 1) * 7);
          else if (rrule === 'biweekly') d.setDate(d.getDate() + (n - 1) * 14);
          else if (rrule === 'daily') d.setDate(d.getDate() + (n - 1));
          else if (rrule === 'monthly') d.setMonth(d.getMonth() + (n - 1));
          until = fmtDate(d);
        }
        const id = await appendItem('schedule', {
          title: a.title, date: a.date || today(),
          startTime: a.startTime || '09:00', endTime: a.endTime || '',
          category: a.category || 'life', note: a.note || '',
          rrule, rruleDays: (a.rruleDays || []).map(Number), rruleUntil: until,
        });
        return { ok: true, id, rrule, rruleUntil: until };
      },

      async add_transaction(a) {
        if (!a.type || !['expense', 'income'].includes(a.type)) throw new Error('type 必须是 expense | income');
        if (!(a.amount > 0)) throw new Error('amount 必须是正数');
        const id = await appendItem('transactions', {
          date: a.date || today(), type: a.type, amount: +a.amount,
          category: a.category || '其他', note: a.note || '',
        });
        return { ok: true, id };
      },
    };
}

