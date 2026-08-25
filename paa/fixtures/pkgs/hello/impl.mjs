// 测试用 ToolPkg 实现（hello 包）
// createPkgTools(env) 返回 短名 → handler 映射；handler 签名 (args, ctx) => Promise<unknown>
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createPkgTools(env) {
  return {
    greet: async (args) => `你好，${args.who}！来自 pkg hello@0.1.0`,
    write_note: async (args, ctx) => {
      const file = path.join(env.pkgDir, 'notes.txt');
      await writeFile(file, `${String(args.text)}\n`, { flag: 'a', encoding: 'utf8' });
      ctx.audit(`[hello] 写入笔记 → ${file}`);
      return { wrote: file, text: String(args.text) };
    },
    // boom 被 manifest permissions.forbid 声明 → 加载后 Permission 硬拒绝，这里实现写了也不可达
    boom: async () => 'boom（不应可达）',
  };
}
