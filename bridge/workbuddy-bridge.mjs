// SPDX-License-Identifier: MIT
/**
 * workbuddy-bridge — expose the locally signed-in CodeBuddy / WorkBuddy desktop
 * session as a local OpenAI-compatible endpoint, for any client that accepts a
 * custom base URL (DeepSeek Harness, Cherry Studio, Open WebUI, ...).
 *
 * How it works (all behaviours verified against the live backend):
 *   - The upstream backend (copilot.tencent.com/v2/chat/completions) already
 *     speaks the OpenAI protocol, so this proxy does NOT translate protocols.
 *     It only injects authentication/tracing headers and guarantees streaming.
 *   - The backend rejects non-streaming requests (400 code 11101), so a
 *     non-streaming client request is converted to streaming upstream and
 *     aggregated back into a single JSON response.
 *   - Auth reuses the desktop session (OAuth access/refresh token) from the
 *     local login file, refreshing it in memory before expiry. The login file
 *     is never rewritten: it holds app-owned at-rest envelopes.
 *   - Compatibility fix: the backend only accepts the `system` role for the
 *     system prompt, while newer OpenAI-spec clients send `developer`. Those
 *     messages are rewritten in place before forwarding.
 *
 * Security boundary: binds 127.0.0.1 only; never logs or persists a token or
 * any conversation content.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';

// ── Static constants (values match the desktop app / official extension) ──
/**
 * 出站客户端身份。上游按 User-Agent / X-IDE-* / X-Product-Version 校验调用
 * 来源，官方客户端升级后旧指纹可能被拒（报告 §8.6 风险 1 的「上游版本漂移」）。
 * 因此三个值都可用环境变量覆盖（.env 由 config.mjs 统一注入），改完重启桥即生效。
 */
const APP_VERSION = process.env.WORKBUDDY_APP_VERSION || '4.9.29177644';
const IDE_VERSION = process.env.WORKBUDDY_IDE_VERSION || '1.119.0';
const IDE_NAME = process.env.WORKBUDDY_IDE_NAME || 'VSCode';
const CHAT_PATH = '/v2/chat/completions';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 15 * 1000;
const TRANSIENT_400_DELAYS = [1000, 4000, 10000, 25000];
/**
 * `400 code 11-128 Illegal API invocation from an unapproved channel` 的**兜底**重试退避。
 *
 * 先说结论：11-128 目前已知的成因**都是确定性的**（见 TROUBLESHOOTING「三类成因」）：
 * ① 消息结构（developer 角色 / 首条不是 system）② 调用方身份 ③ system 提示词命中整句
 * 黑名单（DSH 那两句，已由 {@link AUDIT_TEMPLATE_REWRITES} 出站改写）。上游文案虽写
 * 「请重新发送」，但 2026-10-22 实测那次**原始 + 2 次重试全部被拦** —— 重试救不回
 * 确定性拦截。
 *
 * 那为什么还留 2 次？只当**便宜兜底**：上游是集群，黑名单/校验的生效时间可能在节点间
 * 不同步，万一碰上「这一台拦、下一台放」，一次重试就能救回来。代价封顶约 6.5 秒
 * （1.5s + 5s），远小于 11133 那条的 40 秒，所以只给 2 次。
 *
 * 若将来看到「每条请求都被 11-128」：那不是偶发，是确定性拦截 —— 按 TROUBLESHOOTING
 * 的三类成因逐项排除（尤其 ③ 看日志有没有 `rewrote … audit-template`），别靠重试。
 */
const CHANNEL_BLOCK_DELAYS = [1500, 5000];

/**
 * SSE 心跳间隔（0 = 关）。
 *
 * 为什么需要：上游在长上下文 / 长时间 reasoning 时可能**几十秒不吐一个字节**
 * （实测本机账本里有 132 秒才完成的请求）。期间流的 socket 是静默的，而不少
 * 中间层（反向代理、CDN、企业网关）和客户端读超时会把"长时间无数据的流"判死 ——
 * 表现是「答到一半断了」或「一直转圈然后报网络错误」，且客户端拿不到任何错误码。
 *
 * 用 SSE **注释帧**（`: keepalive`）保活：按 SSE 规范注释行不产生 message 事件，
 * OpenAI/Anthropic SDK 都会安静忽略，不会污染内容、也不影响 finish_reason。
 * 30 秒是常见中间层默认空闲超时（60s）的一半，留足余量。
 */
const SSE_HEARTBEAT_MS = Number(process.env.WORKBUDDY_SSE_HEARTBEAT_MS ?? 30_000);

/**
 * 429 降级链（**默认关闭**；WORKBUDDY_FALLBACK_ON_429=1 打开）。
 *
 * 为什么默认关：降级会消耗**另一个模型**的额度 —— 那是用户的钱，不该由桥替他决定。
 * 默认行为仍是如实把 429 交给客户端（带 Retry-After），换不换由用户选。
 *
 * 数据依据（bridge/usage.jsonl 实测，100 次上游 429）：
 *   · 429 后 5 分钟内换**其他模型**：601 次请求 557 次成功（93%）；
 *   · 同账号同模型在 429 后 60 秒内重试：258 次里 135 次仍失败（52%）；
 *   · 同模型恢复间隔中位数 ~38 小时（也有 1 秒的瞬时抖动机）。
 * 结论：换模型有效，死等同一模型无效。上游自己的文案也写着
 * 「alternatively, you can switch to the other models」。
 *
 * **只在 429 上降级**：11128（黑名单）换模型没用；5xx 换模型会掩盖真实故障；
 * 401 是凭据问题 —— 这些都该如实报给用户。
 */
const FALLBACK_ON_429 = process.env.WORKBUDDY_FALLBACK_ON_429 === '1';
/** 最多换几个模型（0 = 不换）。上限 3 是防止额度被连锁消耗。 */
const FALLBACK_MAX = Math.max(0, Math.min(3, Number(process.env.WORKBUDDY_FALLBACK_MAX ?? 1)));

/**
 * 从上游 429 的文案里解析「什么时候恢复」，返回距现在多少秒（解析不出返回 null）。
 *
 * 为什么值得解析：上游的频率限制**不是按秒级窗口**，而是「到某个时刻重置」
 * （实测 code 6004 的原文：`…your usage will reset at 2026-10-23 15:14:30 UTC+8…`）。
 * 它却**不返回 Retry-After 头** —— 客户端因此完全不知道该等多久：智能退避只能瞎猜，
 * 简单的客户端则直接报错给用户。本机 4599 次请求里有 100 次（2.2%）撞上它，
 * 所以这不是理论问题。
 *
 * 解析出来就转成标准 `Retry-After`（秒），让任何 OpenAI/Anthropic 兼容客户端都能
 * 按规范退避。解析失败**不编造**：返回 null，由调用方退化成「不给该头」——
 * 宁可没有，也不要给一个错的等待时间（那会让客户端等错方向）。
 *
 * 只认文案里明确带时区/UTC 偏移的时刻；纯文本「稍后重试」这类**不猜**。
 */
function retryAfterSecondsFromUpstream(text) {
  if (typeof text !== 'string' || !text) return null;
  // 形如 `2026-10-23 15:14:30 UTC+8` / `2026-10-23T15:14:30+08:00` / `… UTC`
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)?\s*([+-]\d{1,2})?/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, offRaw] = m;
  /**
   * 偏移的两种写法都要认：`UTC+8`（小时）与 `+08:00`（时:分）。
   * 缺失偏移时**不猜本地时区** —— 服务器时区与本机不一定一致，猜错就是让客户端
   * 等错方向。这种情况按「解析不出」处理。
   */
  if (!offRaw) return null;
  const offNum = Number(offRaw);
  if (!Number.isFinite(offNum)) return null;
  const target = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
    - offNum * 3600_000;
  const delta = target - Date.now();
  if (!Number.isFinite(delta)) return null;
  // 已经过去/明显不合理（>30 天）的一律不采信
  if (delta <= 0 || delta > 30 * 86_400_000) return null;
  return Math.max(1, Math.ceil(delta / 1000));
}
const UPSTREAM_TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 0); // 0 = unlimited (long answers need it)

// ── Upstream keep-alive connection pool ────────────────────────────────────
// 为什么要自己管连接：Node 全局 fetch（undici）的空闲连接只保留 ~4 秒。写代码
// 的间隙一过，下一次请求就要重付一遍 DNS + TLS 握手（实测 ~150ms，温连接 ~82ms；
// 复现：node tools/dev/bench-overhead.mjs）。
// 用 http/https 的 keep-alive Agent：空闲连接保留 5 分钟，跨请求复用同一条
// TLS 会话，「首 token 延迟」稳定砍掉一大截。测试桩走纯 HTTP，所以两套都要。
const KEEPALIVE_MS = Number(process.env.WORKBUDDY_KEEPALIVE_MS || 300_000); // 5 min, 0 = off
const httpAgent = new HttpAgent({ keepAlive: KEEPALIVE_MS > 0, keepAliveMsecs: Math.max(1000, KEEPALIVE_MS), maxSockets: 8, scheduling: 'lifo' });
const httpsAgent = new HttpsAgent({
  keepAlive: KEEPALIVE_MS > 0,
  keepAliveMsecs: Math.max(1000, KEEPALIVE_MS),
  maxSockets: 8,
  scheduling: 'lifo',
  // 刻意**不设** socket timeout：LLM 流式回答中间可能有几十秒的 reasoning 停顿，
  // 空闲超时会在流中间掐断长回答。死连接靠 sendWithRetry 的 reusedSocket 重试兜底。
});
const agentFor = (endpoint) => (String(endpoint).startsWith('https:') ? httpsAgent : httpAgent);

const PORT = Number(process.env.WORKBUDDY_PORT || 8790);
const HOST = process.env.WORKBUDDY_HOST || '127.0.0.1';
/**
 * 本地回环令牌。**永远非空** —— 这是认证闸门的前提。
 *
 * 曾经的写法是 `process.env.WORKBUDDY_LOCAL_TOKEN || ''`，配合闸门里的
 * `if ((LOCAL_TOKEN || ...) && identifyClientId(req) === null)`，含义变成
 * 「没配令牌就不校验」。而 `config.mjs` 那份默认值只在**控制台启动桥**时注入，
 * 用户直接 `node bridge/workbuddy-bridge.mjs` 拿到的是空串 → 等于无鉴权：
 * `/health`、`/v1/chat/completions` 对同机任意进程敞开（会真实消耗账号额度）。
 *
 * 现在：未显式配置时**自动生成随机令牌**并在启动日志打印，用户可从日志复制到客户端。
 * 安全默认应当是「拒绝未授权」，不是「放行一切」。（已由 bridge.test.mjs
 * 的「未配置 … 时不得静默放行」用例钉住。）
 */
const EXPLICIT_LOCAL_TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || '';
const LOCAL_TOKEN = EXPLICIT_LOCAL_TOKEN || randomBytes(24).toString('base64url');
/**
 * 客户端凭据分层（opt-in）：`WORKBUDDY_CLIENT_KEYS=逗号分隔的多把 key`。
 *
 * 用途：把不同客户端（Claude Code / opencode / Cursor…）**分开记账与限流**；
 * 某个客户端失控时，在 .env 里删掉它的 key 单独吊销（重启桥生效）。
 *
 * **内存中只保留 SHA-256 哈希**（前 8 位作展示标识），明文只在启动时读一次
 * env，之后不再出现；账本里的 `client` 字段就是这 8 位 —— 日志与账本都不泄露
 * 完整 key。默认空 = 功能关，行为与之前完全一致（只有 LOCAL_TOKEN 一把钥匙）。
 */
const CLIENT_KEY_HASHES = new Map(); // sha256hex -> 展示 id（哈希前 8 位）
for (const rawKey of String(process.env.WORKBUDDY_CLIENT_KEYS || '').split(',')) {
  const key = rawKey.trim();
  if (!key) continue;
  const hex = createHash('sha256').update(key).digest('hex');
  CLIENT_KEY_HASHES.set(hex, hex.slice(0, 8));
}
const EXPLICIT_ENDPOINT = process.env.CODEBUDDY_ENDPOINT || '';
const API_KEY = process.env.CODEBUDDY_API_KEY || '';
/**
 * 每日自动签到（R11.2）。默认**开** —— 用户的诉求就是「别让我记着」。
 * 独立启动的桥也签（不依赖控制台在不在）。`WORKBUDDY_AUTO_CHECKIN=0` 关闭。
 */
const AUTO_CHECKIN_ENABLED = process.env.WORKBUDDY_AUTO_CHECKIN !== '0';
const LOG = process.env.WORKBUDDY_LOG === '1';
/** 进程启动时刻，供 /health 汇报运行时长。 */
const STARTED_AT = Date.now();

// Curated models exposed by default; others remain reachable via /v1/models?all=1
// 兜底的精选模型定义。倍率优先取上游的 credits（形如 "x0.11"），
// 这里的数值取自上游实测，仅在上游没给时才用——注意它们会随官方调价而过时。
//
// **能力字段（images / supportsReasoning）必须显式写**：这些模型是**补全项**
// （不在上游目录端点里，见下方 `supplemented` 那段），所以拿不到
// `m.supportsImages` / `m.supportsReasoning` —— 不写就等于声明"不支持"，
// 用户会发现「贴不了图」「没有推理等级下拉」，而模型其实两个都支持。
//
// 实测（judier-cod / 国际版账号，2026-10-12）：
//   图片：deepseek-v4.1-flash + **真实 400x300 图片** → 200 "Green"（能看图）
//         同一个模型 + 1x1 / 16x16 玩具图 → 400 model_param_invalid
//         **小到不合理的图会被上游当无效请求拒** —— 那是测试假象，不是能力问题。
//   推理：deepseek-v4.1-flash + reasoning_effort=low  → reasoning_tokens=19
//         不带 reasoning_effort                        → reasoning_tokens=0
//         也就是说它**真的按档位推理**，与目录里 glm-5.3 / hy3 的行为一致。
//
// 判据必须用真实尺寸的图 / 真实的 reasoning_tokens，别用玩具载荷。
const FEATURED = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000, credits: 0.11, images: true, supportsReasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context: 1000000, maxOutput: 50000, credits: 0.51, images: true, supportsReasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000, credits: 0.79, images: true, supportsReasoning: true },
];

/**
 * 取某模型的消耗倍率。
 *
 * 上游给的 `credits` 可能是**数字**，也可能是形如 `"x0.03"` 的**字符串**——
 * 只认数字会把后者静默丢掉。
 *
 * **拿不到就返回 undefined，不回退到别的区域的值**：倍率随区域与促销变化，
 * 用国内实测值去填国际版的同一个模型 id，会把免费模型标成 0.11。
 */
function creditsOf(model) {
  const raw = model?.credits;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const hit = /x\s*([0-9]*\.?[0-9]+)/i.exec(raw);
    if (hit) return Number(hit[1]);
  }
  return undefined;
}

/** "HH:MM"（或 "H:MM"）→ 当天的分钟数；非法返回 null。 */
function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 上游促销的时段描述（`modelPromotions[].schedule`）。
 *
 * 两种形状可单用也可同时出现：
 *   - `daily`：每日时段，如 `[{start:"23:00", end:"7:50"}]`（跨零点时 start > end）
 *   - `validFrom` / `validUntil`：活动的绝对起止时间
 * `timezone` 是 IANA 时区名（实测为 "Asia/Shanghai"）。
 *
 * 用 typedef 而不是 `object`：`tsc --checkJs` 下直接访问 `object` 的属性会报
 * TS2339，而这个项目的 CI 就跑 `npm run check:types`。
 *
 * @typedef {object} PromotionSchedule
 * @property {string} [timezone] IANA 时区名
 * @property {string} [validFrom] 生效起点（可被 Date.parse 解析）
 * @property {string} [validUntil] 生效终点（可被 Date.parse 解析）
 * @property {Array<{ start?: string, end?: string }>} [daily] 每日时段列表
 */

/**
 * 促销时段当前是否生效。
 *
 * 上游的 `schedule` 有两种形状（都实测过）：
 *   1. 每日时段：`{ timezone, daily: [{start:"23:00", end:"7:50"}, ...] }`
 *      —— 跨零点要能正确处理（start > end 表示跨夜）。
 *   2. 绝对区间：`{ timezone, validFrom, validUntil }`
 *      —— 活动的起止日期。
 * 两种可以同时出现（限时免费既给了 daily 也可能给 validFrom/Until）。
 *
 * **没有 schedule = 视为长期有效**（上游大部分促销就是这样）。
 * 任何字段无法解析时**按"生效"处理**（保守：宁可显示促销价，也不要
 * 因为解析失败把已经打折的价格显示成全价 —— 后者会让用户多花冤枉钱）。
 *
 * @param {PromotionSchedule} [schedule] 上游给的 schedule 对象
 * @param {Date} [now] 当前时间（测试注入用）
 */
function scheduleActive(schedule, now = new Date()) {
  if (!schedule || typeof schedule !== 'object') return true;

  // 1) 绝对区间：validFrom / validUntil
  const from = schedule.validFrom ? Date.parse(schedule.validFrom) : null;
  const until = schedule.validUntil ? Date.parse(schedule.validUntil) : null;
  const ts = now.getTime();
  if (Number.isFinite(from) && ts < from) return false;
  if (Number.isFinite(until) && ts > until) return false;

  // 2) 每日时段：daily[]，任一段命中即生效
  if (Array.isArray(schedule.daily) && schedule.daily.length) {
    // 按 schedule 自称的时区取"当地几点"。拿不到该时区就退回本机时间。
    let hm = now.getHours() * 60 + now.getMinutes();
    const tz = schedule.timezone;
    if (typeof tz === 'string' && tz) {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(now);
        const hh = parts.find((p) => p.type === 'hour')?.value;
        const mm = parts.find((p) => p.type === 'minute')?.value;
        const local = minutesOfDay(`${hh}:${mm}`);
        if (local !== null) hm = local;
      } catch { /* 时区名不被支持：用本机时间，不因此判为"不生效" */ }
    }
    for (const slot of schedule.daily) {
      const start = minutesOfDay(slot?.start);
      const end = minutesOfDay(slot?.end);
      if (start === null || end === null) continue;
      if (start <= end) {
        if (hm >= start && hm <= end) return true;
      } else if (hm >= start || hm <= end) {
        // 跨零点：如 23:00–07:50
        return true;
      }
    }
    return false;
  }

  return true;
}

// Locate the CodeBuddy / WorkBuddy desktop login file across platforms.
// Override with WORKBUDDY_AUTH_FILE when the desktop app stores it elsewhere.
const AUTH_DIRS = [
  process.env.WORKBUDDY_AUTH_DIR,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
].filter(Boolean);

/**
 * Explicit override wins; otherwise the default file name, then the first
 * `*.info` in sorted order.
 *
 * Taking "the first entry the directory happens to list" is NOT safe: the
 * login directory commonly holds more than one account snapshot (e.g. the
 * international build's `workbuddy-desktop-ai.info`) and that one sorts before
 * `workbuddy-desktop.info`. Standing alone, the bridge would then silently
 * serve the wrong account. config.mjs resolves the same way, so both entry
 * points agree.
 */
function resolveAuthPath() {
  if (process.env.WORKBUDDY_AUTH_FILE) return process.env.WORKBUDDY_AUTH_FILE;
  for (const dir of AUTH_DIRS) {
    const preferred = join(dir, 'workbuddy-desktop.info');
    if (existsSync(preferred)) return preferred;
  }
  for (const dir of AUTH_DIRS) {
    try {
      const hit = readdirSync(dir).filter((f) => f.endsWith('.info')).sort()[0];
      if (hit) return join(dir, hit);
    } catch { /* directory absent on this platform */ }
  }
  return join(AUTH_DIRS[0] || '.', 'workbuddy-desktop.info');
}

const AUTH_PATH = resolveAuthPath();

/**
 * 旧记录（本次改动之前写入的）没有 `acct` 字段。
 *
 * 给它们一个固定桶而不是"归到某个账号"：那些行**无法归因**（当时根本没记），
 * 硬塞给主账号会让"国内版花了多少"这个数字撒谎。单列一桶至少是诚实的，
 * 面板也能照实显示"未标注账号"。
 *
 * 定义在 {@link ACCOUNT_LABEL} **之前**：那个 IIFE 在模块求值时就跑，
 * 引用后面才声明的 const 会撞 TDZ（`Cannot access before initialization`）——
 * 平时靠文件名分支提前返回掩盖住了，属于会随机炸的雷。
 */
const UNKNOWN_ACCOUNT = 'unknown';

/**
 * 本桥服务的**账号标签**，写进账本每一条记录的 `acct` 字段。
 *
 * 取值优先级：
 *   1. `WORKBUDDY_ACCOUNT_LABEL` —— 插件为每个 provider 显式注入
 *      （主账号 `workbuddy`、分组 `workbuddy-ai`）。这是**首选**：与 dsh 模型
 *      选择器里的 provider 名一一对应，用户能直接把账本上的账号对上界面上的分组。
 *   2. 登录文件名（去掉 `.info`），如 `workbuddy-desktop-ai` —— 独立启动桥
 *      （不经插件）时的兜底，至少能区分"哪个登录文件"。
 *   3. `unknown`。
 *
 * 为什么不用 JWT 里的 userId 当标签：那是 36 字符的 UUID，账本里每行都写一遍
 * 太占地方，而且用户认不出 `xxxxxxxx-…` 对应界面上哪个分组。userId 仍然保留在
 * /health 与积分归属里做身份核对，两件事各司其职。
 *
 * **只算一次**：登录文件在运行期可能被客户端重写，但"这个端口是哪个账号"是
 * 启动时就定下的事实 —— 每次记账都去 stat 文件既慢又会让同一个账号中途换标签，
 * 把历史记录劈成两半。
 */
const ACCOUNT_LABEL = (() => {
  const explicit = String(process.env.WORKBUDDY_ACCOUNT_LABEL || '').trim();
  if (explicit) return explicit;
  try {
    const base = AUTH_PATH.replace(/\\/g, '/').split('/').pop() || '';
    const name = base.replace(/\.info$/i, '').trim();
    if (name) return name;
  } catch { /* 路径异常：落到 unknown */ }
  return UNKNOWN_ACCOUNT;
})();

const log = (...a) => { if (LOG) console.error(`[${new Date().toISOString()}]`, ...a); };

/**
 * 把 `fetch` 的错误展开成**可诊断**的一行。
 *
 * 为什么需要：Node 的 `fetch` 在网络层失败时统一抛 `TypeError: fetch failed`，
 * 真正的原因在 `err.cause` 里（`ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` /
 * `UND_ERR_CONNECT_TIMEOUT` …）。只记 `e.message` 的话，日志里全是
 * `fetch failed`，**看不出是断网、DNS、还是上游挂了** —— 实测排查"读取失败"
 * 时就卡在这里：日志有几十条 `fetch failed`，却完全无法定位。
 *
 * `cause` 在 `catch (e)` 里是 `unknown`（TS 严格模式），所以逐层收窄而不是直接取属性。
 *
 * @param {unknown} e
 * @returns {string} 形如 `fetch failed (ECONNRESET: read ECONNRESET)`
 */
function describeFetchError(e) {
  /** @type {any} */
  const err = e;
  const msg = err?.message || String(e);
  const cause = err?.cause;
  if (!cause) return msg;
  const code = cause.code || cause.errno || '';
  const detail = cause.message || '';
  if (!code && !detail) return msg;
  return `${msg} (${[code, detail].filter(Boolean).join(': ')})`;
}

// ── At-rest credential opener (WorkBuddy desktop 5.6.0+) ─────────────────
// 5.6.0+ seals auth fields in an AES-256-GCM envelope
// ({"$wbEncrypted":1,"envelope":"<base64 of {suite,keyId,nonce,authTag,ciphertext}>"}).
// The field key is a build-time constant that the app exposes only through its
// own Electron native binding, so we ask the installed binary for it and cache
// the derived key for the process lifetime.
const ATREST_AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
let atRestKeyCache;
let atRestUsedExe = ''; // 最近一次成功取到密钥的客户端 exe（供启动日志/诊断显示）
let wantedKeyId = ''; // 登录文件里信封的 keyId —— 由 readStoredAuth 每次读取时刷新
let memoryAuth = null; // refreshed in-process; the desktop file is never rewritten

