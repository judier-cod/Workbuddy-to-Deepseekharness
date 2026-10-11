/**
 * 「重启控制台」必须真的重启。
 *
 * ## 背景（实测踩出来的）
 *
 * 用户报"环境诊断这一项还是没变"，而**代码确实改了**：
 *
 *     控制台进程启动  10-11 23:33:26
 *     diagnostics.mjs 改动  10-12 00:01:02   ← 晚 28 分钟
 *
 * 诊断页的数据来自**控制台服务**（`/api/diagnose`），不是插件 —— 而控制台是
 * **detached 的、活过 dsh 重启**的独立进程。于是：
 *
 *   1. 改 `lib/diagnostics.mjs` 只重启 dsh **没用**，控制台还在跑旧代码；
 *   2. 点「重启控制台」也**没用** —— 路由层把 `action: 'restart'` 落到
 *      `ensure({})`，而 `ensure` 发现进程在跑就复用；`ConsoleSupervisor.ensure()`
 *      当时**根本不接受 `restart` 参数**。实测：点了重启 pid 纹丝不动
 *      （23164 → 23164）。
 *
 * 修法：`ensure({restart})` → 先 `stop()` 再 `start()`；而 `stop()` 要能认出
 * "上一轮启动、现在还在跑"的控制台 —— 靠 `dashboard/console.pid` 落盘文件，
 * 以及（`adoptPort` 时）从端口反查 pid。
 *
 * 这个文件钉住四件事：
 *   1. `ensure` 接受并转发 `restart`（不是静默忽略）；
 *   2. `stop()` 在内存 pid 为空时，回退到 pid 文件 / 端口反查；
 *   3. 普通 `stop()` **不**用端口反查（用户手动起的实例不该被插件停）；
 *   4. 路由层把 `action: 'restart'` 真的传下去，且如实回报 `action`。
 *
 *   node --test dsh-plugin/tests/console-restart.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(p, 'utf8');

const CONSOLE = join(HERE, '..', 'lib', 'console.mjs');
const ROUTES = join(HERE, '..', 'lib', 'routes.mjs');

test('ConsoleSupervisor.ensure 接受 restart 并真的先停后起（不是静默忽略）', () => {
  const src = read(CONSOLE);

  // ① 签名里有 restart
  const ensureSig = src.match(/async ensure\(\{([^}]*)\}/);
  assert.ok(ensureSig, '应当能定位到 ensure 的签名');
  assert.match(ensureSig[1], /restart/, 'ensure 必须接受 restart 参数 —— 否则调用方传了也是白传');

  // ② restart 要转发给内部实现
  assert.match(src, /#ensure\(\{\s*signal,\s*readyTimeoutMs,\s*restart\s*\}\)/,
    'ensure 必须把 restart 转发给 #ensure');

  // ③ 运行中 + restart 时必须先 stop
  const block = src.match(/if \(status\.state === 'running' && restart\)[\s\S]*?\n    \}/);
  assert.ok(block, "应当有 `status.state === 'running' && restart` 的分支");
  assert.match(block[0], /this\.stop\(/, '该分支必须先停掉旧进程');
  assert.match(block[0], /adoptPort:\s*true/, '重启是明确动作，允许端口反查认领控制台');

  // ④ 运行中且**不**重启时仍然复用（别把普通 ensure 变成每次都重启）
  assert.match(src, /status\.state === 'running' && !restart\)\s*return \{ ok: true, started: false, reused: true/,
    '非 restart 的 ensure 必须保持"复用"语义');
});

test('stop()：内存 pid 为空时回退到 pid 文件与端口反查', () => {
  const src = read(CONSOLE);

  const stopFn = src.match(/async stop\(\{ adoptPort = false \} = \{\}\)[\s\S]*?\n  \}/);
  assert.ok(stopFn, 'stop 应当接受 { adoptPort } 选项');
  assert.match(stopFn[0], /readPidFile\(this\.pidFile\)/,
    'stop 必须回退到 console.pid 文件 —— 控制台活过 dsh 重启，内存里没有 pid');
  assert.match(stopFn[0], /adoptPort \? findPortPid\(this\.port\) : null/,
    '端口反查必须**只在 adoptPort 时**启用（用户手动起的实例不该被停）');

  // pid 文件必须真的被写与清
  assert.match(src, /writePidFile\(this\.pidFile/, 'start() 成功后必须记下 pid');
  assert.match(src, /clearPidFile\(this\.pidFile\)/, 'stop() 成功后必须清掉 pid 记录');

  // 读 pid 文件时必须确认进程还活着（否则会误杀复用该 pid 的无关进程）
  const reader = src.match(/function readPidFile\([\s\S]*?\n\}/);
  assert.ok(reader, '应当有 readPidFile');
  assert.match(reader[0], /process\.kill\(pid,\s*0\)/,
    'readPidFile 必须用信号 0 确认进程还在 —— 残留 pid 会被复用给别的进程');
});

test('路由层：action=restart 必须真的传下去，并如实回报 action', () => {
  const src = read(ROUTES);
  const block = src.match(/path: '\/workbuddy\/console'[\s\S]*?\n    \},/);
  assert.ok(block, '应当能定位到 /workbuddy/console 的路由');

  assert.match(block[0], /wantRestart/, '路由层应当识别 restart');
  assert.match(block[0], /ensure\(\{\s*restart:\s*wantRestart\s*\}\)/,
    'restart 必须传给 ensure —— 原先落在 ensure({}) 上，于是"重启"变成了"复用"');
  // 回报的 action 不能硬编码成 'start'（否则连"做了什么"都看不出来）
  assert.doesNotMatch(block[0], /action: 'start'/,
    "不该把 action 硬编码成 'start' —— 那让 restart 在返回值里看不出来");
});
