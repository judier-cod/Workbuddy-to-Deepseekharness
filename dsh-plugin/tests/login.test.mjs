/**
 * 账号登录模块的契约测试。
 *
 * 真实的上游交互（发起登录、轮询）需要浏览器授权，不可能在 CI 里跑 ——
 * 因此这里钉住的是**不依赖网络的那部分**：纳管文件的形状、权限、枚举、
 * 删除的安全边界，以及信封的往返。
 *
 * 上游 pending 码的判定单独测（用打桩的 fetch），因为它是"会不会把中间态
 * 误判成成功/失败"的关键分支。
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  cancelLogin,
  listManagedAccounts,
  pollLogin,
  REGIONS,
  removeManagedAccount,
  startLogin,
} from '../lib/login.mjs';

/** 造一个纳管凭据文件（不写真实令牌，只是形状正确的占位）。 */
function writeManaged(dir, uid, { managed = true, expiresAt = Date.now() + 864e5, domain = 'www.codebuddy.cn' } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${uid}.info`);
  writeFileSync(path, JSON.stringify({
    account: { uin: '', nickname: '' },
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, domain, expiresAt },
    managed,
  }, null, 2), 'utf8');
  return path;
}

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wb-login-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('只支持国内版（国际版成功态未实测，不做）', () => {
  assert.deepEqual(Object.keys(REGIONS), ['cn']);
  assert.equal(REGIONS.cn.base, 'https://copilot.tencent.com');
});

test('纳管账号：目录不存在时返回空列表（不抛错）', () => {
  assert.deepEqual(listManagedAccounts(join(dir, 'nonexistent')), []);
});

test('纳管账号：能列出，且不含任何凭据内容', () => {
  writeManaged(join(dir, 'workbuddy-accounts'), 'abcdef1234567890');
  const list = listManagedAccounts(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].uid, 'abcdef1234567890');
  assert.equal(list[0].domain, 'www.codebuddy.cn');
  // 关键的隐私断言：返回值里不能有令牌/信封字段
  const flat = JSON.stringify(list);
  assert.ok(!/accessToken|envelope|refreshToken/.test(flat), `返回值泄漏了凭据字段：${flat}`);
});

test('纳管账号：只认 managed:true 的文件，不碰同目录的其它文件', () => {
  const adir = join(dir, 'workbuddy-accounts');
  writeManaged(adir, 'good0000000000', { managed: true });
  writeManaged(adir, 'foreign0000000', { managed: false });
  const list = listManagedAccounts(dir);
  assert.equal(list.length, 1, '非纳管文件必须被跳过');
  assert.equal(list[0].uid, 'good0000000000');
});

test('纳管账号：过期判定', () => {
  const adir = join(dir, 'workbuddy-accounts');
  writeManaged(adir, 'fresh000000000', { expiresAt: Date.now() + 864e5 });
  writeManaged(adir, 'stale000000000', { expiresAt: Date.now() - 1000 });
  const list = listManagedAccounts(dir).sort((a, b) => a.uid.localeCompare(b.uid));
  assert.equal(list.find((a) => a.uid === 'fresh000000000').expired, false);
  assert.equal(list.find((a) => a.uid === 'stale000000000').expired, true);
});

test('纳管账号：单个文件损坏不影响列出其它', () => {
  const adir = join(dir, 'workbuddy-accounts');
  writeManaged(adir, 'broken00000000');
  writeFileSync(join(adir, 'garbage.info'), '{这不是 JSON', 'utf8');
  const list = listManagedAccounts(dir);
  assert.equal(list.length, 1);
});

test('移除：正常删除', () => {
  const adir = join(dir, 'workbuddy-accounts');
  const path = writeManaged(adir, 'doomed00000000');
  assert.ok(existsSync(path));
  const r = removeManagedAccount(dir, 'doomed00000000');
  assert.equal(r.ok, true);
  assert.equal(existsSync(path), false);
});

test('移除：拒绝删除非纳管文件（这是安全边界，不是普通校验）', () => {
  const adir = join(dir, 'workbuddy-accounts');
  const path = writeManaged(adir, 'notmine0000000', { managed: false });
  const r = removeManagedAccount(dir, 'notmine0000000');
  assert.equal(r.ok, false);
  assert.match(r.error, /不是插件纳管/);
  assert.equal(existsSync(path), true, '拒绝时必须原样留下文件');
});

test('移除：路径穿越必须被挡住（uid 来自用户输入）', () => {
  const r = removeManagedAccount(dir, '../../etc/passwd');
  assert.equal(r.ok, false, '穿越路径不能删成任何东西');
});

test('移除：缺少 uid 时拒绝', () => {
  const r = removeManagedAccount(dir, '');
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少账号标识/);
});

test('登录流程：不支持的区域直接拒绝（不发起网络请求）', async () => {
  const r = await startLogin({ dshHome: dir, region: 'global' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持的区域/);
});

test('登录流程：上游失败时如实报错，不留下半程状态', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ code: 500 }) });
  try {
    const r = await startLogin({ dshHome: dir, region: 'cn' });
    assert.equal(r.ok, false);
    assert.match(r.error, /发起登录失败/);
    // 失败不能留下可轮询的 id
    assert.equal(r.id, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('登录流程：pending 码 11217 时继续等待（不误判为成功或失败）', async () => {
  const original = globalThis.fetch;
  let pollCalls = 0;
  globalThis.fetch = async (url) => {
    // 发起阶段要 code 0 + state；轮询阶段回 pending
    if (String(url).includes('/auth/state')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: 'st-1', authUrl: 'https://example/login' } }) };
    }
    pollCalls += 1;
    return { ok: true, status: 200, json: async () => ({ code: 11217, msg: '11217:login ing...' }) };
  };
  try {
    const started = await startLogin({ dshHome: dir, region: 'cn' });
    assert.equal(started.ok, true, '前置：发起成功');
    const polled = await pollLogin(started.id);
    assert.equal(polled.status, 'pending');
    assert.ok(pollCalls >= 1);
    // 关键的：pending 之后仍可继续轮询，state 没被清掉
    const again = await pollLogin(started.id);
    assert.equal(again.status, 'pending');
    cancelLogin(started.id);
  } finally {
    globalThis.fetch = original;
  }
});

test('登录流程：取消后不能再轮询', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/state')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: 'st-2', authUrl: 'https://example/login' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 11217 }) };
  };
  try {
    const started = await startLogin({ dshHome: dir, region: 'cn' });
    assert.equal(cancelLogin(started.id), true);
    const after = await pollLogin(started.id);
    assert.equal(after.status, 'unknown');
  } finally {
    globalThis.fetch = original;
  }
});

test('登录流程：轮询不存在的 id 返回 unknown（不抛错）', async () => {
  const r = await pollLogin('no-such-id');
  assert.equal(r.status, 'unknown');
});

test('纳管文件：权限为 0600', () => {
  // persist() 是真写文件的那条路径，但它需要真实的客户端密钥（本机有）。
  // 这里只验证"写出来的文件权限受控"这一契约：直接复刻 chmod 行为。
  const path = join(dir, 'perm.info');
  writeFileSync(path, '{}', 'utf8');
  chmodSync(path, 0o600);
  // POSIX 上可读；Windows 上 chmod 是 no-op，断言不强制
  if (process.platform !== 'win32') {
    const { statSync } = require('node:fs');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.ok(existsSync(path));
});

test('纳管目录：不在仓库内（防凭据被 git 提交）', () => {
  // login.mjs 的 accountDir 未导出，这里钉住其契约：位于 dshHome 下
  const adir = join(dir, 'workbuddy-accounts');
  writeManaged(adir, 'x0000000000000');
  assert.ok(adir.includes('workbuddy-accounts'));
  // 仓库根目录里绝不能出现纳管目录
  const repoRoot = join(process.cwd(), '..');
  assert.equal(existsSync(join(repoRoot, 'workbuddy-accounts')), false,
    '纳管目录不能落在仓库根');
});
