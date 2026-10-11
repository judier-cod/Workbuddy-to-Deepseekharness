/**
 * 「自动签到发生后，界面能感知到」这条链路的回归测试。
 *
 * ## 背景（这是实测踩出来的，不是假想）
 *
 * 自动签到有两条**后台**路径：有人调模型时由桥补签、控制台启动时与每小时各一次。
 * 它们发生时**没有任何东西通知界面**。而签到面板原先只在"首次加载"与"手动操作"时
 * 刷新，于是出现了这样的现场：
 *
 *     桥日志   [2026-10-04T16:12:01.683Z] auto checkin ok 100
 *     同一时刻 页面仍显示「今日尚未签到」
 *
 * 用户据此以为"自动签到没生效"，其实积分早已到账。这属于**结论在说谎**，
 * 比不显示更糟 —— 所以这里把它钉住。
 *
 * ## 修法：把"事件"变成依赖项，而不是用轮询去逼近
 *
 * 曾经想过给签到面板加一条 20/30 秒的轮询。那是错的：`/api/checkin` 与
 * `/workbuddy/checkin` 每次都要打**上游计费端点**，为了一个"一天只变一次"的状态
 * 去高频轮询纯属浪费，而且仍然慢（最长要等一个周期）。
 *
 * 正确做法是利用**已有的**信号：
 *   - 桥 `/health` 本来就返回 `autoCheckin`（`{at, result, credit?}`）；
 *   - 控制台 `/api/overview` 每 20 秒轮询、插件 `/workbuddy/status` 每 8 秒轮询；
 *   - 于是只需把这个信号透出来，界面比对 `at` 是否变化，变了才去刷签到面板。
 *   **零额外上游请求**，且延迟等于既有轮询周期。
 *
 * ## 这个文件钉住四件事
 *
 *   1. 控制台 `/api/overview` **必须**透出 `bridge.autoCheckin`（否则信号断在服务端）；
 *   2. 控制台页面的 `syncCheckinFromOverview` 语义：首次只见记基线、**at 变化才刷新**、
 *      桥没跑/旧构建（无该字段）时**不能**误判成"变了"；
 *   3. 控制台的签到面板**不得**被塞进高频轮询（用轮询逼近是错的方向）；
 *   4. 插件的 `useJson` 支持 `refreshKey`，且签到面板确实用它接上了信号。
 *
 *   node --test dsh-plugin/tests/checkin-signal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLIENT = join(HERE, '..', 'lib', 'client.js');
const BRIDGE = join(ROOT, 'bridge', 'workbuddy-bridge.mjs');
const CONSOLE_SERVER = join(ROOT, 'dashboard', 'server.mjs');
const CONSOLE_HTML = join(ROOT, 'dashboard', 'public', 'index.html');

const read = (p) => readFileSync(p, 'utf8');

// ── 1. 服务端：/api/overview 必须透出 autoCheckin ──────────────────────
test('控制台 /api/overview 必须透出桥的 autoCheckin（信号不能断在服务端）', () => {
  const src = read(CONSOLE_SERVER);
  // 取值必须来自桥的 /health body
  assert.match(src, /autoCheckin:\s*health\.body\?\.autoCheckin/,
    'overview 的 bridge.autoCheckin 应当直接取自桥 /health 的 body');
  // 开关也要带出来，面板要据此显示"自动签到：开启/关闭"
  assert.match(src, /autoCheckinEnabled:\s*health\.body\?\.autoCheckinEnabled\s*===\s*true/,
    'overview 应当同时透出 autoCheckinEnabled（否则面板无法显示桥侧开关的真实状态）');
});

// ── 2. 控制台页面：syncCheckinFromOverview 的语义 ──────────────────────
test('控制台页面：at 变化才刷新；首次只记基线；无信号时不误判', () => {
  const html = read(CONSOLE_HTML);
  const m = html.match(/function syncCheckinFromOverview\(bridge\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'index.html 里应当有 syncCheckinFromOverview 函数');
  const fnSource = m[0];

  /**
   * 把真实函数体放进 vm 沙箱**执行**，而不是做结构断言。
   *
   * 为什么改掉结构断言：变异测试抓到过漏网 —— 在 `return` 之后不可达的位置放一句
   * `loadCheckin()`，或在刷新之前塞一个条件 return，位置顺序断言全都发现不了。
   * 结构断言只能证明"代码长这样"，证明不了"行为是这样"；而这条修复的全部意义
   * 就在行为（刷新到底会不会发生）。所以这里把函数放进沙箱真跑一遍，
   * `loadCheckin` 与状态变量由沙箱桩提供，断言的是调用次数。
   */
  const sandboxCode = `
    let seenAutoCheckinAt = null;   // 与 index.html 里的模块级 let 同名同义
    let loadCheckinCalls = 0;
    function loadCheckin() { loadCheckinCalls += 1; }
    ${fnSource}
    // let/const 声明不会挂到 vm 的全局对象上（ES 语义），函数声明才会；
    // 所以这里显式挂一个取状态的出口，测试才能读到调用计数。
    globalThis.__getCalls = () => loadCheckinCalls;
  `;
  const script = new Script(sandboxCode);
  const context = createContext({ console });
  script.runInContext(context);
  const fn = context.syncCheckinFromOverview;
  assert.ok(typeof fn === 'function', '沙箱里应当能取到 syncCheckinFromOverview');
  const calls = () => context.__getCalls();
  const run = (bridge) => fn(bridge);

  // 场景 1：首次见到信号 —— 只记基线，不刷新（避免页面加载后多打一次签到接口）
  run({ autoCheckin: { at: 'T1' } });
  assert.equal(calls(), 0, '首次见到信号只应记基线，不应触发刷新');

  // 场景 2：信号未变 —— 不刷新（否则每 20 秒轮询都打一次上游计费端点）
  run({ autoCheckin: { at: 'T1' } });
  assert.equal(calls(), 0, 'at 未变化时不得刷新');

  // 场景 3：信号变了 —— 必须刷新（这是整条修复的核心行为）
  run({ autoCheckin: { at: 'T2' } });
  assert.equal(calls(), 1, 'at 变化后必须刷新签到面板');

  // 场景 4：桥没跑 / 旧构建（无 autoCheckin 字段）—— 不刷新，且不破坏基线
  run({});
  assert.equal(calls(), 1, '无信号时不得刷新');
  run({ autoCheckin: { at: 'T2' } });
  assert.equal(calls(), 1, '无信号的轮询不应把基线冲掉，信号恢复后也不应重复刷新');

  // 场景 5：再次变化 —— 又刷新（同一天第二次尝试，如失败后重试成功）
  run({ autoCheckin: { at: 'T3' } });
  assert.equal(calls(), 2, '信号再次变化时应再次刷新');
});

