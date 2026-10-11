/**
 * 桥的**补全模型**必须带上图片能力声明。
 *
 * ## 背景（用户报的"judier-cod 下 deepseek-v4.1-flash 不能看图"）
 *
 * `FEATURED` 里的模型是**补全项** —— 它们不在上游目录端点里（国际版尤其明显：
 * `deepseek-v4.1-flash` 根本不出现），由桥硬编码补进来。补全时漏了 `images`
 * 字段，于是：
 *
 *     images: !!m.supportsImages   →  false
 *     → 桥不声明 supports_images
 *     → dsh 认为该模型不支持图片
 *     → 用户贴不了图（而模型其实能看图）
 *
 * ## 排查过程中踩的坑（值得记下来）
 *
 * 我一开始用 **1x1 / 16x16 的玩具图**去测，得到 400 `model_param_invalid`，
 * 于是**误判成"模型不支持图片"**。用户说"我测试过，是支持的"——他是对的。
 * 换成真实尺寸的图片（400x300）后，同一个模型返回 200 "Green"。
 *
 * **结论：判据必须用真实尺寸的图片。** 上游会把小到不合理的图当成无效请求拒掉，
 * 那个 400 是载荷问题，不是能力问题。这个测试因此同时钉住两件事：
 *   1. 补全项必须带 `images`（否则 `supports_images` 缺失）；
 *   2. FEATURED 里的模型能力声明要与**真实图片实测**一致。
 *
 *   node --test dsh-plugin/tests/featured-vision.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BRIDGE = join(ROOT, 'bridge', 'workbuddy-bridge.mjs');
const read = (p) => readFileSync(p, 'utf8');

test('FEATURED 补全项必须声明 images（否则补全的模型在 dsh 里贴不了图）', () => {
  const src = read(BRIDGE);

  const featured = src.match(/const FEATURED = \[([\s\S]*?)\n\];/);
  assert.ok(featured, '应当能定位到 FEATURED 定义');

  // 每一项都必须显式写 images —— 这些模型拿不到上游字段，不写就是 false
  const entries = [...featured[1].matchAll(/\{\s*id:\s*'([^']+)'[^}]*\}/g)];
  assert.ok(entries.length >= 3, `FEATURED 应当有若干项，实际 ${entries.length}`);
  for (const [, id] of entries) {
    const one = entries.find((e) => e[1] === id)[0];
    assert.match(one, /images:\s*true/,
      `FEATURED 里的「${id}」必须显式声明 images: true —— 它是补全项，拿不到上游的 supportsImages，漏写等于声明"不支持图片"`);
  }
});

test('补全时要把 images 传成 supportsImages（不是只在 FEATURED 里写）', () => {
  const src = read(BRIDGE);

  // 补全那段：merged.set(f.id, {...}) 里必须带 supportsImages
  const block = src.match(/for \(const f of FEATURED\)[\s\S]*?shape\.supplemented/);
  assert.ok(block, '应当能定位到 FEATURED 补全那段');
  assert.match(block[0], /f\.images\s*\?\s*\{\s*supportsImages:\s*true\s*\}/,
    '补全项必须把 f.images 映射成 supportsImages —— 否则目录里的 images 仍是 false');

  // 目录输出那一行确实读 supportsImages
  assert.match(src, /images:\s*!!m\.supportsImages/,
    '目录输出应当读 supportsImages（补全项带上了，这里才会是 true）');
});

/**
 * 能力声明的**真机实测记录**（作为注释契约钉住，避免有人"觉得小图也行"又改回去）。
 * 这里只断言注释里留了这条实测结论 —— 因为真正的验证需要打上游，不能进 CI。
 */
test('代码里要留下"小图会被上游拒"这条实测结论（防后人重踩）', () => {
  const src = read(BRIDGE);
  assert.match(src, /1x1|玩具图|小到不合理/,
    'FEATURED 附近应当注明"玩具尺寸的图会被上游当无效请求拒"，否则下次排查还会误判成"模型不支持图片"');
  assert.match(src, /真实\s*400x300|400x300/, '应当记下验证用的真实尺寸');
});
