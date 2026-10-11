/**
 * 旧路由文本手术的自测 + 插件装配冒烟测试（都不碰真实文件、不启桥）。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateProviderBlock, stripProviderBlock, cleanFile, detectInFile } from '../lib/legacy.mjs';
import { resolveConfig, detectProjectRoot, apply, readProjectEnv, DEFAULTS, asAccounts } from '../lib/index.js';
import { BridgeSupervisor } from '../lib/bridge.mjs';

/** 真实插件目录（测试里要用它当"源"来造分发布的副本）。 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 多账号分组：让同一个插件同时暴露多个账号（各自一组 provider）。
 *
 * 这里是纯配置解析的用例 —— 起桥与注册路由由 apply() 的冒烟测试覆盖。
 * 三条防呆必须成立，否则会出现"看起来分组了、实际模型调不通"的静默故障：
 *   1. id 去重（重名会让后一个静默覆盖前一个的路由）
 *   2. 端口去重（两个分组抢同一端口 = 必有一个起不来）
 *   3. provider 名可路由（只留字母数字-_，其余替换）
 */
test('asAccounts：解析分组并生成可路由的 provider 名', () => {
  const list = asAccounts([
    { id: '1', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info' },
    { id: '2', displayName: 'WorkBuddy 国内版', authFile: 'C:/a/cn.info' },
  ], 'workbuddy', 8790);
  assert.equal(list.length, 2);
  assert.equal(list[0].provider, 'workbuddy1');
  assert.equal(list[1].provider, 'workbuddy2');
  assert.equal(list[0].displayName, 'WorkBuddy 国际版');
  assert.equal(list[0].authFile, 'C:/a/ai.info');
  // 端口自动错开，且都不与主桥冲突
  assert.notEqual(list[0].port, 8790);
  assert.notEqual(list[1].port, 8790);
  assert.notEqual(list[0].port, list[1].port);
});

test('asAccounts：id 与端口都去重，脏输入不产生半残分组', () => {
  const list = asAccounts([
    { id: '1' }, { id: '1' },                        // 重名：第二个丢弃
    { id: '  ' },                                     // 空 id：丢弃
    null, 'text', 42,                                 // 非对象：丢弃
    { id: 'a b/c!' },                                 // 特殊字符 → 规范化
    { id: 'x', port: 9999 }, { id: 'y', port: 9999 },  // 抢同一端口：第二个丢弃
    { id: 'z', port: 70000 },                          // 端口越界 → 自动分配
  ], 'workbuddy', 8790);
  const ids = list.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  assert.equal(new Set(list.map((x) => x.port)).size, list.length, '端口必须唯一');
  assert.ok(!ids.includes(''), '空 id 不该出现');
  assert.ok(list.every((x) => /^workbuddy[A-Za-z0-9_-]+$/.test(x.provider)), 'provider 名必须可路由');
  assert.ok(list.every((x) => x.port >= 1024 && x.port <= 65535), '端口必须在合法范围');
  assert.ok(ids.includes('a-b-c'), `规范化后的 id 应存在，实际：${ids.join(',')}`);
});

test('asAccounts：空/非法输入 = 空数组（保持单账号行为不变）', () => {
  for (const bad of [undefined, null, [], 'x', 0]) {
    assert.deepEqual(asAccounts(bad), [], `${JSON.stringify(bad)} 应解析为空数组`);
  }
  // 默认空数组 —— 不配置时行为与升级前完全一致
  assert.deepEqual(DEFAULTS.accounts, []);
});

test('resolveConfig：accounts 会被解析进配置，前缀可自定义', () => {
  const cfg = resolveConfig({ accounts: [{ id: '1' }, { id: '2' }] });
  assert.equal(cfg.accounts.length, 2);
  assert.deepEqual(resolveConfig({}).accounts, []);
});

test('数据面的方法 / 权限矩阵：只读路由拒绝写方法，写路由要求面板头', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const stubAdapter = { catalogCache: { at: Date.now(), models: [] }, catalogError: '', catalog: async () => [], invalidate() {}, setFilter() {} };
  const routes = createRouteTable({
    snapshot: async () => ({ bridge: { state: 'running' } }),
    supervisor: { readLog: () => ({ lines: [] }), probe: async () => ({ state: 'running' }), ensure: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
    consoleSupervisor: { probe: async () => ({ state: 'running' }), ensure: async () => ({ ok: true }), stop: async () => ({ ok: true }), url: 'http://127.0.0.1:8792', spawnedPid: null },
    client: { checkin: async () => ({ status: {} }), clearUsage: async () => ({ ok: true }), usage: async () => ({}), requests: async () => ({}), quota: async () => ({}) },
    adapter: stubAdapter,
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    // 多账号：按 provider 解析目标（缺省 = 主 provider）。真实实现只认已注册的。
    resolveProvider: (name) => {
      const wanted = String(name || '').trim();
      if (!wanted || wanted === 'workbuddy') return { id: 'workbuddy', adapter: stubAdapter, isPrimary: true };
      if (wanted === 'workbuddy-ai') return { id: 'workbuddy-ai', adapter: stubAdapter, isPrimary: false };
      return null;
    },
    readPrefs: () => null,
    onWritePrefs: () => true,
    log: () => {},
  });
  const byPath = (p) => routes.find((r) => r.path === p);

  /** 跑一次路由，返回 {status, body}。url 允许带查询串（真实 req.url 就带）。 */
  const run = async (url, method, headers = {}) => {
    const route = byPath(url.split('?')[0]);
    assert.ok(route, `没有找到路由 ${url}`);
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code) { status = code; },
      write(chunk) { raw += String(chunk); },
      end(body) { if (body) raw += String(body); },
      on() {}, off() {},
    };
    await route.handler({ url, method, headers }, res);
    let body = null;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { status, body };
  };

  // 只读路由：GET 正常，PUT/PATCH/DELETE 一律 405
  for (const path of ['/workbuddy/status', '/workbuddy/models', '/workbuddy/requests', '/workbuddy/migrate', '/workbuddy/console', '/workbuddy/quota', '/workbuddy/context-overrides', '/workbuddy/vision-overrides', '/workbuddy/reasoning-overrides', '/workbuddy/credit-overrides']) {
    const get = await run(path, 'GET');
    assert.equal(get.status, 200, `${path} GET 应当 200`);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await run(path, method);
      assert.equal(res.status, 405, `${path} ${method} 应当是 405（只读路由不接受写方法）`);
    }
  }

  // 多账号：未知 provider 必须**明确 400**，不能静默落到主 provider ——
  // 那会让人以为在改 A 组，实际改到了 B 组。
  for (const path of ['/workbuddy/models', '/workbuddy/model-visibility']) {
    const bad = await run(`${path}?provider=nope`, 'GET');
    assert.equal(bad.status, 400, `${path} 未知 provider 应当 400`);
    assert.match(String(bad.body?.error || ''), /未知 provider/);
  }
  // 已知分组：正常 200，并回显是哪一组
  const ai = await run('/workbuddy/models?provider=workbuddy-ai', 'GET');
  assert.equal(ai.status, 200);
  assert.equal(ai.body?.provider, 'workbuddy-ai');
  // 缺省 = 主 provider（回显**实际名**，前端靠它做分组对账 —— 见下一条用例）
  assert.equal((await run('/workbuddy/models', 'GET')).body?.provider, 'workbuddy');
  assert.equal((await run('/workbuddy/model-visibility', 'GET')).body?.provider, 'workbuddy');

  // 写路由：没有面板头一律 403；带上正确头才放行
  const writes = [
    ['/workbuddy/bridge', 'POST'],
    ['/workbuddy/console', 'POST'],
    ['/workbuddy/migrate', 'POST'],
    ['/workbuddy/quota', 'POST'],
    ['/workbuddy/usage', 'DELETE'],
    ['/workbuddy/log', 'DELETE'],
    ['/workbuddy/context-overrides', 'POST'],
    ['/workbuddy/vision-overrides', 'POST'],
    ['/workbuddy/reasoning-overrides', 'POST'],
    ['/workbuddy/credit-overrides', 'POST'],
  ];
  for (const [path, method] of writes) {
    const blocked = await run(path, method);
    assert.equal(blocked.status, 403, `${method} ${path} 缺面板头应当 403`);
    assert.match(String(blocked.body?.error || ''), /x-workbuddy-panel/);
  }
  // 头不对（值不是 1）同样拒绝
  const wrongHeader = await run('/workbuddy/bridge', 'POST', { 'x-workbuddy-panel': 'true' });
  assert.equal(wrongHeader.status, 403);

  // 签到：GET 读、POST 领取要走面板头、其它方法 405
  assert.equal((await run('/workbuddy/checkin', 'GET')).status, 200);
  assert.equal((await run('/workbuddy/checkin', 'DELETE')).status, 405);
  const claimWithoutHeader = await run('/workbuddy/checkin?claim=1', 'POST');
  assert.equal(claimWithoutHeader.status, 403, '领取是写操作，缺面板头必须拒绝');
  const claimWithHeader = await run('/workbuddy/checkin?claim=1', 'POST', { 'x-workbuddy-panel': '1' });
  assert.equal(claimWithHeader.status, 200);
});

