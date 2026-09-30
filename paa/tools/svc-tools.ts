// ============================================================
// PAA 本地 server 服务管理工具（Windows 专用）— 解决 G8 L1
// 背景：agent 改完 server/main.ts 后旧进程仍占端口 → /api/* 404，
//       但 agent 没有"杀旧 + 重启"的能力（r6 verify 撞墙根因）。
// 安全边界：只操作 PAA 专属端口 18765；8765 被其它项目占用，永不触碰。
// 依赖：tools/start-server.ps1（幂等：端口已监听则 exit 0）
// ============================================================

import { execFile, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../core/types.ts';

const PAA_PORT = 18765;

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function findListeningPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await run('netstat.exe', ['-ano'], 8000);
    const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'm');
    const m = stdout.match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
    // 200=正常；401/403=门禁拦截（无 token），但 server 活着且响应——都算存活
    return r.status === 200 || r.status === 401 || r.status === 403;
  } catch {
    return false;
  }
}

export function createSvcTools(root: string): ToolDefinition[] {
  return [
    {
      name: 'svc_status',
      desc: '检查 PAA 本地 server 是否存活（PAA 专属端口 18765）。返回 PID + /api/health 状态。改完 server 代码后先查这个判断是否需要重启',
      params: {},
      risk: 1,
      handler: async () => {
        const pid = await findListeningPid(PAA_PORT);
        const ok = await healthOk(PAA_PORT);
        return {
          port: PAA_PORT,
          pid,
          health: ok ? 'ok' : pid ? 'down(端口被占但健康检查失败)' : 'down',
          hint: ok ? 'server 正常' : 'server 未响应 → 用 svc_restart 重启（改了 server/main.ts 后旧进程不会自动加载新代码）',
        };
      },
    },
    {
      name: 'svc_restart',
      desc: '重启 PAA 本地 server：杀 18765 旧进程（含进程树）→ 直接 spawn node paa/server/main.ts（PAA_PORT=18765，日志 append 到 paa/server.log）→ 轮询健康检查至多 75s。用途：改完 server/main.ts / 新加 /api 路由后让新代码生效',
      params: {},
      risk: 3,
      handler: async () => {
        const pid = await findListeningPid(PAA_PORT);
        const killed: number[] = [];
        if (pid) {
          // /T 杀进程树：server 的子进程（agent/CLI）会继承 server.log 句柄，不杀树锁不释放
          await run('taskkill.exe', ['/F', '/T', '/PID', String(pid)], 8000);
          killed.push(pid);
          // 等 1.5s：确保文件锁释放，否则 ps1 的 Redirect 会失败
          await new Promise((r) => setTimeout(r, 1500));
        }
        // 直接 spawn node server（绕开 powershell + ps1：detached+stdio:ignore 下 ps1 在部分 Windows 上不执行）
        // 日志 append 打开：若被杀进程刚释放锁，openSync 失败则 1s 重试（最多 5 次）
        const logFile = path.join(root, 'paa', 'server.log');
        const errFile = path.join(root, 'paa', 'server.err.log');
        let outFd: number | null = null;
        let errFd: number | null = null;
        for (let i = 0; i < 5 && (outFd === null || errFd === null); i++) {
          try {
            if (outFd === null) outFd = openSync(logFile, 'a');
            if (errFd === null) errFd = openSync(errFile, 'a');
          } catch {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        if (outFd === null || errFd === null) {
          return { port: PAA_PORT, killedPids: killed, error: '无法打开日志文件（文件锁未释放）' };
        }
        const nodeBin = process.execPath;
        const serverMain = path.join(root, 'paa', 'server', 'main.ts');
        const child = spawn(nodeBin, [serverMain], {
          cwd: root,
          detached: true,
          stdio: ['ignore', outFd, errFd],
          env: { ...process.env, PAA_PORT: String(PAA_PORT) },
          windowsHide: true,
        });
        child.on('error', (e) => {
          void e;
        });
        child.unref();
        // Node 冷启动实测 ~30s，轮询放宽到 75s（每 1.5s 一次 × 50）
        let up = false;
        let waited = 0;
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          waited += 1.5;
          if (await healthOk(PAA_PORT)) {
            up = true;
            break;
          }
        }
        return {
          port: PAA_PORT,
          killedPids: killed,
          started: up,
          health: up ? 'ok' : 'timeout',
          waitedSec: Math.round(waited),
          next: up ? '新代码已生效 → 重跑 curl 验证刚才失败的 API' : '启动超时 → 读 paa/server.err.log + paa/server.log 尾部排查',
        };
      },
    },
  ];
}
