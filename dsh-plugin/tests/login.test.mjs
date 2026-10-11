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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  archiveSnapshot,
  cancelLogin,
  listManagedAccounts,
  maskEmail,
  maskIdentity,
  maskPhone,
  pollLogin,
  REGIONS,
  removeManagedAccount,
  resolveAccountLabel,
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

// ── 自动存档 ────────────────────────────────────────────────────────────
// 这是"切账号后旧账号还在"的唯一实现方式：客户端切账号会覆盖
// workbuddy-desktop.info，切走的账号在磁盘上就没了。必须在切换前持续存档。

/** 造一个"客户端登录文件"（内容是 AtRest 信封占位，存档不需要解密）。 */
function writeClientAuth(dir, { uid = 'cafe0000-1111-2222-3333-444455556666', mark = 'v1' } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'workbuddy-desktop.info');
  writeFileSync(path, JSON.stringify({
    account: { uin: '330125158554', nickname: '' },
    auth: { accessToken: { $wbEncrypted: 1, envelope: mark }, domain: 'www.codebuddy.cn', expiresAt: Date.now() + 864e5 },
    accounts: [], allAccounts: [],
  }, null, 2), 'utf8');
  return { path, uid };
}

test('自动存档：原样复制客户端快照，并打上纳管标记', () => {
  const clientDir = join(dir, 'client-auth');
  const { path: src, uid } = writeClientAuth(clientDir);
  const r = archiveSnapshot({ dshHome: dir, uid, sourcePath: src });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true, '首次存档必须写入');

  const saved = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(saved.managed, true, '必须打上 managed 标记，否则 listManagedAccounts 认不出');
  assert.equal(saved.archivedFrom, src, '要记下来源，便于排障');
  // **原样**：auth 段一个字节都不改（不重新加密，也就不会引入格式差异）
  const original = JSON.parse(readFileSync(src, 'utf8'));
  assert.deepEqual(saved.auth, original.auth, 'auth 段必须原样保留（不重新封装）');
  // 存档后它就该出现在纳管列表里
  assert.equal(listManagedAccounts(dir).length, 1);
});

test('自动存档：来源没变就不重写（巡检每 15 秒跑，不能反复写盘）', () => {
  const clientDir = join(dir, 'client-auth');
  const { path: src, uid } = writeClientAuth(clientDir);
  assert.equal(archiveSnapshot({ dshHome: dir, uid, sourcePath: src }).changed, true);
  const again = archiveSnapshot({ dshHome: dir, uid, sourcePath: src });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, '来源 mtime 没变 → 不该重复写盘');
});

/**
 * mtime 精度：`statSync().mtimeMs` 在 NTFS 上带小数，写进 JSON 再读回来，
 * 与内存里的浮点数直接 `===` 可能差一个 ULP —— 那会把"没变"判成"变了"，
 * 于是巡检每 15 秒白写一次盘（还每次都触发分组桥重读凭据）。
 * 这条断言"存档登记的是整数毫秒"，把精度问题钉死在源头。
 */
test('自动存档：登记的 sourceMtime 是整数毫秒（防浮点精度导致反复写盘）', () => {
  const clientDir = join(dir, 'client-auth');
  const { path: src, uid } = writeClientAuth(clientDir);
  const r = archiveSnapshot({ dshHome: dir, uid, sourcePath: src });
  assert.equal(r.ok, true);
  const saved = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(Number.isInteger(saved.sourceMtime), true,
    `sourceMtime 必须是整数毫秒，实际 ${saved.sourceMtime}（浮点会让"没变"判成"变了"）`);
  // 连续三次调用都应判"没变"
  for (let i = 0; i < 3; i += 1) {
    assert.equal(archiveSnapshot({ dshHome: dir, uid, sourcePath: src }).changed, false,
      `第 ${i + 2} 次调用不该重写`);
  }
});

test('自动存档：来源更新后滚动覆盖（活跃账号跟着客户端刷新，不会 30 天过期）', async () => {
  const clientDir = join(dir, 'client-auth');
  const { path: src, uid } = writeClientAuth(clientDir, { mark: 'v1' });
  assert.equal(archiveSnapshot({ dshHome: dir, uid, sourcePath: src }).changed, true);

  // 客户端刷新了令牌（mtime 变化）→ 存档必须跟上
  await new Promise((r) => setTimeout(r, 20));
  writeClientAuth(clientDir, { mark: 'v2' });
  const r = archiveSnapshot({ dshHome: dir, uid, sourcePath: src });
  assert.equal(r.changed, true, '来源更新后必须重写存档');
  const saved = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(saved.auth.accessToken.envelope, 'v2', '存档必须反映客户端的最新令牌');
});