test('控制台页面：loadOverview 里确实调用了 syncCheckinFromOverview', () => {
  const html = read(CONSOLE_HTML);
  const m = html.match(/async function loadOverview\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'index.html 里应当有 loadOverview 函数');
  assert.match(m[1], /syncCheckinFromOverview\(/,
    'loadOverview（每 20 秒轮询）必须调用它，否则信号永远不会被比对');
});

test('控制台：签到面板**不得**被塞进高频轮询（用轮询逼近是错的方向）', () => {
  const html = read(CONSOLE_HTML);
  const m = html.match(/const pollers = \[([\s\S]*?)\n\];/);
  assert.ok(m, 'index.html 里应当有 pollers 定义');
  const pollers = m[1];
  assert.doesNotMatch(pollers, /loadCheckin\s*,/,
    'loadCheckin 不应出现在轮询列表里 —— /api/checkin 每次都打上游计费端点，'
    + '而签到状态一天只变一次；正确做法是由 overview 带信号、按需刷新');
});

// ── 3. 插件侧：useJson 支持 refreshKey，签到面板接上了信号 ─────────────
test('插件 client.js：useJson 支持 refreshKey（值变化即重拉）', () => {
  const src = read(CLIENT);
  // effect 依赖数组必须含 refreshKey，否则值变了也不会重跑
  assert.match(src, /\},\s*\[reload,\s*opts\.interval,\s*opts\.enabled,\s*opts\.refreshKey\]\)/,
    'useJson 的 useEffect 依赖数组应当包含 opts.refreshKey');
  assert.match(src, /opts\.refreshKey/,
    'useJson 应当读取 opts.refreshKey');
});

