// 确认卡上改参数（比如热量估错了、食物名不对）：只允许改原有的字段，且类型不变
// 不能新增字段、不能把数字改成字符串；字符串最长 500
export function applyEdits(orig: Record<string, unknown>, edits: unknown): { changed: string[] } {
  const changed: string[] = [];
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return { changed };
  for (const [k, v] of Object.entries(edits as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(orig, k)) continue;
    const o = orig[k];
    if (typeof o === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      if (o !== v) { orig[k] = v; changed.push(k); }
    } else if (typeof o === 'string' && typeof v === 'string') {
      const s = v.slice(0, 500);
      if (o !== s) { orig[k] = s; changed.push(k); }
    } else if (typeof o === 'boolean' && typeof v === 'boolean') {
      if (o !== v) { orig[k] = v; changed.push(k); }
    }
  }
  return { changed };
}
