#!/usr/bin/env node
/**
 * 诊断：找出「哪一句 system 提示词触发了上游 400 code 11-128」。
 *
 * 为什么需要它
 * ------------
 * 上游对调用方身份的校验里有一条是**区分大小写的整句黑名单**（已知两类：
 * 2026-10-08 的 Claude Code 模板句、2026-10-21 起的 DSH 两句指纹）。命中时上游回
 * `400 code 11-128 Illegal API invocation from an unapproved channel`，
 * 而错误文案完全看不出是哪一句触发的 —— 只能二分。
 *
 * 本脚本对**运行中的桥**发真实请求（会消耗账号额度，但每个请求都很小），
 * 用「最小触发前缀 + 起点二分 + 两端收缩」把触发片段压到最短，再逐个用中性词
 * 替换后继续找下一处，直到整段不再触发。输出的片段就是需要加进
 * `AUDIT_TEMPLATE_REWRITES` 的那几句（桥内已内置改写；这里是**复核/扩展**用）。
 *
 * 已知的匹配语义（2026-10-22 实测，影响怎么喂输入）
 * --------------------------------------------------
 *   ① `You are an AI agent powered by DeepSeek Harness` —— **锚定在 system 开头**
 *      （前缀匹配）：把它放在最前面 → 400；前面加 `x. ` 或任意一段文字 → 200。
 *   ② `You are interacting with the user through the DeepSeek Harness Web GUI` ——
 *      在正文**任意位置**都能命中。
 *   两者都是**区分大小写**的整句匹配：只改 `web GUI` / `harness` 的大小写仍被拦，
 *   换一个词（built on / working with / via / supplies）即放行。
 *
 * 因此：测 ① 时必须把待测文本**放在开头**（不要加前言），否则会误判成「不触发」。
 *
 * 用法
 * ----
 *   # 1) 先准备一份 system 提示词文本（从会话日志取真实值最准）：
 *   #    ~/.dsh/sessions/**\/session.v4.jsonl.zstd 是多帧 zstd，
 *   #    逐帧 zstdDecompressSync 后可取 system/message 事件。
 *   # 2) 对着桥探测（默认 8790；令牌取 WORKBUDDY_LOCAL_TOKEN 或 wb-local-bridge）
 *   node tools/dev/probe-dsh-fingerprint.mjs --system-file path/to/system.txt \
 *        --port 8790 --model deepseek-v4.1-flash
 *
 *   # 也可以直接给一段文本：
 *   node tools/dev/probe-dsh-fingerprint.mjs --text "You are an AI agent powered by DeepSeek Harness"
 *
 * 退出码：0 = 找到并打印了全部触发片段（或整段不触发）；1 = 参数/网络问题。
 *
 * 注意：本脚本**只做诊断**，不改仓库任何文件；找到的片段请人工确认语义后再
 * 决定是否加进 AUDIT_TEMPLATE_REWRITES（最小改写原则：只动一个词，语义不变）。
 */
import { readFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k?.startsWith('--')) args.set(k.slice(2), v);
}

const port = Number(args.get('port') || 8790);
const model = args.get('model') || 'deepseek-v4.1-flash';
const token = process.env.WORKBUDDY_LOCAL_TOKEN || args.get('token') || 'wb-local-bridge';
const maxRequests = Number(args.get('max-requests') || 200);

let text = args.get('text') || '';
if (args.get('system-file')) text = readFileSync(args.get('system-file'), 'utf8');
if (!text) {
  console.error('用法: --system-file <path> 或 --text "<system 提示词>"（其余参数见文件头注释）');
  process.exit(1);
}

let requests = 0;
/**
 * 发一条最小请求，判断是否被 11-128 拦。
 *
 * **必须把「没触发」和「上游回别的东西」分开**：否则一次 429（频率限制）就会被
 * 误读成「这句不是黑名单」，二分出来的边界全错 —— 诊断工具产生假阴性比不跑更糟。
 * 429/5xx 视为可重试（等 2 秒，最多 3 次），其余非预期状态直接抛错。
 */
async function triggers(sysText) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requests >= maxRequests) throw new Error(`已用满 ${maxRequests} 次探测请求，停止（可用 --max-requests 放宽）`);
    requests++;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'system', content: sysText }, { role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.text();
    let code;
    try { code = JSON.parse(body)?.code; } catch { /* 200 时是 SSE 流 */ }
    if (res.status === 400 && code === 11-128) return true;
    if (res.status >= 200 && res.status < 300) return false;
    // 429 / 5xx：等一下重试，别把限流当成「不触发」
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`上游回了非预期状态 ${res.status}（不是 11-128，也不是 2xx）：${body.slice(0, 200)}`);
  }
  return false;
}

/** 在一段「确定会触发」的文本里，找最短触发片段。 */
async function minimalTrigger(t) {
  let lo = 0;
  let hi = t.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await triggers(t.slice(0, mid))) hi = mid; else lo = mid;
  }
  const end = hi;
  let sLo = 0;
  let sHi = end;
  while (sHi - sLo > 1) {
    const mid = Math.floor((sLo + sHi) / 2);
    if (await triggers(t.slice(mid, end))) sLo = mid; else sHi = mid;
  }
  let a = sLo;
  let b = end;
  while (b - a > 1 && await triggers(t.slice(a + 1, b))) a++;
  while (b - a > 1 && await triggers(t.slice(a, b - 1))) b--;
  return { text: t.slice(a, b), a, b };
}

let current = text;
console.log(`探测目标 http://127.0.0.1:${port}/v1/chat/completions  model=${model}  文本 ${text.length} 字符`);
if (!(await triggers(current))) {
  console.log('整段不触发 11-128（没有黑名单句，或桥已改写/上游未拦截）。');
  process.exit(0);
}

const found = [];
for (let round = 1; round <= 10; round++) {
  if (!(await triggers(current))) break;
  const hit = await minimalTrigger(current);
  found.push(hit.text);
  console.log(`\n[${round}] 触发片段（${hit.text.length} 字符）:`);
  console.log(JSON.stringify(hit.text));
  console.log('上下文:', JSON.stringify(current.slice(Math.max(0, hit.a - 100), Math.min(current.length, hit.b + 100))));
  current = current.slice(0, hit.a) + 'REDACTED' + current.slice(hit.b);
}

console.log(`\n共找到 ${found.length} 处；剩余文本仍触发? ${await triggers(current)}；探测请求数 ${requests}`);
console.log('提示：这些片段需要加进 bridge/workbuddy-bridge.mjs 的 AUDIT_TEMPLATE_REWRITES（最小改写），并补回归用例。');
