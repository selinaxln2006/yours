import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from '../server/confirm-edit.ts';

test('applyEdits：只改已有字段、类型不变；新增字段和换类型都忽略', () => {
  const a: Record<string, unknown> = { name: '什么', calories: 300, mealType: 'lunch', atHome: false, items: [1] };
  const r = applyEdits(a, { name: '三文鱼饭团', calories: 420, mealType: 5, extra: 'x', atHome: true, items: 'no', calories2: 1 });
  assert.deepEqual(r.changed, ['name', 'calories', 'atHome']);
  assert.deepEqual(a, { name: '三文鱼饭团', calories: 420, mealType: 'lunch', atHome: true, items: [1] });
  assert.deepEqual(applyEdits(a, null).changed, []);
  assert.deepEqual(applyEdits(a, { calories: Number.NaN }).changed, []);
});
