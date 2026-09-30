// ============================================================
// 沙箱路径解析：把 agent 给的相对路径限制在 root 内
// 只做字符串层面的 path.resolve 不够——root 里一个指向外部的符号链接
// （如 link -> /etc 或 C:\Users\me\.ssh）就能绕过。这里按「真实路径」再校验一次。
// ============================================================

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 解析 rel 为 root 内的绝对路径，越界（含经符号链接越界）抛错。
 * 目标不存在时（写新文件）校验其最近的已存在祖先目录。
 */
export function resolveInside(root: string, rel: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (!isInside(abs, absRoot)) throw new Error(`路径超出沙箱: ${rel}`);

  // 找最近的已存在路径（lstat：悬空符号链接也算"存在"，不能跳过它去看父目录）
  let probe = abs;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      probe = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    // 悬空符号链接：写入会穿透到链接目标，目标位置无法确认 → 拒绝
    throw new Error(`路径超出沙箱（无法解析的符号链接）: ${rel}`);
  }
  if (!isInside(real, realOrSelf(absRoot))) throw new Error(`路径超出沙箱（符号链接指向外部）: ${rel}`);
  return abs;
}