// ── Locate the WorkBuddy desktop executable ──────────────────────────────
// 客户端可以装到任意目录（E:\App\WorkBuddy、E:\App\WorkbuddyInternational、
// C:\Program Files\Tencent\WorkBuddy…），exe 名也随版本不同（WorkBuddy.exe /
// WorkBuddyAI.exe / CodeBuddy.exe）。只写死几个路径在"换目录重装"后必然失效
// —— 现象正是 `key fetch failed: spawnSync … ENOENT`。
//
// 探测顺序：显式覆盖 → 默认位置 → 磁盘浅扫描 → 系统信号兜底（进程路径 +
// 注册表安装记录，见下方）。与 lib/find-workbuddy.mjs 是同一套算法（桥刻意
// 保持自包含单文件、不 import 本项目模块；改动时两边需同步）。
const WB_EXE_NAME_RE = /^(?:workbuddy(?:\s*ai)?|codebuddy(?:\s*ai)?)\.exe$/i;
const WB_DIR_KEYWORD_RE = /workbuddy|codebuddy/i;
const WB_DESCEND_RE = /^(?:app|apps|application|applications|program|programs|program files(?:\s*\(x86\))?|software|soft|tools?|tencent|portable|green|dev|develop|development|应用|软件)$/i;
const WB_SCAN_MAX_DIRS = 400;
const WB_SCAN_MIN_INTERVAL_MS = 3000;
const WB_MISS_RETRY_MS = 5000;

let wbExeCache = '';
let wbScanCache = null;
let wbScanAt = 0;
let wbMissAt = 0;

