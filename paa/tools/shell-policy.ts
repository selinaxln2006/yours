// ============================================================
// shell 命令策略：硬拒绝（不可逆的毁灭性操作）+ 危险（--yes 全自动模式下也要停下来问人）
// 不是安全边界——真正的防线是确认卡；这里只把"显然危险"的写法认出来，包括常见的绕过写法
// （参数换序、分开写、大小写、PowerShell 别名）
// ============================================================

/** 归一化：小写、合并空白、去掉引号，便于匹配 */
function norm(cmd: string): string {
  return cmd.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

/** 按 ; && || | 换行 拆成子命令（粗略，够用于识别） */
function segments(cmd: string): string[] {
  return norm(cmd).split(/\s*(?:&&|\|\||;|\n|&(?!>))\s*/).filter(Boolean);
}

/** 一个子命令里 unix 风格短参数的字母集合（-rf / -r -f / -fr / --recursive --force 都认） */
function flagLetters(seg: string): Set<string> {
  const out = new Set<string>();
  for (const tok of seg.split(' ').slice(1)) {
    if (/^-[a-z]+$/.test(tok)) for (const c of tok.slice(1)) out.add(c);
    if (tok === '--recursive') out.add('r');
    if (tok === '--force') out.add('f');
  }
  return out;
}

const HARD: Array<[RegExp, string]> = [
  [/^(format|format\.com)\s+[a-z]:/, '格式化磁盘'],
  [/\bmkfs(\.\w+)?\b/, '格式化磁盘'],
  [/\bdiskpart\b/, '磁盘分区'],
  [/\bdd\s+.*\bof=\/dev\//, '写裸设备'],
  [/\b(shutdown|poweroff|halt|reboot)\b/, '关机/重启'],
  [/\b(stop|restart)-computer\b/, '关机/重启'],
  [/\bcipher\s+\/w\b/, '擦除磁盘'],
  [/\breg\s+delete\b/, '删除注册表'],
  [/\bremove-itemproperty\b.*\bhk(lm|cu)\b/, '删除注册表'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork 炸弹'],
];

const RISKY: Array<[RegExp, string]> = [
  [/^(del|erase)\b/, '删除文件'],
  [/^(rd|rmdir)\b/, '删除目录'],
  [/^(remove-item|ri|rm|rmdir|del|erase|rd)\b/, '删除'],
  [/^(unlink|shred|trash)\b/, '删除'],
  [/^git\s+(push\s+.*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-d)/, '改写/丢弃 git 历史或改动'],
  [/^git\s+push\b/, '推送到远端'],
  [/^(npm|pnpm|yarn)\s+publish\b/, '发布包'],
  [/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b.*\|\s*(sh|bash|zsh|iex|invoke-expression|python|node)\b/, '下载并执行'],
  [/^(iex|invoke-expression)\b/, '执行任意代码'],
  [/^(chmod|chown|icacls|takeown|cacls)\b/, '改权限'],
  [/^set-executionpolicy\b/, '改执行策略'],
  [/^(schtasks|crontab|at)\b/, '计划任务'],
  [/^(kill|killall|pkill|taskkill|stop-process)\b/, '结束进程'],
  [/^(setx|\[environment\]::setenvironmentvariable)\b/, '改系统环境变量'],
  [/^(sudo|runas)\b/, '提权'],
  [/^(mv|move|move-item|ren|rename-item)\b/, '移动/重命名'],
  [/(?<![>0-9])>(?!>)\s*(?!nul\b|\/dev\/null\b|&)\S/, '覆盖写文件'],
];

export interface ShellVerdict {
  level: 'ok' | 'risky' | 'blocked';
  reason?: string;
}

export function classifyShell(cmd: string): ShellVerdict {
  const segs = segments(cmd);
  for (const s of segs) {
    for (const [re, why] of HARD) if (re.test(s)) return { level: 'blocked', reason: why };
    // 递归 + 强制删除：rm -rf / rm -r -f / Remove-Item -Recurse -Force（任意顺序、缩写）
    const f = flagLetters(s);
    if (/^(rm|rmdir)\b/.test(s) && f.has('r') && f.has('f')) return { level: 'blocked', reason: '递归强制删除' };
    if (/^(remove-item|ri|rm|del|erase|rd|rmdir)\b/.test(s) && /\s-r(e(c(u(r(s(e)?)?)?)?)?)?\b/.test(s) && /\s-fo(r(c(e)?)?)?\b/.test(s)) {
      return { level: 'blocked', reason: '递归强制删除' };
    }
    if (/^(del|erase|rd|rmdir)\b/.test(s) && /\s\/s\b/.test(s) && /\s\/q\b/.test(s)) return { level: 'blocked', reason: '递归静默删除' };
  }
  for (const s of segs) {
    for (const [re, why] of RISKY) if (re.test(s)) return { level: 'risky', reason: why };
  }
  return { level: 'ok' };
}