test('插件 client.js：签到面板用 refreshKey 接上桥侧自动签到信号', () => {
  const src = read(CLIENT);

  // 面板参数应当接收 autoCheckinAt
  const panel = src.match(/function CheckinPanel\(\{([^}]*)\}\)/);
  assert.ok(panel, '应当有 CheckinPanel 组件');
  assert.match(panel[1], /autoCheckinAt/, 'CheckinPanel 应当接收 autoCheckinAt 参数');

  // useJson 调用应当传 refreshKey: autoCheckinAt。
  // 注意要从**签到面板函数体内部**找：文件里还有别的 useJson('/workbuddy/checkin')
  // 调用（概览告警那次是 interval: 300000），正则会先匹配到那一个。
  const panelFn = src.match(/function CheckinPanel\(\{[\s\S]*?\n    \}/);
  assert.ok(panelFn, '应当能定位到 CheckinPanel 的函数体');
  const useCall = panelFn[0].match(/useJson\('\/workbuddy\/checkin',\s*\{([\s\S]*?)\}\)/);
  assert.ok(useCall, "签到面板里应当有 useJson('/workbuddy/checkin', …) 调用");
  assert.match(useCall[1], /refreshKey:\s*autoCheckinAt/,
    '签到面板必须把 autoCheckinAt 作为 refreshKey 传下去，否则自动签到后仍不会刷新');
  // 兜底 interval 应当保留（旧宿主 / 长期挂机时仍能对齐）
  assert.match(useCall[1], /interval:\s*\d+/,
    '应当保留一个兜底的 interval（旧构建没有该字段时仍需定期对齐）');

  // 父组件应当从 status.bridge.health.autoCheckin.at 取信号
  assert.match(src, /autoCheckinAt:\s*status\?\.bridge\?\.health\?\.autoCheckin\?\.at/,
    '应当从宿主快照的 bridge.health.autoCheckin.at 取值（那里才有桥的真实签到时刻）');
});

/**
 * 桥的失败日志必须**展开 `e.cause`**。
 *
 * ## 背景（实测踩出来的）
 *
 * 用户报"积分读取失败"，面板显示：
 *
 *     读取失败：{"ok":false,"error":"fetch failed"}
 *
 * 于是去翻桥日志 —— 429 行里 **quota 相关 0 行**。两个问题叠在一起：
 *
 *   1. `/v1/quota` 的 catch 只 `return json(res, 502, ...)`，**什么都不记**；
 *   2. 别处（catalog / refresh / checkin）记的是 `e.message`，而 Node 的 `fetch`
 *      在网络层失败时 message 永远是 `"fetch failed"` —— 真正的原因
 *      （`ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND`）只在 `e.cause` 里。
 *
 * 结果就是：**日志有几十条 "fetch failed"，却完全无法定位是断网、DNS 还是上游挂了**。
 * 这类"观测缺口"比 bug 本身更麻烦 —— 它让下一次排查同样卡住。
 *
 * 这个测试钉住两条：错误描述函数存在且读 `cause`；quota 的失败分支有日志。
 */
test('桥：失败日志必须展开 e.cause（否则 "fetch failed" 无法诊断）', () => {
  const src = read(BRIDGE);

  // ① 必须有展开 cause 的助手
  const fn = src.match(/function describeFetchError\([\s\S]*?\n\}/);
  assert.ok(fn, '桥里应当有 describeFetchError()（把 e.cause 展开成可诊断的一行）');
  assert.match(fn[0], /\.cause/, 'describeFetchError 必须读 e.cause —— 真正的原因在那里');
  assert.match(fn[0], /code/, 'describeFetchError 应当取出 cause.code（ECONNRESET 等）');

  // ② /v1/quota 的失败分支必须记日志（原先一条都不记）
  const quotaBlock = src.match(/url\.pathname === '\/v1\/quota'[\s\S]*?\n    \}/);
  assert.ok(quotaBlock, '应当能定位到 /v1/quota 的处理块');
  assert.match(quotaBlock[0], /log\(/, '/v1/quota 失败时必须记日志（否则日志里查不到这次失败）');
  assert.match(quotaBlock[0], /describeFetchError/, '/v1/quota 的日志应当用 describeFetchError 展开原因');

  /*
   * ③ 其它**网络**失败路径也应当展开（catalog / refresh / checkin）。
   *
   * 只查这三个 —— 它们是打上游的。别处（流中断、记账失败、body 过大）不是网络
   * 错误，`e.message` 本身就够用；对它们套 describeFetchError 是没必要的噪音
   * （第一版断言写成"全文件不许出现 e.message"，被这四处误报，是断言太宽）。
   */
  for (const marker of ['catalog fetch failed', 'refresh error', 'auto checkin']) {
    const idx = src.indexOf(marker);
    assert.ok(idx > 0, `应当能找到「${marker}」这条日志`);
    const line = src.slice(idx, src.indexOf('\n', idx));
    if (/e\.message/.test(line) && !/describeFetchError/.test(line)) {
      assert.fail(`「${marker}」是网络路径，日志必须展开 cause：${line.trim()}`);
    }
  }
});