function wbListDirs(dir, budget) {
  if (budget.dirs <= 0) return [];
  budget.dirs -= 1;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Direct child of `dir` that looks like the client binary (full path or ''). */
function wbExeInDir(dir) {
  try {
    const hit = readdirSync(dir, { withFileTypes: true })
      .find((e) => !e.isDirectory() && WB_EXE_NAME_RE.test(e.name));
    return hit ? join(dir, hit.name) : '';
  } catch {
    return '';
  }
}

/** 磁盘浅扫描：盘根 → {App | Program Files | Tencent | …} → {含 workbuddy 的目录} → exe。 */
function wbScan() {
  if (process.platform !== 'win32') return [];
  const found = [];
  const seen = new Set();
  const budget = { dirs: WB_SCAN_MAX_DIRS };
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); found.push(p); } };

  for (let c = 67; c <= 90; c += 1) { // C: … Z:
    const drive = `${String.fromCharCode(c)}:\\`;
    if (!existsSync(drive)) continue;
    for (const name1 of wbListDirs(drive, budget)) {
      const p1 = join(drive, name1);
      if (WB_DIR_KEYWORD_RE.test(name1)) {
        // E:\App\WorkbuddyInternational\WorkBuddy.exe
        push(wbExeInDir(p1));
        for (const name2 of wbListDirs(p1, budget)) push(wbExeInDir(join(p1, name2)));
      } else if (WB_DESCEND_RE.test(name1)) {
        for (const name2 of wbListDirs(p1, budget)) {
          const p2 = join(p1, name2);
          if (WB_DIR_KEYWORD_RE.test(name2)) {
            push(wbExeInDir(p2));
            for (const name3 of wbListDirs(p2, budget)) push(wbExeInDir(join(p2, name3)));
          } else if (WB_DESCEND_RE.test(name2)) {
            // C:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe
            for (const name3 of wbListDirs(p2, budget)) {
              if (WB_DIR_KEYWORD_RE.test(name3)) push(wbExeInDir(join(p2, name3)));
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * All executable candidates, most-trusted first.
 *
 * 静态候选在前；扫描兜底（带缓存与失败防抖 —— "客户端正在重装"的窗口期内
 * 不会每次调用都全盘扫一遍）。返回**数组**而不是单个路径：机器上可能并存
 * 多个 build，由 atRestKey() 按登录文件的 keyId 挑选。
 */
function workBuddyExeCandidates() {
  if (wbExeCache && existsSync(wbExeCache)) return [wbExeCache];

  const out = [];
  if (process.env.WORKBUDDY_APP_EXECUTABLE) out.push(process.env.WORKBUDDY_APP_EXECUTABLE);
  if (process.platform === 'win32') {
    const names = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe'];
    for (const root of [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean)) {
      for (const dir of ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy']) {
        for (const name of names) out.push(join(root, dir, name));
      }
    }
    out.push('E:\\App\\WorkBuddy\\WorkBuddy.exe');
    out.push('E:\\App\\WorkBuddy\\WorkBuddyAI.exe');
    out.push('D:\\App\\WorkBuddy\\WorkBuddy.exe');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push('/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy');
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }

  if (wbScanCache && !wbScanCache.some((p) => existsSync(p))) {
    wbScanCache = null; // 陈旧：命中的文件都不在了 → 允许重扫（由防抖限制频率）
  }
  if (!wbScanCache && Date.now() - wbScanAt >= WB_SCAN_MIN_INTERVAL_MS) {
    wbScanAt = Date.now();
    const hits = wbScan();
    if (hits.length) wbScanCache = hits;
  }
  if (wbScanCache) {
    for (const p of wbScanCache) {
      if (!out.includes(p)) out.push(p); // 静态与扫描可能重叠，去重
    }
  }
  return out;
}

// ── 系统信号兜底（Windows）：进程镜像路径 + 注册表安装记录 ───────────────
// 静态候选与目录扫描本质上都在"猜路径"；客户端装进 `D:\随机名字\` 就会全部
// 落空。而下面两类信号是**客户端自己留下的、与安装位置无关**：
//   ① 运行中进程的镜像路径（客户端在用时即安装位置，最准）；
//   ② 注册表卸载记录 / 深链协议（workbuddy://…）/ App Paths —— 官方安装器
//      必写（否则"应用和功能"里看不到它），装到任何目录都有。
// PowerShell 冷启动数秒，故只在前面全部落空时执行，且带缓存与失败防抖。
// 与 lib/find-workbuddy.mjs 同款（桥保持自包含单文件；改动时两边需同步）。
const WB_SYS_PROBE_MIN_INTERVAL_MS = 120000;
let wbSysHits = null;
let wbSysProbeAt = 0;

function wbPowershellPath() {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell';
}

/** 一次调用收集全部信号，base64 输出（免受编码/引号影响）。 */
const WB_SYS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ procs = @(); reg = @() }
Get-Process | Where-Object { $_.Name -match '^(WorkBuddy|CodeBuddy)' } | ForEach-Object {
  if ($_.Path) { $out.procs += $_.Path }
}
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($r in $roots) {
  Get-ChildItem $r | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ("$($p.DisplayName)" -match 'WorkBuddy|CodeBuddy') {
      $out.reg += @{ icon = "$($p.DisplayIcon)"; uninst = "$($p.UninstallString)" }
    }
  }
}
foreach ($proto in @('workbuddy', 'workbuddyai', 'codebuddy')) {
  foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
    $cmd = (Get-ItemProperty "$hive\$proto\shell\open\command").'(default)'
    if ($cmd) { $out.reg += @{ cmd = "$cmd" } }
  }
}
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
  Get-ChildItem $hive | Where-Object { $_.PSChildName -match 'WorkBuddy|CodeBuddy' } | ForEach-Object {
    $d = (Get-ItemProperty $_.PSPath).'(default)'
    if ($d) { $out.reg += @{ cmd = "$d" } }
  }
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 5 -Compress)))
`;

/**
 * PowerShell 5.1 的 ConvertTo-Json 会把**单元素数组退化成标量**（`["a"]` 输出成
 * `"a"`）。单客户端机器上 procs / reg 恰好可能只有一个元素 —— 不归一化就会在
 * `for...of` 里遍历字符串的字符。一律先过数组。
 */
const wbAsArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** 从信号里提取客户端 exe：exe 名直接认；卸载器/图标路径取所在目录再找本体。 */
function wbExtractExePaths(signal) {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const baseOf = (p) => String(p || '').split(/[\\/]/).pop() || '';
  for (const p of wbAsArray(signal?.procs)) {
    if (WB_EXE_NAME_RE.test(baseOf(p))) push(p);
  }
  for (const rec of wbAsArray(signal?.reg)) {
    // 三个字段都要尝试（而非短路取值）：icon 可能指向无关程序甚至系统图标，
    // 此时 uninst（卸载器路径）是唯一线索。
    for (const raw of [rec.icon, rec.uninst, rec.cmd]) {
      const m = /([A-Za-z]:\\[^"]*?\.exe)/i.exec(String(raw || ''));
      if (!m) continue;
      const exe = m[1];
      if (WB_EXE_NAME_RE.test(baseOf(exe))) {
        push(exe);
        continue;
      }
      const hit = wbExeInDir(dirname(exe)); // 卸载器与客户端同目录
      if (hit) push(hit);
    }
  }
  return out;
}

/** 系统信号兜底（Windows）。成功缓存；失败 2 分钟内不重试；任何异常静默返回 []。 */
function wbProbeSystemSignals() {
  if (wbSysHits && wbSysHits.some((p) => existsSync(p))) return wbSysHits;
  wbSysHits = null; // 陈旧：命中都已不存在 → 允许重探（由防抖限制频率）
  if (process.platform !== 'win32') return [];
  if (Date.now() - wbSysProbeAt < WB_SYS_PROBE_MIN_INTERVAL_MS) return [];
  wbSysProbeAt = Date.now();

  let signal;
  try {
    const res = spawnSync(wbPowershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WB_SYS_PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1048576,
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    signal = JSON.parse(Buffer.from(String(res.stdout).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const hits = wbExtractExePaths(signal).filter((p) => existsSync(p));
  if (hits.length) wbSysHits = hits;
  return hits;
}

/**
 * 首个存在的客户端 exe；全部落空返回 ''。成功结果缓存，缓存失效自动重探。
 * 先便宜的（静态 + 扫描），全落空才动 PowerShell 兜底。
 */
function resolveWorkBuddyExe() {
  if (wbExeCache && existsSync(wbExeCache)) return wbExeCache;
  wbExeCache = '';
  if (Date.now() - wbMissAt < WB_MISS_RETRY_MS) return '';
  let hit = workBuddyExeCandidates().find((p) => existsSync(p));
  if (!hit) hit = wbProbeSystemSignals().find((p) => existsSync(p));
  if (hit) {
    wbExeCache = hit;
    return hit;
  }
  wbMissAt = Date.now();
  return '';
}

/** Length-prefixed UTF-8 string: uint32 big-endian length then the bytes. */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** Additional authenticated data for a FIELD-framed sym-v1 envelope. */
function atRestFieldAad(keyId, suite) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    ATREST_AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    suiteBytes,
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** keyId of a derived field key — same truncation the envelopes use. */
function atRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Envelope keyId carried by an encrypted field ('' for plaintext / malformed). */
function fieldKeyIdOf(value) {
  if (!isEncryptedField(value)) return '';
  try {
    return JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')).keyId || '';
  } catch {
    return '';
  }
}

/** 从某个 exe 取一次密钥载荷；失败返回 { error }。 */
function fetchKeyPayloadFrom(exe) {
  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
    + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
  const res = spawnSync(exe, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // stdin MUST be ignored: the Electron binary fails with EBUSY when a
    // pipe is opened for it, so only stdout/stderr may be piped.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 1048576,
    encoding: 'utf8',
  });
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) {
    return { error: `exit ${res.status}: ${String(res.stderr || '').trim()}` };
  }
  try {
    const secret = JSON.parse(res.stdout).atRestSecretKey;
    if (typeof secret !== 'string' || secret === '') {
      return { error: 'payload carries no atRestSecretKey' };
    }
    return { secret };
  } catch (err) {
    return { error: `unparsable payload: ${String((err && err.message) || err)}` };
  }
}

/**
 * The 32-byte field key, derived from the app's own key payload.
 *
 * 机器上可能并存多个 WorkBuddy build（如国内版 WorkBuddyAI.exe 与国际版
 * WorkBuddy.exe）——它们的 atRestSecretKey 不同，只有"写登录文件的那个"能
 * 解开信封。所以按登录文件里信封的 keyId 逐个候选试，命中即用；一个都不
 * 匹配时退回第一个能取到密钥的，让 openAuthField 给出准确的 keyId 报错。
 */
function atRestKey() {
  if (atRestKeyCache) return atRestKeyCache;
  let candidates = workBuddyExeCandidates().filter((p) => existsSync(p));
  // 廉价层全 miss 才动 PowerShell 兜底（系统信号：进程 + 注册表）
  if (candidates.length === 0) candidates = wbProbeSystemSignals().filter((p) => existsSync(p));
  if (candidates.length === 0) {
    throw new Error(
      'key fetch failed: WorkBuddy 客户端可执行文件未找到'
      + '（已探测默认安装位置并扫描常见目录）。'
      + '若客户端装在非常规目录，请在 .env 设置 WORKBUDDY_APP_EXECUTABLE 指向其 WorkBuddy.exe',
    );
  }
  const failures = [];
  let fallback;
  for (const exe of candidates) {
    const { secret, error } = fetchKeyPayloadFrom(exe);
    if (!secret) {
      failures.push(`${exe} -> ${error}`);
      continue;
    }
    // The app hashes the base64 STRING, not its decoded bytes.
    const key = createHash('sha256').update(secret, 'utf8').digest();
    if (!wantedKeyId || atRestKeyId(key) === wantedKeyId) {
      atRestKeyCache = key;
      atRestUsedExe = exe;
      return key;
    }
    if (!fallback) fallback = { key, exe }; // 可能不是写登录文件的那个 build：先留着
  }
  if (fallback) {
    atRestKeyCache = fallback.key;
    atRestUsedExe = fallback.exe;
    return fallback.key;
  }
  throw new Error(`key fetch failed from all ${candidates.length} candidate(s): ${failures.join(' | ')}`);
}

/** Whether a value is the app's encrypted-field wrapper. */
function isEncryptedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope'
    && value.$wbEncrypted === 1 && typeof value.envelope === 'string';
}

/** Plaintext of an auth field, transparently opening the 5.6+ envelope. */
function openAuthField(value, label) {
  if (typeof value === 'string') return value; // pre-5.6 plaintext, or a refreshed value
  if (!isEncryptedField(value)) return '';
  const envelope = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  const key = atRestKey();
  const expected = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (envelope.keyId !== expected) {
    throw new Error(`${label} was sealed under key ${envelope.keyId}, not ${expected};`
      + ' is this the desktop build that wrote the login file?');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(atRestFieldAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 按登录域名选择上游网关。
 *
 * 国际版与国内版是**不同的网关**，用错会直接 401：
 *   workbuddy.ai / workbuddy.cc  →  https://www.workbuddy.ai
 *   国内版（默认）                →  https://copilot.tencent.com
 *
 * 原实现只判断 `codebuddy.ai`，于是 `www.workbuddy.ai` 落到了国内网关——
 * 只有存在国际版账号（多账号切换）时才会暴露。
 */
function pickUpstream(domain) {
  const d = String(domain || '');
  if (d.includes('workbuddy.ai') || d.includes('workbuddy.cc')) return 'https://www.workbuddy.ai';
  if (d.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  return 'https://copilot.tencent.com';
}

// ── Auth: read the local desktop session ─────────────────────────────────
function readStoredAuth() {
  // A token this process refreshed outlives the file until the desktop app catches up.
  if (memoryAuth && Date.now() < memoryAuth.expiresAt - REFRESH_SKEW_MS) return memoryAuth;
  const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const auth = raw.auth || {};
  if (!auth.accessToken) throw new Error('login file has no accessToken; sign in to the WorkBuddy desktop app first');
  // 密钥选择以本文件为基准：机器上多客户端并存时，优先用"写这份登录文件的
  // build"。文件被另一个 build 重写过 → 已缓存的密钥失效，重新挑。
  wantedKeyId = fieldKeyIdOf(auth.accessToken) || fieldKeyIdOf(auth.refreshToken) || '';
  if (wantedKeyId && atRestKeyCache && atRestKeyId(atRestKeyCache) !== wantedKeyId) {
    atRestKeyCache = undefined;
  }
  const access = openAuthField(auth.accessToken, 'accessToken');
  const refresh = openAuthField(auth.refreshToken, 'refreshToken');
  const claims = decodeJwt(access);
  const domain = auth.domain || claims.iss || '';
  const endpoint = EXPLICIT_ENDPOINT || pickUpstream(domain);
  return {
    access,
    refresh,
    expiresAt: Number(auth.expiresAt || claims.exp * 1000 || 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
    userId: claims.sub || '',
    enterpriseId: claims.enterprise_id || '',
    tenantId: claims.tenant_id || claims.tenant || '',
    endpoint,
    domain,
  };
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// ── Auth: refresh and write back the login file (cross-process lock + atomic write) ──
let lastRefreshFailedAt = 0;
async function refreshAuth(auth) {
  if (!auth.refresh) return null;
  if (Date.now() - lastRefreshFailedAt < REFRESH_COOLDOWN_MS) return null;
  try {
    const res = await fetch(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${auth.refresh}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 0 || !body.data?.accessToken) {
      lastRefreshFailedAt = Date.now();
      // **绝不打印响应体全文**：失败条件里含 `!res.ok`，也就是说非 2xx 的响应体
      // 仍可能带着 `data.accessToken` —— 而这一行会落进 bridge.log（控制台的日志
      // 面板还会把它显示出来），那就直接违反了「不落盘令牌 / 凭据不落盘」的承诺。
      // 只取协议层的 code 与 msg：定位问题够用，且不含凭据。
      const reason = body && typeof body === 'object'
        ? `${body.code ?? ''} ${body.msg || body.message || ''}`.trim()
        : '';
      log('refresh failed', res.status, shortError(reason || '(no protocol message)'));
      return null;
    }
    persistRefreshed();
    const now = Date.now();
    memoryAuth = {
      access: body.data.accessToken,
      refresh: body.data.refreshToken || auth.refresh,
      expiresAt: now + Number(body.data.expiresIn || 0) * 1000,
      refreshExpiresAt: now + Number(body.data.refreshExpiresIn || 0) * 1000,
      userId: auth.userId,
      enterpriseId: auth.enterpriseId,
      tenantId: auth.tenantId,
      endpoint: auth.endpoint,
      domain: auth.domain,
    };
    log('refreshed access token (in memory; file untouched)');
    return memoryAuth;
  } catch (e) {
    lastRefreshFailedAt = Date.now();
    log('refresh error', describeFetchError(e));
    return null;
  }
}

function persistRefreshed() {
  // The login file now holds AES-256-GCM envelopes and the desktop app owns its
  // own refresh cycle. Writing a decrypted token back would corrupt that store,
  // so a refreshed token is kept in memory for this process only.
  log('write-back skipped: the at-rest credential store belongs to the desktop app');
}

// ── Upstream payload normalization ───────────────────────────────────────
/**
 * 上游（copilot.tencent.com）比 OpenAI 规范更严：有几处「规范允许、上游拒绝」
 * 的写法，必须在转发前归一化，否则客户端一用就整条请求失败。目前三处：
 *
 * 1. `developer` 角色 —— 新版 OpenAI 规范用它承载 system 提示，而官方客户端
 *    只发 `system`。上游只认后者，遇到 `developer` 直接 400 code 11128。
 * 2. `tool_choice` 对象形式 —— 规范允许 `{type:'function', function:{name}}`
 *    强制调用某个具体函数，上游的 Go 结构体把它声明成了 `string`，
 *    收到对象会 400 code 11101。Cursor / Trae / opencode 这类基于 AI SDK
 *    的 Agent 客户端会发对象形式。
 * 3. 首条消息必须是 system —— 上游会以 `400 code 11128 first message is not
 *    system prompt` 拒绝纯 user 开头的请求，而不少客户端（含自带的
 *    「对话测试」和只发单轮的 CLI）并不发 system。
 * 4. Claude Code 的固定 system 模板被上游**逐字拉黑**（2026-10-08 实测）：
 *    带原文 → `400 Illegal API invocation from an unapproved channel`；
 *    按报告 §8.7 #44 做最小改写（CLI→CLI tool、Main branch→Default branch）
 *    后 → 200。上游用它识别「经代理转发的 Claude Code」，因此改写放在出站层
 *    统一做（两条协议路径共用 —— OpenAI 路径带同样句子的请求一样会被拒）。
 *    承认这是 cat-and-mouse：只做**已被实测证明有效**的最小改写，不发明更多。
 */
const AUDIT_TEMPLATE_REWRITES = [
  ["You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI tool for Claude."],
  ['Main branch (you will usually use this for PRs)',
    'Default branch (you will usually use this for PRs)'],
  /*
   * DSH（DeepSeek Harness）自己的开场指纹句被国内版网关**逐字**拉黑。
   *
   * 2026-10-22 实测（copilot.tencent.com，账号 6d2b5f6b）：system 里出现
   * `You are an AI agent powered by DeepSeek Harness` 整句，上游就回
   * `400 code 11-128 Illegal API invocation from an unapproved channel`。
   * 已逐项验证的边界（注意匹配**锚定在 system 开头**）：
   *   · 这句放在 system 最前面             → 400
   *   · 前面加任意文本（如 `x. ` 或一段前言）→ 200（说明是前缀匹配）
   *   · 句首这句 + 后面还有别的文本         → 400
   *   · `DeepSeek Harness` 单独出现         → 200（不是关键词命中）
   *   · `powered by DeepSeek Harness` 单独   → 200
   *   · 换动词（built on / running inside）  → 200
   * 即命中的是「出现在开头的那一整句」（含 `powered by` 的动词形态），与当年
   * Claude Code 那条（见上）是同一类机制。最小改写 = 换动词，语义不变。
   *
   * 影响面：这句是 DSH 每一轮 agent 请求的开头；会话标题那条请求用的是另一套
   * system（"Create a concise title…"），不含黑名单句 —— 这正好解释了「面板对话
   * 测试正常、DSH 一用国内版就报错」。国际版（workbuddy.ai）不做这项校验。
   */
  ['You are an AI agent powered by DeepSeek Harness',
    'You are an AI agent built on DeepSeek Harness'],
  /*
   * 第二句（同一批实测）：DSH 的「Web GUI」那句也被逐字拉黑。
   *
   * 实测边界：把 `interacting` 换成 `working`、`through` 换成 `via`、
   * `names` 换成 `supplies`、或插入 `(DSH)` 都 → 200；
   * 而**只改大小写**（`Web GUI`→`web GUI`、`Harness`→`harness`）仍 → 400 ——
   * 说明上游是**区分大小写的整句匹配**，不是关键词命中。
   *
   * 两句都必须改：只改第一句、整段真实提示词依旧 400；两句都改 → 200
   * （2026-10-22 用会话日志里的真实 system + 真实 73 个 tools 复现验证）。
   * 改写只动一个词，语义不变。
   */
  ['You are interacting with the user through the DeepSeek Harness Web GUI',
    'You are working with the user through the DeepSeek Harness Web GUI'],
];

/** system 文本的最小改写；无命中时返回原值（引用不变，便于命中计数）。 */
/*
 * 每条约定的命中次数（进程级，只增不减）。
 *
 * 为什么要计数：黑名单是**上游悄悄加的** —— 2026-10-21 那两句上线时没有任何公告，
 * 表现只是「突然全报 11-128」。有了计数，/health 里 `fingerprints.rewrites` 一旦
 * 由 0 变正，就说明上游又拉黑了新句子（或旧句子复活），能在用户报错之前发现；
 * 而 `fingerprints.byRule` 直接指出是**哪一条**在命中，省掉重新二分定位的功夫。
 *
 * 按 `from` 原文做键（不用下标）：改写表将来增删条目时，历史计数不会串位。
 */
const fingerprintHits = new Map();

function rewriteAuditTemplate(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [from, to] of AUDIT_TEMPLATE_REWRITES) {
    if (!out.includes(from)) continue;
    const occurrences = out.split(from).length - 1;
    fingerprintHits.set(from, (fingerprintHits.get(from) || 0) + occurrences);
    out = out.split(from).join(to);
  }
  return out;
}

/** content 可能是 string 或 parts 数组（Anthropic 的 [{type:'text',text}]）。 */
function rewriteAuditContent(content) {
  if (typeof content === 'string') return rewriteAuditTemplate(content);
  if (Array.isArray(content)) {
    let changed = false;
    const nextParts = content.map((part) => {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        const t = rewriteAuditTemplate(part.text);
        if (t !== part.text) {
          changed = true;
          return { ...part, text: t };
        }
      }
      return part;
    });
    return changed ? nextParts : content;
  }
  return content;
}

function normalizePayload(payload) {
  let next = payload;

  // ── tool_choice：对象 → 字符串 ─────────────────────────────────────────
  // `{type:'function'}` 表达的是「必须调用工具」里最强的那档，而上游没有
  // 「指定某一个函数」的表达，取语义最接近的 `required`（必须调用工具，
  // 但不限定是哪一个）。
  //
  // 认不出来的对象**丢弃而不是原样转发**：留着必然 400，丢掉最多退化成
  // `auto`（让模型自己决定），这比整条请求失败好得多。
  const tc = next.tool_choice;
  if (tc !== null && typeof tc === 'object' && !Array.isArray(tc)) {
    const mapped = tc.type === 'function' ? 'required'
      : (tc.type === 'auto' || tc.type === 'none' || tc.type === 'required') ? tc.type
        : null;
    next = { ...next };
    if (mapped) {
      next.tool_choice = mapped;
      log(`normalize: tool_choice object -> "${mapped}"`);
    } else {
      delete next.tool_choice;
      log('normalize: dropped unrecognized tool_choice object');
    }
  }

  // ── messages：developer → system，并保证首条是 system ──────────────────
  const messages = next.messages;
  if (!Array.isArray(messages) || messages.length === 0) return next;

  let rewritten = 0;
  const fixed = messages.map((m) => {
    if (m && (m.role === 'developer' || m.role === 'Developer')) {
      rewritten++;
      return { ...m, role: 'system' };
    }
    return m;
  });

  // ── 内容审核模板的最小改写（对全部 system 消息；命中才动）───────────────
  let auditFixed = 0;
  const sanitized = fixed.map((m) => {
    if (!m || (m.role !== 'system' && m.role !== 'System')) return m;
    const nextContent = rewriteAuditContent(m.content);
    if (nextContent !== m.content) {
      auditFixed++;
      return { ...m, content: nextContent };
    }
    return m;
  });

  let prepended = 0;
  const first = sanitized[0];
  if (!first || (first.role !== 'system' && first.role !== 'System')) {
    sanitized.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    prepended = 1;
  }

  if (rewritten) log(`normalize: rewrote ${rewritten} developer message(s) -> system`);
  if (auditFixed) log(`normalize: rewrote ${auditFixed} audit-template system message(s)`);
  if (prepended) log('normalize: prepended a system message (upstream requires one first)');
  if (!rewritten && !prepended && !auditFixed) return next;
  return { ...next, messages: sanitized };
}

// ── Request header construction ──────────────────────────────────────────
const trace = () => randomUUID().replace(/-/g, '');

function buildHeaders(auth, model, conversationId) {
  const messageId = trace();
  const traceId = trace();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': IDE_NAME,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': 'production',
    'X-Domain': auth.domain,
    'X-Product': 'SaaS',
    'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
    'X-Request-ID': messageId,
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (model) {
    // 兜底。入口（/v1/chat/completions）已按 HEADER_SAFE_RE 校验并回 400，这里再挡
    // 一次是为了防止**将来新增的调用方**绕过入口校验、把非法值直接送进 http.request ——
    // 那样抛出的 `Invalid character in header content` 会变成 500，而根因（谁传的）
    // 在栈里完全看不出来。Anthropic 路径的模型名会先被映射成真实 id，天然安全。
    if (!HEADER_SAFE_RE.test(model)) {
      throw new Error(`model id would produce an invalid X-Model-ID header: ${shortError(model, 60)}`);
    }
    h['X-Model-ID'] = model;
  }
  if (API_KEY) {
    h.Authorization = `Bearer ${API_KEY}`;
    h['X-API-Key'] = API_KEY;
  } else {
    h.Authorization = `Bearer ${auth.access}`;
    if (auth.userId) h['X-User-Id'] = auth.userId;
    if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
    if (auth.tenantId) h['X-Tenant-Id'] = auth.tenantId;
  }
  return h;
}

// ── Upstream call (with refresh retry and transient-400 retry) ───────────
/**
 * 用 node:http/https + keep-alive Agent 发一次上游请求，返回 IncomingMessage。
 *
 * 为什么不用全局 fetch：Node 内建 fetch（undici）的连接池不开放、空闲连接只留
 * ~4 秒，达不到「跨请求复用 TLS 连接」的目的。node:http 的 Agent 可以。
 * 返回的 res 兼容 bridge 现有消费方式（res.ok / res.status / res.text() /
 * res.body.getReader() 由下面的 shim 补齐）。
 */
/**
 * 非 2xx 响应体的预读缓存。
 *
 * 用 WeakMap 而不是给 IncomingMessage 挂自定义属性：后者在 `tsc --checkJs`
 * 下会报 TS2339（属性不存在于类型上），而且污染 Node 原生对象。
 */
const preReadBodies = new WeakMap();

function upstreamRequest(endpointUrl, { headers, body, signal }) {
  const url = new URL(endpointUrl);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers,
        agent: agentFor(url.protocol),
      },
      (res) => {
        /**
         * **只对非 2xx 预读** body，2xx 一律不碰。
         *
         * 为什么只碰非 2xx：挂 `on('data')` 会把流切到流动模式。2xx 的 SSE 正文
         * 由 `shimResponse.body`（ReadableStream）消费，这里若也去听，两边会
         * **分食同一份数据** —— 实测这么做会让 14 个用例失败（SSE 内容被抢走）。
         * 而非 2xx 的体很小（错误页，还会被截断到 160 字符），预读没有代价。
         *
         * 为什么必须预读：`shimResponse.text()` 是事后挂监听的读法，若拿到响应时
         * 体已经流完（`end` 已派发），监听永远不触发 → Promise 永不 resolve →
         * 请求挂死。实测 Node 25 + "上游 401 + text/html"就是这个场景，用例固定
         * 超时 120 秒，而桥的业务逻辑是对的。
         */
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { preReadBodies.set(res, Buffer.concat(chunks).toString('utf8')); });
        }
        resolve(res);
      },
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      const onAbort = () => req.destroy(new Error(signal.reason?.message || 'aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
      req.on('response', (res) => res.on('close', () => signal.removeEventListener('abort', onAbort)));
    }
    req.end(body);
  });
}

/** http.IncomingMessage → 与 fetch Response 兼容的最小面（bridge 现有消费代码不动）。 */
function shimResponse(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: res.headers,
    text: () => new Promise((resolve, reject) => {
      /**
       * 流已经结束（`end` 已派发）时不能再挂 `data`/`end` 监听 —— 它们永远
       * 不会再触发，这个 Promise 就永不 resolve，请求挂死到客户端超时。
       *
       * 实测（Node 25 / 本机）：上游回 401 + text/html 时，体在 callUpstream
       * 返回前就已流完，`await res.text()` 直接挂住 —— bridge.test.mjs 的
       * 账本截断用例因此固定超时（120 秒），而桥的业务逻辑是对的。
       *
       * 兜底：缓存过就直接用；没缓存说明数据已被别处消费/丢弃，返回空串而不是
       * 挂死 —— 上层据此仍能记一条失败并给出可读错误，比"客户端超时"好得多。
       */
      if (res.readableEnded === true || res.complete === true) {
        resolve(preReadBodies.get(res) ?? '');
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        preReadBodies.set(res, text);
        resolve(text);
      });
      res.on('error', reject);
    }),
    body: new ReadableStream({
      start(controller) {
        res.on('data', (c) => controller.enqueue(new Uint8Array(c)));
        res.on('end', () => controller.close());
        res.on('error', (e) => controller.error(e));
      },
      cancel() { res.destroy(); },
    }),
    // 诊断/重试逻辑用：这条连接是不是复用的（见 sendWithRetry）
    reusedSocket: res.reusedSocket === true,
  };
}

/**
 * 发送并处理「复用的空闲连接已被服务端掐断」：ECONNRESET / socket hang up
 * 发生在**复用** socket 且还没收到任何响应字节时，换新连接重试一次。
 */
// ── Local rate limiting (opt-in) ─────────────────────────────────────────
/**
 * 本地限流 —— 「保护账号配额」的唯一机制：单个失控的客户端（脚本 bug、
 * 死循环重试）能把账号打爆，而在此之前代码里零实现、文档里只有一句提醒。
 *
 * 两个独立旋钮、**默认全关**（0），关着时行为与没有本机制完全一致：
 *   WORKBUDDY_RATE_LIMIT_RPM               每分钟最多向上游发多少条
 *   WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS   两条之间的最小间隔
 *
 * 超限行为（WORKBUDDY_RATE_LIMIT_MODE）：
 *   queue （默认）—— 排队等待，轮到再发（对齐 copilot-api 的 --wait 语义）；
 *   reject        —— 立刻 429 + Retry-After，适合会自行退避重试的客户端。
 *
 * 实现：许可分配走一条 promise 链**串行化** —— 并发请求按到达顺序排队，不惊群；
 * 等待循环对客户端断开敏感（abort 即退出队列，不占位）。闸门在读凭据 / 打上游
 * **之前**：被限流的请求不产生任何上游副作用。
 */
const RATE_LIMIT_RPM = Math.max(0, Math.floor(Number(process.env.WORKBUDDY_RATE_LIMIT_RPM || 0)) || 0);
const RATE_LIMIT_MIN_INTERVAL_MS = Math.max(0, Math.floor(Number(process.env.WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS || 0)) || 0);
const RATE_LIMIT_MODE = process.env.WORKBUDDY_RATE_LIMIT_MODE === 'reject' ? 'reject' : 'queue';

const rateState = {
  /** scope -> { recent, lastStart, tail }：local 与每个 client key 各一个独立桶。 */
  byScope: new Map(),
  /** 触发计数：账本与控制台可见「被限流了多少次」。 */
  limited: 0,
};

/** 取（或建）调用方自己的限流桶 —— 桶之间互不影响（B2 凭据分层）。 */
function bucketFor(scope) {
  let bucket = rateState.byScope.get(scope);
  if (!bucket) {
    bucket = { recent: [], lastStart: 0, tail: Promise.resolve() };
    rateState.byScope.set(scope, bucket);
  }
  return bucket;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 现在能不能放行？不能则返回还需等待的毫秒数。 */
function rateWaitMs(now, bucket) {
  let wait = 0;
  if (RATE_LIMIT_RPM > 0) {
    const cutoff = now - 60_000;
    while (bucket.recent.length && bucket.recent[0] <= cutoff) bucket.recent.shift();
    if (bucket.recent.length >= RATE_LIMIT_RPM) {
      wait = Math.max(wait, bucket.recent[0] + 60_000 - now + 1);
    }
  }
  if (RATE_LIMIT_MIN_INTERVAL_MS > 0 && bucket.lastStart > 0) {
    wait = Math.max(wait, bucket.lastStart + RATE_LIMIT_MIN_INTERVAL_MS - now + 1);
  }
  return wait;
}

/**
 * 取一张「发往上游」的许可。
 * queue 模式等到许可返回；reject 模式超限抛 code=RATE_LIMITED（带 retryAfterMs）。
 * @returns {Promise<{ waitedMs: number, limited: boolean }>}
 */
async function acquireRateSlot(clientSignal, scope = 'local') {
  if (RATE_LIMIT_RPM <= 0 && RATE_LIMIT_MIN_INTERVAL_MS <= 0) return { waitedMs: 0, limited: false };
  const bucket = bucketFor(scope);
  const enter = Date.now();
  const prev = bucket.tail;
  let release;
  bucket.tail = new Promise((resolve) => { release = resolve; });
  await prev;
  let limited = false;
  try {
    for (;;) {
      const now = Date.now();
      const wait = rateWaitMs(now, bucket);
      if (wait <= 0) {
        bucket.recent.push(now);
        bucket.lastStart = now;
        return { waitedMs: now - enter, limited };
      }
      if (!limited) {
        limited = true;
        rateState.limited += 1;
        log(`rate limit engaged (mode=${RATE_LIMIT_MODE}): waiting ${wait}ms`);
      }
      if (RATE_LIMIT_MODE === 'reject') {
        // Node 惯用：给 Error 挂自定义字段（识别码 + Retry-After 毫秒数）
        const err = /** @type {Error & { code?: string, retryAfterMs?: number }} */ (new Error(`local rate limit exceeded; retry in ${Math.ceil(wait / 1000)}s`));
        err.code = 'RATE_LIMITED';
        err.retryAfterMs = wait;
        throw err;
      }
      if (clientSignal?.aborted) {
        const err = /** @type {Error & { code?: string }} */ (new Error('client aborted while waiting for a rate-limit slot'));
        err.code = 'RATE_LIMIT_ABORTED';
        throw err;
      }
      await sleep(Math.min(wait, 500));
    }
  } finally {
    release();
  }
}

/**
 * 请求里是否带图片（OpenAI 的 `image_url`；Anthropic 的 image block 会先被转成同一形态）。
 * 降级选模型要用：请求带图而候选不支持图片，上游会**把图丢掉照常回答** —— 静默错结果，
 * 比直接报 429 更糟。
 */
function requestHasImage(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part && (part.type === 'image_url' || part.type === 'image')) return true;
    }
  }
  return false;
}

/**
 * 为降级挑候选模型：与 `model` **能力相当**、且确实在当前目录里。
 *
 * 硬约束（少一条就会让降级变成「换个方式坏掉」）：
 *   1. 原请求带 tools → 候选必须不是 `supportsToolCall === false`。
 *      否则换过去得到的是普通文本而不是工具调用，用户以为成功了。
 *   2. 原请求带图片 → 候选不能是 `supportsImages === false`（理由见 requestHasImage）。
 *   3. 只用目录里真实存在的 id（否则上游回 11102）。
 * 字段缺失时**按支持处理**：目录偶尔漏报（国际版 deepseek-v4.1-flash 就漏报过图片能力），
 * 因为缺字段就误杀候选，会让降级在真正需要时无模型可用。
 *
 * 排序：优先免费/低价（降级是补救，不该比原模型更贵），其次上下文更接近原模型的。
 */
async function fallbackCandidates(model, payload, limit) {
  if (limit <= 0) return [];
  /*
   * 用 upstreamCatalog() 而不是直接读 catalogCache：
   * 冷启动（桥刚起、还没人调过 /v1/models）时缓存是**空的**，此时直接读会得到
   * 空候选 → 降级静默失效。实测踩过：脚本里先调 /v1/models 再发请求仍然失败，
   * 因为那是异步后台刷新，调用方拿到的仍是空缓存。
   * upstreamCatalog() 在「完全没有缓存」时才同步抓一次，已有缓存立刻返回 ——
   * 正好是降级需要的语义（不能为了降级把每个请求都拖慢）。
   */
  let models = catalogCache.models;
  if (!Array.isArray(models) || models.length === 0) {
    try { models = await upstreamCatalog(); } catch { models = []; }
  }
  if (!Array.isArray(models) || models.length === 0) return [];
  const anyTool = Array.isArray(payload?.tools) && payload.tools.length > 0;
  const anyImage = requestHasImage(payload);
  const current = models.find((m) => m.id === model) || null;
  const usable = models.filter((m) => {
    if (!m || typeof m.id !== 'string' || !m.id || m.id === model) return false;
    if (anyTool && m.supportsToolCall === false) return false;
    if (anyImage && m.supportsImages === false) return false;
    return true;
  });
  const cost = (m) => {
    if (m.free === true) return 0;
    const c = typeof m.credits === 'number' ? m.credits : Number.NaN;
    return Number.isFinite(c) ? c : 99;
  };
  const wantCtx = current?.maxInputTokens || 0;
  usable.sort((a, b) => {
    const d = cost(a) - cost(b);
    if (d !== 0) return d;
    if (wantCtx) {
      const da = Math.abs((a.maxInputTokens || 0) - wantCtx);
      const db = Math.abs((b.maxInputTokens || 0) - wantCtx);
      if (da !== db) return da - db;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  return usable.slice(0, limit).map((m) => m.id);
}

/**
 * 撞上上游 429 时换一个能力相当的模型重发一次。
 *
 * 返回「成功的那次响应」包装（与 callUpstream 同形），或 null 表示放弃降级
 * （此时调用方会照原样返回最初的 429 —— 保留它比抛出「最后一个候选的错误」
 * 更能反映真实原因）。
 *
 * 只在**候选真的成功**时采用：候选也 429 / 5xx / 11128 就跳过试下一个。
 *
 * @param {{ auth: object, model: string, bodyString: string, conversationId: string,
 *   clientSignal?: AbortSignal, upEnter: number,
 *   attemptWithStaleRetry: (a: object, m?: string, b?: string) => Promise<any> }} ctx
 */
async function tryFallbackOn429(ctx) {
  const { auth, model, bodyString, clientSignal, upEnter, attemptWithStaleRetry } = ctx;
  let retryPayload;
  try { retryPayload = JSON.parse(bodyString); } catch { return null; }
  if (!retryPayload) return null;

  const tried = new Set([model]);
  for (const candidate of await fallbackCandidates(model, retryPayload, FALLBACK_MAX)) {
    if (tried.has(candidate) || clientSignal?.aborted) continue;
    tried.add(candidate);
    log(`fallback on 429: ${model} -> ${candidate}`);
    let next;
    try {
      next = await attemptWithStaleRetry(auth, candidate, JSON.stringify({ ...retryPayload, model: candidate }));
    } catch (e) {
      log(`fallback attempt failed (${candidate}): ${e.message}`);
      continue;
    }
    if (next.ok) {
      // 标记来源：上层据此写响应头与账本字段（用户能看到「这条其实换了模型」）。
      next.fallbackFrom = model;
      next.fallbackModel = candidate;
      return { res: next, bodyText: null, upstreamStartedAt: upEnter };
    }
    // 候选失败：把体读掉，避免 keep-alive 连接处于不一致状态（同 callUpstream 的说明）。
    await next.text().catch(() => '');
  }
  return null;
}

async function callUpstream(bodyString, model, conversationId, clientSignal) {
  // 限流闸门（opt-in；默认关）。放在最前：超限的请求连凭据都不读、更不打上游。
  // 限流桶按调用方分（local / 各 client key）—— B2 凭据分层的一部分。
  await acquireRateSlot(clientSignal, requestScope.getStore()?.client || 'local');
  // 上游开始前的时刻戳（供端点计算 `X-WorkBuddy-Overhead-Ms`：
  // overhead = 上游请求发出前，桥自身做的前置处理耗时 —— 鉴权、读凭据、
  // payload 归一化、Anthropic→OpenAI 翻译。**不含限流排队**（那是我们主动
  // 让请求等的）也**不含上游等待**（那是上游的耗时）—— 口径精确、可复现。
  const upEnter = Date.now();

  // API-key mode needs no login file; supply a minimal endpoint/domain instead
  let auth = API_KEY
    ? { endpoint: EXPLICIT_ENDPOINT || 'https://copilot.tencent.com', domain: (EXPLICIT_ENDPOINT || '').includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn', access: '', refresh: '', expiresAt: 0 }
    : readStoredAuth();
  if (!API_KEY && auth.refresh && auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    if (next) auth = next;
  }

  const attempt = (a, useModel = model, useBody = bodyString) => {
    // WORKBUDDY_TIMEOUT_MS > 0 时给整个上游往返加超时（0/未设 = 不限，
    // LLM 长回答需要）；与客户端取消信号合并。
    const timeoutSignal = UPSTREAM_TIMEOUT_MS > 0 ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : null;
    const signal = clientSignal && timeoutSignal ? AbortSignal.any([clientSignal, timeoutSignal])
      : (clientSignal || timeoutSignal || undefined);
    return upstreamRequest(`${a.endpoint}${CHAT_PATH}`, {
      // useModel 默认是原模型；只有降级那一次会传入不同 id（body 也一并替换）
      headers: buildHeaders(a, useModel, conversationId),
      body: useBody,
      signal,
    }).then(shimResponse);
  };

  const attemptWithStaleRetry = async (a, useModel = model, useBody = bodyString) => {
    try {
      return await attempt(a, useModel, useBody);
    } catch (error) {
      // 复用的空闲连接被上游掐断（服务器先关）→ 换新连接重试一次。
      // 新连接必然不是 reused；首次连接就失败属于真故障，不重试。
      if (!clientSignal?.aborted && /ECONNRESET|socket hang up|EPIPE/i.test(String(error?.message || error?.code || ''))) {
        log('stale keep-alive socket, retrying once on a fresh connection');
        return attempt(a, useModel, useBody);
      }
      throw error;
    }
  };

  let res = await attemptWithStaleRetry(auth);
  if (!API_KEY && (res.status === 401 || res.status === 403) && auth.refresh) {
    const next = await refreshAuth(auth);
    if (next) { auth = next; res = await attemptWithStaleRetry(auth); }
  }

  // the gateway occasionally wraps a momentary upstream failure as 400 code 11133: retry idempotently
  /*
   * 非 2xx 的响应体必须**在这里读完**并随 `bodyText` 一起返回。
   *
   * 为什么：调用方拿到 `!up.ok` 后会 `bodyText ?? await up.text()`。
   * 而 `shimResponse.text()` 是**事件式**的（`res.on('data')` / `on('end')`）——
   * 只有在第一份数据到达**之前**挂上监听才收得全。若中途换过一次响应
   * （401 刷新重试、或 400-11133 重试），新响应的 `end` 很可能在调用方
   * 挂监听之前就已经派发过了，于是 `await up.text()` **永远不 resolve**，
   * 请求挂死且客户端只看到超时。
   *
   * 实测复现：上游先回 400（触发一次重试）再回 401 + 一段 HTML →
   * 桥在 25 秒后仍未响应（`tools/dev` 之外的独立脚本验证）。
   * 修法：在返回前就把体读出来，让调用方**不需要**再碰这个流。
   */
  const status = res.status;
  if (status !== 400 && (status < 200 || status >= 300)) {
    const text = await res.text().catch(() => '');
    /*
     * 429 降级链（opt-in）必须放在这里，而不是下面的函数末尾。
     *
     * 血泪教训：最初写在函数末尾，结果**永远不可达** —— 因为 429 是「非 400 且非 2xx」，
     * 会被上面这条 if 直接 return 掉。表现为「降级代码在、日志也在、就是不生效」，
     * 排查时极易误以为是候选模型没选出来（实际连分支都没进）。
     * 现在放在唯一的 429 出口处：既能拿到已经读好的 bodyText，也不会有第二条路径绕过。
     */
    if (FALLBACK_ON_429 && FALLBACK_MAX > 0 && status === 429) {
      const fellBack = await tryFallbackOn429({
        auth, model, bodyString, conversationId, clientSignal, upEnter, attemptWithStaleRetry,
      });
      if (fellBack) return fellBack;
    }
    return { res, bodyText: text, upstreamStartedAt: upEnter };
  }

  /*
   * 400 重试循环。有两类上游 400 可以重试；其余一律照原样透传：
   *   - `11133`：网关把瞬时的上游故障包成 400（原有行为，退避 1/4/10/25 秒）。
   *   - `11-128`：`Illegal API invocation from an unapproved channel`。
   *
   * ⚠️ **不要用 `JSON.parse(text).code === 11-128` 判断**：
   *   1. 上游这个错误体的 `code` 是**裸的 `11-128`**（既不是字符串也不是单个数字），
   *      严格 JSON 解析会直接抛错 —— 实测 2026-10-22 抓到的原文就是
   *      `{"code":11-128,"msg":…}`，最小字面量 `{"code":11-128}` 必然 parse 失败。
   *   2. 即使解析成功，`code === 11-128` 在 JS 里是**减法**（等于 `-117`），
   *      与上游语义无关；测试夹具里写 `code: 11-128` 也会静默变成 -117。
   * 因此按**原始文本**匹配错误码：上游无论写成 `"11-128"`、`11-128` 还是别的
   * 引号形式都能命中。11133 同理（它是正常数字，文本匹配同样成立）。
   */
  const codeOf = (raw) => {
    const m = /"code"\s*:\s*"?(-?\d+(?:-\d+)?)"?/.exec(String(raw || ''));
    return m ? m[1] : '';
  };
  let transientRetries = 0;
  let channelRetries = 0;
  while (res.status === 400) {
    const text = await res.text();
    const code = codeOf(text);
    const transient = code === '11133';
    const channelBlocked = code === '11-128';
    if (!transient && !channelBlocked) return { res, bodyText: text, upstreamStartedAt: upEnter };
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    let delay;
    if (transient) {
      if (transientRetries >= TRANSIENT_400_DELAYS.length) return { res, bodyText: text, upstreamStartedAt: upEnter };
      delay = TRANSIENT_400_DELAYS[transientRetries];
      transientRetries += 1;
      log(`transient 400 (11133), retry ${transientRetries}`);
    } else {
      if (channelRetries >= CHANNEL_BLOCK_DELAYS.length) return { res, bodyText: text, upstreamStartedAt: upEnter };
      delay = CHANNEL_BLOCK_DELAYS[channelRetries];
      channelRetries += 1;
      log(`channel-verification 400 (11128), retry ${channelRetries}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    if (clientSignal?.aborted) return { res, bodyText: text, upstreamStartedAt: upEnter };
    res = await attemptWithStaleRetry(auth);
    // 重试后的响应若不再是 400/2xx，同样要在这里把体读掉（见上面的说明）
    if (res.status !== 400 && (res.status < 200 || res.status >= 300)) {
      const t = await res.text().catch(() => '');
      return { res, bodyText: t, upstreamStartedAt: upEnter };
    }
  }
    return { res, bodyText: null, upstreamStartedAt: upEnter };
}

