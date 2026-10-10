#!/usr/bin/env node
/**
 * 命令行自检 —— 无图形界面时的等价诊断。
 *
 *   node tools/doctor.mjs           人类可读
 *   node tools/doctor.mjs --json    机器可读
 *
 * 与控制台页面的「环境诊断」共用 lib/diagnostics.mjs，结论必然一致。
 */
import config from '../config.mjs';
import { diagnose } from '../lib/diagnostics.mjs';

const asJson = process.argv.includes('--json');
const useColor = !asJson && process.stdout.isTTY;

/**
 * 问一次插件的运行时状态（`/workbuddy/status`），用来修正诊断的**迁移前口径**。
 *
 * 诊断库只看 settings.yaml / profile patch 里有没手写路由 —— 插件是**运行时注册**
 * 的，那两个文件里当然没有，于是永远误报 fail。dsh 在跑时以运行时事实为准。
 *
 * 拿不到（dsh 没开 / 旧宿主）就返回 null，保留原判定 —— 不把"不知道"粉饰成"通过"。
 *
 * 端口从 `DSH_WEB_URL` 取（dsh 自己会设这个环境变量），拿不到才退回默认值。
 * 刻意不扫端口表：那要起 netstat 子进程，而本脚本末尾会 `process.exit()`，
 * 子进程句柄还没关就被退出会触发 libuv 的 `UV_HANDLE_CLOSING` 断言崩溃 ——
 * 为一个"锦上添花"的修正引入崩溃不值得。
 */
async function pluginRouteStatus() {
  const bases = [];
  const fromEnv = String(process.env.DSH_WEB_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) bases.push(fromEnv);
  if (!bases.includes('http://127.0.0.1:19387')) bases.push('http://127.0.0.1:19387');

  for (const base of bases) {
    try {
      const res = await fetch(`${base}/workbuddy/status`, {
        signal: AbortSignal.timeout(1500),
        // 明确不要 keep-alive：池里留下来的空闲 socket 会让本脚本末尾的
        // `process.exit()` 撞上 libuv 的 UV_HANDLE_CLOSING 断言（Windows 上
        // 直接崩，退出码 0xC0000409）。诊断只发这一两次请求，没有复用价值。
        headers: { connection: 'close' },
      });
      if (!res.ok) continue;
      const body = await res.json();
      // 认准是自家插件：有 route 字段才算，避免撞上别的 HTTP 服务
      if (body?.route) return body.route.registered ? (body.route.provider || 'workbuddy') : null;
    } catch {
      /* 这个地址不通，试下一个 */
    }
  }
  return null;
}

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const paint = (text, color) => (useColor ? `${color}${text}${C.reset}` : text);

const MARK = {
  ok: { sym: '[✓]', color: C.green },
  warn: { sym: '[!]', color: C.yellow },
  fail: { sym: '[✗]', color: C.red },
};

const result = await diagnose();
const liveProvider = await pluginRouteStatus();
if (liveProvider) {
  for (const item of result.items) {
    if ((item.id === 'settings' || item.label === 'dsh 模型路由') && item.status === 'fail') {
      item.status = 'ok';
      item.detail = `原生 provider=${liveProvider}（插件运行时注册，无需 settings.yaml）`;
      item.hint = null;
      result.summary.fail = Math.max(0, (result.summary.fail || 1) - 1);
      result.summary.ok = (result.summary.ok || 0) + 1;
    }
  }
}

/**
 * 收尾前关掉 undici 的 keep-alive 连接池。
 *
 * 不关会崩：本脚本末尾用 `process.exit()` 立刻结束，而池里的 socket 句柄还开着
 * —— Windows 上 libuv 会在退出路径断言 `!(handle->flags & UV_HANDLE_CLOSING)`
 * 并让进程以 0xC0000409 终止。表现是**诊断结果全绿、退出码却是崩溃**，
 * 很容易让人以为自检没通过。
 *
 * 只有真的发过请求才需要关；`close()` 抛错也不影响已算出的结论。
 */
async function closeHttpPool() {
  try {
    const undici = await import('undici');
    if (typeof undici?.getGlobalDispatcher === 'function') {
      await undici.getGlobalDispatcher()?.close?.();
    }
  } catch {
    /* 没有 undici（老 Node）就无所谓 */
  }
}
await closeHttpPool();

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(paint('WorkBuddy 中转自检', C.bold));
  console.log(paint('─'.repeat(64), C.dim));
  console.log(`${paint('配置根', C.dim)}      ${config.paths.root}`);
  console.log(`${paint('桥', C.dim)}          ${config.bridge.url}/v1`);
  console.log(`${paint('控制台', C.dim)}      ${config.dashboard.url}`);
  console.log(`${paint('登录文件', C.dim)}    ${config.workbuddy.authFile}`);
  console.log(`${paint('WorkBuddy', C.dim)}   ${config.workbuddy.exe || '（未自动定位，见下方诊断）'}`);
  console.log(`${paint('dsh 运行时', C.dim)}  ${config.dsh.runtime || '（未自动定位，可用 DSH_RUNTIME 指定）'}`
    + (config.dsh.desktopVersion ? `  (DSH ${config.dsh.desktopVersion})` : ''));
  console.log('');

  for (const item of result.items) {
    const mark = MARK[item.status];
    const label = item.label.padEnd(18, ' ');
    console.log(`${paint(mark.sym, mark.color)} ${paint(label, C.bold)} ${item.detail}`);
    if (item.hint) {
      console.log(`      ${paint('└ 建议：' + item.hint, C.yellow)}`);
    }
  }

  console.log('');
  const { ok, warn, fail } = result.summary;
  const verdict = fail > 0
    ? paint('存在必须修复的问题，模型不会出现在 dsh 的模型选择器里。', C.red)
    : warn > 0
      ? paint('可以工作，但有需要留意的项。', C.yellow)
      : paint('全部通过。', C.green);
  console.log(`${paint('结果', C.bold)}  ${ok} 项通过 / ${warn} 项警告 / ${fail} 项失败 —— ${verdict}`);
}

/**
 * 用 exitCode 收尾，而不是 `process.exit()`。
 *
 * `process.exit()` 会立刻终止进程：本脚本为改判「模型路由」发过 HTTP 请求，
 * undici 的 keep-alive 池里留着未关闭的 socket，libuv 在退出路径上会断言
 * `!(handle->flags & UV_HANDLE_CLOSING)` 并让进程崩成 0xC0000409 ——
 * 表现为「诊断 8 项全绿，退出码却是崩溃」，极易误判为自检未通过。
 *
 * 设置 exitCode 让 Node 正常走完退出流程，句柄得以关闭，退出码语义保持不变。
 */
process.exitCode = result.summary.fail > 0 ? 1 : 0;
