/* util.js — 纯工具函数（宿主无关，与前端 U 对象对齐） */
export function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function now() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