// ── SSE parsing and aggregation (non-streaming clients only) ─────────────
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas || []) {
    const idx = d.index ?? acc.length;
    acc[idx] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } };
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

async function aggregateStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '', finishReason = null, usage = null, id = null, model = null, created = null;
  /*
   * 成功解析出的 SSE 数据块数。
   *
   * 为什么需要它：上游回 **HTTP 200 但不是 SSE**（典型：网关把错误包成 200 的
   * HTML）时，这个函数会安静地返回一个「content 为空」的聚合结果 —— 调用方原先
   * 无条件记 `ok: true` 并回 200，用户拿到的是「结构完整但没内容」的成功响应，
   * 账本也记成功。**静默错数据**比报错难查得多。
   * `parsed === 0` 就是「这一坨根本不是 SSE」，据此按失败处理。
   */
  let parsed = 0;
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      parsed += 1;
      id ??= j.id; model ??= j.model; created ??= j.created;
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (d.tool_calls) mergeToolCallDelta(toolCalls, d.tool_calls);
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    parsed,
    id: id || `chatcmpl-${trace().slice(0, 24)}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 上游 usage → 本地账本字段。
 *
 * **必须留在模块级**：OpenAI 的 `/v1/chat/completions` 与 Anthropic 的
 * `/v1/messages` 两条协议路径都要用它。原先它定义在 chat/completions 的
 * 块作用域里，Anthropic 路由根本看不到，一调就是 `ReferenceError`。
 */
const usageOf = (u) => ({
  promptTokens: Number(u?.prompt_tokens) || 0,
  completionTokens: Number(u?.completion_tokens) || 0,
  // 上游在 usage 里回报本次实际扣减的积分，一并记进本地账本（只记数字）
  ...(typeof u?.credit === 'number' ? { credit: u.credit } : {}),
});

// ── Anthropic Messages API 兼容层（POST /v1/messages）─────────────────────
/**
 * 为什么需要这一层
 * ----------------
 * Claude Code 说的是 Anthropic 的 Messages 协议，**不是** OpenAI 的
 * chat/completions。两者在请求结构、响应结构、流式事件格式上都不一样，
 * 光把 Base URL 指过来是接不上的（会直接 404，因为桥原先没有这个路由）。
 *
 * 这一层做两件事：把 Anthropic 请求翻译成上游认的 OpenAI 请求；再把上游的
 * OpenAI 流翻译回 Anthropic 的事件流。翻译是**有损但语义等价**的，下面每处
 * 不可逆的映射都单独注明了原因。
 *
 * 上游只支持流式，所以这里统一走上游流式：`stream:false` 的客户端先收完
 * 再聚合成一个完整 message。
 */

/**
 * 模型名解析。Claude Code 会发 `claude-sonnet-4-...` 这类名字，上游没有这些 id。
 *
 * 顺序：① 精确命中上游目录就原样用（允许用 `ANTHROPIC_MODEL` 指定真实模型）；
 * ② 带 haiku/flash 这类「小快」字样的走 fast 模型（Claude Code 拿它跑标题生成、
 * 文件摘要这类后台活，用大模型纯属浪费额度）；③ 其余走默认模型。
 *
 * 默认取 `glm-5.3` 而不是桥的通用默认 `deepseek-v4.1-flash`：Claude Code 是
 * Agent，全程依赖工具调用，而 `glm-5.3` 是实测 tool_calls 最稳的一个。
 */
const ANTHROPIC_MODEL = process.env.WORKBUDDY_ANTHROPIC_MODEL || 'glm-5.3';
const ANTHROPIC_FAST_MODEL = process.env.WORKBUDDY_ANTHROPIC_FAST_MODEL || 'glm-5.3-flash';

function resolveAnthropicModel(requested) {
  const name = typeof requested === 'string' ? requested : '';
  if (name && catalogCache.models.some((m) => m.id === name)) return name;
  if (name && /haiku|flash|mini|small|fast/i.test(name)) return ANTHROPIC_FAST_MODEL;
  return ANTHROPIC_MODEL;
}

/** Anthropic 的 stop_reason 与 OpenAI 的 finish_reason 不是一一对应，需显式映射。 */
function anthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

/** 上游给的 arguments 是字符串形式的 JSON；模型偶尔吐半截，别让整个请求炸掉。 */
function safeJsonParse(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    // Anthropic 要求 tool_use.input 必须是对象
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/**
 * 零依赖的 token 估算（如实标注"估算"）。
 *
 * 上游没有任何 tokenizer 端点；这里用经验公式：ASCII ≈ 4 字符/token，
 * 非 ASCII（CJK 等）≈ 1 token/字 —— 比原来的"字节数 / 4"准得多（UTF-8 中文
 * 是 3 字节/字，按字节估会把中文算少一半以上）。Claude Code 用它显示上下文
 * 占用，**量级正确**即可。
 */
function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x7f) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/**
 * 估算一条 /v1/messages 请求的输入 token：system + messages + tools 的文本面。
 * 供 `POST /v1/messages/count_tokens` 与流式首帧的 input_tokens 兜底使用。
 */
function estimateRequestTokens(body) {
  let total = estimateTokens(anthropicSystemText(body?.system));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    total += 4; // 每条消息的角色与分隔开销（Anthropic 实测约 3–5）
    const c = m?.content;
    if (typeof c === 'string') {
      total += estimateTokens(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') total += estimateTokens(part.text);
        if (typeof part.content === 'string') total += estimateTokens(part.content); // tool_result
        else if (part.content && typeof part.content === 'object') total += estimateTokens(JSON.stringify(part.content));
        if (part.input && typeof part.input === 'object') total += estimateTokens(JSON.stringify(part.input)); // tool_use
      }
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const t of tools) {
    total += estimateTokens(t?.name) + estimateTokens(t?.description) + estimateTokens(JSON.stringify(t?.input_schema || {}));
  }
  return Math.max(1, total);
}

/** Anthropic 的 `system` 可以是字符串，也可以是 `[{type:'text',text}]`。 */
function anthropicSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Anthropic 的 tool_result.content 同样有字符串 / 块数组两种形态。 */
function anthropicToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/** Anthropic 的 image block → OpenAI 的 image_url（base64 走 data URI）。 */
function anthropicImageToOpenAI(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Anthropic messages → OpenAI messages。
 *
 * 三处结构性差异必须处理，否则上游一定拒：
 * 1. Anthropic 的 system 是**顶层字段**，OpenAI 是**首条消息**；而且上游要求
 *    首条必须是 system，所以即使 system 为空也要补一条占位。
 * 2. Anthropic 把工具调用和结果**混在 content 块数组**里（`tool_use` /
 *    `tool_result`），OpenAI 拆成 assistant.tool_calls + 独立的 `role:"tool"` 消息。
 * 3. 顺序不能乱：带 tool_calls 的 assistant 消息必须排在对应 `role:"tool"`
 *    消息之前，否则上游会以「tool 消息没有前置调用」拒绝。
 */
function anthropicToOpenAIMessages(body) {
  const out = [];
  const sys = anthropicSystemText(body.system);
  out.push({ role: 'system', content: sys || 'You are a helpful assistant.' });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    // 纯字符串是最常见的形态，直接透传
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts = [];       // OpenAI content 数组（text / image_url）
    const toolCalls = [];   // assistant 的 tool_calls
    const toolResults = []; // user 的 tool_result → 独立的 role:"tool" 消息

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const img = anthropicImageToOpenAI(block);
        if (img) parts.push(img);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${trace().slice(0, 20)}`,
          type: 'function',
          function: { name: block.name || '', arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: anthropicToolResultText(block.content),
        });
      }
    }

    if (role === 'assistant') {
      const m = { role: 'assistant' };
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      // 有 tool_calls 时 content 允许为 null（OpenAI 语义就是如此）
      m.content = text || (toolCalls.length ? null : '');
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // tool_result 逻辑上先于本轮的新内容
      for (const tr of toolResults) out.push(tr);
      if (parts.length) {
        out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      } else if (!toolResults.length) {
        out.push({ role: 'user', content: '' });
      }
    }
  }
  return out;
}

/**
 * Anthropic tools → OpenAI tools。`input_schema` 与 `parameters` 是同一份
 * JSON Schema，只是字段名不同。
 */
function anthropicToolsToOpenAIMessages(tools) {
  if (!Array.isArray(tools)) return null;
  const out = tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  return out.length ? out : null;
}

/**
 * Anthropic: {type:'auto'} | {type:'any'} | {type:'tool',name} | {type:'none'}
 * OpenAI:    'auto' | 'required' | {type:'function',...} | 'none'
 *
 * 这里**直接产出字符串**：上游只收字符串，虽然 normalizePayload 会兜底把对象
 * 转掉，但没必要多绕一圈。
 */
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return null;
  if (tc.type === 'any' || tc.type === 'tool') return 'required';
  if (tc.type === 'auto' || tc.type === 'none') return tc.type;
  return null;
}

/** 聚合后的 OpenAI 响应 → Anthropic message 对象（非流式）。 */
function openAIToAnthropicMessage(agg, model) {
  const choice = (agg.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls || []) {
    if (!tc) continue;
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${trace().slice(0, 24)}`,
      name: tc.function?.name || '',
      input: safeJsonParse(tc.function?.arguments),
    });
  }

  return {
    id: `msg_${String(agg.id || trace()).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(agg.usage?.prompt_tokens) || 0,
      output_tokens: Number(agg.usage?.completion_tokens) || 0,
    },
  };
}

/**
 * 把上游的 OpenAI SSE 流翻译成 Anthropic 的 SSE 事件流，直接写进 `res`。
 *
 * Anthropic 的流比 OpenAI 严格得多：它用 `event:` 行标注事件类型，而且
 * **每个内容块必须有 start / delta… / stop 三件套配对**，块索引单调递增且
 * 不复用。少任何一对，Claude Code 会判定流损坏并中断会话。
 *
 * 文本块与工具块共用一个索引空间：文本先来就占 0、工具接着占 1，反之亦然。
 *
 * 返回 `{ finishReason, usage, streamError }` 供调用方记账。
 */
async function relayAnthropicStream(up, res, model, estInputTokens) {
  const write = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  // 头要立刻发出去（Node 的 writeHead 只登记，等首次 write）。理由见 OpenAI 路径同处注释。
  res.flushHeaders?.();

  /*
   * SSE 心跳：Anthropic 路径同样会长时间静默（上游预填充 / 长时间 reasoning）。
   * 用注释帧而不是事件帧：注释不产生 message 事件，Claude Code 的 SSE 解析器会
   * 忽略它 —— 绝不伪造 `ping` 事件，也不插进 content_block 的 start/stop 配对里
   * （那会让客户端判定流损坏）。
   */
  let heartbeat = null;
  if (SSE_HEARTBEAT_MS > 0) {
    heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); heartbeat = null; return; }
      try { res.write(': keepalive\n\n'); } catch { /* 客户端已断，外层统一收尾 */ }
    }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }
  const disarmHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

  write('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${trace().slice(0, 32)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // input_tokens 在流开始时上游还没给，先用字符数粗估；真实值在
      // message_delta 里补正。给 0 会让 Claude Code 的上下文占用显示失真。
      usage: { input_tokens: estInputTokens, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let openKind = null; // null | 'text' | 'tool'
  const toolSlots = new Map(); // 上游 tool_calls 的 index -> { blockIndex, id, name }

  const closeOpen = () => {
    if (openKind !== null) {
      write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      openKind = null;
    }
  };

  let finishReason = null;
  let usage = null;
  let streamError = null;
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let j; try { j = JSON.parse(raw); } catch { continue; }
        if (j.usage) usage = j.usage;
        const choice = (j.choices || [])[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};

        if (typeof d.content === 'string' && d.content) {
          if (openKind !== 'text') {
            closeOpen();
            blockIndex++;
            openKind = 'text';
            write('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          write('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: d.content },
          });
        }

        for (const tc of d.tool_calls || []) {
          if (!tc) continue;
          const upIdx = typeof tc.index === 'number' ? tc.index : 0;
          let slot = toolSlots.get(upIdx);
          if (!slot) {
            // 新工具块：必须先把上一个块关掉，索引才能前进
            closeOpen();
            blockIndex++;
            slot = {
              blockIndex,
              id: tc.id || `toolu_${trace().slice(0, 24)}`,
              name: tc.function?.name || '',
            };
            toolSlots.set(upIdx, slot);
            openKind = 'tool';
            write('content_block_start', {
              type: 'content_block_start',
              index: slot.blockIndex,
              content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
            });
          } else if (tc.function?.name && !slot.name) {
            slot.name += tc.function.name;
          }
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            write('content_block_delta', {
              type: 'content_block_delta',
              index: slot.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  } catch (e) {
    streamError = e;
    log('anthropic stream interrupted', e.message);
  } finally {
    // 必须先停心跳再 end：否则最后一帧可能落在 message_stop 之后，客户端判定流损坏
    disarmHeartbeat();
  }

  closeOpen();
  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
    usage: {
      input_tokens: Number(usage?.prompt_tokens) || estInputTokens,
      output_tokens: Number(usage?.completion_tokens) || 0,
    },
  });
  write('message_stop', { type: 'message_stop' });
  res.end();
  return { finishReason, usage, streamError };
}

// ── Usage accounting (local only) ────────────────────────────────────────
/**
 * 本地请求账本（`bridge/usage.jsonl`）。**只记元数据，从不记对话内容**：
 * 时间、模型、是否流式、耗时、token 数、扣分；失败时记状态码与错误码。
 *
 * 成功与失败写同一个文件，靠 `ok` 区分——旧记录没有该字段，一律按成功处理。
 * 把失败也记下来是必要的：否则「某个模型调不通」在控制台上完全不可见，
 * 只能去翻原始日志。
 *
 * **每条记录带 `acct`（账号标签）**：多账号时两个桥（不同端口、不同登录文件）
 * 跑的是同一个脚本、写的是**同一个账本文件**（见 usageFile()），所以不记账号
 * 就分不清「这 375 分是谁花的」—— 实测两个账号的 /v1/usage 汇总完全相同，
 * 因为读的本来就是同一份文件。
 *
 * **保留策略：按账号各留 MAX_USAGE_LINES_PER_ACCOUNT 条**，某个账号超出就把它
 * 自己砍到一半。按账号而不是全局，是因为全局上限会被**吵的那个账号吃掉**：
 * 国际版免费、调用频繁，它一超限就把国内版的历史一起冲掉。
 * 旧记录没有 `acct`，展示时归 {@link UNKNOWN_ACCOUNT} 一桶，但**不参与裁剪**
 * （它们不会增长，套上限只会在升级瞬间误伤已有历史，见 accountOfLine）。
 */
const MAX_USAGE_LINES_PER_ACCOUNT = 1000;
let usageLines = null;
/**
 * 上次与账本文件同步后的**指纹**（字节数 + mtimeMs），用来发现「文件被外部改动」。
 *
 * 为什么不能只用字节数比大小：镜像可能是空的（`usageBytes === 0`，例如外部刚把
 * 文件删掉、或进程还没记过任何账），这时 `size < usageBytes` 恒为 false ——
 * 于是外部随后写进来的**任何**文件都不会触发重载，镜像会永久性地读成空。
 * 实测这条在「删除文件 → 外部写入新账本」的序列里会真实发生（D4-E7）。
 * 带上 mtime 后，"外部换了个文件" 与 "我们自己刚追加过" 就能区分开。
 */
let usageBytes = 0;
let usageMtimeMs = -1;
/** 账本位置：与脚本同目录（即 bridge/），可用环境变量覆盖。 */
function usageFile() {
  return process.env.WORKBUDDY_USAGE_FILE
    || join(dirname(fileURLToPath(import.meta.url)), 'usage.jsonl');
}

/** 读文件指纹；文件不存在时返回 { size: 0, mtimeMs: -1 }。 */
function usageStat(file) {
  try {
    const st = existsSync(file) ? statSync(file) : null;
    return st ? { size: st.size, mtimeMs: st.mtimeMs } : { size: 0, mtimeMs: -1 };
  } catch {
    return { size: 0, mtimeMs: -1 };
  }
}

function loadUsageLines(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  usageLines = text.split('\n').filter(Boolean);
  usageBytes = Buffer.byteLength(text);
  usageMtimeMs = usageStat(file).mtimeMs;
}

/**
 * 错误摘要：单行、截断。
 *
 * 上游的错误消息是协议层的（`code` + 一句说明），**不含用户输入**；这里再截一刀
 * 防止异常里夹带整段 HTML（APISIX 的 401 就是一大段 HTML）。
 */
function shortError(text, limit = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 确保内存镜像与文件一致，必要时重新加载。
 *
 * 抽成独立函数是因为它现在有**两个**调用方：`recordRequest`（写之前要确认
 * 镜像没被外部清空）和 `readUsageRows`（读之前同样要确认）。这段判断是语义
 * 核心，复制成两份迟早会分叉。
 *
 * **判据：文件指纹与上次同步时不一致就重载。** 指纹 = 字节数 + mtimeMs。
 *
 * 演进过程（两次都栽在"只比大小"上，记下来免得再犯）：
 *   - 最初只判 `size < usageBytes`。这能覆盖「清空账本」（0 字节）与「截断」，
 *     但**镜像为空时失效**：`usageBytes === 0` 意味着 `size < 0` 恒为 false，
 *     外部此后写的任何文件都不会被看到。实测 D4-E7 就是这样读成空账本的
 *     （外部删除文件 → 换入一个非空文件 → 桥永远读 0 条），而 HEAD 的全量
 *     重读没有这个问题。
 *   - 补 `mtimeMs < usageMtimeMs` 也没救：外部**新写**的文件 mtime 只会变大。
 *
 * 所以改成「指纹不等就重载」。这样「删除→重建」「换成另一个文件」「清空」
 * 全都能覆盖，代价只是我们自己每次 append 后要刷新一次指纹
 * （见 recordRequest 末尾），否则会把自己的写入误判成外部改动、白重载一次。
 *
 * `usageLines === null`（进程刚起，一次请求都还没记过）也走这里初始化：
 * 这正是 D4 之前缺失的路径 —— 冷启动后第一个 `/v1/usage` 请求读不到内存副本，
 * 只能回磁盘，改成镜像优先之后必须有地方把它建起来。
 */
function syncUsageMirror(file) {
  if (usageLines === null) {
    loadUsageLines(file);
    return;
  }
  const { size, mtimeMs } = usageStat(file);
  if (size !== usageBytes || mtimeMs !== usageMtimeMs) loadUsageLines(file);
}

/**
 * 从账本行里取出账号标签。
 *
 * 返回 `null` 表示**这一行根本没有 `acct` 键**（本次改动之前写入的旧记录）。
 * 与"标签值为 unknown"是两回事，必须分开：旧记录是一个**只减不增的冻结集合**
 * （新记录永远带 acct 键），所以它们不能被当成一个"会持续增长的账号"去套上限 ——
 * 否则升级后第一次记账就会把用户积攒的历史砍掉一大截。
 *
 * 实测过这个坑：升级前账本已有 1204 行旧记录，若把它们全归入一个受 1000 上限
 * 约束的桶，第一次新请求就会触发裁剪，**当场丢掉 705 行**用户历史。
 */
function accountOfLine(line) {
  try {
    const row = JSON.parse(line);
    const a = row && row.acct;
    return typeof a === 'string' && a ? a : (row && 'acct' in row ? UNKNOWN_ACCOUNT : null);
  } catch {
    // 半截行 / 非 JSON：归入旧记录那类（无法归因），同样不进上限桶
    return null;
  }
}

/**
 * 按账号裁剪账本：每个账号最多 MAX_USAGE_LINES_PER_ACCOUNT 条，某个账号超出就
 * **把它自己**砍到一半。
 *
 * 与旧的"全局 2000 条一起砍"的关键差别：旧策略下，调用频繁的那个账号一超限，
 * 另一个账号的历史**跟着一起被砍**（因为砍的是整个数组的前一半）。多账号时这
 * 等于"吵的那个把安静的挤掉"。现在各账号独立计数，互不牵连。
 *
 * **没有 `acct` 的旧记录不参与裁剪**（见 {@link accountOfLine}）：它们是冻结的
 * 历史，不会增长，给它们套上限只会在升级瞬间误伤用户已有的数据。文件总行数
 * 因此上界 = 旧记录数 + 各账号上限之和，仍是有限的。
 *
 * 返回 `{ trimmed, removed }`；`trimmed === false` 表示没动过，调用方据此决定
 * 是否重写整个文件（避免每次记账都重写上千行）。
 */
function trimUsageByAccount() {
  /*
   * **快速路径**：总行数不超过单账号上限时，任何账号都不可能超限
   * （某账号的条数 ≤ 总行数 ≤ 上限），直接返回。
   *
   * 为什么值得加这一行：旧实现只判 `usageLines.length > MAX`，是 O(1)；
   * 而按账号裁剪必须**逐行解析 JSON** 才能知道每行属于谁，是 O(n)。这段代码
   * 跑在**每一次记账**的关键路径上（每个请求一次），实测 1400+ 行时约 1.2ms。
   * 有了这道闸，账本还小的用户（绝大多数）回到 O(1)。
   */
  if (usageLines.length <= MAX_USAGE_LINES_PER_ACCOUNT) return { trimmed: false, removed: 0 };

  const byAccount = new Map();
  for (let i = 0; i < usageLines.length; i += 1) {
    const acct = accountOfLine(usageLines[i]);
    if (acct === null) continue; // 旧记录：冻结，永不裁剪
    const list = byAccount.get(acct);
    if (list) list.push(i); else byAccount.set(acct, [i]);
  }

  const drop = new Set();
  for (const [, indexes] of byAccount) {
    if (indexes.length <= MAX_USAGE_LINES_PER_ACCOUNT) continue;
    // 保留**最近一半**（indexes 天然按写入顺序递增，取尾部即最新）
    const keepFrom = indexes.length - Math.floor(MAX_USAGE_LINES_PER_ACCOUNT / 2);
    for (let k = 0; k < keepFrom; k += 1) drop.add(indexes[k]);
  }
  if (drop.size === 0) return { trimmed: false, removed: 0 };

  usageLines = usageLines.filter((_, i) => !drop.has(i));
  return { trimmed: true, removed: drop.size };
}

function recordRequest(entry) {
  try {
    // 调用方归因（B2 凭据分层）： ALS 里带着本次请求的 client id（local 或
    // key 哈希前 8 位）—— 桥不可用时静默跳过，不影响记账主流程。
    const scope = requestScope.getStore();
    const client = scope?.client;
    if (client) entry = { ...entry, client };
    // 推理档位：同样从 ALS 取，这样**所有**记账点（含各种失败早退）都自动带上，
    // 不必逐处传参。空串 = 本次没发 reasoning_effort（不写进账本，保持行紧凑）。
    const effort = scope?.effort;
    if (effort) entry = { ...entry, effort };
    /**
     * **错误原文在这里统一截断**，不依赖调用方自觉。
     *
     * 为什么要收口在这里：上游失败时可能是**整段 HTML**（实测 APISIX 的 401 回
     * 4 KB HTML），原样落盘会让账本行膨胀、CSV 导出被换行/长度撑爆，控制台的
     * 「最近请求」也会刷屏。读侧（recentRequests/summarizeUsage）虽然也调
     * shortError，但**账本文件本身**会先被污染 —— 那份数据没有第二份副本。
     *
     * 单一收口点 = 以后新增任何记账调用方都自动受保护，不必记得截断。
     */
    const normalized = entry && typeof entry.error === 'string'
      ? { ...entry, error: shortError(entry.error) }
      : entry;
    const file = usageFile();
    syncUsageMirror(file);

    // acct 放在最前（t 之后）：同一账号的记录连续可读，人工 tail 账本时一眼能
    // 看出这段是谁的。显式传入的 acct 优先（测试/特殊调用方可覆盖）。
    const line = JSON.stringify({ t: Date.now(), acct: ACCOUNT_LABEL, ...normalized });
    usageLines.push(line);
    let { trimmed, removed } = trimUsageByAccount();
    if (trimmed) {
      /*
       * **重写前先以磁盘为准重建。**
       *
       * 为什么必须这样：多账号时**两个桥进程写同一个文件**，而截断是"整份重写"。
       * 从上次 syncUsageMirror 到这次 rewrite 之间，另一个桥可能已追加了若干行 ——
       * 直接拿内存镜像重写会把它们**永久抹掉**（那些行只存在对方的内存里）。
       *
       * 先读盘、再补回自己这条，丢数据的窗口就从"整个请求处理过程"缩到
       * "读盘到 rename 之间"这一瞬。残留窗口无法靠单文件原子写消除（要跨进程
       * 锁），但已压到"极端巧合下丢一行用量"，与旧实现同级。
       */
      let disk = null;
      try { disk = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* 读不到就退回内存镜像 */ }
      if (disk && disk.length) {
        // 自己这条可能已在盘上（异常重试等），别写成两行
        usageLines = disk.includes(line) ? disk : [...disk, line];
      }
      const second = trimUsageByAccount();
      removed += second.removed;
      if (LOG) log(`usage ledger trimmed: -${removed} lines (per-account cap ${MAX_USAGE_LINES_PER_ACCOUNT})`);
      const text = `${usageLines.join('\n')}\n`;
      /*
       * **原子替换**：先写临时文件再 rename，不直接覆盖账本。
       *
       * 截断是「重写整份文件」，用 `writeFileSync(file, ...)` 的话，进程正好
       * 在这时被杀 / 断电就会留下半份文件 —— 丢的是**用户自己的用量历史**，
       * 而项目里没有第二份副本。同目录内 rename 是原子的（Windows 上也是），
       * 崩在任何一步都不会破坏原文件。
       *
       * 临时文件名**必须带 pid**：多账号时两个桥进程写同一个账本，而截断是
       * 各自独立触发的。用固定名 `${file}.tmp` 时两边可能同时写同一个临时文件
       * → 其中一个 rename 到半份内容（另一个还在写）。带上 pid 后各写各的。
       * 插件自己的偏好写入早就用了 `.tmp-${process.pid}`，这里对齐同一标准。
       *
       * 这也是项目自己的标准：`lib/dsh.mjs` 写 dsh 配置是先备份再写。
       * 账本这份数据比配置更没有第二份副本，不该比它更随意。
       */
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      usageBytes = Buffer.byteLength(text);
    } else {
      appendFileSync(file, `${line}\n`);
      usageBytes += Buffer.byteLength(`${line}\n`);
    }
    // 我们自己刚写过，指纹要跟上：否则下一次 syncUsageMirror 会把自己的写入
    // 当成「外部改动」而白重载一次（虽然结果正确，纯属浪费一次全文件解析）。
    usageMtimeMs = usageStat(file).mtimeMs;
  } catch (e) {
    log('usage record failed', e.message); // 记账失败绝不影响请求
  }
}

/** 清空账本：文件与进程内副本一起重置（DELETE /v1/usage）。 */
function resetUsageLedger() {
  const file = usageFile();
  writeFileSync(file, '');
  usageLines = [];
  usageBytes = 0;
  usageMtimeMs = usageStat(file).mtimeMs;
}

/**
 * 读账本原始行（解析失败的行直接跳过）。
 *
 * 优先用内存镜像（`usageLines`），不再每次 `readFileSync` 全文件 + 逐行
 * `JSON.parse`：这个函数被 `/v1/usage` 与 `/v1/requests` 调用，而控制台每 20 秒
 * 轮询一次、插件面板也按 interval 拉 —— 每次重读磁盘并解析 2000 行 JSON，
 * 纯属把事件循环堵上一段，而进程里本来就有一份同步的副本。
 *
 * 镜像里的行是**写入时的原样字符串**（`recordRequest` 只 push 不重排），所以
 * 解析结果与直接读文件**逐字节等价**；输出结构因此完全不变。
 *
 * 保留的唯一磁盘访问是 `syncUsageMirror` 里的 `statSync` —— 它撑住「外部清空
 * 账本」的语义，删掉就会让已清掉的历史被下一次整块重写带回来。
 */
function readUsageRows() {
  try {
    syncUsageMirror(usageFile());
    return usageLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r && typeof r.t === 'number');
  } catch {
    return [];
  }
}

