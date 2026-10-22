#!/usr/bin/env node
/**
 * 体检：**桥的出站指纹改写表，是否仍覆盖当前 DSH 的 system 提示词**。
 *
 * 为什么需要它
 * ------------
 * 2026-10-21 上游悄悄给 system 加了两句整句黑名单（DSH 的开场白与 Web GUI 那句），
 * 表现是「DSH 一用国内版就报 11-128」，而插件面板的对话测试照常 —— 定位它花了一轮
 * 完整排查（解 zstd 会话日志、拿真实 system、对账号回放、二分到句）。
 *
 * 本脚本把那套流程压成一条命令，做**离线**（不花额度）的第一道判断：
 *   1. 找出本机最新的 DSH 会话日志，解出**真实的 system 提示词**；
 *   2. 逐条检查 AUDIT_TEMPLATE_REWRITES 是否还有命中 —— 命中说明改写表在干活；
 *   3. 关键：报告 system 里**仍然原样存在**的可疑「身份/自称」句子，提示候选黑名单。
 *
 * 它不替代真机探测（`probe-dsh-fingerprint.mjs` 会真的打上游），但足够回答
 * 「这次 DSH 升级后，我们那两句改写还对不对得上」。
 *
 * 内存安全（重要）
 * ----------------
 * 会话文件可以到 **20MB+ 且是上千帧拼接的 zstd**。早期版本把整份文件解压成一个
 * 字符串再 `split('\n')`，在大会话上直接把机器内存打满（实测两次把 DSH 一起带崩）。
 * 现在改为：**逐帧解压、逐帧解析、立刻丢弃**，并「拿到完整 system 就停」——
 * 因为 agent 的 system 就在每一轮开头，根本不需要扫全文件。
 * 另有 `--max-frames` 与堆内存硬闸，任何情况下都不允许吃满内存。
 *
 * 用法
 * ----
 *   node tools/dev/check-fingerprint-coverage.mjs                 # 用最新会话
 *   node tools/dev/check-fingerprint-coverage.mjs --session-file <path>
 *   node tools/dev/check-fingerprint-coverage.mjs --system-file <导出的system.txt>
 *   node tools/dev/check-fingerprint-coverage.mjs --quiet         # 只输出结论行（给 CI/巡检用）
 *
 * 退出码：0 = 改写表覆盖正常（或无法取得 system 但已如实说明）；
 *          1 = 改写表没命中而 system 里仍有可疑自称句（疑似上游又加黑名单）；
 *          2 = 运行环境问题（文件读不了 / 内存闸触发）。
 *
 * 隐私：只读本机会话文件的 system 字段，**不打印对话内容**，只打印命中统计与句子摘要。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i += 1; } else { args.set(a.slice(2), true); }
}
const quiet = args.get('quiet') === true;
const say = (...a) => { if (!quiet) console.log(...a); };
const MAX_FRAMES = Number(args.get('max-frames') || 400);
const HEAP_LIMIT_MB = Number(args.get('heap-limit-mb') || 256);

/** 堆内存闸：超过上限立刻退出，绝不把宿主机的内存吃光。 */
function heapGuard(where) {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (mb > HEAP_LIMIT_MB) {
    console.error(`✖ 堆内存已 ${mb.toFixed(0)}MB（上限 ${HEAP_LIMIT_MB}MB），在 ${where} 处主动中止。`);
    console.error('  本脚本刻意不整文件解压；触发这个闸说明会话文件结构异常，请用 --system-file 手工指定。');
    process.exit(2);
  }
}

/* ── 1. 取 system 提示词 ─────────────────────────────────────────────── */

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 逐帧解压并**立即**把每帧交给回调，回调返回 true 即停止。
 *
 * 关键点：绝不把解压结果累积到数组里（那是旧版 OOM 的根源）。每帧处理完就丢，
 * 峰值内存只有「最大单帧 + 一份最佳 system」。
 */
function eachFrame(buf, onFrame) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  const limit = Math.min(starts.length, MAX_FRAMES);
  for (let k = 0; k < limit; k += 1) {
    const start = starts[k];
    let yielded = false;
    // 帧边界：下一个 magic 最可信；假 magic 时向后多试两个候选
    for (let j = k + 1; j <= Math.min(k + 3, starts.length); j += 1) {
      const end = j < starts.length ? starts[j] : buf.length;
      let text;
      try { text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch { continue; }
      yielded = true;
      if (onFrame(text) === true) return { frames: k + 1, stopped: true, total: starts.length };
      break;
    }
    if (!yielded) continue;
    if ((k & 63) === 0) heapGuard(`第 ${k} 帧`);
  }
  return { frames: limit, stopped: false, total: starts.length };
}

/** 从单帧文本里挑出 system 消息的文本。 */
function systemInFrameText(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('system/message') === -1) continue; // 先做廉价排除
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== 'system/message') continue;
    const content = ev?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const s = content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (s) found.push(s);
  }
  return found;
}

function systemFromSessionFile(file) {
  const buf = readFileSync(file);
  let best = '';
  const stat = eachFrame(buf, (text) => {
    for (const s of systemInFrameText(text)) {
      if (s.length > best.length) best = s;
    }
    // DSH 的 agent system 很长（实测 ~10KB）；拿到一条够长的就早停，省内存省时间
    return best.length >= 2000;
  });
  return { system: best, stat };
}

function newestSessionFile(root) {
  let newest = null;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.zstd')) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: p, mtimeMs: st.mtimeMs, size: st.size };
    }
  };
  walk(root);
  return newest;
}

