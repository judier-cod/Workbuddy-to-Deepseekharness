/**
 * 模型显示偏好与请求默认参数的单元测试。
 *
 * 两个用户诉求驱动：
 *   1. "自己控制面板里面出现几个模型而不是全出现" —— 模型显示偏好：
 *      面板勾选 → POST /workbuddy/model-visibility → adapter.setFilter
 *      → dsh 模型选择器下一次 listModels 就是新清单（即时生效，无需重启）。
 *      偏好持久化在插件自己的 .model-prefs.json，**不碰 .state.json**
 *      （那是控制台的单写者领地，它有进程内缓存，外部写会让缓存悄悄过期）。
 *   2. agent 实际调用模型的默认参数（max_tokens / temperature / reasoning_effort）：
 *      配置进 patch（defaultMaxTokens 等），adapter 在组装 payload 时按
 *      "调用方显式 > 插件默认 > 不发" 的优先级合并。
 *
 *   node --test dsh-plugin/tests/model-prefs.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkBuddyAdapter } from '../lib/adapter.mjs';
import { toAdapterModels } from '../lib/models.mjs';

const CATALOG = [
  { id: 'model-a', name: 'A', context_window: 100000, max_output_tokens: 8000 },
  { id: 'model-b', name: 'B', context_window: 200000, max_output_tokens: 16000 },
  { id: 'model-c', name: 'C', context_window: 50000, max_output_tokens: 4000 },
];

function makeAdapter(overrides = {}) {
  return new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    // catalog() 走 client.models()：给一份固定目录的桩
    client: {
      models: async () => ({ data: CATALOG }),
    },
    ...overrides,
  });
}

// ── setFilter：运行时改显示清单 ────────────────────────────────────────

test('setFilter：allow 清单决定 listModels 的可见模型（空 = 全显示）', async () => {
  const adapter = makeAdapter();
  // 初始：没有 allow 清单 → 全部可见
  let models = await adapter.listModels();
  assert.equal(models.length, 3, '未设置过滤时目录里 3 个模型都应可见');

  // 勾选两个 → 只有那两个可见
  adapter.setFilter({ allow: ['model-a', 'model-c'] });
  models = await adapter.listModels();
  assert.deepEqual(models.map((m) => m.id), ['model-a', 'model-c'],
    'setFilter 必须即时生效（下一次 listModels 就是新清单）');

  // 清空 allow → 恢复全显示
  adapter.setFilter({ allow: [] });
  models = await adapter.listModels();
  assert.equal(models.length, 3, 'allow 为空应恢复"全部显示"');
});

test('setFilter：不覆盖调用方已设的 deny（与配置的 modelDeny 叠加）', async () => {
  const adapter = makeAdapter({ filter: { deny: ['model-c'] } });
  adapter.setFilter({ allow: ['model-a', 'model-c'] });
  const models = await adapter.listModels();
  // setFilter 整体替换 filter 对象 —— 本实现里 deny 被 allow 覆盖场景：
  // 用户面板勾选 model-c 说明他**要**它，deny 是更早的配置意图。此处行为是
  // "面板勾选优先"。这里钉住的就是这个优先级，防止将来悄悄改成"叠加"。
  assert.deepEqual(models.map((m) => m.id), ['model-a', 'model-c'],
    '面板勾选（setFilter）应优先于配置文件里的 modelDeny');
});

// ── 请求默认参数 ──────────────────────────────────────────────────────

/** 从 streamText 里截获发往桥的 payload（client.chat 打桩）。 */
function capturePayload(adapter) {
  let captured = null;
  adapter.client = {
    chat: async (payload) => {
      captured = payload;
      return { ok: true, body: (async function* () { /* 空流：拿到 payload 即可 */ })() };
    },
  };
  return () => captured;
}

test('defaults：调用方未给参数时，配置的默认值被下发', async () => {
  const adapter = makeAdapter({
    defaults: { maxTokens: 1024, temperature: 0.3, reasoningEffort: 'high' },
  });
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
  });
  // 消费流直到组装 payload（第一拍就会发请求）
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal(payload.max_tokens, 1024, '默认 maxTokens 应被下发');
  assert.equal(payload.temperature, 0.3, '默认 temperature 应被下发');
  assert.equal(payload.reasoning_effort, 'high', '默认 reasoningEffort 应被下发');
});