/**
 * 最近请求明细（新的在前）。
 *
 * 只回元数据白名单字段——**不回请求体、不回消息内容**，即使账本里将来多写了字段
 * 也不会泄漏出去。
 */
function recentRequests(limit = 50) {
  const rows = readUsageRows();
  return rows.slice(-limit).reverse().map((r) => ({
    t: r.t,
    model: r.model || '',
    // 账号标签：面板/控制台用它区分"这次调用走的是哪个账号"。旧记录没有这个
    // 字段，回 unknown 而不是省略 —— 省略会让前端把 undefined 显示成空白，
    // 看起来像渲染坏了；unknown 至少是明确的一句话。
    acct: typeof r.acct === 'string' && r.acct ? r.acct : UNKNOWN_ACCOUNT,
    // 推理档位：本次请求下发的 reasoning_effort（没发就是空串）。
    // 面板「最近请求」用它显示"思考档位" —— 用户据此核对选择器里选的档位
    // 有没有真的发出去。
    effort: typeof r.effort === 'string' ? r.effort : '',
    stream: r.stream === true,
    ms: Number(r.ms) || 0,
    ok: r.ok !== false,
    ...(r.ok === false
      ? { status: Number(r.status) || 0, code: r.code ?? null, error: shortError(r.error) }
      : {}),
    ...(typeof r.promptTokens === 'number' ? { promptTokens: r.promptTokens } : {}),
    ...(typeof r.completionTokens === 'number' ? { completionTokens: r.completionTokens } : {}),
    ...(typeof r.credit === 'number' ? { credit: r.credit } : {}),
    /*
     * 降级来源：这条请求原本用的模型（本条的 `model` 是**实际服务**的那个）。
     * 不透传的话，面板上只会看到「m-alt-cheap 被调用了」，而用户点的是 m-primary ——
     * 排查「为什么回答风格变了 / 为什么这个模型花了钱」时完全对不上号。
     */
    ...(typeof r.fallbackFrom === 'string' && r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {}),
  }));
}

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * 必须与页面其它地方（「最近请求」用 getHours() 显示本地时间）同一时区口径。
 * `toISOString().slice(0,10)` 取的是 **UTC 日期**，UTC+8 下凌晨 00:00–07:59 的
 * 调用会被记进前一天，趋势图看起来「少了一天、多了一天」。
 */
function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区的小时键 `YYYY-MM-DD HH`。与 localDay() 同一套补零规则，**不用 UTC**——
 *  否则页面上的「今天 13 时」会和用户墙上时钟错位。 */
