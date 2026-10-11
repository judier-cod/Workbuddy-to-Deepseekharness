/**
 * 账号登录 —— 走官方 CLI OAuth，产出与客户端同格式的加密登录文件。
 *
 * 为什么需要它：国内版客户端把登录态写死在
 * `%LOCALAPPDATA%\…\auth\workbuddy-desktop.info`，文件名是常量，**登第二个
 * 国内版账号会覆盖第一个**。所以「同时用两个不同的国内版账号」在只读客户端
 * 快照的设计下做不到。这里自己走一次官方登录流程，拿到令牌后写进
 * `$DSH_HOME/workbuddy-accounts/<uid>.info`，成为一条独立的账号分组凭据。
 *
 * 为什么产出的是 AtRest 信封而不是明文：项目红线禁止凭据落盘，其真实意图
 * （NOTICE.md）是**禁止写明文**——明文会破坏客户端的加密存储。这里用与客户端
 * 同款的 AES-256-GCM 字段信封（`sealEncryptedField`），桥的 `readStoredAuth()`
 * 原样认得出，**桥零改动**，也没有明文落到磁盘。
 *
 * 凭据目录刻意放在 dsh home 而不是仓库内：仓库是 git 检出，凭据进仓库有被
 * `git add` 提交的风险。
 *
 * 设计文档：docs/2026-10-11-account-login-module-design.md
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 上游 pending 码：授权还没完成。
 *
 * 实测 `GET /v2/plugin/auth/token?state=…` 在等待期间返回
 * `{"code":11217,"msg":"11217:login ing..."}`。**除 0 之外都继续等**——
 * 上游若新增别的中间态，只认 0 为成功就不会误判成失败。
 */
const PENDING_CODE = 11217;

/** 单次轮询请求超时。 */
const POLL_TIMEOUT_MS = 15_000;
/** 一次登录流程的总时长上限：超时就作废（上游 state 会自然过期）。 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 3000;

const UA = 'WorkBuddy/4.9.29177644 VSCode/1.119.0';

/**
 * 受支持的区域。**本次只做国内版**：国际版的成功态响应未实测（只探到
 * pending），不做没有验证过的东西。
 */
export const REGIONS = {
  cn: { id: 'cn', label: '国内版', base: 'https://copilot.tencent.com' },
};

/**
 * 纳管凭据目录（`$DSH_HOME/workbuddy-accounts`）。
 *
 * @param {string} dshHome dsh home 目录（来自 resolveDshPaths().home）
 * @returns {string}
 */
export function accountDir(dshHome) {
  return join(dshHome, 'workbuddy-accounts');
}

/** 文件名用 uid：同一账号重复登录覆盖同一文件，不会攒出一堆重复凭据。 */
function fileFor(dir, uid) {
  return join(dir, `${String(uid).replace(/[^A-Za-z0-9_-]+/g, '') || 'unknown'}.info`);
}

/**
 * 原子写一个凭据文件（临时文件 + rename，权限 0600）。
 *
 * 为什么不能用 `writeFileSync` 直接覆盖：**分组桥每次请求都在读这个文件**。
 * 巡检每 15 秒重写一次存档，写到一半被桥读到就是半个 JSON → 凭据读取失败 →
 * 桥 `/health` 回 503（表现为"账号突然不可用"，而文件其实完好）。
 * `rename` 在同目录内是原子的，读者要么看到旧版本、要么看到新版本。
 *
 * 与仓库既有做法一致：`lib/dsh.mjs` 写 dsh 配置、桥截断用量账本都是这一套。
 */
function atomicWrite(dest, text) {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    try { chmodSync(tmp, 0o600); } catch { /* 非 POSIX 上无意义 */ }
    renameSync(tmp, dest);
  } catch (error) {
    // 失败要清掉临时文件，否则纳管目录会攒一堆 .tmp-<pid>
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
}

