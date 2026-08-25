// ============================================================
// 产物工具集（G7，C1 支柱）
// 命名纪律：工具名只允许 [a-zA-Z0-9_-]（LLM function calling 硬约束）
// 权限设计（对齐设计文档 + 内部动作大胆）：
//   artifact_read / list / versions → risk 1 读，自动放行
//   artifact_create / update        → risk 3 写，默认确认（产物是外部可见文件）
// 产物 = 磁盘真文件（artifacts/<path>），fs_read 可直接读同一文件 → 打通 C1 与既有工具
// ============================================================

import type { ArtifactProvider } from '../core/artifact-provider.ts';
import type { ToolDefinition } from '../core/types.ts';

export function createArtifactTools(provider: ArtifactProvider): ToolDefinition[] {
  return [
    {
      name: 'artifact_create',
      desc: '创建产物（落盘为真实文件 artifacts/<path>，可被 fs_read 直接读取）。产物用于交付持久成果：计划/报告/代码/数据文件',
      params: {
        title: { type: 'string', desc: '产物标题（人类可读）' },
        path: { type: 'string', desc: '相对路径（主键），如 plans/fat-loss-plan.md、src/model.py' },
        content: { type: 'string', desc: '文件内容' },
        type: { type: 'string', desc: '类型：md/code/json/html/data 或其他，默认 md', required: false },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const meta = await provider.create({
          title: String(args.title ?? 'untitled'),
          type: String(args.type ?? 'md'),
          path: String(args.path),
          content: String(args.content ?? ''),
        });
        return { created: meta.path, version: meta.version, title: meta.title };
      },
    },
    {
      name: 'artifact_update',
      desc: '更新产物内容（自动版本化：旧版快照存 <path>.v<N>，历史保留最近 5 版）',
      params: {
        path: { type: 'string', desc: '产物路径（同 create 时的 path）' },
        content: { type: 'string', desc: '新内容（全文覆盖）' },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const meta = await provider.update(String(args.path), String(args.content ?? ''));
        return { updated: meta.path, version: meta.version, snapshots: meta.history.length };
      },
    },
    {
      name: 'artifact_read',
      desc: '读取产物当前内容（含元数据：版本/时间戳/标题）',
      params: {
        path: { type: 'string', desc: '产物路径' },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const { meta, content } = await provider.read(String(args.path));
        return { meta, content };
      },
    },
    {
      name: 'artifact_list',
      desc: '列出所有产物（按更新时间倒序，含标题/路径/版本/类型）',
      params: {},
      risk: 1,
      handler: async () => {
        const list = await provider.list();
        return {
          count: list.length,
          artifacts: list.map(({ title, path, type, version, updatedAt }) => ({ title, path, type, version, updatedAt })),
        };
      },
    },
    {
      name: 'artifact_versions',
      desc: '查看产物版本历史（已快照的旧版列表，含版本号与快照文件路径）',
      params: {
        path: { type: 'string', desc: '产物路径' },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const history = await provider.versions(String(args.path));
        return { path: String(args.path), history };
      },
    },
  ];
}