function localHour(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

/** 汇总用量：总数、按模型、按天（本地日期）、按小时（可选），外加失败统计（失败不计入 token / 扣分）。 */
function summarizeUsage(days = 7, opts = {}) {
  // 小时桶只在显式要求时才算：7/30 天视图用不到，白算 24 个桶没意义。
  const wantHours = opts.hours === true;

  // 小时视图把窗口**对齐到整点**（从当前整点往前推 23 小时，共 24 个整点桶）。
  // 若沿用 `now - 24h` 的滚动窗口，最旧那个桶只会统计到半截，图上合计就和
  // 面板的 total 对不上了——「图上的每个数字都能在面板里对上」是硬要求。
  // 不用小时桶时（wantHours=false）走原来的滚动窗口，既有语义完全不变。
  const hourAnchor = (() => { const a = new Date(); a.setMinutes(0, 0, 0); return a.getTime(); })();
  const since = wantHours ? hourAnchor - 23 * 3600000 : Date.now() - days * 86400000;

  const rows = readUsageRows();

  const byModel = new Map();
  const byDay = new Map();
  const byHour = wantHours ? new Map() : null;
  /**
   * 按账号分桶。多账号时两个桥写同一个账本，只有这里拆开才能回答
   * "国际版花了多少分" —— 否则看到的是两个账号的合计（旧版正是如此，
   * 实测两个端口返回完全相同的 total）。
   */
  const byAccount = new Map();
  /**
   * 按推理档位分桶（`high`/`medium`/`low`/未发）。
   *
   * 回答"开 high 到底比不开发多花多少 token / 积分" —— 这是用户调那个旋钮时
   * 唯一想知道的事，而原来账本连档位都没记。空档位归 `(默认)`：那是"没下发
   * reasoning_effort"，交给上游默认，与显式选 low 是两回事，不能合并。
   */
  const byEffort = new Map();
  const failures = [];
  // creditCalls 单独计数：上游**并非每次**都回报 credit。不区分「回报了 0」和
  // 「没回报」的话，两者在页面上只能显示成同一个「—」，看起来像统计坏了。
  // 另外上游是**两位小数**量化，几十 token 的小请求真实扣分就是 0.00——
  // 那是「这次没扣到」，不是「没数据」。
  let total = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0, failed: 0 };

  for (const r of rows) {
    if (r.t < since) continue;
    const acct = typeof r.acct === 'string' && r.acct ? r.acct : UNKNOWN_ACCOUNT;

    // 失败的请求单独归类：它没有 token、没有扣分，混进成功率会误导
    if (r.ok === false) {
      total.failed += 1;
      const a = byAccount.get(acct) || { account: acct, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0, failed: 0 };
      a.failed += 1;
      byAccount.set(acct, a);
      failures.push({
        t: r.t,
        model: r.model || '',
        acct,
        effort: typeof r.effort === 'string' ? r.effort : '',
        stream: r.stream === true,
        ms: Number(r.ms) || 0,
        status: Number(r.status) || 0,
        code: r.code ?? null,
        error: shortError(r.error),
      });
      continue;
    }

    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    const hasCredit = typeof r.credit === 'number';
    const cr = hasCredit ? r.credit : 0;

    total.calls += 1;
    total.promptTokens += pt;
    total.completionTokens += ct;
    total.ms += Number(r.ms) || 0;
    if (hasCredit) { total.credit += cr; total.creditCalls += 1; }

    const m = byModel.get(r.model)
      || { model: r.model, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0 };
    m.calls += 1; m.promptTokens += pt; m.completionTokens += ct; m.ms += Number(r.ms) || 0;
    if (hasCredit) { m.credit += cr; m.creditCalls += 1; }
    byModel.set(r.model, m);

    const day = localDay(r.t);
    const d = byDay.get(day) || { day, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
    d.calls += 1; d.promptTokens += pt; d.completionTokens += ct;
    if (hasCredit) { d.credit += cr; d.creditCalls += 1; }
    byDay.set(day, d);

    const a = byAccount.get(acct)
      || { account: acct, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, credit: 0, creditCalls: 0, failed: 0 };
    a.calls += 1; a.promptTokens += pt; a.completionTokens += ct; a.ms += Number(r.ms) || 0;
    if (hasCredit) { a.credit += cr; a.creditCalls += 1; }
    byAccount.set(acct, a);

    // 推理档位：空串 → '(默认)'（没下发 reasoning_effort，交给上游默认）
    const effortKey = typeof r.effort === 'string' && r.effort ? r.effort : '(默认)';
    const e = byEffort.get(effortKey)
      || { effort: effortKey, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
    e.calls += 1; e.promptTokens += pt; e.completionTokens += ct;
    if (hasCredit) { e.credit += cr; e.creditCalls += 1; }
    byEffort.set(effortKey, e);

    if (byHour) {
      const hour = localHour(r.t);
      const h = byHour.get(hour) || { key: hour, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 };
      h.calls += 1; h.promptTokens += pt; h.completionTokens += ct;
      if (hasCredit) { h.credit += cr; h.creditCalls += 1; }
      byHour.set(hour, h);
    }
  }

  // 浮点累加会攒出 0.6900000000000001 这种噪声，出接口前收一下
  const round4 = (n) => Math.round(n * 10000) / 10000;
  total.credit = round4(total.credit);
  for (const m of byModel.values()) m.credit = round4(m.credit);
  for (const d of byDay.values()) d.credit = round4(d.credit);
  for (const a of byAccount.values()) a.credit = round4(a.credit);
  for (const e of byEffort.values()) e.credit = round4(e.credit);

  // 补齐 24 个桶：没调用的整点也要出现（记 0），否则柱状图会跳变——
  // 空的那小时直接消失，看上去像时间轴缺了一段。
  let hours = null;
  if (byHour) {
    for (const h of byHour.values()) h.credit = round4(h.credit);
    hours = [];
    for (let i = 23; i >= 0; i -= 1) {
      const key = localHour(hourAnchor - i * 3600000);
      hours.push(byHour.get(key) || { key, calls: 0, promptTokens: 0, completionTokens: 0, credit: 0, creditCalls: 0 });
    }
  }

  return {
    windowDays: days,
    total,
    models: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    /**
     * 按账号拆分（调用多的在前）。
     *
     * `total` 是**合计**（保持既有契约不变，老消费方照旧），这里是它的分解 ——
     * 两者对得上（各账号之和 === total）。多账号用户靠它回答"国际版花了多少分"，
     * 而单账号用户看到的就是一行与自己 total 相同的数字，不增加困惑。
     */
    accounts: [...byAccount.values()].sort((a, b) => b.calls - a.calls),
    /**
     * 按推理档位拆分（调用多的在前）。
     *
     * 回答"开 high 比不开发多花多少 token / 积分"。空档位显示为 `(默认)`
     * （没下发 reasoning_effort，交给上游默认）—— 与显式选 low 不是一回事。
     */
    efforts: [...byEffort.values()].sort((a, b) => b.calls - a.calls),
    // 只有 ?hours=1 才带这个字段（checklist R1.4-4：按需计算，不白算）
    ...(hours ? { hours } : {}),
    // 最近 20 条失败，新的在前；页面用它做「为什么调不通」的第一手线索
    failures: failures.slice(-20).reverse(),
  };
}

// ── Model list ───────────────────────────────────────────────────────────
/**
 * 判定「明显不能对话」的内部模型 —— 完全基于上游目录字段，不猜哪些能调通。
 *
 * 实测样本：`nes-gf` 没有上下文窗口（maxInputTokens 缺省）、最大输出仅 256、
 * 也没有倍率，选中它必然失败。规则只排除**同时**满足「未声明上下文」与
 * 「声明了输出上限但低于 1024」的条目；字段缺失无法判定的一律保留。
 */
function isNonChatModel(m) {
  const ctx = Number(m?.maxInputTokens) || 0;
  const out = Number(m?.maxOutputTokens) || 0;
  return ctx <= 0 && out > 0 && out < 1024;
}

/**
 * 模型目录端点。两个端点返回的**不是同一份目录**：
 *
 *   /v2/enterprises/personal/models  具体模型（带 credits 倍率、tags）
 *   /v3/config                       产品配置，其中 models 是**档位/内部型号**
 *                                    （default-model、enhance-1.0 这类）
 *
 * 单用任何一个都会漏。客户端界面里能看到的具体模型（Deepseek-V4.1-Flash、
 * GLM-5.3、Kimi-K3…）来自前者；所以这里**两个都请求、按 id 合并**，
 * 具体模型优先，档位补在后面。
 */
const CATALOG_PATHS = ['/v2/enterprises/personal/models', '/v3/config'];

function catalogPathsFor() {
  return CATALOG_PATHS;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
// `upstreamModelCount` 初值必须是 0：冷启动时一个模型都没看过，此时任何请求都
// 该放行。它同时也是「模型预校验能不能启用」的唯一开关（见 preflightModelError）。
let catalogCache = { at: 0, models: [], shape: null, upstreamModelCount: 0 };
let catalogRefreshing = null;

/**
 * 触发一次目录刷新；同一时刻只允许一个在飞（并发调用复用同一个 Promise）。
 *
 * 返回 `{ ok, at }`：`ok` 表示这次确实把缓存更新了（失败或空目录都算 false）。
 * 手动刷新目录（`/v1/models?refresh=1`）要靠它判断「是不是白刷了一次」，
 * 以便如实告诉用户「刷新失败，仍显示旧缓存」。
 */
function refreshCatalog() {
  if (catalogRefreshing) return catalogRefreshing;
  catalogRefreshing = fetchCatalog()
    .then((r) => ({ ok: r.upstreamOk, at: catalogCache.at }))
    .catch((e) => {
      log('catalog fetch failed', describeFetchError(e));
      return { ok: false, at: catalogCache.at };
    })
    .finally(() => { catalogRefreshing = null; });
  return catalogRefreshing;
}

/**
 * 模型目录。
 *
 * 冷启动（还没有任何缓存）才同步抓一次；已有缓存一律**立刻返回**，过期只在
 * 后台刷新。控制台的健康探测超时是 4 秒，而抓目录要串行打两个上游端点——
 * 把这段延迟转嫁给调用方，会让「桥在跑」被误判成「桥没起」。
 */
async function upstreamCatalog() {
  if (!catalogCache.models.length) await refreshCatalog();
  else if (Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
  return catalogCache.models;
}

/**
 * 是否对请求里的 model 做目录预校验。`WORKBUDDY_SKIP_MODEL_PREFLIGHT=1` 关闭。
 *
 * 为什么必须留这个开关：上游目录**已知是不完整的** —— 上面 fetchCatalog 里
 * 「FEATURED 补全」那段注释记着同一件事（国际版能调 deepseek-v4.1-flash，
 * 目录端点里却没有它）。目录滞后于实际上线模型时，预校验会**误杀一个本来
 * 能用的模型**，这比「省一次上游往返」严重得多。所以：默认开（它能挡住的
 * 是绝大多数拼错 id 的调用），但必须给用户一个立刻能关掉它的出口。
 */
const MODEL_PREFLIGHT_ENABLED = process.env.WORKBUDDY_SKIP_MODEL_PREFLIGHT !== '1';

/**
 * 客户端送来的模型 id 长度上限。
 *
 * 为什么必须有：model 是**客户端可控**且会被**存进账本、写进日志、原样回显**
 * 的字段（400 响应体、/v1/requests、/v1/usage 的分组键）。实测：一个 30 万字符
 * 的 model 会让账本单行变成 30 万字符（文件 600KB/次）、让 400 响应体也是
 * 30 万字符、让 /v1/requests 回显 30 万字符 —— 反复打就能把磁盘/内存灌爆。
 * 真实模型 id 都很短（`deepseek-v4.1-flash` 19 字符），200 是极宽松的上限。
 */
const MAX_MODEL_ID_LEN = 200;

/**
 * 模型 id 会被当作 `X-Model-ID` 请求头发给上游，所以**必须只含 HTTP 头能承载的字符**。
 *
 * 这条约束与「模型在不在目录里」无关，因此**不能交给 `preflightModelError`** ——
 * 后者在目录没拿到时会直接放行（`upstreamModelCount === 0`）。而目录没拿到是常见状态：
 * 冷启动、上游目录接口抖动，以及用户按桥自己的提示设了
 * `WORKBUDDY_SKIP_MODEL_PREFLIGHT=1`。
 *
 * 不校验的后果（实测）：传 `模型-中文名` → Node 的 `http.request` 抛
 * `Invalid character in header content ["X-Model-ID"]` → 外层 catch 把它当未知故障，
 * 客户端收到 **500** 与一段内部报错。含 CR/LF 同理（Node 会拒绝，所以**不存在注入**，
 * 但用户拿到的仍是一个无法理解的 500）。
 *
 * 真实模型 id 都是可见 ASCII（见 `/v1/models`），所以这个约束挡不掉任何合法请求。
 */
const HEADER_SAFE_RE = /^[\x20-\x7e]*$/;

/**
 * chat 前的本地模型预校验。返回错误文本表示「该拒」，返回 null 表示「放行」。
 *
 * **启用条件只有一个：`catalogCache.upstreamModelCount > 0`** —— 即这一轮缓存里
 * 确实有模型是从上游目录端点拿到并留下的。
 *
 * 这里踩过一个真实的坑，记下来免得再犯：最初的判据是 `catalogCache.models.length
 * > 0`，看起来等价，其实完全不等价 —— `fetchCatalog` 末尾会用 FEATURED **无条件**
 * 补全，所以只要两个目录端点都**不返回 5xx**（404 / 字段改名 / 返回空数组 /
 * 模型全被 isNonChatModel 过滤掉…），缓存里也至少躺着 3 个精选模型。
 * 于是「桥对真实目录一无所知」被误判成「目录已知」，任何不在 FEATURED 里的
 * 真实可用模型都会被本地 400 拦下、一次上游都不打 —— 正是这条预校验本该
 * 避免的伤害。FEATURED 是**给客户端兜底的展示数据**，不是目录已知的证据。
 * 实测这条误杀在 404 / 空数组 / 字段改名 / 全被 supportsToolCall:false 挡掉
 * 四种常见故障下**全部可达**（只有 500 硬失败那条路径是对的）。
 *
 * 计数为 0（目录未知）时一律放行：我们不知道有哪些模型，就不该猜。
 *
 * 判定用 `catalogCache` 而不是 `upstreamCatalog()`：后者是 async 且可能触发一次
 * 抓取，放在请求路径上会把「校验」变成「多等几秒」。预校验的卖点就是省一次
 * 上游往返，不能自己先花掉一次。
 *
 * **FEATURED 仍然要在放行名单里**：`/v1/models` 在缓存为空时会退回 FEATURED
 * 定义（见那个端点的 `if (!catalog.length)` 分支），也就是桥刚刚才把这些 id
 * 告诉过客户端。若预校验只认缓存，就会出现「桥让你选 deepseek-v4.1-flash，
 * 转头又说这个模型不在目录里」的自相矛盾。所以放行判断是「在目录里 **或**
 * 在精选定义里」—— 桥对外承诺过的 id 一律不能自己否掉。
 * 注意这两件事是分开的：FEATURED 参与**放行**，但不参与**激活**预校验。
 */
function preflightModelError(model) {
  if (!MODEL_PREFLIGHT_ENABLED) return null;
  // 只在「真的从上游拿到过模型」时才敢拒。404 / 空数组 / 字段改名 / 全被过滤
  // 以及 5xx 硬失败，全都落在这个 0 上。
  if (!catalogCache.upstreamModelCount) return null;
  const catalog = catalogCache.models;
  if (!catalog.length) return null; // 理论上计数 > 0 时不会为空，兜一手
  if (typeof model !== 'string' || !model) return null; // 交给后面的默认值逻辑
  if (catalog.some((m) => m.id === model)) return null;
  if (FEATURED.some((f) => f.id === model)) return null;

  // 提示要**可操作**：光说「模型不存在」，用户下一步只能去猜。这里给出三个
  // 真实出口 —— 看完整目录（默认只回精选，具体模型在 ?all=1 里）、刷新目录
  // （缓存可能过期）、关掉预校验（目录可能漏了这个模型）。
  return `workbuddy-bridge: model "${model}" is not in the current catalog`
    + ` (${catalog.length} models). Check GET /v1/models?all=1 for the full list`
    + ' or GET /v1/models?refresh=1 if the catalog may be stale;'
    + ' set WORKBUDDY_SKIP_MODEL_PREFLIGHT=1 to forward unknown model ids anyway.';
}

/**
 * 上游目录的**能力误报**纠正表：`modelId → 该区域不支持的能力`。
 *
 * 为什么需要：上游目录会**误报**（与漏报相反的方向）。实测 `glm-5.3` 在国际版
 * 目录里 `supportsImages: true`，但把图片发过去会被**静默丢掉**：
 *
 *     国际版 (8791/8795)：glm-5.3 + 图片 → prompt_tokens=56（纯文本量），
 *                         模型回"I can't see any image"
 *     国内版 (8790/8793)：glm-5.3 + 图片 → prompt_tokens=194，正确描述图片
 *     对照 hy3（同区域）：国际版 prompt_tokens=340，正常看到图片
 *
 * 换协议路径（Anthropic）与换图片尺寸（400x300 / 800x600）结果一致 ——
 * 所以是**国际版网关侧**丢图，桥改不了。能做的是**如实反映**：目录里不声明
 * 这个能力，用户在 dsh 里就不会被允许贴一张注定被丢的图。
 *
 * 键是模型 id，值是**该区域不支持**的能力名（`images` / `reasoning`）。
 * 只有实测确认过的才写进来 —— 猜错会让用户少用一个本来能用的能力。
 */
const REGION_CAPABILITY_CORRECTIONS = {
  // 国际版网关不接收 glm-5.3 的图片（实测 2026-10-12）
  'workbuddy.ai': { 'glm-5.3': ['images'] },
  'codebuddy.ai': { 'glm-5.3': ['images'] },
};

/**
 * 取当前区域的"能力纠正表"。
 * @param {string} endpoint 上游 chat 端点（`auth.endpoint`）
 * @returns {Record<string, string[]>} modelId → 要压掉的能力
 */
function capabilityCorrections(endpoint) {
  const e = String(endpoint || '');
  for (const [host, table] of Object.entries(REGION_CAPABILITY_CORRECTIONS)) {
    if (e.includes(host)) return table;
  }
  return {};
}

async function fetchCatalog() {
  // 是否**真的**从上游取到了目录。下面 FEATURED 补全会让 merged 永远非空，
  // 所以不能靠「目录非空」判断这次抓取成没成功。
  let upstreamOk = false;
  // 上游目录里**真正进了缓存的**模型条数（即通过了下面那套过滤、且不是
  // FEATURED 补出来的）。这才是「桥认识哪些模型」的唯一硬证据：
  // upstreamOk 只说明「端点回了 models 数组」，一个空数组也算 true，
  // 而全被过滤掉的情况（非对话模型 / supportsToolCall:false）同样算 true。
  // 模型预校验只有在这个计数 > 0 时才敢启用（见 preflightModelError）。
  let upstreamModelCount = 0;
  // 是否遇到**硬失败**（上游 5xx / 网络异常 / 解析异常）。硬失败时绝不用半份
  // 目录顶掉完整缓存——否则用户的模型列表会凭空少几个，还看不出原因。
  let hardError = false;
  try {
    const auth = readStoredAuth();
    // 该区域的能力纠正表（实测确认过的上游误报，见 REGION_CAPABILITY_CORRECTIONS）
    const corrections = capabilityCorrections(auth.endpoint);
    const shape = { paths: catalogPathsFor(), sources: {}, model: [] };
    const merged = new Map();
    const promotions = new Map(); // modelId → 徽章文案（如「Free now」）

    for (const path of catalogPathsFor()) {
      try {
        const res = await fetch(`${auth.endpoint}${path}`, {
          headers: buildHeaders(auth, '', ''),
          signal: AbortSignal.timeout(8000),
        });
        // 5xx 是上游临时故障 → 硬失败；4xx / 端点没有 models 字段只算「这个
        // 区域没有这个端点」，不能因此让目录永远不更新。
        if (res.status >= 500) {
          hardError = true;
          shape.sources[path] = `HTTP ${res.status}`;
          continue;
        }
        const body = await res.json();
        // 包裹层级随端点而异，都试一遍
        const list = body?.data?.models
          ?? body?.data?.data?.models
          ?? body?.data?.Data?.models;
        if (!Array.isArray(list)) {
          shape.sources[path] = `no models (HTTP ${res.status})`;
          continue;
        }
        upstreamOk = true;
        shape.sources[path] = list.length;
        for (const m of list) {
          if (!m || typeof m.id !== 'string') continue;
          if (!merged.has(m.id)) merged.set(m.id, m);
        }
        if (!shape.model.length && list[0]) shape.model = Object.keys(list[0]);

        // 诊断：客户端界面里的模型可能有别的来源，把这些候选字段的类型记下来
        const d = body?.data || {};
        shape.dataKeys = Object.keys(d);
        // agents[].models 可能是另一个模型来源，值得单独看
        const ag = d.agents;
        if (Array.isArray(ag)) {
          const holders = ag.filter((a) => a && Array.isArray(a.models) && a.models.length);
          shape.agentsWithModels = holders.length;
          if (holders[0]) {
            shape.agentModelsSample = JSON.stringify(holders[0].models.slice(0, 4));
            shape.agentName = holders[0].name;
          }
        }
        const wl = d.fillToolCallContentModelWhitelist;
        if (Array.isArray(wl)) shape.whitelistSample = JSON.stringify(wl.slice(0, 6));

        for (const key of ['agents', 'fillToolCallContentModelWhitelist', 'productFeatures']) {
          const v = d[key];
          if (Array.isArray(v)) {
            const first = v.find((x) => x && typeof x === 'object');
            shape[key] = `array(${v.length})${first ? ` keys=${Object.keys(first).join('/')}` : ''}`;
          } else if (v && typeof v === 'object') {
            shape[key] = `object keys=${Object.keys(v).slice(0, 8).join('/')}`;
          } else {
            shape[key] = typeof v;
          }
        }

        // modelPromotions 是**促销标注**（badge/discount + modelIds），不是模型本身：
        // 它给已有模型挂上「Free now」这类徽章，别把它当模型加进目录。
        const promos = body?.data?.modelPromotions;
        if (Array.isArray(promos) && promos.length) {
          shape.sources[`${path}#modelPromotions`] = promos.length;
          if (!shape.promotionFields) shape.promotionFields = Object.keys(promos[0] || {});
          // schedule / hover / priority 也留档：时段促销（夜间/错峰）的正确性
          // 依赖它们。之前只挑 5 个字段，schedule 丢了 —— 排障时看 /health
          // 就能知道"为什么这个折扣此刻没生效"。
          shape.promotionDetail = promos.map((p) => ({
            badge: typeof p.badge === 'object' ? JSON.stringify(p.badge) : p.badge,
            // display: "activeOnly" = 仅激活时段显示徽章/折扣（上游语义）
            display: typeof p.badge === 'object' ? p.badge?.display : p.display,
            discount: p.discount,
            enabled: p.enabled,
            kind: p.kind,
            models: p.modelIds,
            ...(p.schedule !== undefined ? { schedule: p.schedule } : {}),
            ...(p.hover !== undefined ? { hover: p.hover } : {}),
            ...(p.priority !== undefined ? { priority: p.priority } : {}),
          }));
          for (const p of promos) {
            if (!p || typeof p !== 'object' || p.enabled === false) continue;
            /**
             * 时段判断：不在激活时段的促销**不参与定价与徽章**。
             *
             * 之前没有这一步，导致"夜间折扣 23:00–7:50"在白天也显示半价、
             * "错峰使用"的徽章全天挂着 —— 用户看到的价与实际扣的费对不上。
             * schedule 解析失败时 scheduleActive 按生效处理（保守，见其注释）。
             */
            if (!scheduleActive(p.schedule)) continue;
            // badge 可能是字符串，也可能是 {text,color} 这类对象
            let label = p.badge;
            if (label && typeof label === 'object') {
              label = label.text || label.label || label.name || label.value || '';
            }
            if (!label && typeof p.discount === 'number' && p.discount > 0) {
              label = `-${p.discount}%`;
            }
            if (typeof label !== 'string' || !label) continue;
            // discount.factor === 0（或 discountedCredits 为 "0x"）表示该模型当前免费
            const free = p.discount?.factor === 0
              || /^0x$/i.test(String(p.discount?.discountedCredits || ''));
            for (const mid of (Array.isArray(p.modelIds) ? p.modelIds : [])) {
              if (typeof mid === 'string') promotions.set(mid, { label, free, factor: p.discount?.factor });
            }
          }
        }
      } catch (e) {
        hardError = true;
        shape.sources[path] = `error: ${e.message}`;
      }
    }

    // 在这里定格「上游给了几个模型」：**必须**在下面 FEATURED 补全之前取，
    // 因为补全之后 merged 至少会有 3 条，那个数字就不再代表上游了。
    // 用 merged.size 而不是各端点 list 长度之和：merged 是去重后的 Map，
    // 重复 id 不会把计数灌水，正好等于「桥实际认识多少个上游模型」。
    upstreamModelCount = merged.size;

    // 目录接口**并不完整**：国际版能成功调用 deepseek-v4.1-flash，
    // 但它不出现在任何一个目录端点里。因此把已知可用、目录却漏掉的模型补进来
    // ——能不能用最终由上游决定，列出来才有机会被选到。
    for (const f of FEATURED) {
      if (merged.has(f.id)) continue;
      // 倍率**不猜**：本区域目录没给这个模型，就说明不知道该区域的定价。
      // 早前直接套用 FEATURED 的值（那是国内实测），会把国际版的免费模型
      // 标成 0.11——除非促销明确说它免费（factor 0），否则一律留空。
      const promo = promotions.get(f.id);
      merged.set(f.id, {
        id: f.id,
        name: f.name,
        maxInputTokens: f.context,
        maxOutputTokens: f.maxOutput,
        /*
         * **能力字段必须带上**：补全项拿不到上游的字段，不写就等于声明"不支持"。
         *   - `supportsImages`    → `images: !!m.supportsImages` 会是 false（贴不了图）
         *   - `supportsReasoning` → 目录不声明 → dsh 选择器没有「推理等级」下拉
         * 两个都在补全时漏过，实测各引发一次用户反馈。
         */
        ...(f.images ? { supportsImages: true } : {}),
        ...(f.supportsReasoning ? { supportsReasoning: true } : {}),
        ...(f.onlyReasoning ? { onlyReasoning: true } : {}),
        ...(promo?.free ? { credits: 0 } : {}),
        _supplemented: true,
      });
      shape.supplemented = [...(shape.supplemented || []), f.id];
    }

    const models = [...merged.values()];
    if (models.length && !hardError) {
      // 目录里排掉的东西登记下来，便于在 /health 的 upstreamShape 里追溯
      shape.droppedNonChat = models.filter((m) => isNonChatModel(m)).map((m) => m.id);
      // 与写进缓存的 models 用**同一套过滤**，保证这个计数就是"桥认识几个模型"，
      // 不会因为过滤规则前后不一致而虚高。
      const kept = models.filter((m) => m.supportsToolCall !== false
        && !/^(codewise|hunyuan-image)/.test(m.id)
        && !isNonChatModel(m));
      // 过滤后还剩几个是**真的来自上游**的（FEATURED 补全项带 _supplemented 标记，
      // 要排除掉——否则补全又会把计数顶上去，等于没修）。
      const upstreamKept = kept.filter((m) => !m._supplemented).length;
      catalogCache = {
        at: Date.now(),
        models: kept.map((m) => {
          const promo = promotions.get(m.id);
          // 倍率 = 目录价 × 促销因子。夜间折扣 factor=0.5 之类在这里落地，
          // 否则用户看到的价与实际扣的费对不上（深夜该是半价却显示全价）。
          // factor 缺失（纯徽章促销）不影响倍率；factor=0 已由 free 覆盖。
          const base = creditsOf(m);
          const factor = typeof promo?.factor === 'number' ? promo.factor : null;
          const effectiveCredits = (base !== undefined && factor !== null && factor > 0)
            ? Math.round(base * factor * 100) / 100
            : (promo?.free ? 0 : base);
          return {
          id: m.id,
          name: m.name || m.id,
          context: m.maxInputTokens,
          maxOutput: m.maxOutputTokens,
          /*
           * 能力声明要**同时**过一遍区域纠正表：上游目录会误报（如国际版的
           * glm-5.3 声明 supportsImages 却收不到图）。压掉之后 dsh 不再允许
           * 贴那张注定被丢的图 —— 比"贴了才发现模型说看不见"诚实。
           */
          images: !!m.supportsImages && !(corrections[m.id] || []).includes('images'),
          credits: effectiveCredits,
          // 上游的推理能力标记：supportsReasoning=true 表示该模型接受推理强度控制
          //（选择器要据此显示"推理等级"下拉）；onlyReasoning 表示该模型只能以
          // 推理模式使用。不上报数据里的这两个字段，插件就无法给模型声明
          // reasoning 元数据 —— dsh 的选择器会少一个有用的控件。
          supportsReasoning: m.supportsReasoning === true,
          onlyReasoning: m.onlyReasoning === true,
          // 保留上游的说明与标签：国际版把具体型号写在 description 里，
          // 光看 id（default-model 这类档位名）无法判断它其实是哪个模型
          vendor: m.vendor,
          tags: m.tags,
          descriptionZh: m.descriptionZh,
          descriptionEn: m.descriptionEn,
          isDefault: m.isDefault,
          badge: promo?.label,
          free: promo?.free === true,
          };
        }),
        // 诊断用：各端点的命中数量与模型字段名
        shape,
        /**
         * 缓存里**真正来自上游目录**、且能对话的模型条数。模型预校验的启用
         * 依据（见 preflightModelError），0 表示放行一切。
         *
         * 为什么不能用 `models.length > 0`：上面的 FEATURED 补全会**无条件**
         * 把 3 个精选模型塞进来，所以哪怕两个目录端点一个模型都没给出
         * （404 / 字段改名 / 空数组 / 全被 isNonChatModel 过滤），`models`
         * 照样非空。**非空 ≠ 已知**，差的就是这个 `_supplemented` 的排除。
         *
         * 也不要拿 upstreamOk 顶替：那个变量的语义是「端点回了一个 models
         * 数组」，空数组同样算 true，它服务于 /v1/models?refresh=1 的
         * "这次刷新算不算成功"提示，与本处的「桥认识几个模型」不是一回事。
         */
        upstreamModelCount: upstreamOk && !hardError ? upstreamKept : 0,
        // 原始计数留在诊断口径里，/health 的 upstreamShape 能直接看到
        upstreamModelsSeen: upstreamModelCount,
      };
    } else if (hardError) {
      log('catalog refresh failed; keeping cached catalog');
    }
  } catch (e) { log('catalog fetch failed', describeFetchError(e)); hardError = true; }
  return { models: catalogCache.models, upstreamOk: upstreamOk && !hardError };
}

/**
 * 精选模型：优先取 FEATURED 里**上游确实存在**的那些。
 *
 * 上游模型目录随地区而异——国际版（www.workbuddy.ai）就没有
 * deepseek-v4.1-flash，只有 default-model / fast-model 这类档位名。
 * 若一律照搬 FEATURED，就会报出上游根本没有的模型。
 */
function pickFeatured(catalog) {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  // 精选模型始终保留：目录里没有的用定义值补上（上游目录并不完整，
  // 例如国际版能调 deepseek-v4.1-flash，但目录里没有它）。
  //
  // **能力字段必须一起带上**（images / supportsReasoning）。这里是**第二条**
  // 补全路径（另一条是 merged.set 那段），两处漏字段的表现完全一样：
  // 目录里该模型没有 supports_images / supports_reasoning → dsh 里贴不了图、
  // 没有「推理等级」下拉。第一版只修了 merged.set 那条，这条漏了 ——
  // 用户报"deepseek-v4.1-flash 没有推理等级"就是它。
  return FEATURED.map((f) => byId.get(f.id) ?? {
    id: f.id,
    name: f.name,
    context: f.context,
    maxOutput: f.maxOutput,
    credits: f.credits,
    ...(f.images ? { supportsImages: true } : {}),
    ...(f.supportsReasoning ? { supportsReasoning: true } : {}),
    ...(f.onlyReasoning ? { onlyReasoning: true } : {}),
  });
}

// ── Billing / credits ────────────────────────────────────────────────────
/**
 * 计费网关与 chat 网关**不是同一个主机**：
 *   国内 chat = copilot.tencent.com，计费 = www.codebuddy.cn
 *   国际 = www.workbuddy.ai（chat 与计费同域；codebuddy.ai 登录则用 www.codebuddy.ai）
 */
/**
 * 显式覆盖计费网关。正常部署下不设，按域名推断；
 * 自建网关或验收脚本可以指到本地 stub，否则签到这条路径没法在离线环境验证。
 */
const EXPLICIT_BILLING_BASE = process.env.WORKBUDDY_BILLING_BASE || '';

function billingBase(endpoint) {
  if (EXPLICIT_BILLING_BASE) return EXPLICIT_BILLING_BASE;
  const e = String(endpoint || '');
  if (e.includes('codebuddy.ai')) return 'https://www.codebuddy.ai';
  if (e.includes('workbuddy.ai')) return 'https://www.workbuddy.ai';
  return 'https://www.codebuddy.cn';
}

/** 计费类请求共用的请求头。 */
function billingHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.access}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
    ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
  };
}

/** 向计费网关发一次 POST，返回解包后的 data。 */
async function billingPost(auth, path, body = {}) {
  const res = await fetch(`${billingBase(auth.endpoint)}${path}`, {
    method: 'POST',
    headers: billingHeaders(auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const envelope = await res.json().catch(() => null);
  if (!res.ok || !envelope || envelope.code !== 0) {
    throw new Error((envelope && (envelope.msg || envelope.message)) || `HTTP ${res.status}`);
  }
  return typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
}

/** 今日签到状态（只读，不改状态）。 */
async function fetchCheckinStatus(auth) {
  const d = await billingPost(auth, '/v2/billing/meter/checkin-activity-status');
  const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
  return {
    active: d.active === true,
    todayCheckedIn: d.today_checked_in === true,
    streakDays: num('streak_days'),
    dailyCredit: num('daily_credit'),
    todayCredit: num('today_credit'),
    isStreakDay: d.is_streak_day === true,
    nextStreakDay: num('next_streak_day'),
    streakBonusDays: num('streak_bonus_days'),
    streakBonusCredit: num('streak_bonus_credit'),
  };
}

/**
 * 领取今日签到奖励。
 *
 * 重复签到上游会返回非零业务码（含「已签到」），那是**幂等成功**而非失败——
 * 今天的奖励已经在账上，报成失败反而会误导用户。
 */
async function claimDailyCheckin(auth) {
  try {
    const d = await billingPost(auth, '/v2/billing/meter/daily-checkin');
    const num = (k) => (typeof d[k] === 'number' ? d[k] : 0);
    return {
      ok: true,
      already: false,
      credit: num('credit'),
      streakDays: num('streak_days'),
      isStreakDay: d.is_streak_day === true,
    };
  } catch (e) {
    const msg = String(e.message || e);
    if (/已签到|already/i.test(msg)) {
      return { ok: true, already: true, credit: 0, message: msg };
    }
    throw e;
  }
}

// ── 每日自动签到（R11.2）────────────────────────────────────────────────
// 内存态：桥重启后重新判定（上游幂等兜底，重复签也只是「已签到」）。
// 触发点有两个：/v1/chat/completions 开头（fire-and-forget，绝不阻塞这次调用）
// 与**桥自己的定时器**（见 startAutoCheckinTimer 的说明）。
const AUTO_CHECKIN_COOLDOWN_MS = Number(process.env.WORKBUDDY_CHECKIN_COOLDOWN_MS || 3600000); // 失败后冷却 1 小时再试
const AUTO_CHECKIN_MAX_PER_DAY = 3;       // 当天最多试 3 次，避免对上游打无效请求
let autoCheckinDay = '';                  // 「今天已尝试」的本地日期
let autoCheckinDoneDay = '';              // 「今天已签成功」的本地日期 —— 当天不再重试
let autoCheckinTries = 0;
let autoCheckinLastAt = 0;
let autoCheckinInflight = null;
let autoCheckinState = null;              // { at, result, error?, credit? }

/**
 * 触发一次自动签到（不 await）。失败策略写死，避免对上游打无效请求：
 * 失败后冷却 1 小时、当天最多 3 次；上游「已签到」按**成功**处理。
 */
function maybeAutoCheckin() {
  if (!AUTO_CHECKIN_ENABLED) return;

  const today = localDay(Date.now());
  if (today !== autoCheckinDay) {
    autoCheckinDay = today;
    autoCheckinTries = 0;
    autoCheckinLastAt = 0;
  }
  // 今天已经签成功了就别再打上游 —— 没有这条的话，定时器每小时都会问一次
  // 「签了没」，而答案永远是「签了」。
  if (autoCheckinDoneDay === today) return;
  if (autoCheckinTries >= AUTO_CHECKIN_MAX_PER_DAY) return;
  if (autoCheckinLastAt && Date.now() - autoCheckinLastAt < AUTO_CHECKIN_COOLDOWN_MS) return;
  if (autoCheckinInflight) return;

  autoCheckinLastAt = Date.now();
  autoCheckinTries += 1;
  autoCheckinInflight = (async () => {
    try {
      const claim = await claimDailyCheckin(readStoredAuth());
      autoCheckinState = {
        at: new Date().toISOString(),
        // 上游「已签到」是成功，不是失败（复用 claimDailyCheckin 的幂等语义）
        result: claim.already ? 'already' : 'ok',
        credit: typeof claim.credit === 'number' ? claim.credit : 0,
      };
      // 「已签到」也算今天不用再管了
      autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, autoCheckinState.credit);
    } catch (e) {
      /*
       * 展开 cause 再截断。
       *
       * `shortError` 只负责"单行 + 截断"（防上游异常里夹带整段 HTML），
       * 它**不展开 `e.cause`** —— 而网络层失败时真正的码（ECONNRESET /
       * ETIMEDOUT / ENOTFOUND）只在 cause 里，message 永远是 `fetch failed`。
       * 两个函数职责不同，串起来用。
       */
      const msg = shortError(describeFetchError(e));
      // 国际版网关没有积分系统：这不是「失败」，如实区分开
      const noActivity = /no.?activity|not.?support|无.?签到|不存在|not.?found/i.test(msg);
      autoCheckinState = {
        at: new Date().toISOString(),
        result: noActivity ? 'no-activity' : 'error',
        error: msg,
      };
      // 没有签到活动的地方永远不会「成功」，再试也是白试 —— 当天收工
      if (noActivity) autoCheckinDoneDay = localDay(Date.now());
      log('auto checkin', autoCheckinState.result, msg);
    } finally {
      autoCheckinInflight = null;
    }
  })();
}

/**
 * 桥自己的每日签到定时器。
 *
 * **为什么必须有这个**：签到原先只挂在 `/v1/chat/completions` 开头 ——
 * 也就是说「有人调模型」才顺带签一次。但**桥才是常驻后台的那个进程**，
 * 而用户完全可能一整天不调模型（刚装好还没接客户端、周末没写代码、
 * 只用网页版而没走这个桥……）。
 *
 * 实测就撞上了：桥从 13:03 一直跑着，10-07 一整天**没有一条模型请求**，
 * 于是**一次签到都没发生**，用户晚上打开控制台才发现还得手动签。
 *
 * 控制台侧的 hourly 定时覆盖不了这种情况 —— 它要求控制台开着，而控制台
 * 恰恰是用户平时会关掉的那个（关掉后桥会留下，这是刻意的）。
 * 所以「按天自动」这件事必须由常驻的那一方负责。
 *
 * 间隔取 1 小时与失败冷却同频：`maybeAutoCheckin` 自己会挡掉重复调用
 * （当天成功过、超次数、冷却中都会直接返回），这里不需要再判。
 */
function startAutoCheckinTimer() {
  if (!AUTO_CHECKIN_ENABLED) return;
  // 启动后先等一会儿再试：上游连接预热与目录抓取都在开头，别挤在一起。
  // 可调是为了让测试不必真等 20 秒（生产环境没有理由改它）。
  const kickMs = Number(process.env.WORKBUDDY_CHECKIN_KICK_MS || 20000);
  const kick = () => maybeAutoCheckin();
  setTimeout(kick, kickMs).unref?.();
  setInterval(kick, AUTO_CHECKIN_COOLDOWN_MS).unref?.();
}


/**
 * 只读查询积分余额（按套餐聚合）。
 *
 * 该端点不会消耗积分，可安全地按需调用。月度套餐（CapacityType=4）看
 * CycleCapacityRemain，一次性套餐看 CapacityRemain。
 */
async function fetchQuota(auth) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();

  const res = await fetch(`${billingBase(auth.endpoint)}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(auth.userId ? { 'X-User-Id': auth.userId } : {}),
      ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId } : {}),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 0) {
    throw new Error((body && (body.msg || body.message)) || `HTTP ${res.status}`);
  }

  const accounts = body?.data?.Response?.Data?.Accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  const packages = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
    const monthly = num('CapacityType') === 4;
    const size = monthly ? num('CycleCapacitySize') : num('CapacitySize');
    const remainRaw = monthly ? num('CycleCapacityRemain') : num('CapacityRemain');
    const remain = remainRaw < 0 ? 0 : remainRaw;
    if (!monthly && remain <= 0) continue;
    total += remain;
    packages.push({
      name: a.PackageName || '(unnamed)',
      remain,
      size,
      monthly,
      expiresAt: a.ExpiredTime || (monthly ? a.CycleEndTime : undefined) || undefined,
    });
  }
  return { total, packages, productCode: 'p_tcaca' };
}

// ── HTTP server ──────────────────────────────────────────────────────────
/**
 * chat 请求体上限。
 *
 * 32MB 这个数是**从最大合法请求倒推**的，不是随手取的：dsh / 控制台的「图片
 * 转 base64 内联」会把整张图塞进 messages，1MB 的 PNG 编码后约 1.37MB，一条
 * 多轮带图对话叠到十几 MB 是正常现象。控制台自己那条 readBody 只给 512KB ——
 * 那是**控制台内部**的管理类小请求，桥这边不能照抄，否则一张稍大的图就被拒。
 * 反过来，无上限就等于「一个坏客户端能把这个零依赖的本地进程内存吃干」。
 * 32MB 足够覆盖真实的多模态对话，又能在单个请求层面兜住内存。
 *
 * 可用 `WORKBUDDY_MAX_BODY_BYTES` 覆盖：上限是随用法变的（比如有人专门灌长
 * 上下文做压测），写死会让那种场景没有任何出口。
 */
const MAX_BODY_BYTES = Number(process.env.WORKBUDDY_MAX_BODY_BYTES || 32 * 1024 * 1024);

/**
 * 读取请求体，超过 MAX_BODY_BYTES 立刻失败。
 *
 * **超限时既不在这里 destroy，调用方也不 destroy** —— 这是两次实测才定下来的：
 *
 *   1. 控制台那份 readBody 是「fail() + req.destroy()」，桥这边不能照抄：destroy
 *      会把 socket 直接拆掉，413 还没写出去，客户端只收到 ECONNRESET。
 *   2. 于是改成「这里 pause()、调用方写完 413 再 destroy」—— **仍然不行**。
 *      实测（1MB~16MB）：pause() 之后客户端**还在继续发**，此时 destroy 让内核
 *      回 RST，客户端在读到 413 之前就被复位，丢失率最高到 10/10（8MB）。
 *      对照实验：把 destroy 换成 resume()、其余一字不改 → 0/50 丢失。
 *
 * 所以最终做法是：超限时 `req.pause()` 停止为它累计内存，调用方回完 413 后
 * 用 `req.resume()` 把剩余字节**读掉并丢弃**，让这条连接自然收尾。
 *
 * 代价是确实还会从网络上读走那部分字节 —— 但这不违背 D2 的目标：D2 要挡的是
 * 「无上限地往内存里 Buffer.concat」，而 resume() 之后没有任何东西被累计，
 * 每条请求仍有 MAX_BODY_BYTES 的硬上限兜底。
 *
 * 抛出的错误带上 `code = 'BODY_TOO_LARGE'`：调用方要据此回**明确的 413**，
 * 而不是和「JSON 解析失败」共用同一个 400。
 */
const readBody = (req, limit = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
  let size = 0;
  let done = false;
  const chunks = [];
  req.on('data', (c) => {
    if (done) return; // 已经判定超限：后续在途 chunk 一律丢弃，不再累计
    size += c.length;
    if (size > limit) {
      done = true;
      const err = /** @type {Error & { code?: string }} */ (new Error(`request body exceeds ${limit} bytes`));
      err.code = 'BODY_TOO_LARGE';
      // 先停住继续灌数据，再 reject —— 顺序反过来的话，pause 之前可能又塞进来
      // 几个 chunk（Node 的 data 事件是同步派发的），白占内存。
      // 注意这里**只是暂停**：真正丢弃剩余字节要等 413 写完之后（见调用方）。
      req.pause();
      reject(err);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
  // 连接被对端提前掐断等情况：已经 settle 过就别再 reject 一次
  req.on('error', (e) => { if (!done) { done = true; reject(e); } });
});

/**
 * 所有响应的基础安全头。
 *
 * `nosniff`：不让浏览器去猜 Content-Type（响应里既有 JSON 又有 SSE，猜错会
 * 把数据当可执行内容处理）。`frame-ancestors 'none'`：本服务不该被任何页面嵌。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

const json = (res, status, obj, extraHeaders = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders, ...SECURITY_HEADERS });
  res.end(body);
};

/**
 * 这个请求的 Origin 是否可以放行。
 *
 * **为什么必须校验：绑定 127.0.0.1 挡不住浏览器。** 恶意网页可以把域名解析到
 * 127.0.0.1（DNS rebinding），让浏览器把请求发到本机服务；响应被 CORS 挡住读不到，
 * 但**副作用已经发生** —— 桥会照常转发、消耗账号配额。实测：带
 * `Origin: https://evil.example` 的跨站形状请求（text/plain、无鉴权）得到 200，
 * 打桩上游确实被调用。桥自身的本地令牌默认是**空**，所以不能只靠令牌兜底。
 *
 * 判据：本机 CLI / SDK（curl、dsh 插件、控制台）**不发 Origin**，一律放行；
 * 带 Origin 的只放行**回环来源**（本机网页版客户端照常可用），其余一律拒绝。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器调用（CLI / SDK / 内部代理）
  let host;
  try { host = new URL(origin).hostname; } catch { return false; } // 含 `Origin: null`
  const bare = String(host).replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/**
 * 本地令牌校验。两种写法都收：
 *   - `Authorization: Bearer <token>` —— OpenAI 系客户端的惯例
 *   - `x-api-key: <token>`            —— Anthropic 系客户端的惯例（Claude Code 用这个）
 *
 * 两者承载的是同一个「本机回环令牌」，用途完全一致，没有理由让用户为了换一个
 * 客户端就记两套写法。**只影响本机回环端口上的这一个校验点**，与上游凭据无关。
 * （B2 起鉴权入口改用下方的 identifyClientId —— 它在令牌之上还支持客户端
 * 凭据分层；本函数保留给只需要「是不是管理钥匙」布尔判断的调用方。）
 */

/**
 * 请求级上下文（AsyncLocalStorage）：把「这是哪个调用方」传播到请求处理链的
 * 任何深处（账本、限流都在深处取用），不需要把 res 一路传下去。
 */
const requestScope = new AsyncLocalStorage();

/**
 * 识别调用方：`'local'`（管理 / 控制台 / 默认钥匙）| 客户端 id（key 哈希前 8 位）
 * | `null`（未识别 → 401）。LOCAL_TOKEN 是万能钥匙；client key 是分层的调用方
 * 凭据（可单独吊销、独立限流、独立记账）。两种写法（Bearer / x-api-key）同
 * hasLocalToken，一并支持。
 */
function identifyClientId(req) {
  let token = null;
  if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  if (!token && typeof req.headers['x-api-key'] === 'string') token = req.headers['x-api-key'];
  if (!token) return null;
  if (safeEqual(token, LOCAL_TOKEN)) return 'local';
  const hex = createHash('sha256').update(token).digest('hex');
  return CLIENT_KEY_HASHES.get(hex) || null;
}

/**
 * 常量时间字符串比较。
 *
 * 为什么不能直接 `token === LOCAL_TOKEN`：JS 的字符串比较**短路**——
 * 第一个不同的字符就返回，比较耗时与实际匹配长度成正比。本机进程可以反复
 * 发请求、按返回时序逐字节恢复口令（`wb-local-bridge` 这种短口令尤其容易）。
 * 走 timingSafeEqual 先比长度（长度不等直接 false，这个信息本身不敏感），
 * 等长时定时比较。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── 响应观测：进程级计数 + 开销头（横切两件事，只包一次）──────────────────
/**
 * 进程级计数（供 /health 的 `process` 段）：
 *   requests —— 真实客户端请求数（**排除 /health 探活**，否则会被控制台
 *               每 20 秒的轮询灌水，"本进程处理了多少请求"就没意义了）；
 *   errors / byStatus —— 4xx/5xx 数与状态码分布，排障时一眼看清失败类形。
 */
const procStats = { requests: 0, errors: 0, byStatus: {} };

/**
 * 包装 `res.writeHead`，统一做两件事：
 *   ① 计数（真实请求的状态码分布，健康探活不计）；
 *   ② 注入 `X-WorkBuddy-Overhead-Ms` —— 端点把「桥自身处理耗时」写到
 *      `res.__overheadMs`（= 总耗时 − 上游往返），这里统一发出。
 * 这样各响应点不必各自拼头；没设置该字段的响应（/health、/v1/models 等
 * 本地应答）自然不带 —— 头只出现在"性能主张相关"的对话路径上。
 */
function observeResponse(req, res) {
  if (req.url?.startsWith('/health')) return; // 探活不计数、不加头
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (...args) => {
    const statusCode = args[0];
    if (typeof statusCode === 'number') {
      procStats.requests += 1;
      procStats.byStatus[statusCode] = (procStats.byStatus[statusCode] || 0) + 1;
      if (statusCode >= 400) procStats.errors += 1;
    }
    // 只在 (status, headers对象) 形态时注入；其余形态（数组头/statusMessage）原样放行
    if (
      res.__overheadMs !== undefined
      && args.length === 2
      && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])
    ) {
      args[1] = { 'X-WorkBuddy-Overhead-Ms': String(res.__overheadMs), ...args[1] };
    }
    return origWriteHead(...args);
  };
}

// ── 在途请求注册表（卡死可见性）──────────────────────────────────────────
/**
 * 进行中的对话请求（id / 开始时刻 / 模型 / 流式标记）。
 *
 * 目的：长回答静默几十秒时，用户能区分「模型在想」与「真的卡死了」——
 * 控制台「最近请求」显示进行中条目与已运行时长，超阈值标黄提醒。
 *
 * **红线：不加任何默认超时** —— 长回答需要无限等待（见 README 注意事项），
 * 本注册表只负责**显示**，绝不主动打断请求。
 *
 * 释放：统一挂 `res.once('close')`（响应完成或连接中断都会触发），
 * 成功 / 失败 / 客户端断开三条路径一个挂点全覆盖 —— 不会泄漏。
 */
const inflight = new Map();
let inflightSeq = 0;
/** 运行超过该毫秒数即判「疑似卡死」——只影响显示高亮，不干预请求。 */
const ACTIVE_ALERT_MS = Math.max(1000, Number(process.env.WORKBUDDY_ACTIVE_ALERT_MS || 300_000));

function trackInflight(req, res, model, stream) {
  const id = `req_${(++inflightSeq).toString(36)}-${Date.now().toString(36)}`;
  inflight.set(id, { id, startedAt: Date.now(), model: String(model || ''), stream: !!stream });
  res.once('close', () => { inflight.delete(id); });
}

const server = createServer((req, res) => {
  // 请求级上下文：入口处识别调用方一次（local / client key 哈希前 8 位），
  // 账本与限流在处理链的任何深处用 requestScope.getStore() 取用。
  //
  // `effort` 先留空、解析 body 后再填：**store 是可变对象**，这样深处任意一个
  // recordRequest（含各种失败早退路径）都能自动带上推理档位，不必逐处传参 ——
  // 与 client 的归因同一套机制，新增记账点也不会漏。
  requestScope.run({ client: identifyClientId(req), effort: '' }, () => handleRequest(req, res));
});

async function handleRequest(req, res) {
  /*
   * `Host` 是**客户端可控的**，而 `new URL()` 会对非法 Host 抛 `ERR_INVALID_URL`。
   * 这一句原先在下面那个 try **之外** —— 抛出的异常没被捕获，Node 直接退出进程：
   * 任何能访问本机端口的进程用一条 `Host: bad host with spaces` 就能把桥打死
   * （实测 exitCode=1，见 bridge.test.mjs 的「畸形 Host 头回 400」）。
   * 现在按「非法请求」挡下，与其余入口校验同一处理方式。
   *
   * `Host` 缺失/为空时给个回环默认值：`http://undefined` 也是合法 URL，
   * 但把它当成本机更贴近事实，也不会让下游的绝对 URL 拼出怪东西。
   */
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return json(res, 400, { error: { message: 'workbuddy-bridge: invalid Host header' } });
  }
  observeResponse(req, res);
  try {
    if (!originAllowed(req)) {
      return json(res, 403, { error: { message: 'workbuddy-bridge: cross-origin request rejected (this bridge serves local clients only)' } });
    }
    /*
     * 令牌**始终必需**。
     *
     * 旧写法是 `if ((LOCAL_TOKEN || CLIENT_KEY_HASHES.size) && ...)` —— 未配置令牌时
     * 整个分支不执行，等于「不配令牌就不鉴权」。LOCAL_TOKEN 现在永远非空
     * （未配置时自动生成，见 LOCAL_TOKEN 定义），所以这里可以直接判 null。
     * 保留 `CLIENT_KEY_HASHES.size` 只是为了让「只配了 client key」的语义清楚。
     */
    if (identifyClientId(req) === null) {
      /**
       * 401 必须**可操作**：只说 "bad token" 会让用户无从下手。
       *
       * 常见成因是"令牌变了" —— 桥在未配置 WORKBUDDY_LOCAL_TOKEN 时会自动生成
       * 一把（每次重启都不同），而客户端还存着上一把。所以这里同时给出
       * 「去哪拿新的」与「为什么可能是旧的」两条指引 —— bridge.test.mjs 对这两
       * 点都有断言（它比实现更严格，这里补齐实现）。
       *
       * **绝不能回显任何真实令牌**（本响应体可能进日志/前端）；同一份测试也守着这点。
       */
      return json(res, 401, {
        error: {
          message: 'workbuddy-bridge: bad or missing token',
          hint: '本地回环令牌缺失或不匹配。请到控制台的「客户端接入」页（/clients）复制当前令牌，'
            + '填进客户端的 Authorization: Bearer <token>。'
            + '若之前能用而现在失败：桥未配置 WORKBUDDY_LOCAL_TOKEN 时会自动生成新令牌，重启即变（stale/旧），'
            + '把 .env 里的 WORKBUDDY_LOCAL_TOKEN 固定下来即可升级到稳定配置。',
          howToFix: [
            '打开控制台的「客户端接入」页取令牌',
            '或用启动日志里的 WORKBUDDY_LOCAL_TOKEN= 一行',
            '想固定不变：在 .env 里设 WORKBUDDY_LOCAL_TOKEN=<你的令牌>',
          ],
        },
      });
    }

    if (url.pathname === '/health') {
      let auth = null;
      try {
        const a = readStoredAuth();
        auth = { userId: a.userId, endpoint: a.endpoint, expiresAt: new Date(a.expiresAt).toISOString(), expired: a.expiresAt < Date.now() };
      } catch (e) { return json(res, 503, { ok: false, error: e.message, authFile: AUTH_PATH }); }
      // 这里**绝不能等上游**：控制台的探测超时是 4 秒，冷缓存时抓目录要好几秒，
      // 一旦超时就会被误判成「桥未运行」。有缓存立刻答，没有或过期都只触发后台刷新。
      if (!catalogCache.models.length || Date.now() - catalogCache.at > CATALOG_TTL_MS) refreshCatalog();
      const catalog = catalogCache.models;
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeMs: Date.now() - STARTED_AT,
        auth,
        authFile: AUTH_PATH,
        // 本桥写进账本的账号标签：多账号时账本是按它分桶的，这里回传一份
        // 好让消费方能"把账本上的账号对上界面上的分组"，不必去猜文件名。
        account: ACCOUNT_LABEL,
        // 客户端定位结果（**只读内存缓存、绝不触发探测** —— /health 有 4 秒超时
        // 约束，慢探测会让控制台把桥误判成"未运行"；没定位过就显示空）
        clientExe: atRestUsedExe || wbExeCache || '',
        models: (catalog.length ? pickFeatured(catalog) : FEATURED).map((m) => m.id),
        catalogSize: catalog.length,
        catalogAt: catalogCache.at ? new Date(catalogCache.at).toISOString() : null,
        catalogRefreshing: !!catalogRefreshing,
        upstreamShape: catalogCache.shape || null,
        // 进程级计数：真实请求数（不含 /health 探活）/ 失败数 / 状态码分布 / 限流触发数
        process: {
          requests: procStats.requests,
          errors: procStats.errors,
          byStatus: procStats.byStatus,
          rateLimited: rateState.limited,
        },
        // 客户端凭据分层（B2）：只暴露启用状态与数量，**绝不回显 key 或哈希**
        clients: { enabled: CLIENT_KEY_HASHES.size > 0, count: CLIENT_KEY_HASHES.size },
        /*
         * 指纹改写的命中情况 —— 上游「悄悄加黑名单」的最早信号。
         *
         * 只回「命中了几次」与「命中的是哪条规则的**序号和摘要**」，不回原文：
         * 这些句子本身不是秘密（就在 AUDIT_TEMPLATE_REWRITES 里），但把它们整段
         * 回显到 HTTP 上没有任何好处，摘要足够用户和排查者对号入座。
         */
        fingerprints: {
          rewrites: [...fingerprintHits.values()].reduce((a, b) => a + b, 0),
          byRule: AUDIT_TEMPLATE_REWRITES.map(([from], i) => ({
            rule: i + 1,
            preview: from.slice(0, 48),
            hits: fingerprintHits.get(from) || 0,
          })),
        },
        // 自动签到的内存态：桥重启后清空、重新判定（上游幂等兜底）
        autoCheckinEnabled: AUTO_CHECKIN_ENABLED,
        autoCheckin: autoCheckinState,
        /*
         * 流式保活的**实际生效值**（不是「配置里写了什么」，而是本进程真的会用多少）。
         *
         * 为什么要暴露：心跳间隔默认 30 秒，短请求根本触发不到 —— 想验证「配置到底有没有
         * 被读到」就只能等一个超过 30 秒的请求，很被动。回传生效值即可一眼确认；
         * `0` 明确表示**已关闭**（排查「心跳是否干扰某客户端」时用的正是它）。
         */
        stream: { heartbeatMs: SSE_HEARTBEAT_MS },
      });
    }

    if (url.pathname === '/v1/models') {
      const all = url.searchParams.get('all') === '1';
      // refresh=1：强制重取上游目录。失败**不清空旧缓存**——宁可给一份标了
      // 年纪的目录，也别让页面突然空白；staleMs 就是那个「年纪」。
      const wantRefresh = url.searchParams.get('refresh') === '1';
      let staleMs = null;
      if (wantRefresh) {
        const startedAt = Date.now();
        const r = await refreshCatalog();
        if (!r.ok) {
          // 只有缓存**确实比本次刷新更旧**才叫「旧缓存」。若本次刷新已经更新过
          // 缓存（例如冷启动只拿到部分目录），说「0 秒前的缓存」是误导。
          staleMs = catalogCache.at && catalogCache.at < startedAt ? Date.now() - catalogCache.at : null;
          log('models refresh failed; serving cached catalog',
            staleMs === null ? 'no usable cache' : `${Math.round(staleMs / 1000)}s old`);
        }
      }
      // 刚刷过就别再走 upstreamCatalog()（它在缓存为空时会再触发一次刷新，等于白打一轮上游）
      const catalog = wantRefresh ? catalogCache.models : await upstreamCatalog();

      let models;
      if (!catalog.length) {
        // 上游目录取不到：退回精选定义，至少让客户端能用
        models = FEATURED.map((f) => ({
          id: f.id, name: f.name, context: f.context, maxOutput: f.maxOutput, images: true,
        }));
      } else if (all) {
        models = catalog;
      } else {
        models = pickFeatured(catalog).map((u) => ({
          ...u,
          name: FEATURED.find((f) => f.id === u.id)?.name || u.name,
        }));
      }

      const list = models.map((m) => {
        const credits = creditsOf(m);
        return {
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'workbuddy',
          ...(m.name ? { name: m.name } : {}),
          ...(m.context ? { context_window: m.context } : {}),
          ...(m.maxOutput ? { max_output_tokens: m.maxOutput } : {}),
          ...(typeof credits === 'number' ? { credits } : {}),
          ...(m.images ? { supports_images: true } : {}),
          ...(m.supportsReasoning ? { supports_reasoning: true } : {}),
          ...(m.onlyReasoning ? { only_reasoning: true } : {}),
          ...(m.vendor ? { vendor: m.vendor } : {}),
          ...(Array.isArray(m.tags) && m.tags.length ? { tags: m.tags } : {}),
          ...(m.descriptionZh ? { description_zh: m.descriptionZh } : {}),
          ...(m.descriptionEn ? { description_en: m.descriptionEn } : {}),
          ...(m.badge ? { badge: m.badge } : {}),
          ...(m.free ? { free: true } : {}),
        };
      });
      // staleMs 只在「刷新失败、退回过期缓存」时出现；成功时不带这个字段
      return json(res, 200, { object: 'list', data: list, ...(staleMs !== null ? { staleMs } : {}) });
    }

    if (url.pathname === '/v1/quota') {
      try {
        const quota = await fetchQuota(readStoredAuth());
        return json(res, 200, { ok: true, ...quota });
      } catch (e) {
        /*
         * **必须记日志**：原先这里只回 502、什么都不记 —— 于是面板报
         * "读取失败：fetch failed" 时，桥的日志里**一条都没有**（实测：
         * 排查时 429 行日志里 quota 相关 0 行，完全无法定位是断网还是上游挂了）。
         * 用 describeFetchError 展开 cause，才能看出 ECONNRESET / ETIMEDOUT 等。
         */
        const detail = describeFetchError(e);
        log(`quota fetch failed: ${detail}`);
        return json(res, 502, { ok: false, error: detail });
      }
    }

    if (url.pathname === '/v1/usage') {
      if (req.method === 'DELETE') {
        try {
          resetUsageLedger();
          return json(res, 200, { ok: true, cleared: true });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
      const hours = url.searchParams.get('hours') === '1';
      return json(res, 200, { ok: true, ...summarizeUsage(days, { hours }) });
    }

    if (url.pathname === '/v1/requests') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      // 进行中的请求（卡死可见性）：只报告，不干预 —— 本桥没有任何默认超时。
      const active = [...inflight.values()].map((r) => ({ ...r, runningMs: Date.now() - r.startedAt }));
      return json(res, 200, { ok: true, requests: recentRequests(limit), active, activeAlertMs: ACTIVE_ALERT_MS });
    }

    if (url.pathname === '/v1/checkin') {
      try {
        const auth = readStoredAuth();
        if (req.method === 'POST') {
          const claim = await claimDailyCheckin(auth);
          const status = await fetchCheckinStatus(auth).catch(() => null);
          return json(res, 200, { ...claim, status });
        }
        return json(res, 200, { ok: true, status: await fetchCheckinStatus(auth) });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          // 明确的 413 + JSON：客户端要能一眼分清「请求太大」和「JSON 写错了」，
          // 这两种 400 类失败的处置方式完全不同。这里**不记账**是对的 ——
          // 连 body 都没读全，没有 model / 耗时可言，记一条全是 0 的账只会污染
          // 控制台的失败列表。
          log('rejected oversized body', e.message);
          const body = JSON.stringify({
            error: {
              message: `workbuddy-bridge: request body too large (limit ${MAX_BODY_BYTES} bytes);`
                + ' raise WORKBUDDY_MAX_BODY_BYTES if this is a legitimate multi-modal request',
              type: 'payload_too_large',
            },
          });
          res.writeHead(413, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...SECURITY_HEADERS });
          // 413 写完后 `resume()` 把剩余字节读掉丢弃。
          //
          // **不要改成 destroy()**：实测这样会让客户端在读到 413 之前就吃 RST
          // （8MB 下丢失率可达 10/10，详见 readBody 的注释）。resume() 之后
          // 没有任何东西被累计进内存，D2 的内存上限目标依然成立，而契约
          // （"明确的 413 JSON"）才真的兑现了。
          res.end(body);
          req.resume();
          return;
        }
        throw e;
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'invalid JSON body' } }); }
      const wantStream = payload.stream === true;
      /*
       * 推理档位（`reasoning_effort`）记进请求级上下文，供账本落盘。
       *
       * 为什么要记：它是**用户唯一能在界面上调的"质量/成本"旋钮**，而账本原来
       * 完全不记 —— 面板的「最近请求」看不出这次到底用没用推理、用的哪一档，
       * 用户没法核对"我选了 high，到底发出去了没有"。实测排查"推理等级下拉
       * 有没有生效"时，只能靠翻原始日志，非常费劲。
       *
       * 只收字符串并**截断**（同 model id 的理由：客户端可控字段，账本行必须有界）。
       */
      const effortRaw = payload.reasoning_effort;
      const effort = typeof effortRaw === 'string' ? shortError(effortRaw, 32) : '';
      if (requestScope.getStore()) requestScope.getStore().effort = effort;
      // model 的类型与长度必须**先收敛**：它是客户端可控字段，会进账本、进日志、
      // 还会被原样回显（见 MAX_MODEL_ID_LEN 的说明）。数组/对象/数字/布尔一律拒绝
      // —— 否则类型混淆会让"长度"判断失效（如数组的 length 是元素个数），而且
      // 静默换成默认模型等于"替用户换了个要计费的模型"，比直接报错更糟。
      // `null` 与缺省视同"没给"（沿用原有的回落行为），不当成类型错误。
      if (payload.model != null && typeof payload.model !== 'string') {
        return json(res, 400, { error: { message: 'workbuddy-bridge: "model" must be a string', type: 'invalid_request' } });
      }
      const model = payload.model || 'deepseek-v4.1-flash';
      if (model.length > MAX_MODEL_ID_LEN) {
        const message = `workbuddy-bridge: model id too long (${model.length} chars, max ${MAX_MODEL_ID_LEN})`;
        // 落账与日志都只留**截断版**：账本行必须有界，也绝不把这段垃圾原样回显
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected oversized model id', trimmed);
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 字符集校验：模型 id 会进 `X-Model-ID` 请求头，非可见 ASCII 会让
      // Node 的 http.request 直接抛异常（外层只能回 500）。见 HEADER_SAFE_RE 的说明。
      // **放在 preflightModelError 之前**：这是格式错误，与目录无关，任何时候都该拦。
      if (!HEADER_SAFE_RE.test(model)) {
        const message = 'workbuddy-bridge: model id must be printable ASCII'
          + ' (it is forwarded as the X-Model-ID header)';
        const trimmed = shortError(model, MAX_MODEL_ID_LEN);
        log('rejected non-ascii model id', trimmed);
        // 与其它拒绝路径一致地落账：否则这次拒绝在控制台「最近请求」里不可见
        recordRequest({
          model: trimmed, stream: wantStream, ms: 0, ok: false, status: 400, code: null, error: message,
        });
        return json(res, 400, { error: { message, type: 'invalid_request' } });
      }

      // 模型预校验：桥手里就有目录，拼错的 id 不该花一次上游往返（详见
      // preflightModelError 的注释）。放在 maybeAutoCheckin 之前是刻意的 ——
      // 一次注定失败的调用不该顺带触发签到。
      const modelError = preflightModelError(model);
      if (modelError) {
        log('rejected unknown model', model);
        // **必须落账**：否则这次拒绝在控制台「最近请求」里完全不可见，用户
        // 看到的是一个客户端报错、而账本上什么都没有，只能去翻原始日志 ——
        // 这正是 D3 想解决的场景，不记等于白改。
        recordRequest({
          model,
          stream: wantStream,
          ms: 0,
          ok: false,
          status: 400,
          code: null,
          error: modelError,
        });
        return json(res, 400, { error: { message: modelError, type: 'model_not_found' } });
      }

      // 每日自动签到：**先转发、后台补签**。放在这里是因为「有人调模型」
      // 就是「在用」的最强信号；不 await，绝不拖慢这次请求。
      maybeAutoCheckin();
      // diagnostics: log request shape only, never conversation content
      if (process.env.WORKBUDDY_SHAPE === '1') {
        const roles = {};
        let chars = 0;
        for (const m of payload.messages || []) {
          roles[m.role] = (roles[m.role] || 0) + 1;
          chars += JSON.stringify(m.content ?? '').length;
        }
        const sys = (payload.messages || []).find((m) => m.role === 'system' || m.role === 'developer');
        const hdrs = Object.keys(req.headers).sort();
        log('SHAPE ' + JSON.stringify({
          bodyKeys: Object.keys(payload).sort(),
          model, stream: payload.stream,
          roles, chars,
          sysChars: typeof sys?.content === 'string' ? sys.content.length : null,
          toolCount: payload.tools?.length ?? 0,
          toolNames: (payload.tools || []).map((t) => t?.function?.name).slice(0, 40),
          headers: hdrs,
          ua: req.headers['user-agent'],
        }));
      }
      log(`→ ${model} stream=${wantStream} msgs=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`);
      const startedAt = Date.now();
      trackInflight(req, res, model, wantStream);

      // the backend is streaming-only: always stream upstream, aggregate for non-streaming clients
      const upstream = normalizePayload({ ...payload, stream: true, stream_options: { include_usage: true } });
      delete upstream.max_completion_tokens; // avoid conflicting with max_tokens semantics
      const conversationId = req.headers['x-conversation-id'] || trace();

      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      // 从这一刻起的任何异常都要落账：否则「登录文件坏了 / 取密钥失败」这类故障
      // 在控制台上完全不可见（只有原始日志里有），用户只能看到一个 500。
      try {
        const { res: up, bodyText, upstreamStartedAt } = await callUpstream(JSON.stringify(upstream), model, conversationId, ac.signal);
        if (!up.ok) {
          const text = bodyText ?? await up.text().catch(() => '');
          let parsed; try { parsed = JSON.parse(text); } catch {}
          log('upstream error', up.status, text.slice(0, 300));
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: typeof parsed?.code === 'number' ? parsed.code : null,
            error: parsed?.msg || parsed?.message || parsed?.error?.message || text,
          });
          /*
           * 上游 429 没有 Retry-After 头，但文案里写着恢复时刻（见
           * retryAfterSecondsFromUpstream 的注释）。解析出来补上标准头，客户端就能
           * 按规范退避，而不是盲目重试或直接把错误甩给用户。
           */
          const extraHeaders = {};
          if (up.status === 429) {
            const seconds = retryAfterSecondsFromUpstream(text);
            if (seconds !== null) extraHeaders['Retry-After'] = String(seconds);
          }
          return json(
            res,
            up.status === 200 ? 502 : up.status,
            parsed || { error: { message: text || `upstream HTTP ${up.status}` } },
            extraHeaders,
          );
        }

        if (wantStream) {
          res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            /*
             * 降级留痕：若这次是「原模型 429 → 换了另一个模型才成功」，把原模型名
             * 回给客户端。只加一个响应头、不改协议语义 —— 排查「为什么回答风格变了」
             * 时这是唯一线索（内容里看不出来）。没有降级时这个头不出现。
             */
            ...(up.fallbackFrom ? { 'X-WorkBuddy-Fallback-From': String(up.fallbackFrom) } : {}),
            ...SECURITY_HEADERS,
          });
          /*
           * 立刻把响应头刷出去（flushHeaders）。
           *
           * 为什么必须显式刷：Node 的 `writeHead()` **只登记头部**，真正的 HEAD 要等到
           * 第一次 `write()` 才发。而上游在长上下文预填充期间可能几十秒不出字节 ——
           * 于是客户端连「200 + text/event-stream」都收不到，只能干等；等它超时就是
           * 「网络错误」，连错误码都没有。刷掉之后：客户端立刻知道「连接已建立、正在
           * 等模型」，配合下面的心跳注释帧，中间层的空闲超时也不会误判。
           */
          res.flushHeaders?.();
          /*
           * 心跳定时器：**首个字节到达前也要跳**，因为最长的静默往往就在 TTFT
           * （长上下文预填充）。每次真实写入都重置计时，避免和正常数据打架。
           */
          let heartbeat = null;
          const armHeartbeat = () => {
            if (!(SSE_HEARTBEAT_MS > 0)) return;
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = setInterval(() => {
              if (res.writableEnded) { clearInterval(heartbeat); heartbeat = null; return; }
              try { res.write(': keepalive\n\n'); } catch { /* 客户端已断，下面统一收尾 */ }
            }, SSE_HEARTBEAT_MS);
            // 定时器不该拖住进程退出（测试与被 Ctrl+C 停掉的场景）
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
          };
          const disarmHeartbeat = () => {
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
          };
          armHeartbeat();
          const reader = up.body.getReader();
          const decoder = new TextDecoder();
          let usageSeen = null;
          // 逐行解析，不用正则：上游的 usage 里含 completion_tokens_details /
          // prompt_tokens_details 这类**嵌套对象**，`\{[^{}]*\}` 根本匹配不上，
          // 结果是流式请求的 token 与扣分全被记成 0。
          let tail = '';
          let streamError = null;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
              tail += decoder.decode(value, { stream: true });
              const lines = tail.split('\n');
              tail = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const chunk = line.slice(5).trim();
                if (!chunk || chunk === '[DONE]' || !chunk.includes('"usage"')) continue;
                try {
                  const u = JSON.parse(chunk).usage;
                  if (u) usageSeen = u; // 最后一帧的 usage 胜出
                } catch { /* 半个包，忽略 */ }
              }
              // 兜底：上游若不按行收尾，别让 tail 无限增长
              if (tail.length > 100000) tail = tail.slice(-4096);
            }
          } catch (e) {
            streamError = e;
            log('stream interrupted', e.message);
          } finally {
            disarmHeartbeat();
          }
          // 上游在流中途断了（连接被掐 / 网络故障）**不是成功**：客户端的回答
          // 已被截断，账本要如实记一笔失败，否则「回答为什么少了一半」在控制台上
          // 完全不可见 —— 与非流式路径的处理保持一致（那里同样记 ok:false）。
          //
          // 客户端自己断开（用户点了停止 / 关了页面）不是失败的另一种：请求已经
          // 服务过了，照旧记成功。用 ac.signal.aborted 区分这两者。
          if (streamError && !ac.signal.aborted) {
            recordRequest({
              model,
              stream: true,
              ms: Date.now() - startedAt,
              ok: false,
              status: 0,
              code: null,
              error: streamError.message,
            });
          } else {
            recordRequest({
              // 降级发生时记**实际服务的模型**，并把原模型放 fallbackFrom：
              // 否则账本会显示「deepseek 消耗了额度」，而真正花钱的是候选模型。
              model: up.fallbackModel || model,
              ...(up.fallbackFrom ? { fallbackFrom: up.fallbackFrom } : {}),
              stream: true,
              ok: true,
              ms: Date.now() - startedAt,
              ...usageOf(usageSeen),
            });
          }
          return res.end();
        }

        const aggregated = await aggregateStream(up);
        res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
        /*
         * 上游回 200 但一个 SSE 块都没解析出来 → 这不是「空回答」，是失败。
         * 典型场景：网关把错误包成 200 的 HTML。原先这里无条件记 ok:true 并回 200，
         * 用户看到空白回答、控制台把它算作成功 —— 静默错数据。
         */
        if (!aggregated.parsed) {
          recordRequest({
            model,
            stream: false,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: null,
            error: 'upstream returned 200 but no parseable SSE data',
          });
          return json(res, 502, {
            error: {
              message: 'workbuddy-bridge: upstream returned 200 but no parseable SSE data',
              type: 'upstream_error',
            },
          });
        }
        recordRequest({ model, stream: false, ok: true, ms: Date.now() - startedAt, ...usageOf(aggregated.usage) });
        return json(res, 200, aggregated);
      } catch (e) {
        if (e?.code === 'RATE_LIMITED') {
          const retryAfter = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
          recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 429, code: null, error: `rate_limited (retry in ${retryAfter}s)` });
          return json(res, 429, { error: { type: 'rate_limit_error', message: e.message } }, { 'Retry-After': String(retryAfter) });
        }
        if (e?.code === 'RATE_LIMIT_ABORTED') {
          // 客户端在队列里等待时断开：没打到上游、也没发出任何响应，不记账
          return;
        }
        recordRequest({
          model,
          stream: wantStream,
          ms: Date.now() - startedAt,
          ok: false,
          status: 0,
          code: null,
          error: e.message,
        });
        throw e; // 交给外层统一回 500
      }
    }

    // ── Anthropic count_tokens（Claude Code 用它显示上下文占用）───────────
    // 纯本地**估算**（上游没有 tokenizer 端点，口径见 estimateTokens 注释）；
    // 不打上游、不记账 —— 这个端点随输入变化频繁调用，转上游纯属烧额度。
    if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return json(res, 413, {
            type: 'error',
            error: { type: 'request_too_large', message: `request body too large (limit ${MAX_BODY_BYTES} bytes)` },
          });
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }
      return json(res, 200, { input_tokens: estimateRequestTokens(body) });
    }

    // ── Anthropic Messages API（Claude Code 等）────────────────────────────
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          return json(res, 413, {
            type: 'error',
            error: { type: 'request_too_large', message: `request body too large (limit ${MAX_BODY_BYTES} bytes)` },
          });
        }
        throw e;
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }

      // Anthropic 的 `stream` 缺省是 false（与 OpenAI 相反）
      const wantStream = body.stream === true;
      const model = resolveAnthropicModel(body.model);
      const messages = anthropicToOpenAIMessages(body);
      const tools = anthropicToolsToOpenAIMessages(body.tools);
      const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);

      const oai = { model, messages, stream: true, stream_options: { include_usage: true } };
      if (tools) oai.tools = tools;
      if (toolChoice) oai.tool_choice = toolChoice;
      if (typeof body.max_tokens === 'number') oai.max_tokens = body.max_tokens;
      if (typeof body.temperature === 'number') oai.temperature = body.temperature;
      if (typeof body.top_p === 'number') oai.top_p = body.top_p;
      if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) oai.stop = body.stop_sequences;

      maybeAutoCheckin();
      log(`→ [anthropic] ${body.model || '(no model)'} => ${model} stream=${wantStream} msgs=${messages.length} tools=${tools?.length ?? 0}`);

      const startedAt = Date.now();
      trackInflight(req, res, model, wantStream);
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      try {
        const { res: up, bodyText, upstreamStartedAt } = await callUpstream(
          JSON.stringify(normalizePayload(oai)),
          model,
          req.headers['x-conversation-id'] || trace(),
          ac.signal,
        );
        if (!up.ok) {
          const text = bodyText ?? await up.text().catch(() => '');
          let parsed; try { parsed = JSON.parse(text); } catch {}
          log('upstream error (anthropic)', up.status, text.slice(0, 300));
          recordRequest({
            model,
            stream: wantStream,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: typeof parsed?.code === 'number' ? parsed.code : null,
            error: parsed?.msg || parsed?.message || text,
          });
          // 错误体也必须是 Anthropic 的形状，否则客户端只会显示「未知错误」
          const extraHeaders = {};
          if (up.status === 429) {
            const seconds = retryAfterSecondsFromUpstream(text);
            if (seconds !== null) extraHeaders['Retry-After'] = String(seconds);
          }
          return json(
            res,
            up.status === 200 ? 502 : up.status,
            {
              type: 'error',
              error: {
                type: 'api_error',
                message: parsed?.msg || parsed?.message || text || `upstream HTTP ${up.status}`,
              },
            },
            extraHeaders,
          );
        }

        if (wantStream) {
          res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
          const r = await relayAnthropicStream(up, res, model, estimateRequestTokens(body));
          if (r.streamError && !ac.signal.aborted) {
            recordRequest({ model, stream: true, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: r.streamError.message });
          } else {
            recordRequest({ model, stream: true, ok: true, ms: Date.now() - startedAt, ...usageOf(r.usage) });
          }
          return;
        }

        const aggregated = await aggregateStream(up);
        res.__overheadMs = Math.max(0, upstreamStartedAt - startedAt);
        // 同 OpenAI 路径：上游 200 但解析不出任何 SSE 块 = 失败，不是「空回答」
        if (!aggregated.parsed) {
          recordRequest({
            model,
            stream: false,
            ms: Date.now() - startedAt,
            ok: false,
            status: up.status,
            code: null,
            error: 'upstream returned 200 but no parseable SSE data',
          });
          return json(res, 502, {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'workbuddy-bridge: upstream returned 200 but no parseable SSE data',
            },
          });
        }
        recordRequest({ model, stream: false, ok: true, ms: Date.now() - startedAt, ...usageOf(aggregated.usage) });
        return json(res, 200, openAIToAnthropicMessage(aggregated, model));
      } catch (e) {
        if (e?.code === 'RATE_LIMITED') {
          const retryAfter = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
          recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 429, code: null, error: `rate_limited (retry in ${retryAfter}s)` });
          return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: e.message } }, { 'Retry-After': String(retryAfter) });
        }
        if (e?.code === 'RATE_LIMIT_ABORTED') {
          return; // 客户端等待时断开：无上游副作用，不记账
        }
        recordRequest({ model, stream: wantStream, ms: Date.now() - startedAt, ok: false, status: 0, code: null, error: e.message });
        throw e;
      }
    }

    // ── 上游没有的能力：明确 501，不做假的 ────────────────────────────────
    // 上游 30 个模型全是对话类，**没有任何 embedding 模型**。这里若返回一堆
    // 无意义的向量，客户端的知识库会"看起来建成了、实际全是噪声"，用户要等
    // 检索结果离谱时才发现。宁可现在就讲清楚。
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      return json(res, 501, {
        error: {
          message: 'workbuddy-bridge: /v1/embeddings is not available — the upstream gateway serves chat models only '
            + '(its catalog contains no embedding model). Clients that need embeddings for a knowledge base / RAG '
            + 'should configure a separate embedding provider.',
          type: 'not_implemented',
        },
      });
    }

    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'workbuddy-bridge',
        usage: 'POST /v1/chat/completions · POST /v1/messages (Anthropic) · GET /v1/models · GET /v1/usage · GET /v1/requests · GET /v1/quota · GET /v1/checkin · GET /health',
        featured: FEATURED.map((m) => m.id),
      });
    }
    return json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
    try { res.end(); } catch {}
  }
}

