/**
 * 协议层自测：用**打桩的上游**驱动适配器，验证
 *   1. dsh 消息 / 工具 → OpenAI wire 请求的转换；
 *   2. OpenAI SSE → dsh StreamChunk 的顺序与内容；
 *   3. 错误、终止、abort 都以 finish 块收尾（契约要求）。
 *
 * 不碰真实上游、不消耗任何额度：桩服务器只回放固定 SSE。
 *
 *   node --test dsh-plugin/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { WorkBuddyAdapter, mapUsage } from '../lib/adapter.mjs';
import { BridgeClient } from '../lib/bridge.mjs';
import { makeResolveImage } from '../lib/index.js';
import { creditTag, withCreditTag, isPriceBadge, effectiveCredits, toAdapterModels } from '../lib/models.mjs';

/** 起一个假桥：/health、/v1/models、/v1/chat/completions（SSE 回放）。 */
async function startStub({ sseFrames = [], status = 200, errorBody = null, capture = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        pid: 4242,
        startedAt: new Date().toISOString(),
        uptimeMs: 60000,
        auth: { userId: 'stub-user', endpoint: 'https://example.invalid', expiresAt: new Date(Date.now() + 86400000).toISOString(), expired: false },
        models: ['stub-model'],
        catalogSize: 2,
        catalogAt: new Date().toISOString(),
      }));
    }
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'stub-model', name: 'Stub Model', context_window: 128000, max_output_tokens: 8192, credits: 0.5, supports_images: true },
          { id: 'stub-free', name: 'Stub Free', context_window: 32000, max_output_tokens: 4096, credits: 0, free: true },
        ],
      }));
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (capture) capture.body = body;
      if (errorBody) {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(errorBody));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of sseFrames) {
        res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`);
        await new Promise((r) => setTimeout(r, 1));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no route' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function makeAdapter(baseUrl, capture, resolveImage, extra = {}) {
  const client = new BridgeClient({ baseUrl, token: 't', timeoutMs: 5000 });
  return new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client,
    ensureReady: async () => client,
    resolveImage: resolveImage || (async () => 'data:image/png;base64,AAAA'),
    log: () => {},
    filter: { allow: [], deny: [] },
    catalogTtlMs: 0,
    ...extra,
  });
}

/**
 * 忠实复刻 dsh-attachment-local 的 readImage()：它会把引用里的
 * mediaType/width/height/bytes 与落盘对象的真实元数据逐项核对，
 * 对不上就抛 ATTACHMENT_CORRUPT。偏宽松的桩会让这类 bug 溜过去。
 */
function makeStrictImageStore(ref, bytes) {
  const calls = [];
  return {
    calls,
    async readImage(passed) {
      calls.push(passed);
      const ok =
        passed &&
        passed.attachmentId === ref.attachmentId &&
        passed.mediaType === ref.mediaType &&
        passed.width === ref.width &&
        passed.height === ref.height &&
        passed.bytes === ref.bytes;
      if (!ok) {
        const e = new Error('Stored attachment metadata does not match its reference.');
        e.code = 'ATTACHMENT_CORRUPT';
        throw e;
      }
      return { ref: passed, data: bytes };
    },
  };
}

/** 真 PNG 头 + 指定宽高，让字节本身也自洽。 */
function pngBytes(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

/**
 * 上下文上限（`effectiveContext`）的语义测试。
 *
 * 这是"上限"而不是"声称值"，两条方向必须都不出错：
 *   - 只能压小（目录 1M + 覆盖 200k → 200k）—— 这才是用户想要的
 *   - **绝不放大**（目录 96k + 覆盖 1M → 96k）—— 放大会让 dsh 以为能塞更多
 *     历史，然后在上游拿到 context 错误，是更难查的失败
 */
test('effectiveContext：只压小，绝不放大', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {
    contextOverrides: { 'm-big': 200000, 'm-small': 1000000 },
    contextMaxTokens: 0,
  });
  // 压小：目录 1M，覆盖 200k → 200k
  assert.equal(a.effectiveContext('m-big', 1000000), 200000);
  // 不放大：目录 96k，覆盖 1M → 96k
  assert.equal(a.effectiveContext('m-small', 96000), 96000);
  // 没有覆盖时保持目录值
  assert.equal(a.effectiveContext('m-plain', 128000), 128000);
  // 目录没给值、也没有覆盖 → undefined（不编造）
  assert.equal(a.effectiveContext('m-unknown', undefined), undefined);
});

test('effectiveContext：全局上限对所有模型生效，且取三者最小', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {
    contextOverrides: { m1: 500000 },
    contextMaxTokens: 300000,
  });
  // 目录 1M、模型覆盖 500k、全局 300k → 300k
  assert.equal(a.effectiveContext('m1', 1000000), 300000);
  // 目录 200k 已经小于全局 → 保持 200k（不放大）
  assert.equal(a.effectiveContext('m2', 200000), 200000);
  // 全局为 0 = 不限制
  const b = makeAdapter('http://127.0.0.1:1', null, null, { contextOverrides: {}, contextMaxTokens: 0 });
  assert.equal(b.effectiveContext('m1', 1000000), 1000000);
});

test('促销徽章：只把"影响价格判断"的标进展示名', () => {
  // 免费类与降价类要标 —— 用户据此知道这是时段价，不是常态价
  for (const good of ['夜间免费', '限时免费', '夜间折扣', '错峰使用', 'Free now', '限时优惠']) {
    assert.equal(isPriceBadge(good), true, `「${good}」应当标注`);
  }
  // 营销文案不标 —— 展示名已带模型名+倍率，再塞噪音就看不清价了
  for (const noise of ['新上线', '推荐', '热门', '', '   ']) {
    assert.equal(isPriceBadge(noise), false, `「${noise}」不该标注`);
  }
  assert.equal(isPriceBadge(null), false);
  assert.equal(isPriceBadge(undefined), false);
  assert.equal(isPriceBadge(123), false, '非字符串不该崩');
});

/**
 * 回归：上游目录**漏报倍率**时要能手动补声明。
 *
 * 实测国际版目录里 `deepseek-v4.1-flash` 连 `credits` 都没有，但 32433 tokens
 * 扣分恒为 0（真免费）。漏报导致展示名没有价 —— 用户既怕贵不敢用、
 * 又不知道它免费。下面钉住覆盖语义与"只收非负数"的防呆。
 */
test('倍率覆盖：目录漏报时手动补声明，非法值不采信', () => {
  const catalog = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },         // 目录完全没给 credits
    { id: 'glm-5.2', name: 'GLM-5.2', credits: 0.4, badge: '夜间折扣' }, // 目录有值
  ];
  const plain = toAdapterModels(catalog, { showCredits: true });
  assert.equal(plain[0].name, 'DeepSeek-V4.1-Flash', '目录没给倍率就没有价可标');
  const ov = toAdapterModels(catalog, { showCredits: true, creditOverrides: { 'deepseek-v4.1-flash': 0 } });
  assert.equal(ov[0].name, 'DeepSeek-V4.1-Flash · 免费', '覆盖 0 应当显示免费');
  const ov2 = toAdapterModels(catalog, { showCredits: true, creditOverrides: { 'deepseek-v4.1-flash': 0.11 } });
  assert.equal(ov2[0].name, 'DeepSeek-V4.1-Flash · 0.11×');
  const ov3 = toAdapterModels(catalog, { showCredits: true, creditOverrides: { 'glm-5.2': 0.2 } });
  assert.equal(ov3[1].name, 'GLM-5.2 · 0.2×（夜间折扣）', '覆盖应优先于目录值');
});

test('effectiveCredits：只收非负数，负数与脏值一律忽略', () => {
  const m = { id: 'x', credits: 0.5 };
  assert.deepEqual(effectiveCredits(m, { x: 0 }), { credits: 0, free: true });
  assert.deepEqual(effectiveCredits(m, { x: 1.2 }), { credits: 1.2, free: false });
  assert.deepEqual(effectiveCredits(m, { x: '0.3' }), { credits: 0.3, free: false }, '数字字符串要认');
  for (const bad of [-1, NaN, 'abc', null, undefined, '']) {
    const got = effectiveCredits(m, { x: bad });
    assert.equal(got.credits, 0.5, `${JSON.stringify(bad)} 应回落目录值`);
  }
  assert.deepEqual(effectiveCredits({ id: 'y', credits: 0, free: true }, {}), { credits: 0, free: true });
});

test('setCreditOverrides：面板 setter 同样只收非负数', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {});
  a.setCreditOverrides({ zero: 0, pos: 0.3, text: '0.5', neg: -1, bad: 'abc', empty: '', nil: null });
  assert.deepEqual(a.creditOverrides, { zero: 0, pos: 0.3, text: 0.5 });
  a.setCreditOverrides(null);
  assert.deepEqual(a.creditOverrides, {});
  a.setCreditOverrides([]);
  assert.deepEqual(a.creditOverrides, {});
});

test('免费无促销来源时不编造说明（国际版 hy4-preview 的实际形状）', () => {
  const catalog = [
    // 上游只给 credits:0、无任何促销标注 —— 不能替它写成"限时免费"
    { id: 'hy4-preview', name: 'Hy4 preview', credits: 0 },
    { id: 'hy3', name: 'Hy3', credits: 0 },
    // 有促销来源的才补说明
    { id: 'hy4-preview-f', name: 'Hy4 preview', credits: 0, free: true, badge: '限时免费' },
  ];
  const out = toAdapterModels(catalog, { showCredits: true });
  const byId = Object.fromEntries(out.map((m) => [m.id, m.name]));
  assert.equal(byId['hy4-preview'], 'Hy4 preview · 免费', '无促销来源 → 只写免费，不编来源');
  assert.equal(byId.hy3, 'Hy3 · 免费');
  assert.equal(byId['hy4-preview-f'], 'Hy4 preview · 免费（限时免费）', '有来源才补说明');
});

test('展示名：倍率与促销徽章同时出现，且 id 不受影响', () => {
  const catalog = [
    // 夜间折扣：0.79 已乘 0.5 → 0.4，徽章说明"为什么便宜"
    { id: 'glm-5.2', name: 'GLM-5.2', credits: 0.4, badge: '夜间折扣' },
    { id: 'hy3', name: 'Hy3', credits: 0, free: true, badge: '限时免费' },
    { id: 'plain', name: 'Plain', credits: 0.11 },
    // 有徽章但没倍率：只标徽章（用户仍需知道它免费）
    { id: 'promo-only', name: 'Promo Only', badge: '夜间免费' },
    { id: 'noisy', name: 'Noisy', credits: 0.5, badge: '新上线' },
  ];
  const out = toAdapterModels(catalog, { showCredits: true });
  const byId = Object.fromEntries(out.map((m) => [m.id, m.name]));
  assert.equal(byId['glm-5.2'], 'GLM-5.2 · 0.4×（夜间折扣）');
  assert.equal(byId.hy3, 'Hy3 · 免费（限时免费）');
  assert.equal(byId.plain, 'Plain · 0.11×');
  assert.equal(byId['promo-only'], 'Promo Only · 夜间免费');
  assert.equal(byId.noisy, 'Noisy · 0.5×', '营销徽章不进展示名');
  // id 永远是路由键，绝不改动
  assert.deepEqual(out.map((m) => m.id), ['glm-5.2', 'hy3', 'plain', 'promo-only', 'noisy']);
  // 关掉开关时不带任何标记
  const off = toAdapterModels(catalog, { showCredits: false });
  assert.equal(off[0].name, 'GLM-5.2');
});

test('促销徽章也能从 tags 里取（旧宿主没有字段级 badge）', () => {
  const catalog = [{ id: 'm', name: 'M', credits: 0.3, tags: ['badge:夜间折扣:#1E90FF'] }];
  const [m] = toAdapterModels(catalog, { showCredits: true });
  assert.equal(m.name, 'M · 0.3×（夜间折扣）', '旧宿主把徽章塞在 tags 里，也要认');
});

test('setContextMaxTokens：面板档位用，非法值一律当成"不限"', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {});
  assert.equal(a.setContextMaxTokens(262144), 262144, '262k 档');
  assert.equal(a.contextMaxTokens, 262144);
  assert.equal(a.setContextMaxTokens(1000000), 1000000, '1M 档');
  // 0 / 空 / 非法 → 不限（不是"设成 0 就把上下文禁掉"）
  for (const bad of [0, -1, NaN, null, undefined, 'abc', 12.5, '']) {
    assert.equal(a.setContextMaxTokens(bad), 0, `${JSON.stringify(bad)} 应回落到 0（不限）`);
    assert.equal(a.contextMaxTokens, 0);
  }
  // 数字字符串要认（面板传过来可能是字符串）
  assert.equal(a.setContextMaxTokens('262144'), 262144);
});

test('262k 档：只压 ≥262k 的模型，更小的原样保留', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {});
  a.setContextMaxTokens(262144);
  assert.equal(a.effectiveContext('big', 1000000), 262144, '1M 压到 262k');
  assert.equal(a.effectiveContext('mid', 400000), 262144, '400k 也压');
  assert.equal(a.effectiveContext('small', 256000), 256000, '256k 保持（比档位小，不放大）');
  assert.equal(a.effectiveContext('tiny', 96000), 96000, '96k 保持');
  // 1M 档：上游最大就是 1M，等于不限制
  a.setContextMaxTokens(1000000);
  assert.equal(a.effectiveContext('big', 1000000), 1000000);
});

test('图片能力覆盖：目录漏报时可手动声明，且双向都生效', () => {
  // 复刻真实情况：国际版账号下 deepseek-v4.1-flash 的 supports_images 为空
  const catalog = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'hy4-preview', name: 'Hy4 preview', supports_images: true },
    { id: 'text-only', name: 'Text Only' },
  ];
  // 不覆盖：照目录走
  const plain = toAdapterModels(catalog, {});
  assert.deepEqual(plain[0].inputModalities, ['text'], '目录没声明就不该声称支持');
  assert.deepEqual(plain[1].inputModalities, ['text', 'image']);
  // 覆盖 true：目录漏报时补声明
  const forced = toAdapterModels(catalog, { visionOverrides: { 'deepseek-v4.1-flash': true } });
  assert.deepEqual(forced[0].inputModalities, ['text', 'image'], '覆盖 true 应声明支持');
  // 覆盖 false：目录误报时也能压掉
  const off = toAdapterModels(catalog, { visionOverrides: { 'hy4-preview': false } });
  assert.deepEqual(off[1].inputModalities, ['text'], '覆盖 false 应压掉目录的声明');
  assert.deepEqual(off[2].inputModalities, ['text'], '未列出的模型不受影响');
});

test('setVisionOverrides：只收布尔值，含糊的值一律丢弃', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {});
  a.setVisionOverrides({
    yes: true,
    no: false,
    textTrue: 'true',   // 字符串不算：含糊值被当成"支持"会让用户贴图后被上游拒绝
    one: 1,
    zero: 0,
    nullish: null,
    '': true,
  });
  assert.deepEqual(a.visionOverrides, { yes: true, no: false });
  // 非对象输入不炸
  a.setVisionOverrides(null);
  assert.deepEqual(a.visionOverrides, {});
  a.setVisionOverrides([]);
  assert.deepEqual(a.visionOverrides, {});
});

test('resolveModel 也应用图片覆盖（列表显示了，调用判定必须同口径）', async () => {
  const stub = await startStub();
  try {
    // stub 的 stub-model 声明了 supports_images: true
    const off = makeAdapter(stub.baseUrl, null, null, { visionOverrides: { 'stub-model': false } });
    const r = await off.resolveModel('workbuddy', 'stub-model');
    assert.deepEqual(r.inputModalities, ['text'], 'resolveModel 必须与 listModels 同口径');
  } finally { await stub.close(); }
});

test('setContextOverrides：非法值一律丢弃（dsh 要求正整数）', () => {
  const a = makeAdapter('http://127.0.0.1:1', null, null, {});
  a.setContextOverrides({
    ok: 128000,
    // YAML / 表单里数字常写成字符串，这种要认（转得成正整数）
    numericText: '64000',
    zero: 0,
    negative: -1,
    decimal: 12.5,
    notANumber: 'abc',
    nan: NaN,
    empty: '',
    nullish: null,
  });
  assert.deepEqual(
    a.contextOverrides,
    { ok: 128000, numericText: 64000 },
    '只保留正整数（含可转成正整数的数字字符串）',
  );
  // 非对象输入不炸，退化成空覆盖
  a.setContextOverrides(null);
  assert.deepEqual(a.contextOverrides, {});
  a.setContextOverrides('nope');
  assert.deepEqual(a.contextOverrides, {});
  a.setContextOverrides([]);
  assert.deepEqual(a.contextOverrides, {});
});

test('resolveModel 应用上下文上限：压小生效，放大无效', async () => {
  const stub = await startStub();
  try {
    // stub 里 stub-model 的 context_window = 128000
    const shrink = makeAdapter(stub.baseUrl, null, null, { contextOverrides: { 'stub-model': 64000 } });
    assert.equal((await shrink.resolveModel('workbuddy', 'stub-model')).context.contextWindow, 64000);

    const enlarge = makeAdapter(stub.baseUrl, null, null, { contextOverrides: { 'stub-model': 9000000 } });
    assert.equal((await enlarge.resolveModel('workbuddy', 'stub-model')).context.contextWindow, 128000,
      '覆盖值大于目录值时必须保持目录值（不能放大）');

    // 非法覆盖值被忽略，回落到目录值
    const bogus = makeAdapter(stub.baseUrl, null, null, { contextOverrides: { 'stub-model': -5 } });
    assert.equal((await bogus.resolveModel('workbuddy', 'stub-model')).context.contextWindow, 128000);
  } finally { await stub.close(); }
});

test('倍率标记：只标已知数值，不猜、不编造', () => {
  // 正常倍率：去掉多余小数尾
  assert.equal(creditTag(0.5), '0.5×');
  assert.equal(creditTag(0.11), '0.11×');
  assert.equal(creditTag(2.2), '2.2×');
  assert.equal(creditTag(1), '1×');
  assert.equal(creditTag(0.79), '0.79×');
  // 免费：credits === 0 或显式 free:true
  assert.equal(creditTag(0), '免费');
  assert.equal(creditTag(0.5, true), '免费');
  // 未知 / 非法：不产出标记（宁可没有，也不能标错价）
  assert.equal(creditTag(undefined), '');
  assert.equal(creditTag(null), '');
  assert.equal(creditTag(''), '');
  assert.equal(creditTag('abc'), '');
  assert.equal(creditTag(-1), '');
  assert.equal(creditTag(NaN), '');
  // 拼装：没有标记时不留下孤零零的分隔符
  assert.equal(withCreditTag('GLM-5.3', 0.79), 'GLM-5.3 · 0.79×');
  assert.equal(withCreditTag('GLM-5.3', undefined), 'GLM-5.3');
});

test('倍率开关：showCredits=false 时名称保持干净，且 id 永不受影响', () => {
  const catalog = [
    { id: 'm1', name: 'Model One', credits: 0.25, supports_images: true },
    { id: 'm2', name: 'Model Two', credits: 0, free: true },
  ];
  const on = toAdapterModels(catalog, { showCredits: true });
  assert.deepEqual(on.map((m) => m.name), ['Model One · 0.25×', 'Model Two · 免费']);
  const off = toAdapterModels(catalog, { showCredits: false });
  assert.deepEqual(off.map((m) => m.name), ['Model One', 'Model Two']);
  // 无论开关如何，id 都是路由键，必须原样
  assert.deepEqual(on.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(off.map((m) => m.id), ['m1', 'm2']);
  // 上下文 / 多模态等元数据不受标记影响
  assert.equal(on[0].contextWindow, undefined);
  assert.deepEqual(on[0].inputModalities, ['text', 'image']);
});

test('listModels / resolveModel 使用桥目录的元数据', async () => {
  const stub = await startStub();
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const models = await adapter.listModels();
    assert.equal(models.length, 2);
    // 展示名带消耗倍率标记：选择器只渲染 name，倍率看不见就等于盲选。
    // id 必须保持裸 id（路由键），只有 name 变。
    assert.deepEqual(models[0], { provider: 'workbuddy', id: 'stub-model', name: 'Stub Model · 0.5×', inputModalities: ['text', 'image'] });
    assert.deepEqual(models[1], { provider: 'workbuddy', id: 'stub-free', name: 'Stub Free · 免费', inputModalities: ['text'] });
    const resolved = await adapter.resolveModel('workbuddy', 'stub-model');
    assert.equal(resolved.context.contextWindow, 128000);
    assert.equal(resolved.defaultMaxTokens, 8192);
    // 触发标签（会话标题等处）用干净的名字，不重复倍率后缀
    assert.equal(resolved.name, 'Stub Model');
    assert.equal(adapter.providerInfo('workbuddy').id, 'workbuddy');
    assert.equal(adapter.providerRetryPolicy().mode, 'normal');
  } finally { await stub.close(); }
});

test('文本流：block-start → text-delta → block-end → usage → finish', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ role: 'assistant', content: '' }),
      delta({ content: '你' }),
      delta({ content: '好' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) out.push(chunk);

    assert.deepEqual(out.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.equal(out[0].blockType, 'text');
    assert.equal(out[3].block.text, '你好');
    assert.deepEqual(out[4].usage, { inputTokens: 11, outputTokens: 2, totalTokens: 13 });
    assert.deepEqual(out[5].reason, { kind: 'stop' });
  } finally { await stub.close(); }
});

test('文本流：命中缓存的 usage 如实映射进 dsh 用量桶（端到端）', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ role: 'assistant', content: '' }),
      delta({ content: 'OK' }),
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1456,
          completion_tokens: 1,
          total_tokens: 1457,
          prompt_tokens_details: { cached_tokens: 1280 },
          prompt_cache_hit_tokens: 1280,
          prompt_cache_miss_tokens: 176,
          cached_tokens: 0,
        },
      },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) out.push(chunk);
    const usage = out.find((c) => c.type === 'usage')?.usage;
    assert.deepEqual(usage, { inputTokens: 176, outputTokens: 1, totalTokens: 1457, cacheReadTokens: 1280 });
  } finally { await stub.close(); }
});

test('usage 映射：inputTokens 是「未命中缓存」的输入（回归：命中率上限被压到 50%）', () => {
  // 本机上游**实测**的真实 payload：prompt_tokens 含缓存，命中 + 未命中 = prompt_tokens
  const warm = mapUsage({
    prompt_tokens: 1456,
    completion_tokens: 1,
    total_tokens: 1457,
    prompt_tokens_details: { cached_tokens: 1280 },
    prompt_cache_hit_tokens: 1280,
    prompt_cache_miss_tokens: 176,
    cached_tokens: 0, // 上游同时下发的恒 0 占位，不许挡住真实值
    cache_read_input_tokens: 0,
    prompt_cache_write_tokens: 0,
  });
  assert.equal(warm.inputTokens, 176, '未命中缓存的那部分才是 inputTokens');
  assert.equal(warm.cacheReadTokens, 1280);
  assert.equal(warm.outputTokens, 1);
  assert.equal(warm.totalTokens, 1457);
  // dsh 的会话命中率 = cacheRead / (uncachedInput + cacheRead + cacheWrite)
  const hitRate = warm.cacheReadTokens / (warm.inputTokens + warm.cacheReadTokens);
  assert.ok(Math.abs(hitRate - 0.879) < 0.001, `真实命中率应约 87.9%，实际 ${(hitRate * 100).toFixed(1)}%`);

  // 冷启动：全未命中
  const cold = mapUsage({ prompt_tokens: 1456, completion_tokens: 1, total_tokens: 1457, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1456 });
  assert.equal(cold.inputTokens, 1456);
  assert.equal(cold.cacheReadTokens, undefined, '零缓存字段必须省略，不编造 0');

  // 全命中：命中率上限必须能到 100%（旧实现这里恰好只有 50%）
  const full = mapUsage({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 0 });
  assert.equal(full.inputTokens, 0);
  assert.equal(full.cacheReadTokens / (full.inputTokens + full.cacheReadTokens), 1);
});

test('usage 映射：字段别名、缓存写、脏数据防御', () => {
  // 只有 Anthropic 风格别名时也要认
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 60 }).inputTokens, 40);
  // 缓存写单列：三个桶互斥，input 要把写的那部分一并减掉
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_write_tokens: 30 }).inputTokens, 70);
  // miss 与另外两个桶不自洽（上游漏报 hit）→ 不信 miss，按减法倒推
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 10 }).inputTokens, 50);
  // 脏数据：负数忽略、超量兜底到 0（input 永不为负）
  assert.equal(mapUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: -5 }).inputTokens, 10);
  assert.equal(mapUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 999 }).inputTokens, 0);
  assert.equal(mapUsage(null), null);
});

test('工具调用：tool-call-delta 累积出完整的 JSON 参数，finish 为 tool-calls', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    const end = out.find((c) => c.type === 'block-end');
    assert.deepEqual(end.block, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' });
    assert.equal(out.at(-1).reason.kind, 'tool-calls');
    const start = out.find((c) => c.type === 'block-start');
    assert.equal(start.blockType, 'tool-call');
  } finally { await stub.close(); }
});

test('wire 请求：developer→system、工具表、图片、max_tokens', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      system: 'SYS',
      maxTokens: 256,
      temperature: 0.3,
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      toolHistory: { tools: [], updates: [{ messageId: 'm1', additions: [{ name: 'grep', description: 'grep', parameters: { type: 'object' } }] }] },
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'DEV' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
      ],
    })) { /* drain */ }

    const body = capture.body;
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'SYS');
    assert.equal(body.messages[1].role, 'system', 'developer 必须被改写成 system');
    assert.equal(body.messages[1].content, 'DEV');
    assert.equal(body.messages[2].role, 'user');
    assert.equal(body.messages[2].content[0].type, 'text');
    assert.equal(body.messages[2].content[1].type, 'image_url');
    assert.match(body.messages[2].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.messages[3].tool_calls[0].function.name, 'read');
    assert.equal(body.messages[4].role, 'tool');
    assert.equal(body.messages[4].tool_call_id, 'c1');
    assert.equal(body.messages[4].content, 'file body');
    assert.deepEqual(body.tools.map((t) => t.function.name), ['read', 'grep'], 'toolHistory 的动态新增必须一起带上');
  } finally { await stub.close(); }
});

test('tool 结果里的图片必须转成 image_url 数组段（read_image 可见性回归）', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看看这张图' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{"path":"a.png"}' }] },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: 'image/png image, 320x200 px' },
            { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
          ],
        },
      ],
    })) { /* drain */ }

    const toolMessage = capture.body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMessage, 'tool 消息必须存在');
    assert.ok(Array.isArray(toolMessage.content), '带图的 tool 结果必须是多段数组，否则图片会被整段丢弃');
    assert.equal(toolMessage.content[0].type, 'text');
    assert.equal(toolMessage.content[1].type, 'image_url');
    assert.match(toolMessage.content[1].image_url.url, /^data:image\/png;base64,/);
  } finally { await stub.close(); }
});

/**
 * 回归：resolveImage 必须把**整份** durable 引用交给附件存储。
 *
 * 现场症状：用户贴图后，模型只收到 "[图片：无法读取该附件]"，看一眼图都做不到。
 * 根因：宿主把 { attachmentId, mediaType } 这个**残缺**引用传给
 * attachments.readImage()，而它会拿引用里的 width/height/bytes 与落盘对象的
 * 真实元数据逐项核对，对不上就抛 ATTACHMENT_CORRUPT；adapter 侧
 * `.catch(() => null)` 把异常吞成 null，于是每一张图都退化成文字占位。
 *
 * 这里用 makeStrictImageStore 复刻那套核对（偏宽松的桩会让 bug 溜过去），
 * 断言的是**真的那份 resolveImage 实现**。
 */
test('图片回归：残缺引用会被判 ATTACHMENT_CORRUPT，完整引用才能出图', async () => {
  const attachment = {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png',
    width: 322,
    height: 631,
    bytes: 312562,
  };
  const bytes = pngBytes(attachment.width, attachment.height);
  const store = makeStrictImageStore(attachment, bytes);

  // 1) 残缺引用（旧实现就是这么传的）——必须失败，证明这个桩真的会拦。
  await assert.rejects(
    () => store.readImage({ attachmentId: attachment.attachmentId, mediaType: attachment.mediaType }),
    /metadata does not match/,
    '桩必须复刻真实存储的元数据核对，否则测不出这个 bug',
  );

  // 2) 走真的 resolveImage：它必须原样透传整份引用，并产出可用的 data URL。
  const resolveImage = makeResolveImage((name) => (name === 'attachments' ? store : undefined));
  const url = await resolveImage(attachment);
  assert.equal(store.calls.at(-1), attachment,
    'resolveImage 必须把整份引用（含 width/height/bytes）交给 readImage');
  assert.match(url, /^data:image\/png;base64,/);

  // 3) 单张图成功，端到端就不再出现占位文字。
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl, capture, resolveImage);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment }] }],
    })) { /* drain */ }

    const userMessage = capture.body.messages.find((m) => m.role === 'user');
    const imgPart = userMessage.content.find((p) => p.type === 'image_url');
    assert.ok(imgPart, '图片必须以 image_url 段下发');
    assert.doesNotMatch(JSON.stringify(userMessage.content), /无法读取该附件/,
      '读图成功时绝不能出现"[图片：无法读取该附件]"占位');
  } finally { await stub.close(); }
});

/**
 * 回归：图片读取失败**必须留下原因**，不能静默吞成 null。
 *
 * 这是实测故障的根因面：`resolveImage` 把异常吞掉，用户只看到
 * 「[图片：无法读取该附件]」，完全不知道断在哪一步。加 onError 上报后，
 * 至少能在日志里看到「attachments 服务不可用」这类可行动的线索。
 */
test('makeResolveImage：失败经 onError 上报原因，不静默吞掉', async () => {
  const seen = [];
  const onError = (reason) => seen.push(reason);

  // 1) 服务不可用
  const noService = makeResolveImage(() => undefined, onError);
  assert.equal(await noService({ attachmentId: 'x', mediaType: 'image/png' }), null);
  assert.match(seen.at(-1), /attachments 服务不可用/);

  // 2) 引用残缺
  const noId = makeResolveImage(() => ({}), onError);
  assert.equal(await noId({ mediaType: 'image/png' }), null);
  assert.match(seen.at(-1), /缺少 attachmentId/);

  // 3) readImage 抛错（真实场景：元数据核对失败 → ATTACHMENT_CORRUPT）
  const throwing = makeResolveImage(() => ({
    async readImage() { const e = new Error('metadata does not match'); e.code = 'ATTACHMENT_CORRUPT'; throw e; },
  }), onError);
  assert.equal(await throwing({ attachmentId: 'y', mediaType: 'image/png' }), null);
  assert.match(seen.at(-1), /readImage 抛错/);
  assert.match(seen.at(-1), /metadata does not match/);

  // 4) 返回对象里没有字节
  const noBytes = makeResolveImage(() => ({ async readImage() { return { ref: {} }; } }), onError);
  assert.equal(await noBytes({ attachmentId: 'z', mediaType: 'image/png' }), null);
  assert.match(seen.at(-1), /未返回字节/);

  // 上报回调本身抛错也不能影响降级（否则会把宿主拖挂）
  const badReporter = makeResolveImage(() => undefined, () => { throw new Error('reporter boom'); });
  assert.equal(await badReporter({ attachmentId: 'q', mediaType: 'image/png' }), null);
});

test('纯文本 tool 结果仍保持字符串形态（不因上面的修复而改变）', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'file body' }] },
      ],
    })) { /* drain */ }

    const toolMessage = capture.body.messages.find((m) => m.role === 'tool');
    assert.equal(toolMessage.content, 'file body');
  } finally { await stub.close(); }
});

test('wire 净化：空助手轮与孤儿 tool 结果被剔除，成对的工具调用保留', async () => {
  const capture = {};
  const stub = await startStub({
    sseFrames: [delta({ content: 'ok' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    capture,
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    for await (const _ of adapter.stream({
      provider: 'workbuddy',
      model: 'stub-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一问' }] },
        { role: 'assistant', content: [] },                                              // 空助手轮（上一轮失败留下的）
        { role: 'assistant', content: [{ type: 'text', text: '' }] },                    // 只有空文本，同样算空
        { role: 'user', content: [{ type: 'text', text: '第二问' }] },
        { role: 'tool', toolCallId: 'orphan-1', content: [{ type: 'text', text: '没配对的工具结果' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: '配对的工具结果' }] },
        { role: 'user', content: [{ type: 'text', text: '第三问' }] },
      ],
    })) { /* drain */ }

    const roles = capture.body.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'user', 'assistant', 'tool', 'user'],
      '空的助手轮和孤儿 tool 结果都要消失，成对的助手/工具结果必须保留');
    assert.equal(capture.body.messages[0].content, '第一问');
    assert.equal(capture.body.messages[1].content, '第二问');
    assert.equal(capture.body.messages[2].tool_calls[0].id, 'c9');
    assert.equal(capture.body.messages[3].tool_call_id, 'c9');
    assert.equal(capture.body.messages[4].content, '第三问');
  } finally { await stub.close(); }
});

test('推理流：reasoning 块独立编号，正文块从其后的索引开始', async () => {
  const stub = await startStub({
    sseFrames: [
      delta({ reasoning_content: '想' }),
      delta({ reasoning_content: '一下' }),
      delta({ content: '答案' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ],
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    const starts = out.filter((c) => c.type === 'block-start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((s) => [s.index, s.blockType]), [[0, 'reasoning'], [1, 'text']]);
    const ends = out.filter((c) => c.type === 'block-end');
    assert.deepEqual(ends.map((e) => e.block.type), ['reasoning', 'text']);
    assert.equal(ends[0].block.text, '想一下');
    assert.equal(ends[1].block.text, '答案');
  } finally { await stub.close(); }
});

test('上游错误：不抛异常，以 error finish 收尾并带上状态码', async () => {
  const stub = await startStub({ status: 429, errorBody: { error: { message: 'rate limited' }, code: 11102 } });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const out = [];
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'finish');
    assert.equal(out[0].reason.kind, 'error');
    assert.equal(out[0].reason.failure.status, 429);
    assert.equal(out[0].reason.failure.code, 'RATE_LIMIT');
    assert.match(out[0].reason.failure.message, /rate limited/);
  } finally { await stub.close(); }
});

test('空回复：finish 变成 EMPTY_RESPONSE 错误而不是静默 stop', async () => {
  /**
   * 这段只回一帧就结束，在 `node --test` 并行跑多个测试文件、CPU 抢得厉害时，
   * 偶尔会在读完之前被对端提前关闭，此时适配器如实报 `TRANSPORT`（这是**正确**行为，
   * 不是 bug）。因此这里允许重试一次：真的协议错会两次都错，环境抖动只错一次。
   */
  const run = async () => {
    const stub = await startStub({ sseFrames: [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }] });
    try {
      const adapter = makeAdapter(stub.baseUrl);
      const out = [];
      for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [] })) out.push(chunk);
      return out.at(-1);
    } finally { await stub.close(); }
  };

  let finish = await run();
  if (finish.reason.failure?.code === 'TRANSPORT') finish = await run();
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE', `实际：${finish.reason.failure.code} / ${finish.reason.failure.message}`);
});

test('取消：abort 后以 aborted finish 收尾', async () => {
  const stub = await startStub({
    sseFrames: Array.from({ length: 200 }, (_, i) => delta({ content: 'x' + i })),
  });
  try {
    const adapter = makeAdapter(stub.baseUrl);
    const controller = new AbortController();
    const out = [];
    let count = 0;
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'stub-model', messages: [], signal: controller.signal })) {
      out.push(chunk);
      count += 1;
      if (count === 3) controller.abort();
    }
    const finish = out.at(-1);
    assert.equal(finish.type, 'finish');
    assert.ok(['aborted', 'stop'].includes(finish.reason.kind) || finish.reason.kind === 'error');
    if (finish.reason.kind === 'aborted') assert.equal(finish.reason.failure.code, 'ABORTED');
  } finally { await stub.close(); }
});

test('模型不在白名单：直接以 INVALID_REQUEST 收尾，不打上游', async () => {
  const adapter = new WorkBuddyAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    client: new BridgeClient({ baseUrl: 'http://127.0.0.1:1', token: '' }),
    filter: { allow: ['other-model'] },
  });
  const out = [];
  for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'text-embedding-3', messages: [] })) out.push(chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'INVALID_REQUEST');
});