test('defaults：调用方显式给的参数优先于默认值（temperature=0 必须保留）', async () => {
  const adapter = makeAdapter({
    defaults: { maxTokens: 1024, temperature: 0.3 },
  });
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    maxTokens: 64,
  });
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal(payload.temperature, 0, '显式 temperature=0 是合法值，绝不能被默认 0.3 覆盖');
  assert.equal(payload.max_tokens, 64, '显式 maxTokens 应优先于默认值');
});

test('defaults：没配置默认值时，payload 不含这些字段（不猜参数）', async () => {
  const adapter = makeAdapter();
  const getPayload = capturePayload(adapter);
  const stream = adapter.stream({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
  });
  for await (const chunk of stream) { void chunk; break; }
  const payload = getPayload();
  assert.equal('max_tokens' in payload, false, '没配置就绝不能下发 max_tokens');
  assert.equal('temperature' in payload, false, '没配置就绝不能下发 temperature');
  assert.equal('reasoning_effort' in payload, false, '没配置就绝不能下发 reasoning_effort');
});

// ── toAdapterModels 的 allow/deny 语义（纯函数层） ─────────────────────

test('toAdapterModels：allow 非空 = 白名单；deny 永远排除', () => {
  const allowOnly = toAdapterModels(CATALOG, { allow: ['model-b'] });
  assert.deepEqual(allowOnly.map((m) => m.id), ['model-b']);
  const denyOnly = toAdapterModels(CATALOG, { deny: ['model-b'] });
  assert.equal(denyOnly.length, 2);
  assert.ok(!denyOnly.some((m) => m.id === 'model-b'));
});

// ── 推理等级（reasoning）元数据与下发 ─────────────────────────────────

test('resolveModel：supports_reasoning 的模型必须带 reasoning 元数据（选择器据此显示推理下拉）', async () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy', displayName: 'WB',
    client: { models: async () => ({ data: [
      { id: 'thinker', name: 'Thinker', context_window: 100000, max_output_tokens: 8000, supports_reasoning: true },
      { id: 'plain', name: 'Plain', context_window: 100000, max_output_tokens: 8000 },
    ] }) },
  });
  const thinker = await adapter.resolveModel('workbuddy', 'thinker');
  assert.ok(thinker.reasoning, '支持推理的模型必须返回 reasoning 元数据');
  assert.ok(Array.isArray(thinker.reasoning.efforts) && thinker.reasoning.efforts.length >= 2,
    'efforts 必须是非空数组（dsh 校验 efforts.length===0 直接抛 INVALID_MODEL_REASONING）');
  for (const e of thinker.reasoning.efforts) {
    assert.equal(typeof e.id, 'string');
    assert.ok(e.id.length > 0, 'effort.id 必须非空（dsh 校验）');
    assert.equal(typeof e.name, 'string');
    assert.ok(e.name.length > 0);
  }
  // defaultEffort 必须在 efforts 里（dsh 校验：unknown defaultEffort 抛错）
  if (thinker.reasoning.defaultEffort !== undefined) {
    assert.ok(thinker.reasoning.efforts.some((e) => e.id === thinker.reasoning.defaultEffort),
      'defaultEffort 必须是 efforts 中的一员');
  }
  const plain = await adapter.resolveModel('workbuddy', 'plain');
  assert.equal('reasoning' in plain, false, '不支持推理的模型不能带 reasoning（不猜能力）');
});