test('readLog 只读日志尾部：大文件不吃满内存、截断的半行被丢掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  try {
    const logPath = join(dir, 'bridge.log');
    // 造一个 > maxBytes 的日志：每行定长，方便断言首尾
    const line = (i) => `line-${String(i).padStart(6, '0')}-${'x'.repeat(40)}`;
    const total = 4000;
    writeFileSync(logPath, Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n');

    const supervisor = new BridgeSupervisor({ logPath, scriptPath: join(dir, 'nope.mjs'), projectRoot: dir });
    const tail = supervisor.readLog({ lines: 5, maxBytes: 2048 });
    assert.equal(tail.lines.length, 5, '行数应当被 lines 截断');
    assert.equal(tail.lines[4], line(total - 1), '最后一行必须是文件真正的最后一行');
    assert.deepEqual(tail.lines, [line(total - 5), line(total - 4), line(total - 3), line(total - 2), line(total - 1)]);
    assert.ok(!tail.lines.some((l) => l.includes('line-0000')), '不许把整个文件都读回来');
    assert.equal(tail.size, Buffer.byteLength(Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n'));

    // 单行超过 maxBytes：不该返回半行（宁可为空，也不给半个 JSON）
    const oneLong = join(dir, 'one.log');
    writeFileSync(oneLong, 'A'.repeat(5000) + '\n' + '短行\n');
    const tail2 = new BridgeSupervisor({ logPath: oneLong, scriptPath: 'x', projectRoot: dir }).readLog({ lines: 10, maxBytes: 1024 });
    assert.deepEqual(tail2.lines, ['短行'], '被截断的长行应当被丢弃，只留完整行');

    // 文件不存在：给空结果而不是抛
    const missing = new BridgeSupervisor({ logPath: join(dir, 'missing.log'), scriptPath: 'x', projectRoot: dir }).readLog({});
    assert.deepEqual(missing.lines, []);
    assert.equal(missing.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SETTINGS = `# DeepSeek Harness 用户设置文档
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy
      apiKeyEnv: WORKBUDDY_BRIDGE_KEY
      baseURL: http://127.0.0.1:8790/v1
      models:
        - id: hy3
          name: "Hy3"
    other-provider:
      displayName: Other
      baseURL: https://example.invalid/v1
`;

const PATCH = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:8790/v1
      keep-me:
        displayName: Keep
- id: workbuddy
  name: dsh-plugin-workbuddy
`;

test('locateProviderBlock 只框住 providers.workbuddy 这一段', () => {
  const hit = locateProviderBlock(SETTINGS, 'workbuddy');
  assert.ok(hit);
  const lines = SETTINGS.split('\n');
  assert.match(lines[hit.start], /^\s{4}workbuddy:$/);
  assert.match(lines[hit.end], /^\s{4}other-provider:$/);
});

test('stripProviderBlock 删除 workbuddy，保留其它 provider 与注释', () => {
  const { changed, text } = stripProviderBlock(SETTINGS, 'workbuddy');
  assert.equal(changed, true);
  assert.doesNotMatch(text, /workbuddy:/);
  assert.match(text, /# DeepSeek Harness 用户设置文档/);
  assert.match(text, /other-provider:/);
  assert.match(text, /displayName: Other/);
  // 另一条 route 不受影响
  assert.match(text, /llm-pi-ai:/);
});

test('stripProviderBlock 处理 patch 层（列表条目缩进）', () => {
  const { changed, text } = stripProviderBlock(PATCH, 'workbuddy');
  assert.equal(changed, true);
  assert.doesNotMatch(text, /^\s+workbuddy:$/m);
  assert.match(text, /keep-me:/);
  assert.match(text, /- id: ui-theme/);
  assert.match(text, /- id: workbuddy\n  name: dsh-plugin-workbuddy/);
});

test('providers 被清空时改写成 providers: {}（避免 YAML null）', () => {
  const only = `llm-pi-ai:\n  providers:\n    workbuddy:\n      displayName: WorkBuddy\n`;
  const { text } = stripProviderBlock(only, 'workbuddy');
  assert.match(text, /providers: \{\}/);
  assert.doesNotMatch(text, /workbuddy/);
});

test('没有旧路由时不动文件，也不报"已改"', () => {
  const clean = `llm-pi-ai:\n  providers:\n    keep:\n      displayName: Keep\n`;
  const { changed, text } = stripProviderBlock(clean, 'workbuddy');
  assert.equal(changed, false);
  assert.equal(text, clean);
});

test('cleanFile 先备份再写，备份内容与原文一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-legacy-'));
  try {
    const file = join(dir, 'settings.yaml');
    writeFileSync(file, SETTINGS, 'utf8');
    const result = cleanFile(file, { provider: 'workbuddy' });
    assert.equal(result.changed, true);
    assert.ok(existsSync(result.backup));
    assert.equal(readFileSync(result.backup, 'utf8'), SETTINGS);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /workbuddy:/);
    // 再跑一次：已经干净，不应重复改动
    const again = cleanFile(file, { provider: 'workbuddy' });
    assert.equal(again.changed, false);
    assert.equal(again.reason, 'no-legacy-route');
    assert.equal(detectInFile(file, 'workbuddy').found, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveConfig 合默认值并做类型收敛', () => {
  const cfg = resolveConfig({ bridgePort: '9999', autoStart: '0', modelAllow: 'a, b', migrateLegacy: false });
  assert.equal(cfg.bridgePort, 9999);
  assert.equal(cfg.autoStart, false);
  assert.deepEqual(cfg.modelAllow, ['a', 'b']);
  assert.equal(cfg.migrateLegacy, false);
  assert.equal(cfg.provider, DEFAULTS.provider);
  assert.equal(cfg.displayName, 'WorkBuddy');
});

test('detectProjectRoot 能从插件目录上溯找到项目根', () => {
  const root = detectProjectRoot('');
  assert.ok(root, '应该找到 workbuddy-to-dsh 检出目录');
  assert.ok(existsSync(join(root, 'bridge', 'workbuddy-bridge.mjs')));
});

/** 一个足够像 cordis 的假 ctx：记录注册了什么，验证装配而不需要真实 dsh。 */
function fakeCtx() {
  const calls = { adapters: [], tools: [], commands: [], routes: [], effects: [], provides: [] };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter });
        const handle = () => {};
        handle.replace = () => {};
        return handle;
      },
    },
    get(name) {
      if (name === 'tools') return { register: (d) => { calls.tools.push(d); return () => {}; } };
      if (name === 'commands') return { register: (d) => { calls.commands.push(d); return () => {}; } };
      if (name === 'webServer') return { register: (r) => { calls.routes.push(r); return () => {}; } };
      return undefined;
    },
    effect(fn, label) { calls.effects.push(label); const dispose = fn(); return dispose; },
    provide(name, value) { calls.provides.push({ name, value }); return () => {}; },
  };
  return { ctx, calls };
}

test('换账号后积分/签到缓存必须作废（回归：面板把 A 账号积分挂在 B 账号头上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-account-'));
  try {
    const { ctx } = fakeCtx();
    const result = apply(ctx, { projectRoot: dir, dshHome: dir, autoStart: false, consoleAutoStart: false, migrateLegacy: false });
    const { state, snapshot } = result;

    // 桩：probe 返回的 userId 由外部变量控制 —— **模拟真实换号**：
    // 桥重启后 health 报新 userId，插件靠自己对比发现"账号变了"。
    // （不许手动改 state.bridgeAccount —— 那等于替插件作弊，把变化掩盖了。）
    let currentAccount = 'A';
    result.supervisor.probe = async () => ({
      state: 'running',
      health: { auth: { userId: currentAccount, expiresAt: new Date(Date.now() + 864e5).toISOString() } },
    });

    // 桩：quota/checkin 也打桩 —— **不能依赖真实桥**（CI 上没有桥在跑，
    // 之前本地能过只是因为 8790 上恰好有一个）。返回值随账号变化，
    // 顺带验证"换号后必须重新调上游，不能吃旧缓存"。
    let quotaCalls = 0;
    let checkinCalls = 0;
    result.client.quota = async () => { quotaCalls += 1; return { ok: true, total: currentAccount === 'A' ? 111 : 222, packages: [] }; };
    result.client.checkin = async () => { checkinCalls += 1; return { ok: true, status: { todayCheckedIn: false, streakDays: 1 }, auto: { auto: false } }; };

    // ── 第一幕：账号 A，正常取一次积分与签到
    // 预置一份模型目录：第三幕要断言"换号后目录被作废"
    result.adapter.catalogCache = { at: Date.now(), models: [{ id: 'm-from-A' }] };
    const snapA = await snapshot({});
    assert.ok(snapA.quota, '账号 A 应当有积分缓存');
    assert.equal(state.quotaCache.account, 'A', '积分缓存必须打上账号 A 的标记');
    // 签到刷新是后台异步的：等它落盘再断言
    await state.checkinInflight;
    assert.equal(state.checkinCache.account, 'A', '签到缓存必须打上账号 A 的标记');
    const quotaA = snapA.quota;

    // ── 第二幕：切到账号 B（只改桥报告的身份，让插件自己发现变化）
    currentAccount = 'B';
    // TTL 内再取快照：换号后**不许**继续用 A 的缓存值
    const snapB = await snapshot({});
    await state.checkinInflight;
    assert.equal(snapB.quota?.total, 222, `换账号后积分必须换新（B=222），实际 ${snapB.quota?.total}`);
    assert.equal(state.quotaCache.account, 'B', '新缓存必须标记为账号 B');
    assert.equal(state.checkinCache.account, 'B', '签到缓存也必须换到账号 B 名下');

    // ── 第三幕：模型目录同样属于账号视角 —— reconcile 必须把目录作废
    // （adapter.invalidate 会把 catalogCache 清空，下一次目录读取自然从桥重取）
    assert.equal(result.adapter.catalogCache.models.length, 0, '换号后模型目录必须已作废（等下一次从桥重取）');

    // ── 第四幕：bridgeAccount 为 null（旧桥/探测不完整）时**不许**误清有效缓存
    result.supervisor.probe = async () => ({ state: 'running', health: { auth: {} } });
    const beforeNull = { quota: state.quotaCache.value, checkin: state.checkinCache.value };
    await snapshot({});
    assert.equal(state.quotaCache.value, beforeNull.quota, '拿不到账号身份时不能清掉积分缓存');
    assert.equal(state.checkinCache.value, beforeNull.checkin, '拿不到账号身份时不能清掉签到缓存');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply() 装配：注册 llm 路由、5 个工具、命令、HTTP 路由', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-apply-'));
  try {
    const { ctx, calls } = fakeCtx();
    // 用一个空目录当 projectRoot（桥/控制台脚本都不存在）：不自动启任何进程，只验证装配
    const result = apply(ctx, { projectRoot: dir, dshHome: dir, autoStart: false, consoleAutoStart: false, migrateLegacy: false });
    assert.equal(calls.adapters.length, 1);
    assert.deepEqual(calls.adapters[0].providers, ['workbuddy']);
    assert.equal(calls.adapters[0].adapter.providerInfo('workbuddy').name, 'WorkBuddy');
    assert.equal(calls.tools.length, 5);
    assert.deepEqual(calls.tools.map((t) => t.name).sort(), [
      'workbuddy_bridge', 'workbuddy_checkin', 'workbuddy_models', 'workbuddy_status', 'workbuddy_usage',
    ]);
    for (const tool of calls.tools) {
      assert.equal(typeof tool.execute, 'function');
      assert.equal(typeof tool.output.render, 'function');
      assert.ok(tool.parameters && tool.parameters.type === 'object');
    }
    assert.equal(calls.commands.length, 1);
    assert.equal(calls.commands[0].name, 'workbuddy');
    assert.equal(calls.routes.length, 17, 'HTTP 数据面应有 17 条路由（16 条 exact + 1 条 console-api 前缀）');
    assert.deepEqual(calls.routes.map((r) => r.path).sort(), [
      '/workbuddy/bridge', '/workbuddy/checkin', '/workbuddy/console', '/workbuddy/console-api', '/workbuddy/context-overrides',
      '/workbuddy/credit-overrides', '/workbuddy/log', '/workbuddy/login', '/workbuddy/migrate', '/workbuddy/model-visibility',
      '/workbuddy/models', '/workbuddy/quota', '/workbuddy/reasoning-overrides', '/workbuddy/requests', '/workbuddy/status',
      '/workbuddy/usage', '/workbuddy/vision-overrides',
    ]);
    const prefix = calls.routes.find((r) => r.path === '/workbuddy/console-api');
    assert.equal(prefix.kind, 'prefix', 'console-api 必须挂成前缀路由');
    assert.equal(typeof prefix.handler, 'function');
    assert.equal(result.state.route.registered, true);
    assert.ok(result.consoleSupervisor, 'apply() 必须返回控制台管理器');
    assert.equal(result.consoleSupervisor.url, 'http://127.0.0.1:8792');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply() 遇到 DUPLICATE_ADAPTER 时退回兜底 provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fallback-'));
  try {
    const calls = { providers: [] };
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      llm: {
        registerAdapter(providers) {
          calls.providers.push(providers[0]);
          if (providers[0] === 'workbuddy') {
            const error = new Error('an adapter for provider "workbuddy" is already registered');
            error.code = 'DUPLICATE_ADAPTER';
            throw error;
          }
          const handle = () => {};
          handle.replace = () => {};
          return handle;
        },
      },
      get() { return undefined; },
      effect(fn) { return fn(); },
    };
    const result = apply(ctx, { projectRoot: dir, dshHome: dir, autoStart: false, migrateLegacy: false, tools: false, commands: false, routes: false });
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(calls.providers.includes('workbuddy-native'), '应该用兜底 provider 再注册一次');
    assert.equal(result.state.route.registered, true);
    assert.equal(result.state.route.fallback, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模型目录归一化：徽章从 tags 里拆出来（带颜色），厂商单字母保留为"标识"', async () => {
  const { toDirectory } = await import('../lib/models.mjs');
  const dir = toDirectory([
    {
      id: 'hy3', name: 'Hy3', context_window: 192000, max_output_tokens: 64000, supports_images: true,
      credits: 0, free: true, vendor: 'j', badge: '限时免费',
      tags: ['craft', 'badge:限时免费:#FF0000'], description_zh: '混元思考模型',
    },
    { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'e', tags: ['craft'] },
  ]);
  const hy3 = dir.find((m) => m.id === 'hy3');
  assert.deepEqual(hy3.tags, ['craft'], 'tags 里不该再留着 badge: 规格（那是噪音）');
  assert.deepEqual(hy3.badges, [{ label: '限时免费', color: '#FF0000' }], '徽章要结构化并保住颜色');
  assert.equal(hy3.badge, '限时免费');
  assert.equal(hy3.vendor, 'j', '上游厂商代码原样保留（界面标注为"标识"）');
  assert.deepEqual(dir.find((m) => m.id === 'glm-5.3').badges, [], '没有徽章的模型给空数组而不是 undefined');
  assert.ok(!JSON.stringify(dir).includes('badge:'), '整个目录里都不该再出现 badge: 原始规格');
});

/**
 * 回归：**面板的 `images` 必须与适配器的 `inputModalities` 同口径。**
 *
 * 这是与"分组 adapter 漏传覆盖"并列的第二个坑：`toDirectory()` 原来直接读
 * 上游的 `supports_images`，完全无视 `visionOverrides`。后果是同一份声明
 * 在两处给出相反答案 —— dsh 侧已经能收图（`inputModalities` 含 image），
 * 面板却显示"不支持图片"。用户看到面板说不行，就以为手动声明没生效，
 * 根本不会去贴图；而面板正是他判断"要不要贴图"的唯一依据。
 */
test('图片能力覆盖：面板目录的 images 必须与适配器 inputModalities 同口径（回归：两处各说一套）', async () => {
  const { toDirectory, toAdapterModels } = await import('../lib/models.mjs');
  // 复刻真实情况：国际版目录**漏报** supports_images，全靠覆盖声明
  const catalog = [{ id: 'deepseek-v4.1-flash', name: 'F', context_window: 1000000, max_output_tokens: 128000 }];

  // ① 覆盖 true：面板与适配器都必须说"支持"
  const on = { 'deepseek-v4.1-flash': true };
  assert.equal(toDirectory(catalog, { visionOverrides: on })[0].images, true,
    '声明支持后，面板必须显示支持图片（否则用户以为声明没生效，不会去贴图）');
  assert.deepEqual(toAdapterModels(catalog, { visionOverrides: on })[0].inputModalities, ['text', 'image'],
    '同一份声明下，适配器必须也声明支持（两处同口径）');

  // ② 覆盖 false：能压掉目录的误报，两处同样一致
  const misreported = [{ id: 'm', name: 'M', context_window: 1000, supports_images: true }];
  const off = { m: false };
  assert.equal(toDirectory(misreported, { visionOverrides: off })[0].images, false, '覆盖 false 必须压掉目录的误报');
  assert.deepEqual(toAdapterModels(misreported, { visionOverrides: off })[0].inputModalities, ['text'], '适配器同样要被压掉');

  // ③ 没有覆盖时退回目录（不猜能力）
  assert.equal(toDirectory(misreported)[0].images, true, '无覆盖时按目录走');
  assert.equal(toDirectory(catalog)[0].images, false, '目录没声明又没覆盖 → 不支持');
});

test('桥的健康检查：503 要认领成「凭据异常」，不能误判成"端口上是别人的服务"', async () => {
  const { createServer } = await import('node:http');
  const { BridgeSupervisor } = await import('../lib/bridge.mjs');

  /** 起一个假服务：默认回我们桥那种 503（登录读不出来），可切换成"别人的服务"。 */
  const startFake = async (body, status = 503, contentType = 'application/json') => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };

  // ① 我们的桥 + 登录坏了：503 + {ok:false, error, authFile}
  const ours = await startFake({
    ok: false,
    error: 'login file has no accessToken; sign in to the WorkBuddy desktop app first',
    authFile: 'C:\\auth\\workbuddy-desktop.info',
  });
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: ours.port, token: 't', projectRoot: '.', logPath: 'x' });
    const probe = await sup.probe();
    assert.equal(probe.state, 'degraded', '带 authFile 的 503 必须认领成本项目的桥（凭据异常）');
    assert.match(probe.error, /login file|sign in/i, '要把桥给的原因原样带出来');
    // ensure() 必须复用而不是再拉一个（否则撞端口）
    const ensured = await sup.ensure({ readyTimeoutMs: 500 });
    assert.equal(ensured.reused, true, '凭据异常时要复用这个桥');
    assert.equal(ensured.started, false, '不许因为健康检查不绿就再拉一个');
    assert.equal(ensured.state, 'degraded');
  } finally { await ours.close(); }

  // ② 真的不是我们的服务：503 + HTML（比如某个反向代理）
  const foreign = await startFake('<html><body>503 Service Unavailable</body></html>', 503, 'text/html');
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: foreign.port, token: 't', projectRoot: '.', logPath: 'x' });
    const probe = await sup.probe();
    assert.equal(probe.state, 'foreign', 'HTML 503 不能被当成自己的桥');
  } finally { await foreign.close(); }

  // ③ 令牌不符：401 → unauthorized
  const wrongToken = await startFake({ error: { message: 'bad or missing local token' } }, 401);
  try {
    const sup = new BridgeSupervisor({ host: '127.0.0.1', port: wrongToken.port, token: 't', projectRoot: '.', logPath: 'x' });
    assert.equal((await sup.probe()).state, 'unauthorized');
  } finally { await wrongToken.close(); }
});

test('分发形态：只有插件文件夹（自带 vendor）时也能定位到运行目录', async () => {
  const { cpSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-standalone-'));
  try {
    // 造一个"别人拿到的样子"：<sandbox>/dsh-plugin（含 lib + vendor），父目录里没有仓库
    const pluginDir = join(sandbox, 'dsh-plugin');
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'vendor'), join(pluginDir, 'vendor'), { recursive: true });
    assert.ok(existsSync(join(pluginDir, 'vendor', 'bridge', 'workbuddy-bridge.mjs')), 'vendor 里必须有桥脚本');
    assert.ok(existsSync(join(pluginDir, 'vendor', 'dashboard', 'server.mjs')), 'vendor 里必须有控制台脚本');

    // 动态 import 一个"副本插件"：它的 PLUGIN_DIR 就是临时目录，能真实检验解析顺序
    const prevRoot = process.env.WORKBUDDY_ROOT;
    delete process.env.WORKBUDDY_ROOT;
    try {
      const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
      const detected = mod.detectProjectRoot();
      // macOS 的 tmpdir 在 /var/folders → ESM loader 会把模块路径 realpath 成
      // /private/var/folders —— 两侧都 realpath 归一后再比，断言语义不变
      const { realpathSync } = await import('node:fs');
      assert.equal(realpathSync(detected), realpathSync(join(pluginDir, 'vendor')), '没有仓库时必须回落到插件自带的 vendor/');
      // 候选顺序：仓库位置排在 vendor 前面（本机开发优先用仓库）
      const kinds = mod.projectRootCandidates('').map((c) => c.kind);
      assert.ok(kinds.indexOf('repo') < kinds.indexOf('vendor'), '仓库检出目录必须优先于 vendor');
    } finally {
      if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('分发形态：仓库在旁边时优先用仓库（不会被 vendor 快照盖住）', async () => {
  const { cpSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const sandbox = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  try {
    // <sandbox>/bridge/... + <sandbox>/dsh-plugin/{lib,vendor} —— 两边都有桥，
    // 必须选仓库那份（否则本机改了 bridge 却不生效）
    mkdirSync(join(sandbox, 'bridge'), { recursive: true });
    writeFileSync(join(sandbox, 'bridge', 'workbuddy-bridge.mjs'), '// repo copy\n');
    const pluginDir = join(sandbox, 'dsh-plugin');
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'vendor'), join(pluginDir, 'vendor'), { recursive: true });

    const prevRoot = process.env.WORKBUDDY_ROOT;
    delete process.env.WORKBUDDY_ROOT;
    try {
      const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
      // 同上：macOS tmpdir 的 /var → /private/var 符号链接，realpath 归一后再比
      const { realpathSync } = await import('node:fs');
      assert.equal(realpathSync(mod.detectProjectRoot()), realpathSync(sandbox), '仓库检出目录优先于 vendor 快照');
    } finally {
      if (prevRoot !== undefined) process.env.WORKBUDDY_ROOT = prevRoot;
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('面板 /workbuddy/models 返回归一化目录（不是上游原始字段名）', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const stubAdapter = {
    catalogCache: { at: Date.now(), models: [] },
    catalogError: '',
    async catalog() {
      return [
        { id: 'm1', name: 'M One', context_window: 128000, max_output_tokens: 8192, credits: 0.5, supports_images: true, free: false },
      ];
    },
  };
  const route = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { readLog: () => ({ lines: [] }) },
    client: {},
    adapter: stubAdapter,
    resolveProvider: (name) => (!name || name === 'workbuddy' ? { id: 'workbuddy', adapter: stubAdapter } : null),
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  }).find((r) => r.path === '/workbuddy/models');

  let payload;
  const res = {
    writeHead() {},
    end(body) { payload = JSON.parse(body); },
  };
  await route.handler({ url: '/workbuddy/models', method: 'GET' }, res);
  assert.equal(payload.ok, true);
  assert.equal(payload.models.length, 1);
  const [model] = payload.models;
  assert.equal(model.contextWindow, 128000, '必须是 contextWindow，而不是上游的 context_window');
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.images, true);
  assert.equal(model.credits, 0.5);
});

test('面板写操作要求 x-workbuddy-panel 头（挡住跨站简单请求）', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const calls = [];
  const route = createRouteTable({
    snapshot: async () => ({}),
    supervisor: {
      readLog: () => ({ lines: [] }),
      probe: async () => ({ state: 'stopped' }),
      ensure: async () => { calls.push('ensure'); return { ok: true, health: { pid: 1 } }; },
      stop: async () => ({ ok: true, stopped: true }),
    },
    client: {},
    adapter: { catalogCache: { at: 0, models: [] }, catalogError: '', invalidate() {} },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  }).find((r) => r.path === '/workbuddy/bridge');

  const send = () => {
    let status = 0;
    let payload;
    const res = { writeHead(code) { status = code; }, end(body) { payload = body ? JSON.parse(body) : undefined; } };
    return { res, get: () => ({ status, payload }) };
  };

  const denied = send();
  await route.handler({ method: 'POST', headers: {}, url: '/workbuddy/bridge', async *[Symbol.asyncIterator]() {} }, denied.res);
  assert.equal(denied.get().status, 403);
  assert.equal(calls.length, 0, '没有头的请求不能触发任何桥操作');

  const allowed = send();
  const body = JSON.stringify({ action: 'start' });
  await route.handler({
    method: 'POST',
    headers: { 'x-workbuddy-panel': '1' },
    url: '/workbuddy/bridge',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  }, allowed.res);
  assert.equal(allowed.get().status, 200);
  assert.equal(allowed.get().payload.ok, true);
  assert.deepEqual(calls, ['ensure']);
});

test('readProjectEnv 解析 .env，且只在 config 未显式指定时生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  try {
    mkdirSync(join(dir, 'bridge'), { recursive: true });
    writeFileSync(join(dir, 'bridge', 'workbuddy-bridge.mjs'), '// stub\n', 'utf8');
    writeFileSync(join(dir, '.env'), [
      '# 注释',
      'WORKBUDDY_PORT=8899',
      'WORKBUDDY_LOCAL_TOKEN="tok-from-env"',
      'WORKBUDDY_AUTH_FILE=\'C:\\tmp\\custom.info\'',
      '',
    ].join('\n'), 'utf8');

    const parsed = readProjectEnv(dir);
    assert.equal(parsed.WORKBUDDY_PORT, '8899');
    assert.equal(parsed.WORKBUDDY_LOCAL_TOKEN, 'tok-from-env');
    assert.equal(parsed.WORKBUDDY_AUTH_FILE, 'C:\\tmp\\custom.info');

    const { ctx } = fakeCtx();
    // 不显式给端口 → 跟随 .env
    const fromEnv = apply(ctx, { projectRoot: dir, dshHome: dir, autoStart: false, tools: false, commands: false, routes: false, migrateLegacy: false });
    assert.equal(fromEnv.state.config.bridgePort, 8899, '.env 里的端口必须被采纳');
    assert.equal(fromEnv.state.config.localToken, 'tok-from-env');
    assert.equal(fromEnv.supervisor.authFile, 'C:\\tmp\\custom.info');

    // 显式给了端口 → 以配置为准，不被 .env 覆盖
    const { ctx: ctx2 } = fakeCtx();
    const explicit = apply(ctx2, { projectRoot: dir, dshHome: dir, bridgePort: 9911, autoStart: false, tools: false, commands: false, routes: false, migrateLegacy: false });
    assert.equal(explicit.state.config.bridgePort, 9911, '显式配置优先于 .env');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ConsoleSupervisor：靠首页结构标记识别控制台，认不出就报 foreign', async () => {
  const { ConsoleSupervisor, CONSOLE_MARKER } = await import('../lib/console.mjs');
  const { createServer } = await import('node:http');

  // 1) 真控制台（首页带我们的结构标记）
  const real = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><nav ${CONSOLE_MARKER}></nav>ok</body></html>`);
  });
  await new Promise((r) => real.listen(0, '127.0.0.1', r));
  const realPort = real.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port: realPort, cacheTtlMs: 0 });
    const probe = await sup.probe({ cached: false });
    assert.equal(probe.state, 'running');
    assert.equal(sup.url, `http://127.0.0.1:${realPort}`);
    const ensured = await sup.ensure({});
    assert.equal(ensured.ok, true);
    assert.equal(ensured.reused, true, '已在运行的控制台必须复用，不重复拉起');
    // 别人起的控制台（双击 启动.cmd）：插件不去停它
    const stopped = await sup.stop();
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /不是插件启动的/);
  } finally { await new Promise((r) => real.close(r)); }

  // 2) 端口被别的 HTTP 服务占着 → foreign，且不会去「拉起」
  const foreign = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>别的服务</title>'); });
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  const foreignPort = foreign.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port: foreignPort, cacheTtlMs: 0 });
    assert.equal((await sup.probe({ cached: false })).state, 'foreign');
    const ensured = await sup.ensure({});
    assert.equal(ensured.ok, false);
    assert.equal(ensured.reused, false);
  } finally { await new Promise((r) => foreign.close(r)); }

  // 3) 没人监听 → stopped
  const sup = new ConsoleSupervisor({ projectRoot: 'x', port: 1, cacheTtlMs: 0 });
  assert.equal((await sup.probe({ cached: false })).state, 'stopped');
});