function decodeJwtSub(token) {
  try {
    const seg = String(token).split('.');
    if (seg.length < 2) return '';
    const claims = JSON.parse(Buffer.from(seg[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return String(claims.sub || '');
  } catch {
    return '';
  }
}

/**
 * `state` 的内存态。刻意只放内存：state 是一次性的，落盘等于把"半程登录"
 * 留在磁盘上；进程重启后没有可恢复的价值。
 */
const pending = new Map();

function nonce() {
  return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 发起一次登录：向上游要一个 state 与授权链接。
 *
 * @param {object} options
 * @param {string} options.dshHome
 * @param {'cn'} [options.region]
 * @returns {Promise<{ok: boolean, id?: string, authUrl?: string, error?: string}>}
 */
export async function startLogin({ dshHome, region = 'cn' } = {}) {
  const reg = REGIONS[region];
  if (!reg) return { ok: false, error: `不支持的区域：${region}（当前只支持国内版）` };

  const id = nonce();
  try {
    const url = `${reg.base}/v2/plugin/auth/state?platform=CLI&nonce=${encodeURIComponent(nonce())}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: '{}',
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 0 || !body.data?.state) {
      return { ok: false, error: `发起登录失败（HTTP ${res.status}${body?.code !== undefined ? ` / code ${body.code}` : ''}）` };
    }
    pending.set(id, {
      region: reg,
      state: body.data.state,
      startedAt: Date.now(),
      dir: accountDir(dshHome),
      // 上一次轮询的结果缓存：面板每几秒读一次，不要每次都打上游
      last: { status: 'pending' },
    });
    return { ok: true, id, authUrl: body.data.authUrl };
  } catch (error) {
    return { ok: false, error: `发起登录失败：${String(error?.message || error)}` };
  }
}

/**
 * 轮询一次登录状态。
 *
 * 面板每几秒调一次；真正打上游是有节流的（POLL_INTERVAL_MS），所以重复调用
 * 不会把上游打爆。
 *
 * @param {string} id startLogin 返回的 id
 * @returns {Promise<{status: 'pending'|'done'|'error'|'expired'|'unknown', account?: object, error?: string}>}
 */
export async function pollLogin(id) {
  const entry = pending.get(id);
  if (!entry) return { status: 'unknown', error: '没有进行中的登录（可能已取消或超时）' };

  if (Date.now() - entry.startedAt > LOGIN_TIMEOUT_MS) {
    pending.delete(id);
    return { status: 'expired', error: '登录超时，请重新发起' };
  }

  // 节流：不到间隔就回上一次的结果，不重复打上游
  const elapsed = Date.now() - (entry.lastPollAt || 0);
  if (entry.lastPollAt && elapsed < POLL_INTERVAL_MS) return entry.last;

  entry.lastPollAt = Date.now();
  try {
    const res = await fetch(`${entry.region.base}/v2/plugin/auth/token?state=${encodeURIComponent(entry.state)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!body) {
      entry.last = { status: 'error', error: '上游返回了非 JSON 响应' };
      return entry.last;
    }
    if (body.code === PENDING_CODE) {
      entry.last = { status: 'pending' };
      return entry.last;
    }
    if (body.code !== 0 || !body.data?.accessToken) {
      pending.delete(id);
      entry.last = { status: 'error', error: `授权未完成（code ${body.code ?? '未知'}）` };
      return entry.last;
    }
    // 令牌不进返回值、不进日志：只回非敏感的元数据
    const account = await persist(entry.dir, body.data);
    pending.delete(id);
    entry.last = { status: 'done', account };
    return entry.last;
  } catch (error) {
    entry.last = { status: 'error', error: String(error?.message || error) };
    return entry.last;
  }
}

/** 取消一次登录：作废 state，不再轮询。 */
export function cancelLogin(id) {
  return pending.delete(id);
}

/**
 * 载入仓库侧的 AtRest 库（加密 / 解密 / 取密钥）。
 *
 * 两个候选是必须的：插件在仓库里时 `../../lib/` 是**唯一真源**（改了立刻生效）；
 * 单文件夹分发时仓库不在旁边，但 vendor 里有同步的快照。`vendor.mjs` 的
 * `--check` 门禁保证这两份内容一致，所以回退不会用到旧代码。
 */
async function loadAtRest() {
  const candidates = ['../../lib/atrest.mjs', '../vendor/lib/atrest.mjs'];
  for (const rel of candidates) {
    try {
      return await import(rel);
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('找不到 AtRest 库（仓库 lib/ 与插件 vendor/lib/ 都没有）');
}

/**
 * 造一个「解开信封字段」的函数，供 {@link listManagedAccounts} 解析账号标签用。
 *
 * 为什么要单独抽出来：`nickname` / `phoneNumber` 在登录文件里是 AtRest 加密信封，
 * 而取密钥会**拉起一次客户端二进制**（约 340ms）。面板每 60 秒轮询一次账号，
 * 每次都现取等于每分钟拉起一个客户端进程 —— 显然不行。
 *
 * 因此这里：
 *   1. **密钥在进程内缓存**（`atrest.mjs` 的 `fetchKeyPayload` 本来就按 exe 缓存）；
 *   2. 首次调用时密钥可能还没取到 —— 那就先返回 null（标签退化到 uin），
 *      同时后台把钥匙取回来，下一轮轮询就是完整的；
 *   3. 任何失败都返回 `null`（调用方退回到明文的 uin），**绝不抛**：
 *      客户端没装、密钥换了、信封格式变了，都不该让面板的账号页打不开。
 *
 * @returns {Promise<{decrypt: (v: unknown) => string|null, warmup: () => Promise<void>}>}
 */
export async function createIdentityDecoder() {
  let atrest = null;
  let key = null;
  let keyTried = false;

  const ensureKey = async () => {
    if (key || keyTried) return key;
    keyTried = true;
    try {
      atrest = await loadAtRest();
      const { existsSync } = await import('node:fs');
      const cands = atrest.defaultExecutableCandidates().filter((p) => { try { return existsSync(p); } catch { return false; } });
      if (!cands.length) return null;
      key = (await atrest.fetchKeyFor(cands, '')).key;
    } catch {
      key = null; // 取不到就退化成"不解密"
    }
    return key;
  };

  return {
    /**
     * @param {unknown} value 文件里的字段值（信封或明文）
     * @returns {string|null} 解不开返回 null
     */
    decrypt: (value) => {
      if (value === undefined || value === null || value === '') return '';
      if (typeof value === 'string') return value; // 明文（旧版客户端）
      /*
       * 同步接口但内部需要异步取密钥：密钥没就绪时**返回 null**（这一轮标签
       * 退化到 uin），并在后台把密钥取回来 —— 下一轮轮询（60 秒）就有完整标签。
       * 这样"首次打开面板"不会被 340ms 的客户端拉起阻塞，取密钥失败也不会空白。
       */
      if (!key || !atrest) {
        void ensureKey().catch(() => {});
        return null;
      }
      try {
        return atrest.openEncryptedField(value, key) || null;
      } catch {
        return null; // 信封坏了 / 不属于这把钥：当作没有
      }
    },
    /** 预热密钥（可在后台调用，不阻塞渲染）。 */
    warmup: () => ensureKey().then(() => undefined).catch(() => undefined),
  };
}

/**
 * 把令牌封成 AtRest 信封并写入纳管目录。
 *
 * 密钥**现取**（`fetchKeyFor`），不内置任何副本 —— 因此客户端不在场时这里会
 * 失败，登录流程如实报错而不是写出一个解不开的文件。
 *
 * @returns {Promise<{uid: string, path: string, domain: string, expiresAt: number, refreshExpiresAt: number}>}
 */
async function persist(dir, data) {
  const { sealEncryptedField, defaultExecutableCandidates, fetchKeyFor } = await loadAtRest();
  const { existsSync } = await import('node:fs');

  const uid = decodeJwtSub(data.accessToken);
  if (!uid) throw new Error('令牌里没有 sub，无法确定账号身份');

  const { key } = await fetchKeyFor(defaultExecutableCandidates().filter((p) => { try { return existsSync(p); } catch { return false; } }), '');

  const now = Date.now();
  const payload = {
    account: { uin: '', nickname: '' },
    auth: {
      accessToken: sealEncryptedField(String(data.accessToken), key),
      refreshToken: data.refreshToken ? sealEncryptedField(String(data.refreshToken), key) : '',
      tokenType: data.tokenType || 'Bearer',
      scope: data.scope || '',
      sessionState: data.sessionState || '',
      domain: data.domain || '',
      expiresIn: Number(data.expiresIn || 0),
      refreshExpiresIn: Number(data.refreshExpiresIn || 0),
      expiresAt: now + Number(data.expiresIn || 0) * 1000,
      refreshExpiresAt: now + Number(data.refreshExpiresIn || 0) * 1000,
      lastRefreshTime: now,
    },
    accounts: [],
    allAccounts: [],
    // 标记：这是插件自己纳管的凭据，不是客户端写的。诊断与面板据此区分。
    managed: true,
  };

  mkdirSync(dir, { recursive: true });
  const path = fileFor(dir, uid);
  // 与存档走同一个原子写：分组桥随时在读这个文件（见 atomicWrite 的说明）
  atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    uid,
    path,
    domain: payload.auth.domain,
    expiresAt: payload.auth.expiresAt,
    refreshExpiresAt: payload.auth.refreshExpiresAt,
  };
}

/**
 * 把客户端**当前**的登录快照存档一份到纳管目录（原样复制，不重新加密）。
 *
 * 为什么必须有这一步：客户端切账号时会**覆盖** `workbuddy-desktop.info`，
 * 旧账号就不再存在于磁盘上（实测：切走的那个账号在磁盘上彻底没了）。所以
 * "切账号后旧账号还能用"这件事，只能在切换**发生之前**就把快照存下来。
 * 我们已经有 15 秒一次的账号巡检在读客户端快照，顺手存档即可，不需要用户做
 * 任何事，也不需要走 OAuth。
 *
 * 为什么是**原样复制**而不是重新封装：客户端写的本来就是同一套 AtRest 信封、
 * 同一把 build 密钥，桥原样就能解开 —— 复制比重新加密更简单，也不可能引入
 * "封装格式与客户端不一致"这类新故障。只在文件里加一个 `managed` 标记，
 * 让 `listManagedAccounts()` 认得出这是插件纳管的。
 *
 * **滚动存档**：每次都按源文件是否更新决定要不要重写，因此**当前正在用的账号**
 * 会跟着客户端一起刷新（不会 30 天过期）；只有不再活跃的账号才会随令牌自然过期。
 *
 * @param {object} options
 * @param {string} options.dshHome
 * @param {string} options.uid 目标账号标识（取自桥 /health 的 auth.userId）
 * @param {string} options.sourcePath 客户端登录文件路径（桥 /health 的 authFile）
 * @returns {{ok: boolean, changed?: boolean, path?: string, reason?: string}}
 */
export function archiveSnapshot({ dshHome, uid, sourcePath }) {
  const id = String(uid || '').replace(/[^A-Za-z0-9_-]+/g, '');
  if (!id) return { ok: false, reason: '缺少账号标识' };
  const src = String(sourcePath || '');
  if (!src) return { ok: false, reason: '缺少来源登录文件' };

  const dir = accountDir(dshHome);
  const dest = fileFor(dir, id);

  // 来源就在纳管目录里（桥正读着我们自己的存档）：不要自己复制自己，
  // 否则下一次存档会把 managed 标记与来源信息覆盖掉，且毫无意义。
  if (resolve(src) === resolve(dest)) return { ok: true, changed: false, path: dest, reason: '来源即存档' };

  let raw;
  let srcMtime;
  try {
    raw = readFileSync(src, 'utf8');
    srcMtime = Math.round(statSync(src).mtimeMs);
  } catch (error) {
    return { ok: false, reason: `读不到来源登录文件：${String(error?.message || error)}` };
  }

  // 已有存档且来源没更新过 → 什么都不用做（秒级巡检的常态路径）
  // `Math.round` 在两侧都要：NTFS 的 mtimeMs 带小数，JSON 往返后与内存里的
  // 原始浮点数比较可能差 1 个 ULP，那会让"没变"判成"变了"、每 15 秒白写一次盘。
  try {
    const existing = JSON.parse(readFileSync(dest, 'utf8'));
    if (existing?.managed && Math.round(Number(existing.sourceMtime) || 0) === srcMtime) {
      return { ok: true, changed: false, path: dest };
    }
  } catch { /* 没有 / 坏了：下面重写 */ }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `来源不是合法 JSON：${String(error?.message || error)}` };
  }
  if (!parsed?.auth) return { ok: false, reason: '来源里没有 auth 段（不是登录文件？）' };

  // 原样保留 auth（AtRest 信封照旧），只加标记与来源信息。
  // **不写任何明文令牌**：这里全程没有解密动作。
  const payload = {
    ...parsed,
    managed: true,
    /** 存档来源（排障用）：哪个文件、存于何时、当时的 mtime */
    archivedFrom: src,
    archivedAt: Date.now(),
    sourceMtime: srcMtime,
  };

  try {
    mkdirSync(dir, { recursive: true });
    atomicWrite(dest, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    return { ok: false, reason: `写入存档失败：${String(error?.message || error)}` };
  }
  return { ok: true, changed: true, path: dest };
}

/**
 * 手机号脱敏：保留前 3 位与后 4 位，中间固定 4 个星号。
 *
 * 例：`19157621006` → `191****1006`。
 *
 * 为什么留 7 位可见：用户的诉求是"一眼认出是哪个账号"。只留前 2 后 2（某些
 * 实现的做法）在 11 位号码上只剩 4 位，同一人的两个号很容易看着一样 —— 那就没
 * 达到目的。前 3 后 4 足以区分，又不至于把完整号码暴露在截图里。
 *
 * @param {string} phone
 * @returns {string}
 */
export function maskPhone(phone) {
  const s = String(phone || '').trim();
  // 只有"看起来像手机号"才脱敏：不足 8 位没什么可掩的，原样返回更好认
  if (s.length < 8) return s;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/**
 * 邮箱脱敏：本地部分保留前 2 位与末 2 位，中间固定一个星号；域名保留。
 *
 * 例：`a3236792972@gmail.com` → `a3****72@gmail.com`（见下）。
 *
 * 星号数**固定**而不是"按长度打"，否则星号数随地址长度增长，会把整列撑宽
 * （窄列下面板会被挤坏）。域名原样保留 —— 用户靠它区分国内版 / 国际版。
 *
 * @param {string} email
 * @returns {string}
 */
export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return s; // 不像邮箱：原样（可能是昵称）
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local[0] || ''}*${domain}`;
  const head = local.slice(0, 2);
  const tail = local.length > 4 ? local.slice(-2) : '';
  return `${head}****${tail}${domain}`;
}

/**
 * 把任意账号标识（手机号 / 邮箱 / 昵称）脱敏成"能认出来但不泄露"的形式。
 *
 * 判据只看形状，不看字段名 —— 因为 WorkBuddy 把手机号放在 `phoneNumber`，
 * 而**昵称字段里可能直接就是手机号或邮箱**（实测：一个账号的 nickname 是
 * `19157621006`，国际版那个是 `a3236792972@gmail.com`）。按字段名判断会漏。
 *
 * @param {string} value
 * @returns {string}
 */
export function maskIdentity(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.includes('@')) return maskEmail(s);
  // 纯数字且长度像手机号（11 位）或像 QQ 号之类：按手机号规则脱敏
  if (/^\d{6,}$/.test(s)) return maskPhone(s);
  // 其它（真昵称、英文名）：原样 —— 昵称不是 PII，打码反而更难认
  return s;
}

/**
 * 从登录文件里解析出**用户认得出的账号标签**（已脱敏）。
 *
 * 取值优先级：手机号 → 邮箱 → 昵称 → uin。
 *
 * ⚠️ `nickname` / `phoneNumber` 在文件里是 **AtRest 加密信封**（实测），解密要
 * 现取客户端密钥（会拉起一次客户端二进制）。因此这里的 `decrypt` 是**可选注入**
 * 的：调用方拿不到密钥就传 null，本函数退回到只用明文的 `uin` —— 面板照常
 * 工作，只是标签退化成数字。**绝不因为解不开就报错**。
 *
 * @param {object} raw 登录文件解析后的对象
 * @param {(value: unknown) => string|null} [decrypt] 信封解密函数（null = 不解密）
 * @param {(value: string) => string} [mask] 脱敏函数
 * @returns {{label: string, full: string, kind: 'phone'|'email'|'nickname'|'uin'|''}}
 *   `label` 是可直接显示的脱敏值；`full` 只在用户主动要求时才用
 */
export function resolveAccountLabel(raw, decrypt = null, mask = maskIdentity) {
  const acc = raw?.account || {};
  const read = (v) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'string') return v;
    if (decrypt) {
      try { return decrypt(v) || ''; } catch { return ''; } // 解不开就当没有
    }
    return '';
  };
  const phone = read(acc.phoneNumber);
  if (phone) return { label: mask(phone), full: phone, kind: 'phone' };
  const nick = read(acc.nickname);
  if (nick) {
    // 昵称字段里可能就是邮箱或手机号（实测），按形状脱敏
    const kind = nick.includes('@') ? 'email' : (/^\d{6,}$/.test(nick) ? 'phone' : 'nickname');
    return { label: mask(nick), full: nick, kind };
  }
  const uin = read(acc.uin);
  if (uin) return { label: uin, full: uin, kind: 'uin' };
  return { label: '', full: '', kind: '' };
}

/**
 * 列出已纳管的账号（不含任何凭据内容）。
 *
 * @param {string} dshHome
 * @param {object} [options]
 * @param {(value: unknown) => string|null} [options.decrypt] 信封解密（见 resolveAccountLabel）
 * @param {boolean} [options.full] true = 额外返回未脱敏的 `fullLabel`
 *   （仅当调用方明确要"显示完整账号"时才用；默认**不返回**，免得它出现在
 *    截图、日志或诊断报告里）
 * @returns {Array<{uid: string, path: string, uin: string, label: string, labelKind: string, domain: string, expiresAt: number, remainingMs: number, expired: boolean}>}
 */
export function listManagedAccounts(dshHome, { decrypt = null, full = false } = {}) {
  const dir = accountDir(dshHome);
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch {
    return []; // 目录还没建：等于没有纳管账号
  }
  const out = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (!raw.managed) continue; // 只认自己纳管的，不碰别的东西
      const expiresAt = Number(raw.auth?.expiresAt || 0);
      // 解析"用户认得出的标签"。解密失败/拿不到密钥时内部会退回 uin，不抛。
      const resolved = resolveAccountLabel(raw, decrypt);
      out.push({
        uid: name.replace(/\.info$/i, ''),
        path,
        /**
         * 账号的 **uin**（形如 `330125158554`）。
         *
         * 这是**用户认得出的那个标识** —— 客户端界面上显示的就是它。而 uid 是
         * 36 字符的 UUID，只取前 8 位当标签的话用户根本对不上"这是哪个账号"
         * （实测反馈："我现在不知道哪个是哪个账号了"）。不是凭据，可以外传。
         */
        uin: raw.account?.uin ? String(raw.account.uin) : '',
        /**
         * 用户认得出的账号标签（**已脱敏**）：手机号 / 邮箱 / 昵称，退回到 uin。
         * 这是面板显示的那一列 —— 光给 uuid 或纯数字 uin 都对不上"这是哪个账号"。
         * 完整值**默认不返回**（见函数注释：它会进截图与诊断报告）。
         */
        label: resolved.label,
        labelKind: resolved.kind,
        ...(full && resolved.full ? { fullLabel: resolved.full } : {}),
        domain: raw.auth?.domain || '',
        expiresAt,
        remainingMs: expiresAt - Date.now(),
        expired: expiresAt > 0 && expiresAt < Date.now(),
      });
    } catch {
      /* 单个文件坏了不影响列其它 */
    }
  }
  return out;
}

/**
 * 删除一个纳管账号（登出）。
 *
 * 只删我们写的那个文件 —— 客户端的登录文件不在本目录，不可能被误删。
 *
 * @returns {{ok: boolean, removed?: boolean, error?: string}}
 */
export function removeManagedAccount(dshHome, uid) {
  const safe = String(uid || '').replace(/[^A-Za-z0-9_-]+/g, '');
  if (!safe) return { ok: false, error: '缺少账号标识' };
  const path = join(accountDir(dshHome), `${safe}.info`);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw.managed) return { ok: false, error: '该文件不是插件纳管的凭据，拒绝删除' };
  } catch {
    return { ok: false, error: '凭据文件不存在或不可读' };
  }
  try {
    rmSync(path, { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