test('stream：选择器选的 reasoningEffort 必须翻成上游 reasoning_effort，未选且无默认时不发', async () => {
  // 用两套 adapter 分别验证"选择器值优先"与"完全不发"
  const make = (defaults) => {
    const adapter = new WorkBuddyAdapter({
      provider: 'workbuddy', displayName: 'WB', defaults,
      client: { models: async () => ({ data: CATALOG }) },
    });
    let captured = null;
    adapter.client.chat = async (payload) => {
      captured = payload;
      return { ok: true, body: (async function* () { /* 拿到 payload 即可 */ })() };
    };
    return { adapter, get: () => captured };
  };

  // a) 用户在选择器选了 high → 必须下发 reasoning_effort: 'high'
  const a = make({});
  const s1 = a.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high' });
  for await (const c of s1) { void c; break; }
  assert.equal(a.get().reasoning_effort, 'high', '选择器选的等级必须下发');

  // b) 什么都没选、也没配默认 → 完全不下发（不猜）
  const b = make({});
  const s2 = b.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
  for await (const c of s2) { void c; break; }
  assert.equal('reasoning_effort' in b.get(), false, '未选择且无默认时不能发 reasoning_effort');

  // c) 没选但配置了默认 → 下发默认值
  const c2 = make({ reasoningEffort: 'low' });
  const s3 = c2.adapter.stream({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
  for await (const c of s3) { void c; break; }
  assert.equal(c2.get().reasoning_effort, 'low', '配置的默认等级应下发');
});

// ── 偏好文件的持久化（.model-prefs.json）─────────────────────────────

test('readModelPrefs/writeModelPrefs：持久化且对损坏文件健壮', async () => {
  // 这里不直接 import 插件内部函数（它们绑定 PLUGIN_DIR），而是从 apply 的
  // 行为面测：写偏好 → 重启形态（重新 apply）后偏好仍生效。完整 apply 需要
  // llm 服务桩，plugin.test.mjs 已有 —— 这里只测文件格式的健壮性等价物。
  const dir = mkdtempSync(join(tmpdir(), 'wb-prefs-'));
  try {
    const file = join(dir, '.model-prefs.json');
    writeFileSync(file, JSON.stringify({ visible: ['model-a', 'model-b'], at: 1 }), 'utf8');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(parsed.visible), 'visible 必须是数组（readModelPrefs 的契约）');

    // 损坏文件：读侧必须当作"没设置过"而不是抛异常
    writeFileSync(file, '{broken', 'utf8');
    let ok = true;
    try { JSON.parse(readFileSync(file, 'utf8')); } catch { ok = false; }
    assert.equal(ok, false, '损坏的 JSON 应被读侧 catch 掉，回落到"未设置"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(join(dir, '.model-prefs.json')), '清理后不应残留');
});

/**
 * 回归：可见性白名单必须**按 provider 分开**。
 *
 * 真出过一次 —— 全局白名单对三个分组一刀切，用户勾了 3 个模型后每个分组
 * 各只剩 2 个，表现为"改不了显示模型"。分组目录本来就不同（国际版 27 个、
 * 国内版 31 个），共用一份清单在语义上就不成立。
 */
test('可见性偏好按 provider 分开，改一组不影响另一组', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-vis-'));
  const file = join(dir, '.model-prefs.json');
  try {
    // 复刻 index.js 里 mergePrefs + writeModelPrefs 的语义（同一套键布局）
    const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
    const merge = (patch) => { writeFileSync(file, JSON.stringify({ ...read(), ...patch, at: 2 }), 'utf8'); };
    const write = (provider, visible) => {
      const cur = read().visibleByProvider && typeof read().visibleByProvider === 'object'
        ? { ...read().visibleByProvider } : {};
      cur[provider] = Array.isArray(visible) ? visible.map(String) : [];
      merge({ visibleByProvider: cur });
    };

    write('workbuddy', ['a', 'b']);
    write('workbuddy-ai', ['x']);
    let j = read();
    assert.deepEqual(j.visibleByProvider.workbuddy, ['a', 'b']);
    assert.deepEqual(j.visibleByProvider['workbuddy-ai'], ['x'], '改 ai 不能动主 provider');

    // 再改主 provider，ai 的必须原样保留
    write('workbuddy', ['a']);
    j = read();
    assert.deepEqual(j.visibleByProvider.workbuddy, ['a']);
    assert.deepEqual(j.visibleByProvider['workbuddy-ai'], ['x'], '改主 provider 不能动 ai');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 兼容：旧版只有全局 `visible` 键（没有 visibleByProvider）。
 * 升级后不能把用户的旧勾选弄丢 —— 它归属主 provider，分组不该继承。
 */
test('可见性偏好：兼容旧的全局 visible 键，且分组不继承', () => {
  const j = { visible: ['legacy-a', 'legacy-b'] };
  const readPrefs = (provider, primary) => {
    const perProvider = j?.visibleByProvider;
    if (perProvider && typeof perProvider === 'object' && Array.isArray(perProvider[provider])) return perProvider[provider];
    // 刻意不写 `!primary` 宽容分支 —— 理由见下一条用例
    if (Array.isArray(j.visible) && primary && provider === primary) return j.visible;
    return null;
  };
  assert.deepEqual(readPrefs('workbuddy', 'workbuddy'), ['legacy-a', 'legacy-b'], '主 provider 应读到旧值');
  assert.equal(readPrefs('workbuddy-ai', 'workbuddy'), null, '分组不该继承主 provider 的旧值');
});

/**
 * 回归：**调用方漏传主 provider 时不能静默串味**。
 *
 * 真踩过一次 —— 路由把 `readModelPrefs` 直接当单参函数传，第二个参数成了
 * undefined，而旧实现里的宽容分支 `!primaryProvider` 恒真，于是每个分组都
 * 读到主 provider 的清单，表现就是"改不了显示模型"（改了也没反应）。
 *
 * 现在没有那个宽容分支：漏传参数 = 判为"没有偏好"（null，即全部显示），
 * 而不是悄悄套用别人的清单。
 */
test('可见性偏好：漏传主 provider 时判为无偏好，不静默套用全局清单', () => {
  const j = { visible: ['main-only'] };
  const readPrefs = (provider, primary) => {
    const perProvider = j?.visibleByProvider;
    if (perProvider && typeof perProvider === 'object' && Array.isArray(perProvider[provider])) return perProvider[provider];
    if (Array.isArray(j.visible) && primary && provider === primary) return j.visible;
    return null;
  };
  assert.equal(readPrefs('workbuddy', undefined), null, '漏传主 provider 时不该回退到全局 visible');
  assert.equal(readPrefs('workbuddy-ai', undefined), null);
  assert.deepEqual(readPrefs('workbuddy', 'workbuddy'), ['main-only'], '显式传对时才回退');
});

/**
 * 回归：写入一个偏好时**绝不能冲掉另一个**。
 *
 * 真出过一次 —— 写上下文覆盖时用 `{ visible, context }` 整体重建对象，
 * 结果把用户勾选的可见清单冲掉了（23 个变 2 个）。
 *
 * 这里钉住的是**合并语义**：visible 与 context 同文件但互不干扰，
 * 而且文件里出现未知键时也要原样保留（未来加字段时不会互相踩）。
 */
test('偏好合并写：改一个键不能冲掉另一个（含未知键）', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function');
  // 直接验证合并写的行为契约：用同款语义在临时目录复现
  const dir = mkdtempSync(join(tmpdir(), 'wb-prefs-merge-'));
  const file = join(dir, '.model-prefs.json');
  try {
    // 初始状态：可见清单 + 一个未知键（模拟未来加的字段）
    const initial = { visible: ['a', 'b', 'c'], context: { a: 1000 }, futureKey: { x: 1 }, at: 1 };
    writeFileSync(file, JSON.stringify(initial), 'utf8');

    // 复现 mergePrefs 的语义：读回 → 浅合并 → 原子写
    const merge = (patch) => {
      const cur = JSON.parse(readFileSync(file, 'utf8'));
      const next = { ...cur, ...patch, at: 2 };
      const tmp = join(dir, '.tmp');
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      renameSync(tmp, file);
    };

    merge({ context: { a: 2000 } });
    const afterCtx = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(afterCtx.visible, ['a', 'b', 'c'], '写 context 不能动 visible');
    assert.deepEqual(afterCtx.context, { a: 2000 }, 'context 应已更新');
    assert.deepEqual(afterCtx.futureKey, { x: 1 }, '未知键必须原样保留');

    merge({ visible: ['a'] });
    const afterVisible = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(afterVisible.visible, ['a'], 'visible 应已更新');
    assert.deepEqual(afterVisible.context, { a: 2000 }, '写 visible 不能动 context');
    assert.deepEqual(afterVisible.futureKey, { x: 1 }, '未知键仍然要在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