test('probe() 有界读取：标记远在首个 chunk 之后也必须认出来（先红后绿，§7 P0-2）', async () => {
  const { ConsoleSupervisor, CONSOLE_MARKER } = await import('../lib/console.mjs');
  const { createServer } = await import('node:http');

  /**
   * 110KB 填充 + 标记放在最后，整页一次写出。
   *
   * 这正是原实现（只读"第一个 chunk"就判断）的失效场景 —— 报告 §6.0 实测
   * 30/30 全部误判：首块读到的只是开头一部分，永远到不了标记。修复后应逐块
   * 读到匹配或上限为止。
   */
  const pad = 'x'.repeat(110 * 1024);
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${pad}<nav ${CONSOLE_MARKER}></nav></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port, cacheTtlMs: 0 });
    const probe = await sup.probe({ cached: false });
    assert.equal(probe.state, 'running', '标记不在首块内时不得误判 foreign');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('probe() 有界读取：超过上限也没有标记 → 判 foreign，不无限读', async () => {
  const { ConsoleSupervisor, CONSOLE_READ_CAP } = await import('../lib/console.mjs');
  const { createServer } = await import('node:http');

  // 上限之外**远超一个 chunk** 才放标记：读取必须在上限处停下（而非读完整个 body）。
  // 留 256KB 余量 —— 上限检查按 chunk 粒度，最后一个被读的块可能越过上限一点；
  // 若标记贴着上限放，可能恰好被那块覆盖，用例就测不到"停在边界"的语义了。
  const pad = 'x'.repeat(CONSOLE_READ_CAP + 256 * 1024);
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${pad}<nav id="navTabs"></nav></body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const sup = new ConsoleSupervisor({ projectRoot: 'x', port, cacheTtlMs: 0 });
    const probe = await sup.probe({ cached: false });
    assert.equal(probe.state, 'foreign');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('交叉校验（§6.0 纪律）：真产物 index.html 的识别标记必须在 probe 读取上限之内', async () => {
  const { CONSOLE_MARKER, CONSOLE_READ_CAP } = await import('../lib/console.mjs');
  /**
   * 本文件其余用例都是「用被测常量造夹具」——它们只能证明"代码读得到自己写的
   * 常量"。这条不同：**直读 dashboard/public/index.html 真产物**。§6.0 的教训是
   * 「凡读外部资源做判断的常量，必须有一条对真实产物的断言」——页面的标记改名 /
   * 位置下移时，先红的就是这条，而不是等用户发现插件认不出控制台。
   */
  const htmlPath = join(PLUGIN_ROOT, '..', 'dashboard', 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const at = html.indexOf(CONSOLE_MARKER);
  assert.ok(at >= 0, `真产物缺少识别标记 ${CONSOLE_MARKER}（控制台会被 probe() 判成 foreign）`);
  assert.ok(
    at < CONSOLE_READ_CAP,
    `识别标记位于第 ${at} 字节，超出 probe() 的读取上限 ${CONSOLE_READ_CAP}`,
  );
});

test('快照与控制台路由：状态里带 console，写操作同样要面板头', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const consoleSupervisor = {
    url: 'http://127.0.0.1:8792',
    spawnedPid: null,
    async probe() { return { state: 'running', error: '' }; },
    async ensure() { return { ok: true, reused: true, url: this.url }; },
    async stop() { return { ok: false, error: '不是插件启动的' }; },
  };
  const routes = createRouteTable({
    snapshot: async () => ({ console: { state: 'running', url: consoleSupervisor.url } }),
    supervisor: { readLog: () => ({ lines: [] }), probe: async () => ({ state: 'running' }) },
    consoleSupervisor,
    client: {},
    adapter: { catalogCache: { at: 0, models: [] }, catalogError: '' },
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  });

  let statusPayload;
  await routes.find((r) => r.path === '/workbuddy/status').handler(
    { url: '/workbuddy/status', method: 'GET' },
    { writeHead() {}, end(b) { statusPayload = JSON.parse(b); } },
  );
  assert.equal(statusPayload.console.url, 'http://127.0.0.1:8792');
  assert.equal(statusPayload.console.state, 'running');

  const consoleRoute = routes.find((r) => r.path === '/workbuddy/console');
  assert.ok(consoleRoute, '必须挂上 /workbuddy/console');

  let getPayload;
  await consoleRoute.handler({ url: '/workbuddy/console', method: 'GET' }, { writeHead() {}, end(b) { getPayload = JSON.parse(b); } });
  assert.equal(getPayload.url, consoleSupervisor.url);
  assert.equal(getPayload.state, 'running');

  let denied = 0;
  await consoleRoute.handler({ method: 'POST', headers: {}, url: '/workbuddy/console', async *[Symbol.asyncIterator]() {} }, { writeHead(c) { denied = c; }, end() {} });
  assert.equal(denied, 403);

  let okStatus = 0;
  let okPayload;
  const body = JSON.stringify({ action: 'start' });
  await consoleRoute.handler({
    method: 'POST',
    headers: { 'x-workbuddy-panel': '1' },
    url: '/workbuddy/console',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  }, { writeHead(c) { okStatus = c; }, end(b) { okPayload = JSON.parse(b); } });
  assert.equal(okStatus, 200);
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.action, 'start');
});

test('apply() 的 migrateLegacy 默认会清理指向的文件（用临时目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-migrate-'));
  const previous = { home: process.env.DSH_HOME, dir: process.env.DSH_PROFILE_DIR, profile: process.env.DSH_PROFILE };
  try {
    // 先把 dsh home **与 profile 目录**都指向临时目录。注意：DSH_PROFILE_DIR 的
    // 优先级高于 DSH_HOME，只改 DSH_HOME 会让 patchPath 落到真实 profile 上
    // （这正是本测试曾经误改真实文件的原因）。
    const profileDir = join(dir, 'profiles', 'test-profile');
    process.env.DSH_HOME = dir;
    process.env.DSH_PROFILE = 'test-profile';
    process.env.DSH_PROFILE_DIR = profileDir;
    mkdirSync(profileDir, { recursive: true });
    const settings = join(dir, 'settings.yaml');
    const patch = join(profileDir, 'cordis.patch.yml');
    writeFileSync(settings, SETTINGS, 'utf8');
    writeFileSync(patch, PATCH, 'utf8');

    const { ctx } = fakeCtx();
    const result = apply(ctx, { projectRoot: join(dir, 'nowhere'), dshHome: dir, autoStart: false, tools: false, commands: false, routes: false });
    // 语义：`cleaned` 记录这次删了什么，`found` 是**清理之后**是否还有残留
    assert.equal(result.state.legacy.cleaned.changed, true);
    assert.equal(result.state.legacy.found, false, '清理干净之后不应再报“检测到旧路由”');
    assert.ok(result.state.legacy.cleaned.files.some((f) => f.changed && f.backup), '必须有文件被改且留下备份');
    assert.equal(result.state.dshPaths.patchPath, patch, 'patchPath 必须落在临时目录里');
    assert.doesNotMatch(readFileSync(settings, 'utf8'), /workbuddy:/);
    assert.doesNotMatch(readFileSync(patch, 'utf8'), /^\s+workbuddy:$/m);
    // patch 里其它内容与插件自己的条目都不受影响
    assert.match(readFileSync(patch, 'utf8'), /- id: workbuddy\n  name: dsh-plugin-workbuddy/);
    assert.match(readFileSync(patch, 'utf8'), /keep-me:/);
  } finally {
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous.dir;
    if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 回归：**主分组的回显必须是实际 provider 名，不能是空串。**
 *
 * 面板上的"当前分组"用空串代表主分组，而这两个接口回显的是 "workbuddy"。
 * 前端若直接拿 `viewProvider`（空串）去比回显值就永远对不上 —— 主分组的
 * 目录和白名单都加载不出来，表现为"模型没有了"。这里钉住这个契约。
 */
test('不传 provider 时回显实际 provider 名（前端靠它做分组对账）', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const stubAdapter = { catalogCache: { at: Date.now(), models: [] }, catalogError: '', catalog: async () => [], invalidate() {}, setFilter() {} };
  const routes = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { readLog: () => ({ lines: [] }) },
    client: {},
    adapter: stubAdapter,
    resolveProvider: (n) => (!n || n === 'workbuddy' ? { id: 'workbuddy', adapter: stubAdapter } : null),
    readPrefs: () => [],
    onWritePrefs: () => true,
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  });
  const runOne = async (url) => {
    const route = routes.find((r) => r.path === url.split('?')[0]);
    let payload;
    const res = { writeHead() {}, end(b) { payload = JSON.parse(b); }, on() {}, off() {} };
    await route.handler({ url, method: 'GET', headers: {} }, res);
    return payload;
  };
  for (const path of ['/workbuddy/models', '/workbuddy/model-visibility']) {
    const p = await runOne(path);
    assert.equal(p.ok, true, path + ' 应当 ok');
    assert.equal(p.provider, 'workbuddy', `${path} 缺省时必须回显实际 provider 名，不能是空串`);
  }
});

