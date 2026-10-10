/**
 * `bundlesAllInstalled()` 的用例 —— 「空 = 未知，未知不等于健康」。
 *
 *   node --test lib/dsh.test.mjs
 *
 * 为什么要单独钉这一条：`[].every(...)` 在 JS 里返回 `true`，所以只要
 * 「插件列表读不出来」这条路径一旦走到（profile 目录缺失、解析异常被 catch 吞掉），
 * 原来的写法就会把「什么都没检查」报成「健康」。这类 bug 不会报错、也不会崩，
 * 只会让用户看着一个绿点以为一切正常 —— 只有用例能拦住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bundlesAllInstalled, bundleInAsar } from './dsh.mjs';

test('bundlesAllInstalled：空列表不算健康（读不到 ≠ 都装好了）', () => {
  assert.equal(bundlesAllInstalled([]), false, '空数组必须判为 false —— 这是本用例存在的唯一理由');
});

test('bundlesAllInstalled：非数组输入一律 false', () => {
  for (const bad of [null, undefined, 'x', 0, {}]) {
    assert.equal(bundlesAllInstalled(bad), false, `${JSON.stringify(bad)} 应当判为 false`);
  }
});

test('bundlesAllInstalled：全装好为 true，缺一个为 false', () => {
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: true }]), true);
  assert.equal(bundlesAllInstalled([{ installed: true }, { installed: false }]), false);
});

/**
 * `bundleInAsar()`：打包版 DSH 把 bundle 放在 app.asar 里，普通 Node 的 fs
 * 读不进去，于是诊断会把它们永远判成"缺失"。这个函数是那条误报的修正。
 *
 * 这里钉住两件事：
 *   1. **坏输入必须返回 false**，绝不能抛 —— 它在诊断的兜底路径上被调用，
 *      抛异常会连累整个诊断。
 *   2. **不存在的包必须返回 false** —— 把"不确定"粉饰成"已安装"，
 *      正是这类修正最容易犯的错（比误报更糟）。
 */
test('bundleInAsar：坏输入一律 false，不抛异常', () => {
  const rt = 'D:/Apps/DeepSeekHarness/resources/runtime';
  for (const bad of ['', null, undefined, 'a/b/c/d/e', '   ']) {
    assert.equal(bundleInAsar(bad, rt), false, `${JSON.stringify(bad)} 应判 false 且不抛`);
  }
});

test('bundleInAsar：runtime 路径无效时返回 false（不硬崩）', () => {
  // 注意这里**不测 undefined**：那是默认参数，会正确地回退到 config.dsh.runtime
  // （本机真实的 DSH 安装），而不是"无效路径"。
  for (const rt of [null, '', 'Z:/nope/runtime', 'relative/path']) {
    assert.equal(bundleInAsar('@deepseek-ai/dsh-base', rt), false, `runtime=${JSON.stringify(rt)} 应判 false`);
  }
});

test('bundleInAsar：runtime 省略时回退到 config 里的真实 runtime', () => {
  // 与「显式传无效路径」区分开：省略参数应当用配置值，这是设计行为。
  const withDefault = bundleInAsar('@deepseek-ai/dsh-base');
  assert.equal(typeof withDefault, 'boolean', '必须返回布尔值，不能抛');
  // 本机装了 DSH 就是 true；没装则 false。两种都合法，只钉"不抛、是布尔"。
  assert.equal(withDefault, bundleInAsar('@deepseek-ai/dsh-base', undefined), '显式 undefined 与省略等价');
});

test('bundleInAsar：本机真实 asar 内存在的包判 true，不存在的判 false', () => {
  const rt = 'D:/Apps/DeepSeekHarness/resources/runtime';
  // 只在本机能定位到 DSH 安装时断言存在性；找不到就跳过（CI 上不该失败）
  const found = bundleInAsar('@deepseek-ai/dsh-base', rt);
  if (found) {
    assert.equal(bundleInAsar('@deepseek-ai/dsh-web-app', rt), true);
  }
  // 不存在的包在任何情况下都必须是 false —— 这是防"粉饰"的关键一条
  assert.equal(bundleInAsar('@deepseek-ai/definitely-not-a-real-bundle', rt), false);
});
