// ============================================================
// 终端渲染 — PAA CLI 外观层
// ANSI 256 色 + 卡片框线；告别"丑 CLI"
// ============================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[38;5;81m',
  green: '\x1b[38;5;114m',
  yellow: '\x1b[38;5;222m',
  red: '\x1b[38;5;203m',
  gray: '\x1b[38;5;245m',
  blue: '\x1b[38;5;117m',
  magenta: '\x1b[38;5;176m',
};

export const render = {
  banner(): string {
    return [
      `${C.cyan}┌─────────────────────────────────────────────┐${C.reset}`,
      `${C.cyan}│${C.reset}  ${C.bold}PAA v2${C.reset} — Personal AI Agent Framework`,
      `${C.cyan}│${C.reset}  ${C.dim}大脑层自研 · 参考 DSH/Operit/TencentDB 设计思想${C.reset}`,
      `${C.cyan}└─────────────────────────────────────────────┘${C.reset}`,
      '',
    ].join('\n');
  },

  user(text: string): string {
    return `${C.cyan}${C.bold}你 ›${C.reset} ${text}`;
  },

  assistant(text: string): string {
    return `${C.green}${C.bold}枢 ›${C.reset} ${text}`;
  },

  toolCard(name: string, args: Record<string, unknown>, result: { ok: boolean; data?: unknown; error?: string }): string {
    const w = 60;
    const line = (s: string) => `${C.magenta}│${C.reset} ${s.padEnd(w - 4)}${C.magenta}│${C.reset}`;
    const head = `${C.magenta}┌─ ${C.bold}⚙ ${name}${C.reset}${C.magenta}${'─'.repeat(Math.max(0, w - name.length - 5))}┐${C.reset}`;
    const foot = `${C.magenta}└${'─'.repeat(w - 2)}┘${C.reset}`;
    const argStr = JSON.stringify(args);
    const resStr = result.ok
      ? JSON.stringify(result.data).slice(0, 400)
      : `❌ ${result.error}`;
    return [
      head,
      line(`${C.dim}参数${C.reset} ${argStr.slice(0, w - 10)}${argStr.length > w - 10 ? '…' : ''}`),
      line(`${C.dim}结果${C.reset} ${resStr.slice(0, w - 10)}${resStr.length > w - 10 ? '…' : ''}`),
      foot,
    ].join('\n');
  },

  audit(line: string): string {
    return `${C.gray}${line}${C.reset}`;
  },

  status(text: string): string {
    return `${C.dim}${text}${C.reset}`;
  },

  error(text: string): string {
    return `${C.red}✗ ${text}${C.reset}`;
  },

  prompt(): string {
    return `${C.bold}你 ›${C.reset} `;
  },

  ask(prompt: string): string {
    return `${C.yellow}${C.bold}? ${prompt}${C.reset} ${C.dim}(y/n)${C.reset}`;
  },
};