// ── 图片能力覆盖：必须按 provider 分开，且必须喂到分组 adapter ──────────

/**
 * 给 adapter 换一份固定目录。
 *
 * 注意必须同时替换 `ensureReady`（不只是 `this.client`）：`catalog()` 走的是
 * `await this.ensureReady()`，而 ensureReady 是构造时用闭包捕获 client 的箭头
 * 函数 —— 只改 `this.client` 的话，目录仍会真的去打本机 8790 上的桥。
 */
function stubCatalog(adapter, data) {
  adapter.client = { models: async () => ({ data }) };
  adapter.ensureReady = async () => adapter.client;
  adapter.catalogCache = { at: 0, models: [] };
  return adapter;
}

/**
 * 回归（本次修复的核心）：**分组 adapter 必须拿到该分组自己的图片能力覆盖。**
 *
 * 真出过一次，且症状极隐蔽 —— 面板上声明了「deepseek-v4.1-flash 支持图片」，
 * 但那份覆盖只喂给了主 adapter，分组 adapter 拿到的仍是空的
 * `config.visionOverrides`。于是"上游目录漏报 + 用户手动声明 true"的模型在
 * 分组下依然被算成纯文本，`inputModalities` 只有 `['text']`；dsh 侧看到
 * `!model.input.includes('image')` 就把图**静默降级**成
 * "(image omitted: model does not support images)" —— 用户贴了图像没贴，还不报错。
 *
 * 默认模型走分组 provider 时必现（本项目的默认正是 workbuddy-ai + 国际版）。
 */