test('自动存档：来源就在纳管目录里时不自复制（否则会覆盖掉标记）', () => {
  const adir = join(dir, 'workbuddy-accounts');
  const path = writeManaged(adir, 'self0000000000');
  const r = archiveSnapshot({ dshHome: dir, uid: 'self0000000000', sourcePath: path });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false, '来源即存档：不该自我复制');
  // 标记必须还在
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).managed, true);
});

test('自动存档：来源不存在 / 非法 JSON / 缺少 auth 段都如实报错，不写坏文件', () => {
  const missing = archiveSnapshot({ dshHome: dir, uid: 'a11111111111', sourcePath: join(dir, 'nope.info') });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /读不到来源/);

  mkdirSync(dir, { recursive: true });
  const bad = join(dir, 'bad.info');
  writeFileSync(bad, '{不是 JSON', 'utf8');
  const r1 = archiveSnapshot({ dshHome: dir, uid: 'a22222222222', sourcePath: bad });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /不是合法 JSON/);

  const noAuth = join(dir, 'noauth.info');
  writeFileSync(noAuth, JSON.stringify({ account: {} }), 'utf8');
  const r2 = archiveSnapshot({ dshHome: dir, uid: 'a33333333333', sourcePath: noAuth });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /没有 auth 段/);

  // 三次失败都不该留下纳管文件
  assert.equal(listManagedAccounts(dir).length, 0, '失败不能留下半个存档');
});

test('自动存档：缺少 uid / 来源路径时拒绝', () => {
  assert.equal(archiveSnapshot({ dshHome: dir, uid: '', sourcePath: 'C:/x.info' }).ok, false);
  assert.equal(archiveSnapshot({ dshHome: dir, uid: 'abc', sourcePath: '' }).ok, false);
});

/**
 * 原子写：分组桥随时在读凭据文件，写到一半被读到 = 半个 JSON = 桥 503。
 * 这条钉住"写完之后目录里只剩目标文件"——临时文件必须被 rename 掉，不能残留。
 */
test('自动存档：原子写，不留临时文件', () => {
  const clientDir = join(dir, 'client-auth');
  const { path: src, uid } = writeClientAuth(clientDir);
  assert.equal(archiveSnapshot({ dshHome: dir, uid, sourcePath: src }).ok, true);

  const adir = join(dir, 'workbuddy-accounts');
  const leftover = readdirSync(adir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftover, [], `不该留下临时文件：${leftover.join(', ')}`);
  // 目录里只有那一个凭据文件
  assert.deepEqual(readdirSync(adir), [`${uid}.info`]);
  // 内容必须是**完整** JSON（原子写的目的就是读者永远看到完整文件）
  assert.ok(JSON.parse(readFileSync(join(adir, `${uid}.info`), 'utf8')).managed);
});

// ── 账号标签脱敏 ────────────────────────────────────────────────────────
/*
 * 这些字段会进**截图**（docs/*.png，公开仓库）、日志与诊断报告，所以脱敏是安全
 * 相关代码，不是显示偏好。用户的要求是"一眼认出是哪个账号"，所以可见位数不能
 * 太少（都显示成 `1***0` 就分不清了），但也不能泄露完整号码。
 */

test('maskPhone：保留前 3 后 4，中间固定星号', () => {
  assert.equal(maskPhone('19157621006'), '191****1006');
  assert.equal(maskPhone('18505580760'), '185****0760');
  // 太短的不掩（没什么可掩的，原样更好认）
  assert.equal(maskPhone('123'), '123');
  assert.equal(maskPhone(''), '');
});

test('maskEmail：本地部分前 2 后 2，域名保留，星号数固定', () => {
  assert.equal(maskEmail('a3236792972@gmail.com'), 'a3****72@gmail.com');
  assert.equal(maskEmail('ab@x.com'), 'a*@x.com');
  // 域名必须保留 —— 用户靠它区分国内版/国际版
  assert.ok(maskEmail('someone@workbuddy.ai').endsWith('@workbuddy.ai'));
  // 星号数固定（不随长度增长），否则窄列会被撑宽
  const longLocal = maskEmail('aaaaaaaaaaaaaaaaaaaaaaa@x.com').split('@')[0];
  assert.equal((longLocal.match(/\*/g) || []).length, 4, `星号数必须固定：${longLocal}`);
});

test('maskIdentity：按形状判，不按字段名（昵称里可能就是手机号/邮箱）', () => {
  assert.equal(maskIdentity('19157621006'), '191****1006');
  assert.equal(maskIdentity('a3236792972@gmail.com'), 'a3****72@gmail.com');
  // 真昵称不是 PII，原样保留（打码反而更难认）
  assert.equal(maskIdentity('局第二'), '局第二');
  assert.equal(maskIdentity('jiale'), 'jiale');
  assert.equal(maskIdentity(''), '');
});

