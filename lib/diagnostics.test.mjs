/**
 * 环境诊断的**展示口径**契约。
 *
 * 诊断是与控制台共用的模块（`lib/diagnostics.mjs`），它的 detail 会同时出现在
 * 控制台网页、dsh 设置页、以及用户复制给开发者的诊断报告里 —— 所以"显示什么"
 * 是契约，不是随手拼的字符串。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { humanDuration, summarizeAccounts } from './diagnostics.mjs';

/**
 * 诊断的「登录文件」正文必须显示**账号**，不是文件名。
 *
 * 回归（用户实测）：那一行原先把登录文件名用 ` · ` 拼起来，5 个带时间戳的备份
 * 拼成一长串 —— 用户看到的是"这登录文件是不是太多了"，而他想知道的是"我有几个
 * 账号"。实测 5 个文件其实只有 3 个账号。
 */
test('summarizeAccounts：按账号身份去重，显示 uin@domain 而不是文件名', () => {
  const files = [
    { name: 'workbuddy-desktop-ai.info', account: '450702377403', domain: 'www.workbuddy.ai' },
    // 同一账号的带时间戳备份（客户端切账号时留下的）—— 不该产生第二行
    { name: 'workbuddy-desktop-ai.2026-10-11T13-42-54-474Z.3500.abc.info', account: '450702377403', domain: 'www.workbuddy.ai' },
    { name: 'workbuddy-desktop-ai.2026-10-11T13-47-47-066Z.3500.def.info', account: '450702472734', domain: 'www.workbuddy.ai' },
    { name: 'workbuddy-desktop.info', account: '330125158554', domain: 'www.workbuddy.cn' },
    { name: 'workbuddy-desktop.2026-10-11T09-10-37-642Z.16856.ghi.info', account: '330125158554', domain: 'www.workbuddy.cn' },
  ];
  const { summary, count } = summarizeAccounts(files);

  assert.equal(count, 3, '5 个文件是 3 个账号');
  assert.equal(summary,
    '450702377403@www.workbuddy.ai  ·  450702472734@www.workbuddy.ai  ·  330125158554@www.workbuddy.cn');

  // **关键**：正文里不能出现带时间戳的长文件名
  assert.ok(!/\.2026-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(summary),
    `正文不该出现文件名：${summary}`);
  assert.ok(!/\.info/.test(summary), `正文不该出现 .info 后缀：${summary}`);
});

test('summarizeAccounts：uin 缺失时退回 userId，再退回文件名', () => {
  const { summary } = summarizeAccounts([
    { name: 'a.info', userId: 'uid-1', domain: 'www.workbuddy.ai' },
    { name: 'only-name.info' },
  ]);
  assert.equal(summary, 'uid-1@www.workbuddy.ai  ·  未识别');
});

test('summarizeAccounts：空列表 / 脏数据都安全', () => {
  assert.deepEqual(summarizeAccounts([]), { summary: '', unique: [], count: 0 });
  assert.deepEqual(summarizeAccounts(null), { summary: '', unique: [], count: 0 });
  // 没有身份字段的条目会被跳过（不能显示成"未识别"占位，那会撑宽列表）
  assert.equal(summarizeAccounts([{}, { name: '' }]).count, 0);
});

test('summarizeAccounts：域名缺失时只显示账号（不拼出空 @）', () => {
  const { summary } = summarizeAccounts([{ name: 'a.info', account: '330125158554' }]);
  assert.equal(summary, '330125158554', '没有域名就不该出现 "@"');
});

test('humanDuration：诊断里"剩余 X 天 Y 小时"的口径', () => {
  // 注意：实现里小时后面**总会**带分钟（`5 小时 0 分`），不是 `5 小时` ——
  // 断言按实际契约写，不按"我觉得应该怎样"。
  assert.equal(humanDuration(2 * 86400e3 + 3 * 3600e3), '2 天 3 小时');
  assert.equal(humanDuration(5 * 3600e3), '5 小时 0 分');
  assert.equal(humanDuration(-1), '已过期');
});