test('图片能力覆盖：分组 adapter 必须应用该分组自己的覆盖（回归：贴图被静默降级）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-vision-group-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  // 这份偏好文件被模块顶层常量绑死在**真实插件目录**上，所以测试只能
  // "备份—写入—还原"，绝不能留下痕迹（那会改掉用户真实的面板设置）。
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    // 国际版分组：目录漏报 supports_images（真实情况就是国际版为空）
    writeFileSync(prefsPath, JSON.stringify({
      visionByProvider: { 'workbuddy-ai': { 'deepseek-v4.1-flash': true } },
    }), 'utf8');

    const { ctx, calls } = fakeCtx();
    apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    // 分组 adapter 注册在 workbuddyai 上
    const groupEntry = calls.adapters.find((a) => a.providers.includes('workbuddy-ai'));
    assert.ok(groupEntry, '应当注册了分组 adapter（workbuddy-ai）');
    const groupAdapter = groupEntry.adapter;

    // 目录里的模型**没有** supports_images —— 完全靠覆盖声明
    stubCatalog(groupAdapter, [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000 },
    ]);

    const models = await groupAdapter.listModels('workbuddy-ai');
    const m = models.find((x) => x.id === 'deepseek-v4.1-flash');
    assert.ok(m, '目录里应当有 deepseek-v4.1-flash');
    assert.deepEqual(m.inputModalities, ['text', 'image'],
      '分组 adapter 必须应用面板声明的图片能力 —— 否则 dsh 会把用户贴的图静默降级成占位文字');

    // resolveModel 必须同口径（选择器与推理元数据都走它）
    stubCatalog(groupAdapter, [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000 },
    ]);
    const resolved = await groupAdapter.resolveModel('workbuddy-ai', 'deepseek-v4.1-flash');
    assert.deepEqual(resolved.inputModalities, ['text', 'image'],
      'resolveModel 必须与 listModels 同口径，否则贴图在真正调用时又被降级');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 回归：**不能把某组的图片声明串到另一组。**
 *
 * 国内版目录本来就 `supports_images: true`，国际版漏报。用户在国际版手动
 * 声明后，这份覆盖不该让国内版也被标记成"手动指定"；更关键的是反向语义 ——
 * 用户在国际版**取消**声明（写 false）时，绝不能把国内版目录真实的
 * `true` 一起压掉（那会让国内版本来能看的图也贴不了）。
 */