let system = '';
let source = '';
let frameInfo = null;
if (args.get('system-file')) {
  source = `--system-file ${args.get('system-file')}`;
  system = readFileSync(args.get('system-file'), 'utf8');
} else if (args.get('session-file')) {
  source = `--session-file ${args.get('session-file')}`;
  const r = systemFromSessionFile(args.get('session-file'));
  system = r.system;
  frameInfo = r.stat;
} else {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  const hit = newestSessionFile(root);
  if (hit) {
    source = `最新会话 ${hit.file}（${new Date(hit.mtimeMs).toISOString()}，${(hit.size / 1024 / 1024).toFixed(1)}MB）`;
    const r = systemFromSessionFile(hit.file);
    system = r.system;
    frameInfo = r.stat;
  } else {
    source = `没找到会话日志（找过 ${root}）`;
  }
}

if (!system) {
  say(`ℹ️ 取不到 system 提示词：${source}`);
  say('   这不算失败 —— 换 --system-file 传入一份导出的 system 即可；或先跑一次 DSH 会话。');
  process.exit(0);
}
if (frameInfo?.stopped) {
  say(`（逐帧扫描 ${frameInfo.frames} 帧后已拿到 system；该文件共 ${frameInfo.total} 帧，未全量解压）`);
}
say(`system 来源：${source}`);
say(`system 长度：${system.length} 字符`);

/* ── 2. 读桥的改写表（从源码解析，避免为了拿常量而起进程）──────────── */
const bridgeSrc = readFileSync(new URL('../../bridge/workbuddy-bridge.mjs', import.meta.url), 'utf8');
const block = /const AUDIT_TEMPLATE_REWRITES = \[([\s\S]*?)\n\];/.exec(bridgeSrc);
if (!block) {
  console.error('✖ 解析不出 AUDIT_TEMPLATE_REWRITES（桥源码结构变了？）');
  process.exit(2);
}

/*
 * 规则解析：改写表里的字符串字面量**单双引号混用** —— Claude Code 那条含撇号
 * （`Anthropic's`），只能用双引号包；其余用单引号。只认单引号会把那条整条漏掉，
 * 于是「覆盖检查」假装它在、实际从没被检查过。这里两种引号都认。
 */
const STR_LIT = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;
const RULE_RE = new RegExp(String.raw`\[\s*${STR_LIT}\s*,\s*${STR_LIT}\s*,?\s*\]`, 'g');
const unescapeStr = (v) => (v === undefined ? undefined : v.replace(/\\(['"\\])/g, '$1'));
const rules = [];
for (const m of block[1].matchAll(RULE_RE)) {
  const from = unescapeStr(m[1] !== undefined ? m[1] : m[2]);
  const to = unescapeStr(m[3] !== undefined ? m[3] : m[4]);
  if (from && to) rules.push({ from, to });
}
say(`改写表：${rules.length} 条规则`);

/* ── 3. 逐条检查覆盖情况 ────────────────────────────────────────────── */
let hitRules = 0;
say('');
for (const [i, r] of rules.entries()) {
  const hits = system.split(r.from).length - 1;
  if (hits > 0) hitRules += 1;
  say(`  ${String(i + 1).padStart(2)}. ${hits > 0 ? '命中' : '未命中'} ${String(hits).padStart(2)} 次 │ ${r.from.slice(0, 62)}`);
  if (hits > 0) say(`      改写为 → ${r.to.slice(0, 62)}`);
}

/* ── 4. 可疑自称句扫描：system 里仍有、且不像普通业务文案的句子 ──────── */
const SUSPICIOUS = [
  /You are an AI agent[^.\n]{0,80}/g,
  /You are interacting with the user[^.\n]{0,120}/g,
  /You are a coding agent[^.\n]{0,80}/g,
];
const candidates = new Set();
for (const re of SUSPICIOUS) {
  re.lastIndex = 0; // 带 g 的正则复用前必须复位；否则上次残留的 lastIndex 会漏掉开头
  for (const m of system.matchAll(re)) {
    const s = m[0].trim();
    if (s.length >= 24) candidates.add(s);
  }
}
/*
 * 过滤噪声，只留「真的可能是新黑名单」的句子：
 *   1. 已被某条**改写前**原文覆盖 → 改写表正在处理它，不是待办；
 *   2. 是某条**改写后**形态的一部分 → 那是桥自己合成出来的句子，本来就安全；
 *   3. 属于模型名描述（含 deepseek-v4 这类版本串）→ 上游文案，非自称句；
 *   4. 短残片：黑名单按**整句**匹配（单独 `DeepSeek Harness` 是放行的），
 *      从句级残片不可能是真身，报出来只会稀释信号。
 */
const coveredByRewrite = [...candidates].filter((c) => {
  if (rules.some((r) => c.includes(r.from))) return false;
  if (rules.some((r) => r.to.includes(c) || c.includes(r.to))) return false;
  if (/deepseek-v\d/i.test(c)) return false;
  return /^You are\b/.test(c) || c.length > 60;
});

say('');
if (coveredByRewrite.length) {
  say('⚠️ system 里还有这些**自称类**句子没被改写表覆盖（候选新黑名单，需真机复核）：');
  for (const c of coveredByRewrite) say(`   · ${c}`);
  say('   复核命令：node tools/dev/probe-dsh-fingerprint.mjs --system-file <system.txt> --port 8790');
} else {
  say('✅ 没发现未覆盖的自称类句子。');
}

say('');
if (hitRules === 0) {
  say('⚠️ 结论：本次 system **一条改写都没命中**。若 DSH 升级过、或用户报 11-128，');
  say('   说明改写表已对不上新提示词 —— 用 probe-dsh-fingerprint.mjs 重新定位。');
  process.exit(coveredByRewrite.length ? 1 : 0);
}
say(`✅ 结论：改写表命中 ${hitRules} 条规则，覆盖正常。`);
process.exit(0);
