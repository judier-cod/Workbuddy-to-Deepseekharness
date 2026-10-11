/**
 * AtRest 信封的封装 / 解封契约。
 *
 * `sealEncryptedField` 是账号登录模块的地基：它让插件能把 OAuth 拿到的令牌
 * 写成**与客户端同款**的加密信封，桥因此不必改一行代码。若这里退化成明文或
 * 结构对不上，桥会解不开 —— 而"看不出原因的登录失败"正是最难排查的一类故障。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { defaultExecutableCandidates, deriveAtRestKey, deriveAtRestKeyId, fetchKeyFor, isEncryptedFieldWrapper, openEncryptedField, sealEncryptedField } from './atrest.mjs';

/** 本机必须有客户端才能取到密钥；取不到就跳过需要密钥的用例。 */
function tryKey() {
  const candidates = defaultExecutableCandidates().filter((p) => { try { return existsSync(p); } catch { return false; } });
  return candidates.length ? fetchKeyFor(candidates, '') : null;
}

const keyPromise = tryKey();

test('seal → open 往返：短串', async () => {
  const got = await keyPromise;
  if (!got) return; // 无客户端环境：跳过
  const sealed = sealEncryptedField('hello-workbuddy', got.key);
  assert.equal(openEncryptedField(sealed, got.key), 'hello-workbuddy');
});

test('seal → open 往返：JWT 形状与多字节字符', async () => {
  const got = await keyPromise;
  if (!got) return;
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiLmt7HlnLPmnLrkv6Hku73mlLnmlL_nmoTlhYPkuoYifQ.sig';
  assert.equal(openEncryptedField(sealEncryptedField(jwt, got.key), got.key), jwt);
});

test('封出的信封与客户端登录文件同构（桥能原样解开的前提）', async () => {
  const got = await keyPromise;
  if (!got) return;
  const sealed = sealEncryptedField('x', got.key);
  // 包装层：必须是客户端那两个键，且标记为加密字段
  assert.equal(isEncryptedFieldWrapper(sealed), true);
  assert.deepEqual(Object.keys(sealed).sort(), ['$wbEncrypted', 'envelope']);
  assert.equal(sealed.$wbEncrypted, 1);

  // 信封层：字段集必须与真实文件一致（缺一个桥就解不开）
  const env = JSON.parse(Buffer.from(sealed.envelope, 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(env).sort(), ['authTag', 'ciphertext', 'keyId', 'nonce', 'suite']);

  // keyId 必须与本客户端派生的一致 —— 这是"桥认得出"的关键
  assert.equal(env.keyId, deriveAtRestKeyId(got.key));
  assert.match(env.keyId, /^[0-9a-f]{16}$/);
});

test('每次封装的 nonce 都不同（重放安全）', async () => {
  const got = await keyPromise;
  if (!got) return;
  const a = JSON.parse(Buffer.from(sealEncryptedField('same', got.key).envelope, 'base64').toString('utf8'));
  const b = JSON.parse(Buffer.from(sealEncryptedField('same', got.key).envelope, 'base64').toString('utf8'));
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ciphertext, b.ciphertext, '同样明文两次封装的密文必须不同');
});

test('空串与超长串都能往返', async () => {
  const got = await keyPromise;
  if (!got) return;
  assert.equal(openEncryptedField(sealEncryptedField('', got.key), got.key), '');
  const long = 'x'.repeat(5000);
  assert.equal(openEncryptedField(sealEncryptedField(long, got.key), got.key), long);
});