test('图片能力覆盖：按 provider 分开，一组不能影响另一组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-vision-iso-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    // 国内版（主 provider）**没有**覆盖；国际版显式声明 false
    writeFileSync(prefsPath, JSON.stringify({
      visionByProvider: { 'workbuddy-ai': { 'deepseek-v4.1-flash': false } },
    }), 'utf8');

    const { ctx, calls } = fakeCtx();
    apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    const CATALOG = [{ id: 'deepseek-v4.1-flash', name: 'F', context_window: 1000, supports_images: true }];

    // 主 provider：目录 true，且**没有**覆盖 → 保持 true
    const main = stubCatalog(calls.adapters.find((a) => a.providers.includes('workbuddy')).adapter, CATALOG);
    assert.deepEqual((await main.listModels('workbuddy')).find((m) => m.id === 'deepseek-v4.1-flash').inputModalities,
      ['text', 'image'], '主 provider 不该被分组的 false 覆盖影响');

    // 分组：显式 false → 压掉目录的 true
    const group = stubCatalog(calls.adapters.find((a) => a.providers.includes('workbuddy-ai')).adapter, CATALOG);
    assert.deepEqual((await group.listModels('workbuddy-ai')).find((m) => m.id === 'deepseek-v4.1-flash').inputModalities,
      ['text'], '分组自己的 false 覆盖必须生效（用户想压掉误报）');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 兼容：升级前存的是**全局 `vision` 键**（没有 visionByProvider）。
 * 它归属主 provider，读过一次后不该凭空消失；而分组不该继承它。
 */
test('图片能力覆盖：兼容旧的全局 vision 键，且分组不继承', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-vision-legacy-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    writeFileSync(prefsPath, JSON.stringify({ vision: { 'legacy-model': true } }), 'utf8');

    const { ctx, calls } = fakeCtx();
    apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    const CATALOG = [{ id: 'legacy-model', name: 'L', context_window: 1000 }];

    // 主 provider 读到旧全局键 → 声明支持
    const main = stubCatalog(calls.adapters.find((a) => a.providers.includes('workbuddy')).adapter, CATALOG);
    assert.deepEqual((await main.listModels('workbuddy')).find((m) => m.id === 'legacy-model').inputModalities,
      ['text', 'image'], '旧全局 vision 键必须对主 provider 继续生效（别把用户设置弄丢）');

    // 分组不继承旧全局键
    const group = stubCatalog(calls.adapters.find((a) => a.providers.includes('workbuddy-ai')).adapter, CATALOG);
    assert.deepEqual((await group.listModels('workbuddy-ai')).find((m) => m.id === 'legacy-model').inputModalities,
      ['text'], '分组不该继承主 provider 的旧全局覆盖（那是另一账号的能力声明）');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 回归（审计发现）：**从分组账号写一次覆盖，不能销毁主账号还在读的旧全局键。**
 *
 * 旧的 `writeBoolPrefs` 无条件把全局 `vision` 键置 null —— 不管写的是哪个
 * provider。而 `readBoolPrefs` 只在 `provider === primaryProvider` 时才回退到
 * 那个键，于是"用户切到分组账号随手存一次"就会把主账号的声明**销毁**：
 * 实测 `{"vision":{...}}` 写一次分组后，主 provider 读到 `{}`，图片能力又被
 * 静默降级 —— 正是本次一系列修复要解决的症状，却因这个写入副作用复发。
 *
 * 正确语义：写任何 provider 时，先把旧全局值**迁移进主 provider 的桶**，再清旧键。
 * 这条测试走**真实的 apply() 接线**（`writeVisionPrefs` 由 index.js 绑好主 provider），
 * 而不是手写桩 —— 否则测不出"绑定漏了主 provider"这个具体缺陷。
 */
test('布尔覆盖写入：从分组写不能销毁主账号的旧全局 vision 键（回归：声明被静默清掉）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-legacy-write-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    // 升级用户：只有旧的全局 vision 键
    writeFileSync(prefsPath, JSON.stringify({ vision: { 'legacy-model': true } }), 'utf8');

    // 模拟用户在**分组**账号下保存一条 vision 覆盖（走真实的写入实现）。
    // 关键：必须传 primaryProvider —— index.js 的接线就是这么绑的
    // （`(providerId, overrides) => writeVisionPrefs(providerId, overrides, config.provider)`）。
    const { writeVisionPrefs } = await import('../lib/index.js');
    writeVisionPrefs('workbuddy-ai', { 'other-model': false }, 'workbuddy');

    const after = JSON.parse(readFileSync(prefsPath, 'utf8'));
    // ① 旧全局键必须被迁移进主 provider 的桶，而不是销毁
    assert.equal(after.visionByProvider?.workbuddy?.['legacy-model'], true,
      '旧全局 vision 声明必须迁移到主 provider 的桶（否则主账号的图片声明被静默清掉）');
    // ② 分组的写入照常生效
    assert.equal(after.visionByProvider?.['workbuddy-ai']?.['other-model'], false,
      '分组的写入必须照常生效');
    // ③ 旧键本身要清掉（迁移完成，避免两套语义并存）
    assert.equal(after.vision, null, '旧全局键迁移后应置 null');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
test('图片能力覆盖路由：按 provider 写入并回显 provider 名', async () => {
  const { createRouteTable } = await import('../lib/routes.mjs');
  const written = [];
  const mkAdapter = () => ({ visionOverrides: {}, setVisionOverrides(v) { this.visionOverrides = v; } });
  const mainAdapter = mkAdapter();
  const groupAdapter = mkAdapter();
  const routes = createRouteTable({
    snapshot: async () => ({}),
    supervisor: { readLog: () => ({ lines: [] }) },
    client: {},
    adapter: mainAdapter,
    resolveProvider: (n) => {
      const w = String(n || '').trim();
      if (!w || w === 'workbuddy') return { id: 'workbuddy', adapter: mainAdapter, isPrimary: true };
      if (w === 'workbuddy-ai') return { id: 'workbuddy-ai', adapter: groupAdapter, isPrimary: false };
      return null;
    },
    writeVisionPrefs: (provider, overrides) => { written.push({ provider, overrides }); return true; },
    readPrefs: () => [],
    onWritePrefs: () => true,
    paths: { settingsPath: 'x', patchPath: 'y' },
    provider: 'workbuddy',
    log: () => {},
  });
  const run = async (url, method, body) => {
    const route = routes.find((r) => r.path === url.split('?')[0]);
    let payload; let status = 0;
    const res = {
      writeHead(c) { status = c; },
      write() {}, end(b) { if (b) payload = JSON.parse(b); }, on() {}, off() {},
    };
    // readJsonBody 用 `for await (const chunk of req)` 消费消息体 —— 桩要是个
    // 异步可迭代对象，不是 EventEmitter（用 on/emit 那套它会一个 chunk 都读不到，
    // 于是 body 恒为 {}）。
    const req = {
      url, method, headers: { 'x-workbuddy-panel': '1' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    await route.handler(req, res);
    return { status, payload };
  };

  // 写到分组：必须落在分组的 adapter 上，且持久化到该 provider 的桶
  const post = await run('/workbuddy/vision-overrides?provider=workbuddy-ai', 'POST', { overrides: { 'm1': true } });
  assert.equal(post.payload.ok, true);
  assert.equal(post.payload.provider, 'workbuddy-ai', '必须回显实际 provider 名（前端靠它对账）');
  assert.deepEqual(groupAdapter.visionOverrides, { m1: true }, '必须写到分组的 adapter 上');
  assert.deepEqual(mainAdapter.visionOverrides, {}, '绝不能串到主 adapter');
  assert.deepEqual(written, [{ provider: 'workbuddy-ai', overrides: { m1: true } }], '持久化必须带 provider');

  // 未知 provider 明确 400，不静默落到主 provider
  const bad = await run('/workbuddy/vision-overrides?provider=nope', 'GET');
  assert.equal(bad.status, 400);
  assert.match(String(bad.payload?.error || ''), /未知 provider/);

  // 读分组：回显该组自己的值
  const get = await run('/workbuddy/vision-overrides?provider=workbuddy-ai', 'GET');
  assert.equal(get.payload.provider, 'workbuddy-ai');
  assert.deepEqual(get.payload.overrides, { m1: true });
});

/**
 * 回归：**推理能力也要能手动声明，且必须喂到分组 adapter。**
 *
 * 与图片能力同一个坑（上游目录漏报 `supports_reasoning`），而且是最早暴露在
 * 用户界面上的一处：国内版 `deepseek-v4.1-flash` 带 `supports_reasoning: true`，
 * 国际版同一模型**整个字段都没有** —— 而实测国际版接受
 * `reasoning_effort: "high"` 并返回 200。不声明，dsh 的选择器就没有
 * 「推理等级」下拉，用户以为这个模型不支持推理。
 *
 * 这里钉住：分组 adapter 应用覆盖后，listModels 与 resolveModel 都必须带上
 * reasoning（两者同口径，否则选择器显示了下拉、真正调用又没了）。
 */
test('推理能力覆盖：分组 adapter 必须应用该分组自己的覆盖（回归：国际版没有推理等级）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-reason-group-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    // 国际版分组：目录漏报 supports_reasoning，用户手动声明
    writeFileSync(prefsPath, JSON.stringify({
      reasoningByProvider: { 'workbuddy-ai': { 'deepseek-v4.1-flash': true } },
    }), 'utf8');

    const { ctx, calls } = fakeCtx();
    apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    const groupEntry = calls.adapters.find((a) => a.providers.includes('workbuddy-ai'));
    assert.ok(groupEntry, '应当注册了分组 adapter（workbuddy-ai）');
    const groupAdapter = groupEntry.adapter;

    // 目录里的模型**没有** supports_reasoning —— 完全靠覆盖声明
    const CATALOG = [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000 }];
    stubCatalog(groupAdapter, CATALOG);

    // resolveModel 是选择器判断"要不要显示推理下拉"的依据
    const resolved = await groupAdapter.resolveModel('workbuddy-ai', 'deepseek-v4.1-flash');
    assert.ok(resolved.reasoning, '声明支持推理后，resolveModel 必须返回 reasoning 元数据（否则选择器没有下拉）');
    assert.ok(Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length >= 2,
      'efforts 必须是非空数组（dsh 校验 efforts.length===0 直接抛 INVALID_MODEL_REASONING）');

    // 主 provider 没有覆盖、目录也没报 → 不该凭空声明（不猜能力）
    const main = stubCatalog(calls.adapters.find((a) => a.providers.includes('workbuddy')).adapter, CATALOG);
    const mainResolved = await main.resolveModel('workbuddy', 'deepseek-v4.1-flash');
    assert.equal('reasoning' in mainResolved, false,
      '主 provider 既没目录声明也没覆盖时不能带 reasoning（不猜）');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 回归：**面板目录的 `reasoning` 必须与适配器同口径。**
 *
 * 与 images / credits 同源、同一处代码（`toDirectory`）。用户在国际版声明了
 * 推理能力后，选择器已经出现「推理等级」下拉，但面板详情若仍说"不支持" ——
 * 用户会以为声明没生效，反复去点。两处必须一致。
 */
test('推理能力覆盖：面板目录的 reasoning 必须与适配器同口径', async () => {
  const { toDirectory, toAdapterModels } = await import('../lib/models.mjs');
  const intl = [{ id: 'deepseek-v4.1-flash', name: 'F', context_window: 1000000, max_output_tokens: 128000 }];
  const ov = { 'deepseek-v4.1-flash': true };

  // ① 覆盖 true：两处都必须说"支持"
  assert.equal(toDirectory(intl, { reasoningOverrides: ov })[0].reasoning, true,
    '面板目录必须采用覆盖值，否则详情里显示"不支持"，用户以为声明没生效');
  assert.equal(toAdapterModels(intl, { reasoningOverrides: ov })[0].reasoning, true,
    '适配器必须同口径（选择器据此显示推理下拉）');

  // ② 覆盖 false：压掉目录的误报。
  //    注意两边的**形状不同**（这是刻意的，不是不一致）：
  //      - toDirectory 给显式布尔（面板要拿它渲染"支持/不支持"两态）
  //      - toAdapterModels **省略该键**（dsh 的契约是"键存在 = 支持"，
  //        所以不支持时不能给 false，那会让 dsh 以为"声明了但不支持"）
  const misreported = [{ id: 'm', name: 'M', supports_reasoning: true }];
  assert.equal(toDirectory(misreported, { reasoningOverrides: { m: false } })[0].reasoning, false, '覆盖 false 必须压掉目录误报');
  assert.equal('reasoning' in toAdapterModels(misreported, { reasoningOverrides: { m: false } })[0], false,
    '适配器在不支持时必须**省略** reasoning 键（dsh 契约：键存在 = 支持）');

  // ③ 无覆盖时按目录走（不猜）
  assert.equal(toDirectory(intl, {})[0].reasoning, false, '目录没报又没覆盖 → 不支持');
  assert.equal(toDirectory(misreported, {})[0].reasoning, true, '目录声明了 → 支持');
  assert.equal('reasoning' in toAdapterModels(intl, {})[0], false, '目录没报又没覆盖 → 适配器不带 reasoning');
  assert.equal(toAdapterModels(misreported, {})[0].reasoning, true, '目录声明了 → 适配器带 reasoning');

  // ④ 与 images 互不串味：一个覆盖不能影响另一个
  const both = toDirectory(intl, { reasoningOverrides: ov, visionOverrides: { 'deepseek-v4.1-flash': true } })[0];
  assert.equal(both.reasoning, true);
  assert.equal(both.images, true);
});

/**
 * 回归：**「刷新积分」必须连分组账号一起刷。**
 *
 * 面板那颗按钮走 `POST /workbuddy/quota` → `snapshot({ quota: true })`，意图是
 * "现在就给我最新值"。但分组积分原来是**无条件 fire-and-forget**，且只判
 * `stale`（TTL 120s）—— 于是按钮只让主账号重读，各分组的数字纹丝不动。
 * 用户点完看到"国内版变了、国际版还是旧值"，会以为那个账号真的没额度，
 * 而实际上只是没人去读。
 *
 * 这里钉住两条：
 *   1. `quota: true` 时**即使缓存没过期也要重取**分组积分（否则按下去没反应）
 *   2. `quota: true` 时快照返回的是**重取后**的值（要 await，不能返回旧缓存）
 *   3. 平时的 8 秒轮询**仍然不 await**（不能被上游计费端点拖住）
 */
test('刷新积分：强制刷新必须同时重读分组账号（回归：按钮只刷主账号）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-quota-group-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    writeFileSync(prefsPath, '{}', 'utf8');
    const { ctx } = fakeCtx();
    const result = apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'AI', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });
    const { snapshot } = result;

    // 桥与控制台打桩（不碰真实进程）
    result.supervisor.probe = async () => ({
      state: 'running',
      health: { auth: { userId: 'main-acct', expiresAt: new Date(Date.now() + 864e5).toISOString() } },
    });
    result.consoleSupervisor.probe = async () => ({ state: 'running' });

    // 主账号与分组各有一个"额度计数器"，每次调用 +1 —— 用来数到底读了几次
    let mainQuota = 100;
    let groupQuota = 5;
    let groupCalls = 0;
    result.client.quota = async () => ({ ok: true, total: (mainQuota += 1), packages: [] });
    result.client.requests = async () => ({ requests: [] });
    const group = result.state.accountGroups.find((g) => g.provider === 'workbuddy-ai');
    assert.ok(group, '分组应当已注册');
    group.client.quota = async () => { groupCalls += 1; return { ok: true, total: (groupQuota += 1), packages: [] }; };

    // ── 第一次快照：SSE 里把分组积分灌进缓存（模拟 TTL 内已有值）
    const first = await snapshot({});
    assert.equal(first.groupQuotas[0].total, 6, '第一次应读到分组积分');

    // ── 强制刷新：即使缓存刚写入（远未过期），也必须重取分组积分
    const callsBefore = groupCalls;
    const forced = await snapshot({ quota: true });
    assert.ok(groupCalls > callsBefore,
      `「刷新积分」必须重新读取分组账号，实际调用次数没变（${groupCalls}）—— 按钮只会刷主账号`);
    assert.equal(forced.groupQuotas[0].total, 7,
      '强制刷新后快照必须返回**重取后**的分组积分（要 await，不能给旧缓存）');

    // ── 普通轮询：TTL 内不重复打上游（status 每 8 秒一次，不能被拖住）
    const callsAfterForce = groupCalls;
    const polled = await snapshot({});
    assert.equal(groupCalls, callsAfterForce,
      '普通轮询在 TTL 内不该重复读分组积分（8 秒一轮，会把计费端点打爆）');
    assert.equal(polled.groupQuotas[0].total, 7, '轮询返回缓存值即可');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 倍率覆盖：**目录漏报倍率时必须能手动补，且按 provider 分开。**
 *
 * 实测：国际版目录里 `deepseek-v4.1-flash` 连 `credits` 字段都没有（国内版同一
 * 模型给 0.11），而它实际免费 —— 国际版调用成功且余额恒为 0。漏报的后果是
 * 模型选择器里那一行光秃秃没有价：用户既怕贵不敢用，又不知道它免费。
 *
 * 这里钉住三件事：
 *   1. 目录漏报（credits 缺失）时，`toAdapterModels` 不带价（不猜）
 *   2. 覆盖 0 时，展示名打上"免费"（用户终于看得懂）
 *   3. 覆盖按 provider 分开 —— 国际版标免费不能把国内版的 0.11× 一起改掉
 */
test('倍率覆盖：目录漏报时手动声明免费，且不串到另一个账号（回归：国际版没显示免费）', async () => {
  const { toAdapterModels } = await import('../lib/models.mjs');
  // 国际版真实目录：**没有任何 credits 字段**
  const intlCatalog = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000 }];
  // 国内版真实目录：credits 0.11
  const cnCatalog = [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', context_window: 1000000, max_output_tokens: 128000, credits: 0.11 }];

  // ① 漏报时不猜：不覆盖就只显示模型名，不带任何价
  const bare = toAdapterModels(intlCatalog, { showCredits: true })[0];
  assert.equal(bare.name, 'DeepSeek-V4.1-Flash', '目录没报倍率时不能凭空编一个价');

  // ② 覆盖 0 → 展示名必须出现"免费"
  const free = toAdapterModels(intlCatalog, { showCredits: true, visionOverrides: {}, creditOverrides: { 'deepseek-v4.1-flash': 0 } })[0];
  assert.match(free.name, /免费/, `覆盖 0 后展示名应标"免费"，实际：${free.name}`);

  // ③ 国内版给的是真实倍率，照常显示
  const cn = toAdapterModels(cnCatalog, { showCredits: true })[0];
  assert.match(cn.name, /0\.11/, `国内版应显示 0.11×，实际：${cn.name}`);

  // ④ 覆盖按 provider 分开：国际版标免费，不能影响国内版
  const cnWithIntlOverride = toAdapterModels(cnCatalog, { showCredits: true, creditOverrides: {} })[0];
  assert.match(cnWithIntlOverride.name, /0\.11/, '国内版不该被国际版的覆盖影响');
});

/**
 * 回归：**面板目录的 `credits` 也必须带上覆盖。**
 *
 * 与 images 那个坑同源、同一处代码（`toDirectory` 直读上游字段）。用户在国际版
 * 手动把 deepseek-v4.1-flash 标成免费后，模型选择器已经显示"· 免费"了，
 * 但面板详情里"计费倍率"仍写着"未知" —— 于是用户以为声明没生效，反复去点。
 * 两处必须同口径，否则用户不知道该信哪个。
 */
test('倍率覆盖：面板目录的 credits 必须与适配器同口径（回归：标了免费面板还说未知）', async () => {
  const { toDirectory, toAdapterModels } = await import('../lib/models.mjs');
  // 国际版真实目录：整个 credits 字段都没有
  const intl = [{ id: 'deepseek-v4.1-flash', name: 'F', context_window: 1000000, max_output_tokens: 128000 }];
  const ov = { 'deepseek-v4.1-flash': 0 };

  // ① 覆盖 0：面板必须看到 credits=0 / free=true（而不是 null）
  const d = toDirectory(intl, { creditOverrides: ov })[0];
  assert.equal(d.credits, 0, '面板目录必须采用覆盖值，否则详情里显示"未知"');
  assert.equal(d.free, true, '覆盖 0 时 free 必须为 true（面板据此显示"免费"）');

  // ② 同口径：适配器展示名也带"免费"
  assert.match(toAdapterModels(intl, { showCredits: true, creditOverrides: ov })[0].name, /免费/);

  // ③ 没有覆盖时不猜：保留 null（"未知"），不编造价格
  const bare = toDirectory(intl, {})[0];
  assert.equal(bare.credits, null, '目录没报又没覆盖时必须保持 null（宁可不标也不编）');
  assert.equal(bare.free, false);

  // ④ 目录真实倍率不被覆盖影响（国内版照常）
  const cn = toDirectory([{ id: 'x', name: 'X', credits: 0.11 }], { creditOverrides: {} })[0];
  assert.equal(cn.credits, 0.11, '国内版目录值应原样透传');
});

/**
 * 回归：**上下文上限覆盖必须喂到分组 adapter。**
 *
 * 上下文覆盖是四种覆盖里唯一**不按 provider 分桶**的（一份全局设置），
 * 但它原来只喂给了主 adapter —— 分组 adapter 拿到的是空的
 * `config.contextOverrides`，于是面板里设的上限对分组账号**静默失效**。
 *
 * 实测证据（修复前）：主 adapter `{deepseek-v4.1-flash:200000}` / maxTokens 500000，
 * 分组 adapter `{}` / 0。用户以为设了 1M 上限，分组仍按目录原值跑 ——
 * 而"上下文设了没生效"的后果是上游可能直接报 context 超限，很难联想到是这里。
 */
test('上下文覆盖：分组 adapter 必须拿到面板保存的上限（回归：分组静默失效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ctx-group-'));
  const prefsPath = join(PLUGIN_ROOT, '.model-prefs.json');
  const backup = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null;
  try {
    // 面板里设过：逐模型上限 + 全局档位
    writeFileSync(prefsPath, JSON.stringify({
      context: { 'deepseek-v4.1-flash': 200000 },
      contextMaxTokens: 500000,
    }), 'utf8');

    const { ctx, calls } = fakeCtx();
    apply(ctx, {
      projectRoot: dir,
      dshHome: dir,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: 'WorkBuddy 国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    const main = calls.adapters.find((a) => a.providers.includes('workbuddy')).adapter;
    const group = calls.adapters.find((a) => a.providers.includes('workbuddy-ai')).adapter;
    assert.ok(group, '分组 adapter 应当已注册');

    assert.deepEqual(main.contextOverrides, { 'deepseek-v4.1-flash': 200000 }, '主 adapter 应拿到逐模型上限');
    assert.equal(main.contextMaxTokens, 500000, '主 adapter 应拿到全局档位');

    assert.deepEqual(group.contextOverrides, { 'deepseek-v4.1-flash': 200000 },
      '分组 adapter 必须拿到同一份上下文覆盖 —— 否则面板里设的上限对分组静默失效');
    assert.equal(group.contextMaxTokens, 500000, '分组 adapter 也必须拿到全局档位');

    // 端到端：生效的 contextWindow 必须是 min(目录, 覆盖, 全局)
    stubCatalog(group, [{ id: 'deepseek-v4.1-flash', name: 'F', context_window: 1000000, max_output_tokens: 128000 }]);
    const resolved = await group.resolveModel('workbuddy-ai', 'deepseek-v4.1-flash');
    assert.equal(resolved.context?.contextWindow, 200000,
      '分组下生效的上下文必须是覆盖值（200000），而不是目录原值（1000000）');
  } finally {
    if (backup !== null) writeFileSync(prefsPath, backup, 'utf8');
    else rmSync(prefsPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 纳管账号的端口必须避开**控制台**端口。
 *
 * 回归：`asAccounts()` 的自动分配是 `basePort + 已处理条数 + 1` —— 只看列表位置、
 * 不看实际占用。手写分组占过 8791（basePort 8790 时 `+1` 正好也是 8791，靠
 * seenPort 让开），下一个自动值就轮到 8792 —— 而那正是控制台端口。真机配置
 * （bridgePort 8790 + accounts[ai]=8791 + consolePort 8792）复现过：纳管分组会
 * 与控制台抢同一个端口，起桥直接失败。
 */
test('纳管账号分配端口：必须避开控制台端口（回归：抢 8792 起不来）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-managed-port-'));
  try {
    // 造一个纳管凭据，让 apply() 把并入逻辑跑起来
    const adir = join(dir, 'workbuddy-accounts');
    mkdirSync(adir, { recursive: true });
    writeFileSync(join(adir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.info'), JSON.stringify({
      account: { uin: '', nickname: '' },
      auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, domain: 'www.codebuddy.cn', expiresAt: Date.now() + 864e5 },
      managed: true,
    }), 'utf8');

    const { ctx } = fakeCtx();
    const result = apply(ctx, {
      projectRoot: dir,
      dshHome: dir,                 // 纳管账号从这里的 workbuddy-accounts/ 读
      bridgePort: 8790,
      consolePort: 8792,
      autoStart: false,
      consoleAutoStart: false,
      migrateLegacy: false,
      tools: false,
      commands: false,
      routes: false,
      accounts: [{ id: 'ai', displayName: '国际版', authFile: 'C:/a/ai.info', port: 8791 }],
      accountProviderPrefix: 'workbuddy-',
    });

    const groups = result.state.accountGroups || [];
    assert.equal(groups.length, 2, '手写分组 + 纳管分组都应在册');

    const ports = groups.map((g) => g.port);
    assert.equal(new Set(ports).size, ports.length, `分组端口不能重复：${ports.join(', ')}`);
    assert.ok(!ports.includes(8792),
      `纳管分组不能占用控制台端口 8792（实际：${ports.join(', ')}）—— 会撞端口起不来`);
    assert.ok(!ports.includes(8790), '也不能占用主桥端口');

    // 手写的分组保留它声明的 8791；**自动分配的那个**才要避开已知占用
    const manual = groups.find((g) => g.provider === 'workbuddy-ai');
    assert.equal(manual?.port, 8791, '手写分组的端口必须原样保留');
    const managedGroup = groups.find((g) => g.provider !== 'workbuddy-ai');
    assert.ok(managedGroup, '纳管分组应已注册');
    assert.ok(managedGroup.port > 8792,
      `自动分配的端口应避开已知占用（8790 主桥 / 8791 手写分组 / 8792 控制台），实际 ${managedGroup.port}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
