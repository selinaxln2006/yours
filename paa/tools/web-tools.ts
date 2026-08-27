// ============================================================
// 网络工具集（v1.1 聪明度补丁：补齐 web 能力，零第三方依赖）
// Node 24 内置 fetch；DuckDuckGo HTML 端点做搜索（无需 API key）
// 安全：web_download 只写沙箱 downloads/ 内；所有请求 15s 超时
// ============================================================

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExecContext, ToolDefinition } from '../core/types.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 15_000;
const MAX_TEXT = 8000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** HTML → 可读文本：去 script/style/标签/实体/多余空白 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** 从 URL 提取安全的文件名（防路径穿越/非法字符） */
function safeBasename(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').pop() || 'index.html');
    const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
    return cleaned || 'index.html';
  } catch {
    return 'download.bin';
  }
}

/** DDG 结果 href 是重定向链接，解出真实 URL */
function decodeDdgHref(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg || href;
  } catch {
    return href;
  }
}

export function createWebTools(): ToolDefinition[] {
  return [
    {
      name: 'web_fetch',
      desc: '抓取网页内容并转为纯文本（自动跳过脚本/样式，截断 8000 字符）',
      params: {
        url: { type: 'string', desc: '完整 URL（http/https）' },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const url = String(args.url);
        if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
          redirect: 'follow',
          signal: timeoutSignal(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const ctype = String(res.headers.get('content-type') || '');
        const buf = Buffer.from(await res.arrayBuffer());
        if (/html|xml|text|json/.test(ctype) || ctype === '') {
          const raw = buf.toString('utf8').replace(/^\uFEFF/, '');
          const text = htmlToText(raw).slice(0, MAX_TEXT);
          if (!text) throw new Error('页面无可见文本内容（可能是 JS 渲染页，需用 shell 或另找来源）');
          return { url, bytes: buf.length, truncated: buf.length > MAX_TEXT, text };
        }
        return { url, bytes: buf.length, type: ctype, note: '非文本内容，未读取（可考虑 web_download）' };
      },
    },
    {
      name: 'web_search',
      desc: '网页搜索（DuckDuckGo，无需 key）。返回标题/链接/摘要，最多 N 条',
      params: {
        query: { type: 'string', desc: '搜索关键词' },
        max: { type: 'number', desc: '结果条数，默认 5，最多 10', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const query = String(args.query);
        const max = Math.min(Number(args.max ?? 5), 10);
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html' },
          redirect: 'follow',
          signal: timeoutSignal(),
        });
        if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
        const html = await res.text();
        // DDG html 端点：result__a 是标题+链接，result__snippet 是摘要
        const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const titles: { href: string; title: string }[] = [];
        const snippets: string[] = [];
        // 过滤 DDG 广告位（bing ad 重定向），只留真实结果
        const AD_RE = /(duckduckgo\.com\/y\.js|bing\.com\/aclick)/i;
        let m: RegExpExecArray | null;
        while ((m = titleRe.exec(html)) && titles.length < max) {
          const href = decodeDdgHref(m[1]);
          if (AD_RE.test(href)) continue;
          titles.push({ href, title: htmlToText(m[2]).slice(0, 150) });
        }
        while ((m = snipRe.exec(html)) && snippets.length < max) {
          snippets.push(htmlToText(m[1]).slice(0, 300));
        }
        if (titles.length === 0) {
          return { query, count: 0, note: '无结果（可能被限流；稍后重试或换关键词）' };
        }
        return {
          query,
          count: titles.length,
          results: titles.map((t, i) => ({ ...t, snippet: snippets[i] ?? '' })),
        };
      },
    },
    {
      name: 'web_download',
      desc: '下载文件到沙箱 downloads/ 目录（供 skill 包/PDF 等二进制使用）',
      params: {
        url: { type: 'string', desc: '文件 URL' },
        as: { type: 'string', desc: '可选自定义文件名', required: false },
      },
      risk: 2,
      handler: async (args: Record<string, unknown>, ctx: ExecContext) => {
        const url = String(args.url);
        if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
        const dlDir = path.resolve(ctx.cwd, 'downloads');
        await mkdir(dlDir, { recursive: true });
        const name = args.as ? String(args.as).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') : safeBasename(url);
        const target = path.join(dlDir, name);
        if (target !== dlDir && !target.startsWith(dlDir + path.sep)) throw new Error('文件名非法');
        const res = await fetch(url, {
          headers: { 'user-agent': UA },
          redirect: 'follow',
          signal: timeoutSignal(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(target, buf);
        ctx.audit(`[AUTO] web_download ${url} → ${name} (${buf.length} bytes)`);
        return { saved: target, bytes: buf.length, name };
      },
    },
  ];
}