// ── Preflight (--check): report prerequisites without starting the server ──
if (process.argv.includes('--check')) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node            ${process.version}${major >= 18 ? '' : '  [FAIL] Node 18+ required'}`);
  lines.push(`auth file       ${AUTH_PATH}`);
  let authOk = false;
  try {
    const a = readStoredAuth();
    authOk = true;
    lines.push(`account         ${a.userId || '(no sub claim)'}`);
    lines.push(`endpoint        ${a.endpoint}`);
    lines.push(`token expires   ${new Date(a.expiresAt).toISOString()}${a.expiresAt < Date.now() ? '  (expired: the bridge refreshes on first request)' : ''}`);
  } catch (e) {
    lines.push(`auth            [FAIL] ${e.message}`);
  }
  lines.push(`client exe      ${atRestUsedExe || resolveWorkBuddyExe() || '未找到（设置 WORKBUDDY_APP_EXECUTABLE 指向 WorkBuddy.exe）'}`);
  lines.push(`models          ${FEATURED.map((m) => m.id).join(', ')}`);
  console.log(lines.join('\n'));
  process.exit(authOk || API_KEY ? 0 : 1);
}

server.listen(PORT, HOST, () => {
  let who = '(no desktop session read)';
  try { const a = readStoredAuth(); who = `${a.userId} @ ${a.endpoint}`; } catch (e) { who = `ERROR: ${e.message}`; }
  console.log(`workbuddy-bridge listening on http://${HOST}:${PORT}/v1`);
  console.log(`auth       : ${API_KEY ? 'API key (CODEBUDDY_API_KEY)' : `desktop session ${who}`}`);
  console.log(`auth file  : ${AUTH_PATH}`);
  console.log(`client exe : ${atRestUsedExe || resolveWorkBuddyExe() || '未找到（设置 WORKBUDDY_APP_EXECUTABLE 指向 WorkBuddy.exe）'}`);
  console.log(`models     : ${FEATURED.map((m) => m.id).join(', ')}  (all models: /v1/models?all=1)`);
  console.log(`keep-alive : ${KEEPALIVE_MS > 0 ? `${Math.round(KEEPALIVE_MS / 1000)}s idle pool` : 'off'}`);
  /*
   * 未显式配置令牌时把自动生成的值打印出来。
   *
   * 只打印「本次生成的」：用户自己配了 `WORKBUDDY_LOCAL_TOKEN` 就不需要看这段，
   * 也不该把用户的口令回显到日志里（日志可能被随手贴出去）。
   * 前缀写成 `WORKBUDDY_LOCAL_TOKEN=` 是刻意的 —— 用户可以直接整行复制进 .env。
   */
  if (!EXPLICIT_LOCAL_TOKEN) {
    console.log(`token      : 未配置 WORKBUDDY_LOCAL_TOKEN，已自动生成（重启会变）：`);
    console.log(`             WORKBUDDY_LOCAL_TOKEN=${LOCAL_TOKEN}`);
    console.log(`             要固定它，请把上面这行写进 .env；客户端就用这个值。`);
  }

  // ── 连接预热：listen 后立刻向上游开一条 TLS 连接放进池子 ─────────────────
  // 首次对话请求就免去 DNS + TCP + TLS 握手（实测 ~150ms）。只预热、不发请求体；
  // 失败完全无害 —— Agent 会在真正请求时重连。
  //
  // **必须尊重 CODEBUDDY_ENDPOINT**：它读的应该是"这次真正要打的上游"，
  // 而不是无条件去读登录文件里的 domain。否则在**测试/隔离环境**里会去预热
  // 真实外网地址（实测：本机直连 copilot.tencent.com 不通时，这条预热会一直
  // 挂着，把后续 chat 响应一起拖死 —— bridge.test.mjs 的账本截断用例因此
  // 固定超时，而桥的业务逻辑其实是对的）。
  try {
    const endpoint = (API_KEY || EXPLICIT_ENDPOINT)
      ? (EXPLICIT_ENDPOINT || 'https://copilot.tencent.com')
      : pickUpstream(JSON.parse(readFileSync(AUTH_PATH, 'utf8'))?.auth?.domain || '');
    const url = new URL(endpoint);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'GET',
      agent: agentFor(url.protocol),
      timeout: 8000,
    });
    // 拿到响应就算预热完成（连接已进池）；上游 4xx/5xx 都无所谓，我们要的只是连接
    req.on('response', (res) => { res.resume(); log(`warmed upstream connection to ${url.hostname}`); });
    req.on('error', () => {});   // 预热失败不吵不闹
    req.on('timeout', () => req.destroy());
    req.end();
  } catch { /* 登录文件读不出来等：真正请求时自会报错 */ }

  // ── 每日自动签到的定时器 ─────────────────────────────────────────────
  // 必须由**常驻的那一方**负责：桥会在后台一直活着，控制台不会。
  // 详见 startAutoCheckinTimer 的注释（实测：桥跑了一整天、零模型请求，
  // 结果一次签到都没发生）。
  startAutoCheckinTimer();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nworkbuddy-bridge stopped'); process.exit(0); });
}