test('resolveAccountLabel：手机号 → 邮箱 → 昵称 → uin', () => {
  // ① 手机号优先（明文形式）
  assert.deepEqual(
    resolveAccountLabel({ account: { phoneNumber: '19157621006', nickname: '局第二', uin: '3301' } }, null),
    { label: '191****1006', full: '19157621006', kind: 'phone' });
  // ② 没手机号 → 昵称当邮箱（国际版就是这样，昵称字段里是邮箱）
  assert.deepEqual(
    resolveAccountLabel({ account: { nickname: 'a3236792972@gmail.com', uin: '4507' } }, null),
    { label: 'a3****72@gmail.com', full: 'a3236792972@gmail.com', kind: 'email' });
  // ③ 昵称是普通人名 → 原样
  assert.deepEqual(
    resolveAccountLabel({ account: { nickname: '局第二', uin: '3301' } }, null),
    { label: '局第二', full: '局第二', kind: 'nickname' });
  // ④ 什么都解不出 → 退回明文 uin（**绝不返回空**）
  assert.deepEqual(
    resolveAccountLabel({ account: { uin: '330125158554' } }, null),
    { label: '330125158554', full: '330125158554', kind: 'uin' });
});

test('resolveAccountLabel：加密信封解出后要脱敏', () => {
  const env = { $wbEncrypted: 1, envelope: 'x' };
  const decrypt = (v) => (v === env ? '19157621006' : null);
  const r = resolveAccountLabel({ account: { phoneNumber: env, uin: '3301' } }, decrypt);
  assert.equal(r.label, '191****1006', '信封解开后要脱敏');
  assert.equal(r.full, '19157621006');
});

test('resolveAccountLabel：解不开就退回 uin，绝不抛', () => {
  const env = { $wbEncrypted: 1, envelope: 'x' };
  // 解密函数抛错
  const throwing = () => { throw new Error('key fetch failed'); };
  const r1 = resolveAccountLabel({ account: { phoneNumber: env, uin: '330125158554' } }, throwing);
  assert.equal(r1.label, '330125158554', '解不开要退回明文 uin，不能让账号变成无名');
  assert.equal(r1.kind, 'uin');
  // 没有解密函数（密钥没就绪）
  const r2 = resolveAccountLabel({ account: { phoneNumber: env, uin: '330125158554' } }, null);
  assert.equal(r2.label, '330125158554');
  // 完全没有账户信息
  assert.equal(resolveAccountLabel({}, null).label, '');
  assert.equal(resolveAccountLabel(null, null).label, '');
});

test('listManagedAccounts：默认只回脱敏标签，不含完整 PII', () => {
  const adir = join(dir, 'workbuddy-accounts');
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'aaaa-bbbb.info'), JSON.stringify({
    account: { uin: '330125158554', nickname: '局第二', phoneNumber: { $wbEncrypted: 1, envelope: 'x' } },
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, domain: 'www.workbuddy.cn', expiresAt: Date.now() + 864e5 },
    managed: true,
  }), 'utf8');

  const decrypt = (v) => (v && v.$wbEncrypted === 1 && v.envelope === 'x' ? '18505580760' : null);
  const list = listManagedAccounts(dir, { decrypt });
  assert.equal(list.length, 1);
  assert.equal(list[0].label, '185****0760', '面板显示的是脱敏值');
  assert.equal(list[0].labelKind, 'phone');
  assert.equal(list[0].uin, '330125158554');

  /*
   * **关键隐私断言**：默认返回值里不能出现完整手机号。
   * 这个对象会被序列化后发给浏览器、也会出现在截图与诊断报告里 ——
   * 一旦带出完整 PII，就等于把它写进了公开仓库。
   */
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes('18505580760'), `默认返回值泄漏了完整手机号：${serialized}`);
  assert.ok(!list[0].fullLabel, '默认不返回 fullLabel');

  // 明确要求时才给完整值（供"显示完整账号"这类主动操作）
  const withFull = listManagedAccounts(dir, { decrypt, full: true });
  assert.equal(withFull[0].fullLabel, '18505580760');
});

test('listManagedAccounts：拿不到解密函数时退回 uin（面板不能空白）', () => {
  const adir = join(dir, 'workbuddy-accounts');
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'cccc-dddd.info'), JSON.stringify({
    account: { uin: '330125158554', phoneNumber: { $wbEncrypted: 1, envelope: 'x' } },
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, expiresAt: Date.now() + 864e5 },
    managed: true,
  }), 'utf8');

  const list = listManagedAccounts(dir); // 不传 decrypt
  assert.equal(list.length, 1);
  assert.equal(list[0].label, '330125158554', '解不开要显示 uin，不能是空');
  assert.equal(list[0].labelKind, 'uin');
});
