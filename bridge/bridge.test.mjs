/**
 * 本地桥的**合约测试**：起一个真实桥进程，用真实 HTTP 打它。
 *
 *   node --test bridge/
 *
 * 为什么这么测：`bridge/workbuddy-bridge.mjs` 是"启动即监听"的脚本，没有导出
 * 可直接单测的单元；而它对外的东西恰恰是**HTTP 契约**（面板、控制台、dsh 插件
 * 都按这些端点对接）。所以这里起真进程、打真请求 —— 验的是别人实际依赖的那层。
 *
 * 隔离措施（绝不碰使用者的真实凭据与额度）：
 *   - 临时目录里放一份**假的登录文件**，用 WORKBUDDY_AUTH_FILE 指过去；
 *   - 端口用 0 让内核分配，避免和正在跑的 8790 撞车；
 *   - 临时目录里的 usage.jsonl 是独立账本，不写使用者的那份；
 *   - 不触达上游：这里只验"不需要上游就能答"的契约（鉴权、/、模型目录形状、
 *     计数类端点），需要真实额度的 /v1/chat/completions 由 dsh-plugin 的
 *     adapter 测试用打桩上游覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BRIDGE = join(REPO, 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-abc';

/**
 * 一份"看起来像登录文件"的假凭据：桥能读结构，但拿不到真实令牌。
 *
 * 注意这里是**扁平**的（没有 `auth` 包裹层）。这不是笔误，而是刻意保留的：
 * 桥读的是 `raw.auth.accessToken`，扁平文件会让 `readStoredAuth()` 抛
 * 「login file has no accessToken」—— 正好被 `/health` 那条用例用来复现
 * 「凭据异常」。
 */
const FAKE_AUTH = {
  userId: 'test-account-000000',
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  endpoint: 'https://example.invalid',
  domain: 'example.invalid',
  expiresAt: Date.now() + 30 * 86_400_000,
};

/**
 * 一份**结构正确**的假登录文件：`auth` 包裹层齐全，`readStoredAuth()` 能读通。
 *
 * 需要它的场景（如 D3 的模型预校验）必须先让桥成功读到凭据，否则抓目录那步
 * 直接抛异常、`catalogCache` 永远是空的，预校验按设计放行就测不到。
 * 令牌本身仍是假的 —— 断言的是「桥怎么处理目录」，不是「能不能打通上游」。
 */
const READABLE_FAKE_AUTH = {
  auth: {
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    domain: 'example.invalid',
    expiresAt: Date.now() + 30 * 86_400_000,
  },
};

/**
 * 起一个隔离的桥实例。
 * @param {object} [env] 额外环境变量
 * @param {object} [opts]
 * @param {object} [opts.auth] 写入登录文件的凭据（默认 FAKE_AUTH）。
 *   `readStoredAuth()` 要求 `auth.accessToken` 存在；传 READABLE_FAKE_AUTH
 *   可让桥"读得到凭据"，从而走到抓目录 / 打上游那几步。
 * @returns {Promise<{baseUrl: string, dir: string, out: () => string, stop: () => Promise<void>}>}
 */
/**
 * 向内核要一个**空闲端口**。
 *
 * 为什么不能用随机数：`20000 + Math.random()*20000` 只是"看起来不会撞"，
 * 它**不检查占用**。实测在 CI 上撞了（`EADDRINUSE: 127.0.0.1:37736`，
 * 只有 ubuntu 那个 job 挂，windows/macos 过 —— 典型的 flaky）。
 *
 * 也不能"先探一个空闲端口再用"：探测与真正 listen 之间有空窗，别的进程可能
 * 抢占（原注释担心的正是这个）。**唯一可靠的做法是让内核分配**：先 listen(0)
 * 拿到端口号，记下来，然后关掉 —— 紧接着由子进程去 listen 同一个端口。
 * 空窗仍然存在，但只有"探测与关闭之间"那一瞬，且端口号由内核从未用段里挑，
 * 比随机数撞车的概率低好几个数量级。
 *
 * 注意：不能把 server 一直留着占位 —— 子进程要自己 listen 同一个端口，
 * 父进程占着就会 EADDRINUSE。
 */
async function freePort() {
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/**
 * 起一个测试用桥。**端口被抢时自动重试**。
 *
 * `freePort()` 由内核分配端口，但"关掉探测 server"与"子进程 listen"之间仍有
 * 极小的空窗 —— 别的进程可能正好抢占。这类失败是**环境噪声**，不该让整个
 * 测试套件变红（实测 CI 上就红过一次：`EADDRINUSE: 127.0.0.1:37736`）。
 *
 * 重试只针对 EADDRINUSE，其它错误（桥启动崩溃、配置错）照常抛 ——
 * 不能把真故障也吞掉。
 */
async function startBridge(env = {}, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await startBridgeOnce(env, opts);
    } catch (e) {
      lastErr = e;
      if (!/EADDRINUSE/.test(String(e?.message || e))) throw e;
      // 端口被抢：换一个再试
    }
  }
  throw lastErr;
}

async function startBridgeOnce(env = {}, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-test-'));
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify(opts.auth || FAKE_AUTH));

  const port = await freePort();
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: dir, // 工作目录放在临时目录：账本/日志都落在里面
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_AUTO_CHECKIN: '0', // 别在测试里触发签到
      WORKBUDDY_LOG: '0',
      ...env,
    },
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // 子进程的输出要带进错误里：桥自己 listen 失败时打的是 `EADDRINUSE`，
    // 上层靠这个字符串决定要不要换个端口重试（见 startBridge）。
    if (child.exitCode !== null) throw new Error(`桥提前退出（code ${child.exitCode}）：\n${output}`);
    try {
      const res = await fetch(baseUrl + '/', { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1500) });
      if (res.status > 0) {
        return {
          baseUrl,
          dir,
          out: () => output,
          stop: () => new Promise((resolve) => {
            child.once('exit', resolve);
            child.kill();
            setTimeout(resolve, 3000);
          }),
        };
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`桥未在 20 秒内就绪：\n${output}`);
}

/**
 * 用**原始 socket** 发一个请求，返回状态码。
 *
 * 为什么不用 `fetch`：**Fetch 规范把 `Host` 列为禁止头**，用它根本发不出去 ——
 * 排查「畸形 Host」时用 `fetch` 只会得到假阴性（第一次就是这么误判的）。
 */
function rawStatus(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── 打桩上游：验证「桥实际发了什么出去」─────────────────────────────────
/**
 * 记录收到的每个请求（headers/body），回最小 SSE。
 *
 * 配合 `CODEBUDDY_ENDPOINT` 把桥的出站流量全部导向这里 —— 审计模板改写、
 * 出站身份指纹、限流计数之类的断言都靠它（不触真上游、不耗额度）。
 *
 * @param {string[]} [models] `/v2/enterprises/personal/models` 返回的模型 id
 */
async function startStubUpstream(models = ['stub-model'], opts = {}) {
  const seen = [];
  let chatCallIndex = 0;
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { models: models.map((id) => ({ id, maxInputTokens: 128000, maxOutputTokens: 4096 })) },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ headers: req.headers, body, at: Date.now() });
        /*
         * `opts.chatRaw`：模拟「上游 HTTP 200，但返回的不是 SSE」。
         * 网关把错误包成 200 的 HTML 是真实会发生的（见 BUG-2 的用例）。
         */
        /*
         * `opts.chatSilentMs`：先静默这么多毫秒**一个字节都不发**，再正常流式回。
         * 用来验证「上游长时间不出声时，桥是否会向客户端发 SSE 心跳」——
         * 上游长上下文预填充/长时间 reasoning 时就是这个形态。
         */
        if (opts.chatSilentMs > 0) {
          res.writeHead(opts.chatSilentStatus || 200, {
            'content-type': opts.chatSilentType || 'text/event-stream',
          });
          res.flushHeaders?.();
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
            res.end('data: [DONE]\n\n');
          }, opts.chatSilentMs);
          return;
        }
        if (opts.chatRaw !== undefined) {
          res.writeHead(opts.chatStatus || 200, { 'content-type': opts.chatType || 'text/html' });
          return res.end(opts.chatRaw);
        }
        /*
         * `opts.chatResponses`：**按次序**脚本化聊天响应，用来打「上游先失败、重试后成功」这类
         * 重试」这类时序行为。数组元素二选一：
         *   - 字符串 `'sse'`      → 正常流式回答
         *   - `{ status, body }`  → 指定状态码与响应体（对象会被 JSON 序列化）
         * 用完后**重复最后一个元素**（所以「一直 11128」只写一条即可）。
         * 每条请求都带 `at`（毫秒时间戳），供断言重试真的等过退避。
         */
        if (Array.isArray(opts.chatResponses) && opts.chatResponses.length > 0) {
          const idx = Math.min(chatCallIndex, opts.chatResponses.length - 1);
          chatCallIndex += 1;
          const step = opts.chatResponses[idx];
          if (step !== 'sse') {
            res.writeHead(step.status || 400, { 'content-type': 'application/json' });
            return res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
          }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    /*
     * 兜底 404 也必须**先把请求体读完**再响应。
     *
     * 为什么：Node 的 HTTP 服务在"还没读完请求体就 end 响应"时，这条 keep-alive
     * 连接会进入不一致状态 —— 后一个复用它的请求**永远收不到响应**。
     * 实测代价：`refreshAuth`（用全局 fetch，走该兜底分支拿 404）之后，桥重试
     * chat 会复用这条被污染的连接，于是整个请求挂死；表现为「401 + text/html」
     * 用例固定卡满测试超时（120 秒），而桥的业务逻辑其实是对的。
     */
    req.resume();
    req.on('end', () => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    seen,
    close: () => new Promise((r) => srv.close(r)),
  };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test('桥：端点契约 —— 鉴权、身份、模型目录形状', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    // ① 无令牌 → 401（本地端口默认要求令牌）
    const noAuth = await fetch(bridge.baseUrl + '/v1/models');
    assert.equal(noAuth.status, 401, '没有 Authorization 时必须是 401');

    // ② 错令牌 → 401
    const badAuth = await fetch(bridge.baseUrl + '/v1/models', { headers: { authorization: 'Bearer wrong' } });
    assert.equal(badAuth.status, 401);

    // ③ 身份端点：给插件/控制台用来确认"端口上的确实是我们"
    const root = await (await fetch(bridge.baseUrl + '/', { headers: auth })).json();
    assert.ok(root.name || root.service || root.version, 'GET / 必须能自报名号');
    assert.match(JSON.stringify(root), /workbuddy/i, '身份信息里应当有 workbuddy 字样');

    // ④ 模型目录：OpenAI 兼容形状（object/data + 每项 id）
    const modelsRes = await fetch(bridge.baseUrl + '/v1/models', { headers: auth });
    assert.equal(modelsRes.status, 200);
    const models = await modelsRes.json();
    assert.ok(Array.isArray(models.data), '/v1/models 必须返回 {data: [...]}（OpenAI 兼容）');
    assert.ok(models.data.length > 0, '假凭据下也应当有内置的模型目录（不依赖上游）');
    for (const m of models.data) {
      assert.equal(typeof m.id, 'string', '每个模型必须有字符串 id');
      assert.ok(m.id.length > 0);
    }

    // ⑤ 计数类端点必须是"不需要上游就能答"的：不能挂
    for (const endpoint of ['/v1/usage', '/v1/requests']) {
      const res = await fetch(bridge.baseUrl + endpoint, { headers: auth, signal: AbortSignal.timeout(8000) });
      assert.equal(res.status, 200, `${endpoint} 应当直接 200（本地账本，不需要上游）`);
      const body = await res.json();
      assert.equal(typeof body, 'object');
    }

    // ⑥ 未知路径 → 404，且是 JSON（不是 HTML 错误页）
    const missing = await fetch(bridge.baseUrl + '/nope', { headers: auth });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /json/, '错误也必须是 JSON，调用方才能解析');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：账本是本地文件，且不写使用者的那份', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    const usage = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(typeof usage, 'object');
    // 临时目录里应当出现（或可创建）账本文件；关键是**工作目录隔离**
    const localLedger = join(bridge.dir, 'usage.jsonl');
    const repoLedger = join(REPO, 'bridge', 'usage.jsonl');
    const repoLedgerBefore = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8').length : -1;

    // 触发一次"清空账本"（不需要上游）
    const cleared = await fetch(bridge.baseUrl + '/v1/usage', { method: 'DELETE', headers: auth });
    assert.ok([200, 204].includes(cleared.status), `清空账本应当成功，实际 ${cleared.status}`);

    const repoLedgerAfter = existsSync(repoLedger) ? readFileSync(repoLedger, 'utf8').length : -1;
    assert.equal(repoLedgerAfter, repoLedgerBefore, '测试绝不能改到使用者的真实账本');

    // 清空后仍可读，且是空账本
    const after = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    const total = after.total || after.usage?.total || {};
    assert.ok((total.calls || 0) === 0, '清空后调用数应为 0');
    assert.ok(localLedger === join(bridge.dir, 'usage.jsonl'));
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：无凭据时 /health 如实报 503 并带上原因（插件据此判"凭据异常"）', { timeout: 90_000 }, async () => {
  // 故意指向一个不存在的登录文件：模拟"WorkBuddy 没登录/登录文件被删"
  const bridge = await startBridge({ WORKBUDDY_AUTH_FILE: 'C:\\definitely\\missing\\auth.info' });
  try {
    const res = await fetch(bridge.baseUrl + '/health', { headers: auth, signal: AbortSignal.timeout(8000) });
    assert.equal(res.status, 503, '读不出凭据时 /health 必须是 503（不是 200，也不能崩）');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error, '必须给出原因，调用方才能显示给用户');
    assert.ok(body.authFile, '必须回带它尝试读的登录文件路径（便于排查）');
    // 关键：进程还活着，且其它端点仍可用（不是整个桥挂掉）
    assert.equal((await fetch(bridge.baseUrl + '/', { headers: auth })).status, 200, '凭据坏了也应当能自报名号');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：超大请求体必须是 413 JSON，且桥仍然可用（D2）', { timeout: 90_000 }, async () => {
  // 把上限压到 64KB，这样才能用一个几 MB 的 body 稳定触发它 —— 真按 32MB 默认值
  // 测，就得在测试里造 32MB 的字符串（慢、吃内存），而这里验的是**拒绝逻辑**，
  // 不是那个具体数值。上限可配正是为这种场景留的。
  const bridge = await startBridge({ WORKBUDDY_MAX_BODY_BYTES: String(64 * 1024) });
  try {
    // 一个远超上限的 body：桥会在读到 64KB 时就判定超限、停止消费，并回 413。
    // 注意这里**必须**断言拿到的是 413 而不仅仅是"连接断了" —— 早期实现在
    // readBody 里直接 req.destroy()，客户端只会收到 ECONNRESET，413 根本发不
    // 出来。这正是本用例要钉住的行为。
    const oversized = 'x'.repeat(256 * 1024);
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: oversized }] });

    let status = 0;
    let payload = null;
    let contentType = '';
    try {
      const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      status = res.status;
      contentType = res.headers.get('content-type') || '';
      payload = await res.json().catch(() => null);
    } catch (e) {
      // 连接被掐断（ECONNRESET）说明 413 没发出来 —— 契约要求的是明确的
      // 413 JSON，所以这里直接判失败，而不是"连接异常也算过"。
      assert.fail(`超大 body 应当拿到 413 JSON 响应，实际连接异常：${e.message}`);
    }

    assert.equal(status, 413, `超大 body 必须是 413，实际 ${status}`);
    assert.match(contentType, /json/, '413 也必须是 JSON（调用方才能解析）');
    assert.ok(payload?.error?.message, '413 必须带可读的错误说明');
    assert.match(payload.error.message, /too large|limit/i, '错误信息要说明是"太大"而不是别的');

    // 关键：拒绝一次超大请求之后，桥自己必须还活着（不是被那个 body 打崩）
    const stillUp = await fetch(bridge.baseUrl + '/', { headers: auth, signal: AbortSignal.timeout(8000) });
    assert.equal(stillUp.status, 200, '拒绝超大 body 之后桥必须仍然可用');

    // 回归：**大 body 下的 413 不能变成 ECONNRESET**。
    // 早期实现在 413 分支里 destroy()，客户端还没读到响应就被 RST 掉 ——
    // 实测 8MB 时 10/10 丢失。修法是回完 413 后 req.resume() 把剩余字节读掉。
    // 这里用 8MB（远超 64KB 上限）连打 3 次，每次都必须拿到 413。
    const big = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'y'.repeat(8 * 1024 * 1024) }],
    });
    for (let i = 0; i < 3; i += 1) {
      let bigStatus = 0;
      try {
        const r = await fetch(bridge.baseUrl + '/v1/chat/completions', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: big,
          signal: AbortSignal.timeout(20000),
        });
        bigStatus = r.status;
        await r.arrayBuffer().catch(() => {});
      } catch (e) {
        assert.fail(`第 ${i + 1} 次 8MB 请求应当拿到 413，实际连接异常：${e.message}`);
      }
      assert.equal(bigStatus, 413, `第 ${i + 1} 次 8MB 请求必须是 413（不能被 RST 吞掉）`);
    }
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：目录非空时拒绝未知模型，且不打上游（D3）', { timeout: 90_000 }, async () => {
  // 起一个**打桩上游**：它按上游的目录形状回模型清单，并记录 chat 有没有被调过。
  // 为什么必须打桩、不能沿用 example.invalid：预校验只在「目录已知」时生效，
  // 而目录只有在真正抓到上游之后才会被填上（FEATURED 补全也在那之后）。
  // 用假域名的话缓存永远是空的，预校验按设计放行，这个用例就白测了。
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: {
          models: [
            { id: 'stub-known', name: 'Stub Known', maxInputTokens: 128000, maxOutputTokens: 8192 },
            { id: 'stub-other', name: 'Stub Other', maxInputTokens: 32000, maxOutputTokens: 4096 },
          ],
        },
      }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    // 先打一次 /v1/models?all=1：这一步会把上游目录真的抓进 catalogCache，
    // 从而让预校验进入「目录非空」这条分支。
    const models = await (await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth })).json();
    const ids = models.data.map((m) => m.id);
    assert.ok(ids.includes('stub-known'), `前置条件：目录里应当有 stub-known，实际 ${ids.join(',')}`);

    const chatCallsBefore = calls.chat;

    // ① 未知模型 → 400，且**上游 chat 一次都没被打**
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'definitely-not-a-real-model-id',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(res.status, 400, '未知模型必须被本地拦成 400（不是打一次上游再报错）');
    assert.equal(calls.chat, chatCallsBefore, '预校验必须在**打上游之前**拦下，上游 chat 不能被调过');
    const body = await res.json();
    const message = body?.error?.message || '';
    assert.match(message, /not in the current catalog/i, '错误信息必须说明"不在当前目录中"');
    assert.match(message, /\/v1\/models/, '必须给出可操作提示（怎么看到完整目录）');
    assert.match(message, /WORKBUDDY_SKIP_MODEL_PREFLIGHT/, '必须告诉用户逃生开关，目录滞后时能放行');

    // ② 必须落账：否则这次拒绝在控制台"最近请求"里看不见（D3 的初衷之一）
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    const rejected = (requests.requests || []).find((r) => r.model === 'definitely-not-a-real-model-id');
    assert.ok(rejected, '被拒的请求必须记进账本，否则控制台看不到这次拒绝');
    assert.equal(rejected.ok, false, '这条账必须是失败态');
    assert.equal(rejected.status, 400, '账上要能看出是 400');

    // ③ 目录里的模型必须放行（不能把合法模型一起误杀）
    const known = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-known', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(known.status, 200, '目录里确实存在的模型必须放行到上游');
    assert.equal(calls.chat, chatCallsBefore + 1, '放行的模型应当真的打了一次上游');

    // ④ 桥**对外承诺过**的精选模型也不能被否掉：/v1/models 在目录为空时回退到
    //    FEATURED 定义，客户端可能正拿着这些 id 来调。预校验只查 catalogCache
    //    的话，就会出现「桥让你选，转头又说不在目录里」的自相矛盾。
    const featured = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(featured.status, 200, 'FEATURED 里的模型必须放行（桥自己列出来过它们）');

    // ⑤ 逃生开关：关掉预校验后，同一个未知模型不能再被本地拦下
    const bridge2 = await startBridge(
      { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_SKIP_MODEL_PREFLIGHT: '1' },
      { auth: READABLE_FAKE_AUTH },
    );
    try {
      await fetch(bridge2.baseUrl + '/v1/models?all=1', { headers: auth });
      const res2 = await fetch(bridge2.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'still-not-real', messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      });
      assert.notEqual(res2.status, 400, '逃生开关打开时，未知模型不能再被预校验拦下');
    } finally {
      await bridge2.stop();
      rmSync(bridge2.dir, { recursive: true, force: true });
    }
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
    await new Promise((r) => upstream.close(r));
  }
});

test('桥：上游目录拿不到模型时，未知模型必须放行（D3 不能误杀）', { timeout: 120_000 }, async () => {
  // 这条用例钉住 D3 最容易写错的地方，也是 verifier 报出的**真实误杀**。
  //
  // 背景：fetchCatalog 末尾会用 FEATURED **无条件**补全，所以只要目录端点不返回
  // 5xx，catalogCache.models 就至少躺着 3 个精选模型 —— 但那**不代表桥认识目录**。
  // 若预校验拿 "models.length > 0" 当启用条件，下面这些常见故障下所有不在
  // FEATURED 里的真实可用模型都会被本地 400 拦下、一次上游都不打。
  //
  // 场景全部取自 verifier 的 probe-d3-realistic.mjs，都是上游**真实可能**出现的
  // 非 5xx 失败：代理没放通目录端点（404）、字段改名、返回空数组、模型全被过滤。
  const CASES = [
    ['目录端点 404（代理/WAF 未放通）', 404, () => ({ code: 404, message: 'not found' })],
    ['目录 200 但 models 是空数组', 200, () => ({ code: 0, data: { models: [] } })],
    ['目录 200 但没有 models 字段（上游改名）', 200, () => ({ code: 0, data: { agents: [], other: 1 } })],
    ['目录 200 但模型全被 supportsToolCall:false 挡掉', 200, () => ({
      code: 0,
      data: { models: [{ id: 'no-tools-a', maxInputTokens: 1000, maxOutputTokens: 100, supportsToolCall: false }] },
    })],
  ];

  for (const [label, status, bodyFn] of CASES) {
    const hits = { chat: 0 };
    const upstream = createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/v2/chat/completions') {
        hits.chat += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      }
      if (path === '/v3/config') {
        // /v3/config 给 200 空表：贴近真实（它通常不是主目录端点）
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
      }
      if (path === '/v2/enterprises/personal/models') {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(bodyFn()));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

    const bridge = await startBridge(
      { CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
      { auth: READABLE_FAKE_AUTH },
    );
    try {
      // 触发一次目录抓取（会失败/落空），再给后台刷新一点时间
      await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth, signal: AbortSignal.timeout(15000) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));

      // 这个 id 上游 chat 完全能答（stub 对任何 model 都回 200），只是目录里没有。
      // 桥对目录一无所知时必须**原样转发**，而不是自作聪明地 400。
      const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'available-but-unlisted-model', messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      });

      assert.notEqual(res.status, 400, `${label}：目录未知时绝不能 400 误杀（实际 ${res.status}）`);
      assert.equal(hits.chat, 1, `${label}：目录未知时必须把请求原样转发给上游（chat 被调 ${hits.chat} 次）`);
    } finally {
      await bridge.stop();
      rmSync(bridge.dir, { recursive: true, force: true });
      await new Promise((r) => upstream.close(r));
    }
  }
});

test('桥：账本改用内存镜像后，/v1/usage 与 /v1/requests 的形状不变（D4）', { timeout: 90_000 }, async () => {
  const bridge = await startBridge();
  try {
    // 先在**桥外面**写一份账本，模拟"上次运行留下的真实历史"。
    // 关键是这份文件必须在桥读过它之前就存在，从而同时覆盖两条路径：
    //   - 冷启动时 usageLines === null，必须先初始化镜像
    //   - 镜像建起来之后，后续读取应当与直接解析文件逐字段一致
    const now = Date.now();
    const rows = [
      { t: now - 3600_000, model: 'deepseek-v4.1-flash', stream: false, ms: 120, ok: true, promptTokens: 10, completionTokens: 20, credit: 0.11 },
      { t: now - 1800_000, model: 'deepseek-v4-pro', stream: true, ms: 900, ok: true, promptTokens: 5, completionTokens: 7 },
      { t: now - 600_000, model: 'glm-5.3', stream: false, ms: 300, ok: false, status: 429, code: 11133, error: 'rate limited' },
    ];
    writeFileSync(join(bridge.dir, 'usage.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const usage = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(usage.ok, true);
    assert.equal(usage.windowDays, 7, '默认窗口 7 天');

    // 形状断言：这些字段是控制台/插件实际读的，一个都不能少
    assert.equal(typeof usage.total, 'object');
    assert.ok(Array.isArray(usage.models), 'models 必须是数组');
    assert.ok(Array.isArray(usage.days), 'days 必须是数组');
    assert.ok(Array.isArray(usage.failures), 'failures 必须是数组');

    // 语义断言：成功的 2 条计入 total，失败的第 3 条单独归类
    assert.equal(usage.total.calls, 2, '成功调用数应为 2（失败那条不算）');
    assert.equal(usage.total.failed, 1, '失败数应为 1');
    assert.equal(usage.total.promptTokens, 15);
    assert.equal(usage.total.completionTokens, 27);
    // creditCalls 只数"上游真的回报了 credit"的那条（第 1 条），第 2 条没报
    assert.equal(usage.total.creditCalls, 1, '只有回报了 credit 的调用才算 creditCalls');
    assert.equal(usage.total.credit, 0.11);

    // 逐字段核对：内存镜像解析出来的模型聚合必须与直接解析文件得到的完全一致
    const expectedModels = rows.filter((r) => r.ok !== false).map((r) => r.model).sort();
    assert.deepEqual(
      usage.models.map((m) => m.model).sort(),
      expectedModels,
      '按模型聚合的结果必须与账本文件一致（镜像不能丢行、不能重复）',
    );

    // 失败明细：字段名与内容必须与写进去的一致
    assert.equal(usage.failures.length, 1);
    assert.equal(usage.failures[0].model, 'glm-5.3');
    assert.equal(usage.failures[0].status, 429);
    assert.equal(usage.failures[0].code, 11133);
    assert.equal(usage.failures[0].error, 'rate limited');

    // /v1/requests：新的在前，且元数据白名单字段齐全
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.equal(requests.ok, true);
    assert.ok(Array.isArray(requests.requests));
    assert.equal(requests.requests.length, 3, '三条账都应当出现在最近请求里');
    assert.deepEqual(
      requests.requests.map((r) => r.model),
      ['glm-5.3', 'deepseek-v4-pro', 'deepseek-v4.1-flash'],
      '最近请求必须新的在前',
    );
    const failed = requests.requests[0];
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 429);
    assert.equal(failed.code, 11133);
    // 老记录（本次改动前写的）没有 acct：必须回 'unknown'，不能省略、更不能
    // 硬塞给某个账号（那会让"某账号花了多少"撒谎）。
    assert.equal(failed.acct, 'unknown', '没有 acct 的旧记录必须归 unknown 桶');
    // 白名单：不能带出账本里的其它字段（这里本来也没有，但形状要固定）
    // acct / effort 是**有意新增**的：多账号共用一个账本，不记账号就分不清
    // 谁花的（见 ACCOUNT_LABEL）；effort 是用户唯一能调的"质量/成本"旋钮，
    // 不记就无法核对"我选了 high 到底发出去没有"。
    assert.deepEqual(
      Object.keys(failed).sort(),
      ['acct', 'code', 'effort', 'error', 'model', 'ms', 'ok', 'status', 'stream', 't'],
      '/v1/requests 的字段集必须稳定（只回元数据白名单）',
    );
    // 老记录没有 effort：必须回空串（前端据此显示"—"），不能是 undefined
    assert.equal(failed.effort, '', '没有 effort 的旧记录必须回空串而不是 undefined');

    // 小时视图：只有 ?hours=1 才带 hours 字段，且必须是补齐的 24 个桶
    const hourly = await (await fetch(bridge.baseUrl + '/v1/usage?days=1&hours=1', { headers: auth })).json();
    assert.ok(Array.isArray(hourly.hours), 'hours=1 时必须带 hours 数组');
    assert.equal(hourly.hours.length, 24, '小时桶必须补齐到 24 个');
    const plain = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(plain.hours, undefined, '不带 hours=1 时不能出现 hours 字段');

    // 外部清空账本：内存镜像必须跟着作废（syncUsageMirror 的语义，不能被 D4 丢掉）
    writeFileSync(join(bridge.dir, 'usage.jsonl'), '');
    const after = await (await fetch(bridge.baseUrl + '/v1/usage', { headers: auth })).json();
    assert.equal(after.total.calls, 0, '文件被外部清空后，镜像必须一起作废（不能读回旧数据）');
    assert.equal(after.failures.length, 0);

    // 回归：外部**删除**账本文件、再换入一个**非空**文件时，镜像必须重新加载。
    //
    // 这条钉住一个真实踩过的坑：最初的重载判据是 `size < usageBytes`，而文件被
    // 删除后 usageBytes 归 0 —— `size < 0` 恒不成立，于是此后外部写进来的任何
    // 账本都读不到，镜像永久性地读成空。改成"指纹（字节数 + mtime）不一致就重载"
    // 之后才正确。先删再写，正是让 usageBytes 归零的最短路径。
    const ledger = join(bridge.dir, 'usage.jsonl');
    const externalRows = [
      { t: now - 60_000, model: 'external-a', stream: false, ms: 11, ok: true, promptTokens: 1, completionTokens: 2 },
      { t: now - 30_000, model: 'external-b', stream: false, ms: 22, ok: true, promptTokens: 3, completionTokens: 4 },
    ];
    rmSync(ledger, { force: true });
    const afterDelete = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.equal(afterDelete.requests.length, 0, '文件被删除后不得复活旧记录');

    writeFileSync(ledger, `${externalRows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const afterExternal = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.deepEqual(
      afterExternal.requests.map((r) => r.model),
      ['external-b', 'external-a'],
      '删除后外部换入的新账本必须被读到（只比大小的判据会在这里永久读成空）',
    );
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游流中途断开必须记成失败（与非流式路径一致）', { timeout: 90_000 }, async () => {
  // 打桩上游：发一帧正文后**掐断连接**，模拟"回答到一半上游断了"。
  // 这是真实会出现的情况（网络抖动 / 上游重启），而客户端只会看到回答被截断。
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'stub-stream', name: 'Stub', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      setTimeout(() => { try { res.socket.destroy(); } catch { /* 已断 */ } }, 50);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  try {
    // 先抓一次目录：让模型预校验认识 stub-stream（否则会被本地 400 拦下）
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth });

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    // 流已经以 200 开始，错误无法再改 HTTP 状态 —— 只能反映在账本里
    assert.equal(res.status, 200, '流已开始后状态只能是 200');
    try {
      const reader = res.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch { /* 上游被掐断，客户端读流异常属预期 */ }

    await new Promise((r) => setTimeout(r, 300)); // 等落账（异步写文件）
    const requests = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    const row = (requests.requests || []).find((r) => r.model === 'stub-stream');
    assert.ok(row, '这次调用必须落账');
    assert.equal(row.ok, false, '上游流中断不是成功：必须记失败（曾长期被错记为 ok:true）');
    assert.ok(row.error, '失败行必须带错误原文，控制台才能显示"为什么被截断"');

    // 对照：账本的失败汇总也要能看到它（否则"失败数"统计漏报）
    const usage = await (await fetch(bridge.baseUrl + '/v1/usage?days=1', { headers: auth })).json();
    assert.equal(usage.total.failed, 1, '失败数必须把这笔算进去');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：拒绝外来 Origin（DNS rebinding 防线），且不误伤本机调用', { timeout: 90_000 }, async () => {
  // 刻意用**空令牌**启动 —— 那是桥自身的默认（`WORKBUDDY_LOCAL_TOKEN` 缺省为空），
  // 也是 Origin 这道防线真正要覆盖的场景：没有令牌时，如果连 Origin 都不看，
  // 一个恶意网页就能靠 DNS rebinding 把浏览器指向 127.0.0.1 来消耗账号配额。
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'origin-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  /*
   * 用自动生成的令牌（传空 = 让桥自己生成），再从启动日志里取出来。
   *
   * 注意这里**不能在 `WORKBUDDY_LOCAL_TOKEN: ''` 下裸跑请求** —— 那正是
   * 「未配置即放行」的旧契约，已被「不得静默放行」用例推翻。本用例要验的是
   * **Origin 这道防线**，所以必须在一个合法令牌之上比对，否则 403 会被 401 抢先。
   */
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_LOCAL_TOKEN: '' },
    { auth: READABLE_FAKE_AUTH },
  );
  const autoToken = bridge.out().match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
  assert.ok(autoToken, '本用例依赖桥自动生成令牌（启动日志里应有 WORKBUDDY_LOCAL_TOKEN=…）');
  const bearer = { authorization: `Bearer ${autoToken}` };
  const body = JSON.stringify({ model: 'origin-model', messages: [{ role: 'user', content: 'hi' }] });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: bearer }); // 预热目录，让预校验认识该模型

    // ① 外来 Origin（跨站形状：text/plain 简单请求）→ 403，且**一次上游都不打**
    const before = calls.chat;
    const cross = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(cross.status, 403, '外来 Origin 必须被 403 拒绝');
    await cross.text();
    assert.equal(calls.chat, before, '被拒的请求绝不能打到上游（副作用必须为零）');

    // ② 回环 Origin 放行（本机网页版客户端仍然可用）
    const loop = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(loop.status, 200, '回环 Origin 必须放行');
    await loop.text();

    // ③ 无 Origin（curl / dsh 插件 / 控制台内部代理）放行
    const none = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(none.status, 200, '无 Origin 必须放行（本机 CLI/SDK 不发这个头）');
    await none.text();

    // ④ 基础安全响应头
    const models = await fetch(bridge.baseUrl + '/v1/models', { headers: bearer });
    assert.equal(models.headers.get('x-content-type-options'), 'nosniff');
    assert.match(models.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await models.text();
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：客户端可控的 model 必须收敛类型与长度（账本/日志/回显都不能被撑爆）', { timeout: 90_000 }, async () => {
  const calls = { chat: 0 };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'len-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      calls.chat += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  const post = (body) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1', { headers: auth }); // 预热目录

    // ① 超长 model：本地 400，且响应体**不能**原样回显那 30 万字符
    const huge = 'x'.repeat(300000);
    const over = await post({ model: huge, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(over.status, 400, '超长 model 必须被本地拒绝');
    const overText = await over.text();
    assert.ok(overText.length < 1000, `400 响应体必须短（实际 ${overText.length} 字符）-- 不能回显客户端输入`);
    assert.ok(!overText.includes(huge), '响应体里不得原样回显超长 model');

    // ② 账本行必须有界，否则反复打就能把磁盘灌爆
    await new Promise((r) => setTimeout(r, 300));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split('\n');
    const lastRow = JSON.parse(ledger[ledger.length - 1]);
    assert.ok(String(lastRow.model).length <= 210, `账本行 model 必须被截断（实际 ${String(lastRow.model).length} 字符）`);
    assert.equal(lastRow.ok, false);

    // ③ /v1/requests 回显也必须是有界的
    const reqs = await (await fetch(bridge.baseUrl + '/v1/requests', { headers: auth })).json();
    assert.ok(String(reqs.requests[0].model || '').length <= 210, '/v1/requests 的 model 不得原样回显超长串');

    // ④ model 不是字符串（数组/对象/数字/布尔）→ 类型混淆会让"长度"判断失效，必须拒
    for (const badModel of [['a', 'b'], { id: 'x' }, 123, true]) {
      const r = await post({ model: badModel, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 400, `model=${JSON.stringify(badModel)} 必须被拒（必须是字符串）`);
      await r.text();
    }

    // ⑤ `null` / 缺省视同"没给" → 沿用原有的默认模型回落（不算类型错误）
    for (const missing of [null, undefined]) {
      const r = await post({ model: missing, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 200, `model=${String(missing)} 应当回落到默认模型，而不是被拒`);
      await r.text();
    }

    // ⑥ 正常模型不受影响
    const before = calls.chat;
    const okModel = await post({ model: 'len-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(okModel.status, 200);
    await okModel.text();
    assert.equal(calls.chat, before + 1, '合法模型必须照常打到上游');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：刷新失败时不得把响应体写进日志（响应体可能带 accessToken）', { timeout: 90_000 }, async () => {
  const SENTINEL = 'SENTINEL-ACCESS-TOKEN-MUST-NOT-BE-LOGGED';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/plugin/auth/token/refresh') {
      // 关键形状：**非 2xx，但响应体里带着 accessToken** —— 这正是"打印响应体"
      // 会把令牌落进 bridge.log 的场景（失败条件含 !res.ok）。
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { accessToken: SENTINEL, refreshToken: SENTINEL } }));
    }
    if (path === '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  // expiresAt 只剩 60 秒（< 5 分钟 skew）→ 请求会先触发一次 token 刷新
  const nearExpiry = {
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 60_000,
    },
  };
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: upstreamBase, WORKBUDDY_LOG: '1' },
    { auth: nearExpiry },
  );
  try {
    const r = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    await r.text().catch(() => '');
    await new Promise((res) => setTimeout(res, 400));

    // 路径确实走到了（否则这条断言是空转）
    assert.match(bridge.out(), /refresh failed/, '应当记录了一次刷新失败（用例必须真的覆盖到目标路径）');
    assert.ok(!bridge.out().includes(SENTINEL), '日志里不得出现刷新响应体里的令牌（违反"不落盘令牌"）');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：keep-alive 连接被复用，且复用连接被掐断时自动换新连接重试', { timeout: 90_000 }, async () => {
  // 两个断言点：
  //  ① 复用：第二次对话请求命中上游**同一个** TCP socket（server 端连接计数不涨）；
  //  ② 稳定：上游把空闲 socket 掐断后，下一次请求必须成功（桥换新连接重试一次），
  //     客户端看到的是正常回答，而不是 ECONNRESET。
  let socketsOpened = 0;
  let chatCalls = 0;
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'ka-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      chatCalls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: {"choices":[{"delta":{"content":"call${chatCalls}"}}]}\n\ndata: [DONE]\n\n`);
      if (chatCalls === 3) {
        // 第 3 次：应答完整返回**之后**掐掉底层 socket，
        // 让 Agent 池里留一条**服务端已关闭**的死连接给第 4 次。
        setTimeout(() => { try { res.socket.destroy(); } catch { /* 已断 */ } }, 30);
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  upstream.on('connection', () => { socketsOpened += 1; });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: upstreamBase }, { auth: READABLE_FAKE_AUTH });
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ka-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.text());
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 ka-model

    const r1 = await chat();
    const socketsAfterFirst = socketsOpened;
    const r2 = await chat();
    assert.match(r1, /call1/);
    assert.match(r2, /call2/);
    assert.equal(socketsOpened, socketsAfterFirst, '第二次请求必须复用同一条 keep-alive 连接（不得新开 socket）');

    // 第 3 次：正常拿到回答，但上游随后掐掉 socket（池子里留下一条死连接）
    const r3 = await chat();
    assert.match(r3, /call3/);
    await new Promise((r) => setTimeout(r, 100)); // 等 socket 真正被掐断

    // 第 4 次：撞上死连接 → 桥自动换新连接重试并成功（对客户端透明）
    const r4 = await chat();
    assert.match(r4, /call4/, '复用连接被掐断后必须自动重试成功，客户端无感');
  } finally {
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：出站 system 已做审计模板最小改写（黑名单原文不得出现在上游看到的请求里）', { timeout: 90_000 }, async () => {
  // 背景（2026-10-08 实测）：带 Claude Code 原文模板的请求被上游**逐字拉黑**
  // —— 400 `Illegal API invocation from an unapproved channel`；按报告
  // §8.7 #44 最小改写（CLI→CLI tool、Main branch→Default branch）后放行。
  // 本用例把「出站不含黑名单原文」钉死为回归（打桩上游直接审视桥发了什么）。
  const stub = await startStubUpstream(['audit-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 audit-model

    const res = await fetch(bridge.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'audit-model',
        max_tokens: 16,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: 'Main branch (you will usually use this for PRs)' },
        ],
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 1, '桥应向上游发出恰好一条聊天请求');
    const outbound = JSON.parse(stub.seen[0].body);
    const sysText = outbound.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    assert.ok(!sysText.includes("Anthropic's official CLI for Claude."),
      '出站 system 不得含黑名单原文（…official CLI for Claude.）');
    assert.ok(!sysText.includes('Main branch (you will usually use this for PRs)'),
      '出站 system 不得含黑名单原文（Main branch …）');
    assert.ok(sysText.includes("Anthropic's official CLI tool for Claude."),
      '应含最小改写后的形态（CLI tool）');
    assert.ok(sysText.includes('Default branch (you will usually use this for PRs)'),
      '应含最小改写后的形态（Default branch）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：DSH 自己的开场指纹句被逐字拉黑 → 出站必须已改写成非黑名单形态', { timeout: 90_000 }, async () => {
  /*
   * 背景（2026-10-22 实测，copilot.tencent.com / 账号 6d2b5f6b）：DSH 的 system
   * 提示词里有**两句**被逐字拉黑，命中即回
   *   `400 code 11-128 Illegal API invocation from an unapproved channel`：
   *   ① `You are an AI agent powered by DeepSeek Harness`
   *   ② `You are interacting with the user through the DeepSeek Harness Web GUI`
   * 只改一句仍 400（两句都必需）；改一个词即 200；**只改大小写无效**
   * （上游做的是区分大小写的整句匹配，不是关键词命中）。
   *
   * 这两句在 DSH 每轮 agent 请求里都有，所以症状是「面板对话测试正常、DSH 一用
   * 国内版就报错」。本用例把「出站不含这两句、且含最小改写后的形态」钉死为回归。
   */
  const stub = await startStubUpstream(['dsh-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 dsh-model

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'dsh-model',
        stream: true,
        messages: [
          {
            role: 'system',
            // content 用 parts 数组：这正是 DSH 实际发出的形状（会话日志实测）
            content: [
              {
                type: 'text',
                text: 'You are an AI agent powered by DeepSeek Harness.\n\n'
                  + 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.\n\n'
                  + 'Keep the rest of this prompt intact.',
              },
            ],
          },
          { role: 'user', content: 'ping' },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 1, '桥应向上游发出恰好一条聊天请求');
    const outbound = JSON.parse(stub.seen[0].body);
    const sysText = outbound.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    assert.ok(!sysText.includes('You are an AI agent powered by DeepSeek Harness'),
      '出站 system 不得含黑名单整句 ①（…powered by DeepSeek Harness）');
    assert.ok(!sysText.includes('You are interacting with the user through the DeepSeek Harness Web GUI'),
      '出站 system 不得含黑名单整句 ②（…interacting with the user through … Web GUI）');
    assert.ok(sysText.includes('You are an AI agent built on DeepSeek Harness'),
      '应含 ① 的最小改写形态（built on）');
    assert.ok(sysText.includes('You are working with the user through the DeepSeek Harness Web GUI'),
      '应含 ② 的最小改写形态（working with）');
    assert.ok(sysText.includes('Keep the rest of this prompt intact.'),
      '改写必须是最小改写：提示词其余内容不得被动');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});


test('桥：出站身份指纹可用 env 覆盖（上游版本漂移时的逃生门）', { timeout: 90_000 }, async () => {
  // 上游按 UA / X-IDE-* / X-Product-Version 校验调用来源；官方客户端升级后
  // 旧指纹可能整体被拒。三个值必须能用 .env（→ bridgeEnv → 桥）覆盖，
  // 否则用户只能改源码 —— 这是报告 §8.6 风险 1 的最低成本逃生门。
  const stub = await startStubUpstream(['id-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_APP_VERSION: '9.9.9-test',
      WORKBUDDY_IDE_NAME: 'TestIDE',
      // IDE_VERSION 故意不覆盖 → 应保持默认
    },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 id-model
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'id-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(stub.seen.length, 1);
    const h = stub.seen[0].headers;
    assert.equal(h['user-agent'], 'TestIDE/1.119.0 CodeBuddy/9.9.9-test',
      'UA 应由 env 覆盖的 IDE 名/版本与 App 版本拼出，未覆盖项保持默认');
    assert.equal(h['x-ide-name'], 'TestIDE');
    assert.equal(h['x-ide-version'], '1.119.0', '未设置的 IDE_VERSION 应保持默认值');
    assert.equal(h['x-product-version'], '9.9.9-test');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：本地限流 reject 模式 —— 上限 N 时上游恰好收到 N 条，第 N+1 条 429 + Retry-After', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['rl-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_RATE_LIMIT_RPM: '2',
      WORKBUDDY_RATE_LIMIT_MODE: 'reject',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'rl-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录（不打 chat，不消耗许可）

    const r1 = await chat();
    const r2 = await chat();
    const r3 = await chat();
    await r1.text(); await r2.text(); await r3.text();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, '第 3 条必须被限流拒绝');
    assert.ok(Number(r3.headers.get('retry-after')) >= 1, 'Retry-After 头必须存在且 ≥1 秒');
    assert.equal(stub.seen.length, 2, '上游恰好收到 2 条 -- 被限流的请求不得打上游');

    // 账本归因：被限流的请求要留下 rate_limited 痕迹（控制台据此可见）
    await new Promise((r) => setTimeout(r, 100)); // 等账本落盘
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8');
    assert.match(ledger, /rate_limited/, '账本必须记录限流归因');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：本地限流 queue 模式 —— 并发请求按最小间隔排队放行，不拒绝', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['rl2-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS: '400',
      WORKBUDDY_RATE_LIMIT_MODE: 'queue',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = () => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'rl2-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const t0 = Date.now();
    const rs = await Promise.all([chat(), chat(), chat()]); // 并发：必须被串行化排队
    const elapsed = Date.now() - t0;
    for (const r of rs) {
      assert.equal(r.status, 200, 'queue 模式不得拒绝');
      await r.text();
    }
    assert.equal(stub.seen.length, 3, '三条最终都要发往上游');
    // 第 1 条立即、第 2 条等 ~400ms、第 3 条等 ~800ms —— 明显长于"无排队"的几十毫秒
    assert.ok(elapsed >= 700, `并发三条在 400ms 最小间隔下应排队 ≥700ms（实测 ${elapsed}ms）`);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：开销头与进程计数 —— 响应带 X-WorkBuddy-Overhead-Ms，/health 报 process 段', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['ov-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ov-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    const raw = res.headers.get('x-workbuddy-overhead-ms');
    const overhead = Number(raw);
    assert.ok(raw !== null && Number.isFinite(overhead) && overhead >= 0,
      `对话响应必须带 ≥0 的开销头（实测 ${raw}）`);
    await res.text();

    // /health 的进程计数：真实请求入账、探活不入账
    const health = await fetch(bridge.baseUrl + '/health', { headers: auth, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.ok(health.process && typeof health.process.requests === 'number', '/health 必须带 process 段');
    assert.ok(health.process.requests >= 2, `进程计数应 ≥2（models 预热 + chat），实测 ${health.process.requests}`);
    assert.ok((health.process.byStatus['200'] || 0) >= 2, '状态码分布应含 200');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：在途请求可见 —— 成功 / 失败 / 客户端断开三条路径都正确登记与释放', { timeout: 120_000 }, async () => {
  // stub 上游可以"挂起"（等测试放行才响应），用来制造稳定的"进行中"观察窗口。
  let releaseHold = null;
  let holdGate = new Promise((r) => { releaseHold = r; });
  let mode = 'ok';
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'act-model', maxInputTokens: 128000, maxOutputTokens: 4096 }] } }));
    }
    if (path === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { models: [] } }));
    }
    if (path === '/v2/chat/completions') {
      req.resume();
      (async () => {
        await holdGate; // 「挂起」：模拟长回答 / 卡死中的上游
        if (mode === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ code: 50000, msg: 'boom' }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      })();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
    { auth: READABLE_FAKE_AUTH },
  );

  const reqs = () => fetch(bridge.baseUrl + '/v1/requests', { headers: auth, signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const waitFor = async (pred, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const d = await reqs();
      if (pred(d)) return d;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待超时：${label}`);
  };
  const resetGate = () => { holdGate = new Promise((r) => { releaseHold = r; }); };
  const chat = (signal) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'act-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal,
  });

  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录

    // ① 成功路径：登记 → 放行 → 释放
    mode = 'ok'; resetGate();
    const p1 = chat(AbortSignal.timeout(30000));
    const seen = await waitFor((d) => d.active.length === 1, '出现进行中条目');
    assert.equal(seen.active[0].model, 'act-model');
    assert.ok(seen.active[0].id, '进行中条目必须带 id');
    assert.ok(typeof seen.active[0].runningMs === 'number' && seen.active[0].runningMs >= 0,
      'runningMs 必须存在（UI 的「已运行」时长靠它）');
    assert.ok(typeof seen.activeAlertMs === 'number' && seen.activeAlertMs > 0,
      'activeAlertMs 必须随响应带回（阈值由桥单点定义）');
    releaseHold();
    const r1 = await p1; await r1.text();
    assert.equal(r1.status, 200);
    await waitFor((d) => d.active.length === 0, '成功后被释放');

    // ② 失败路径：上游 500 → 同样释放
    mode = 'fail'; resetGate();
    const p2 = chat(AbortSignal.timeout(30000));
    await waitFor((d) => d.active.length === 1, '失败场景出现进行中条目');
    releaseHold();
    const r2 = await p2; await r2.text();
    assert.equal(r2.status, 500);
    await waitFor((d) => d.active.length === 0, '失败后被释放');

    // ③ 客户端断开：abort → 同样释放（注册表不得泄漏）
    mode = 'ok'; resetGate();
    const ac = new AbortController();
    const p3 = chat(ac.signal).catch(() => null);
    await waitFor((d) => d.active.length === 1, '断开场景出现进行中条目');
    ac.abort();
    await p3;
    await waitFor((d) => d.active.length === 0, '客户端断开后被释放');
  } finally {
    try { releaseHold(); } catch { /* 忽略 */ }
    await bridge.stop();
    try { upstream.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：count_tokens —— 规范同形、纯本地估算（不打上游）、中文按字计', { timeout: 90_000 }, async () => {
  const stub = await startStubUpstream(['ct-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  const countTokens = (payload) => fetch(bridge.baseUrl + '/v1/messages/count_tokens', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  try {
    // 中文：每字 ≥ 1 token（旧的"字节/4"会把中文算少一半以上）
    const cn = await countTokens({ model: 'ct-model', messages: [{ role: 'user', content: '你好世界'.repeat(25) }] });
    assert.equal(cn.status, 200);
    const cnBody = await cn.json();
    assert.ok(typeof cnBody.input_tokens === 'number' && cnBody.input_tokens >= 100,
      `中文 100 字应估算 ≥100 token（实测 ${cnBody.input_tokens}）`);

    // ASCII：≈ 4 字符/token（400 字符的 system ≈ 100）
    const en = await countTokens({ model: 'ct-model', system: 'a'.repeat(400), messages: [{ role: 'user', content: 'hi' }] });
    const enBody = await en.json();
    assert.ok(enBody.input_tokens >= 100 && enBody.input_tokens <= 120,
      `400 个 ASCII 字符应估算 ≈100–120（实测 ${enBody.input_tokens}）`);

    // 纯本地：这个端点一条请求都不该打到上游
    assert.equal(stub.seen.length, 0, 'count_tokens 不得触达上游（没有 tokenizer 可打）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：客户端凭据分层 —— key 鉴权、账本归因、独立限流桶', { timeout: 120_000 }, async () => {
  const stub = await startStubUpstream(['ck-model']);
  const bridge = await startBridge(
    {
      CODEBUDDY_ENDPOINT: stub.base,
      WORKBUDDY_CLIENT_KEYS: 'key-aaa,key-bbb',
      WORKBUDDY_RATE_LIMIT_RPM: '2',
      WORKBUDDY_RATE_LIMIT_MODE: 'reject',
    },
    { auth: READABLE_FAKE_AUTH },
  );
  const chat = (token) => fetch(bridge.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ck-model', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15000),
  });
  try {
    // ① LOCAL_TOKEN 仍然万能（管理面 / 控制台用它）
    const rLocal = await chat(TOKEN);
    assert.equal(rLocal.status, 200, 'LOCAL_TOKEN 必须仍然可用');
    await rLocal.text();

    // ② client key 可用；未登记的 key 401
    const rA = await chat('key-aaa');
    assert.equal(rA.status, 200, '已登记的 client key 应被接受');
    await rA.text();
    const rBad = await chat('key-wrong');
    assert.equal(rBad.status, 401, '未登记的 key 必须 401');
    await rBad.text();

    // ③ per-key 限流：key-aaa 的桶打满 → 429；key-bbb 的桶独立不受影响
    const rA2 = await chat('key-aaa');
    assert.equal(rA2.status, 200);
    await rA2.text();
    const rA3 = await chat('key-aaa');
    assert.equal(rA3.status, 429, 'key-aaa 第 3 条应被自己的桶限流');
    await rA3.text();
    const rB1 = await chat('key-bbb');
    assert.equal(rB1.status, 200, 'key-bbb 的桶独立，不受 key-aaa 打满影响');
    await rB1.text();

    // ④ 账本归因：client key 的记录带「哈希前 8 位」，明文绝不落账
    await new Promise((r) => setTimeout(r, 100));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const expected = createHash('sha256').update('key-aaa').digest('hex').slice(0, 8);
    assert.ok(ledger.some((l) => l.client === expected), 'key-aaa 的记录必须带哈希前 8 位归因');
    assert.ok(ledger.some((l) => l.client === 'local'), 'LOCAL_TOKEN 的记录归因为 local');
    assert.ok(!ledger.some((l) => String(l.client || '').includes('key-aaa')), '明文 key 不得出现在账本');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 畸形 `Host` 头必须回 400，**进程必须活着**。
 *
 * 踩过的坑：`handleRequest` 里 `new URL(req.url, 'http://' + req.headers.host)`
 * 原先在 `try` **之外**，而 Host 是客户端可控的 —— `new URL()` 对
 * `Host: bad host with spaces` 抛 `ERR_INVALID_URL`，异常没被捕获，
 * Node 直接退出进程（实测 exitCode=1）。也就是说**任何能访问本机端口的进程
 * 用一条请求就能把桥打死**，之后控制台/插件只会显示「桥未运行」。
 *
 * 用原始 socket 发：`fetch` 发不出自定义 Host（Fetch 规范把它列为禁止头），
 * 用它测这条只会得到假阴性。
 */
test('桥：畸形 Host 头回 400，且进程不被带走', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    const port = Number(new URL(bridge.baseUrl).port);
    const status = await rawStatus(port, '/v1/models', { Host: 'bad host with spaces' });
    assert.equal(status, 400, '畸形 Host 应当按非法请求挡下（400）');

    await new Promise((r) => setTimeout(r, 300));
    const health = await fetch(`${bridge.baseUrl}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(3000),
    });
    assert.ok(health.status > 0, '桥必须还活着 -- 畸形 Host 不该让进程退出');
    assert.ok(
      !/ERR_INVALID_URL|Unhandled/i.test(bridge.out()),
      `输出里不该有未捕获异常：\n${bridge.out().slice(-300)}`,
    );
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 上游回 **HTTP 200 但内容不是 SSE**（典型：网关把错误包成 200 的 HTML）时，
 * 桥必须**记失败**，不能回 200 + 空内容。
 *
 * 踩过的坑：非流式路径在 `aggregateStream()` 之后**无条件** `ok: true`，
 * 于是上游给一坨 HTML 时，客户端拿到的是「结构完整但 content 为空」的成功响应，
 * 账本记 `{"ok":true,"promptTokens":0,"completionTokens":0}` ——
 * 用户以为模型没说话，控制台的成功率还把它算作成功。**静默错数据**比报错更难查。
 *
 * `choices: []` 是同一类：一个 SSE 块都没解析出内容。
 */
test('桥：上游 200 但不是 SSE → 记失败，不回「空回答成功」', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], { chatRaw: '<html>gateway error</html>' });
  /*
   * **必须用 READABLE_FAKE_AUTH**：默认的 FAKE_AUTH 是扁平的（刻意用来复现
   * 「凭据异常」），桥读到它会直接 500 —— 那样断言会因为「请求压根没走到 chat
   * 路径」而变绿，是假绿。第一版就是这么写的，靠打印实际响应才发现。
   */
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.ok(res.status >= 400, `上游返回非 SSE 时不能回 200（实际 ${res.status}）`);

    await new Promise((r) => setTimeout(r, 300));
    const ledger = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = ledger[ledger.length - 1];
    assert.equal(last.ok, false, '账本必须记失败 -- 否则控制台把它算作成功（静默错数据）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 账本**按账号**截断：每个账号超过 `MAX_USAGE_LINES_PER_ACCOUNT`(1000) 时，
 * 只有**它自己**被砍到一半，别的账号一条不动。
 *
 * 为什么改成按账号：旧实现是"全局 2000 条一起砍"。多账号下两个桥写同一个文件，
 * 调用频繁的账号（国际版免费、刷得多）一超限，**另一个账号的历史跟着被砍** ——
 * 等于吵的那个把安静的挤掉。这条测试就是钉住"不再互相牵连"。
 *
 * 同时保留旧断言的两件事：截断是「重写整份文件」，必须**原子替换**（tmp+rename）
 * 否则断电会留下半份；以及每一行都必须是合法 JSON（抓半截行）。
 */
test('桥：账本按账号各留一半，一个账号超限不牵连另一个（原子替换）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  // 本桥的账号标签固定为 acct-under-test，便于断言"只有它被裁"
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_ACCOUNT_LABEL: 'acct-under-test' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const file = join(bridge.dir, 'usage.jsonl');
    const now = Date.now();
    // A 账号：1000 条（正好到上限）；B 账号：50 条（远不到）
    const rowsA = Array.from({ length: 1000 }, (_, i) => JSON.stringify({
      t: now - (2000 - i) * 1000, acct: 'acct-under-test', model: 'pre-a', stream: false, ms: 1, ok: true,
    }));
    const rowsB = Array.from({ length: 50 }, (_, i) => JSON.stringify({
      t: now - (500 - i) * 1000, acct: 'other-account', model: 'pre-b', stream: false, ms: 1, ok: true,
    }));
    writeFileSync(file, `${[...rowsA, ...rowsB].join('\n')}\n`);

    // 本桥再记一条 → A 变 1001 条 → 触发裁剪
    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) JSON.parse(l); // 半截行会在这里抛

    const countOf = (acct) => lines.filter((l) => {
      const r = JSON.parse(l);
      return (r.acct || 'unknown') === acct;
    }).length;

    const aCount = countOf('acct-under-test');
    const bCount = countOf('other-account');

    assert.ok(aCount <= 501, `超限账号应被砍到一半（≤501），实际 ${aCount}`);
    assert.ok(aCount >= 400, `不该把超限账号清空，实际 ${aCount}`);
    assert.equal(bCount, 50,
      `另一个账号一条都不能少（旧实现会连带砍掉它），实际 ${bCount}`);
    // 临时文件必须被 rename 掉。名字带 pid（多桥共享账本时避免互踩），
    // 所以按前缀扫，而不是钉死 `${file}.tmp`。
    const strayTmp = readdirSync(bridge.dir).filter((f) => f.startsWith('usage.jsonl.tmp'));
    assert.deepEqual(strayTmp, [], `临时文件必须被 rename 掉，实际残留：${strayTmp.join(', ')}`);

    // 新增的那条必须真的在账本里（重写路径不能把它弄丢）
    assert.ok(lines.some((l) => { const r = JSON.parse(l); return r.model === 'stub-model'; }),
      '本次调用的记录必须落盘（重写前要以磁盘为准重建并补回自己这条）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 旧账本（没有 `acct` 字段）**既不归到某个账号，也不参与裁剪**。
 *
 * 这是升级时最容易误伤用户数据的地方：实测现场账本已有 **1204 行**旧记录
 * （全部没有 acct）。若把它们当成"一个叫 unknown 的账号"去套 1000 上限，
 * 升级后**第一次记账**就会触发裁剪、当场丢掉约 705 行历史。
 *
 * 正确语义：旧记录是**只减不增的冻结集合**（新记录永远带 acct 键），给它们套
 * 上限没有意义、只会毁数据。展示时归 unknown 一桶是为了诚实——那些行确实无法
 * 归因，硬塞给主账号会让"某账号花了多少"撒谎。
 */
test('桥：旧账本（无 acct）不参与裁剪、不被新记录连带删除', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_ACCOUNT_LABEL: 'main-acct' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    const file = join(bridge.dir, 'usage.jsonl');
    const now = Date.now();
    // 关键：旧记录数量**故意超过 1000 上限**，模拟现场那 1204 行
    const legacy = Array.from({ length: 1204 }, (_, i) => JSON.stringify({
      t: now - (2000 - i) * 1000, model: 'legacy', stream: false, ms: 1, ok: true,
    }));
    writeFileSync(file, `${legacy.join('\n')}\n`);

    // 记一条新请求 → 若旧记录被当成受限账号，这里就会砍掉约 700 行
    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const legacyLeft = lines.filter((l) => { const r = JSON.parse(l); return !('acct' in r); }).length;
    assert.equal(legacyLeft, 1204,
      `旧记录必须一行不少地保留（升级不能吃掉用户历史），实际剩 ${legacyLeft}`);

    // 展示时它们归 unknown 桶，且与本账号分开计
    const usage = await (await fetch(`${bridge.baseUrl}/v1/usage?days=1`, { headers: auth })).json();
    const unknown = usage.accounts.find((a) => a.account === 'unknown');
    const main = usage.accounts.find((a) => a.account === 'main-acct');
    assert.equal(unknown?.calls, 1204, `旧记录应全部计入 unknown，实际 ${unknown?.calls}`);
    assert.equal(main?.calls, 1, `本账号记录单独成桶，实际 ${main?.calls}`);
    const sum = usage.accounts.reduce((n, a) => n + a.calls, 0);
    assert.equal(sum, usage.total.calls, 'accounts 之和必须等于 total.calls');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 账本里的每条新记录都必须带本桥的 `acct`（来自 WORKBUDDY_ACCOUNT_LABEL）。
 *
 * 这是"分账号统计"的地基：标签写歪了，后面所有按账号的汇总都是错的。
 */
test('桥：新写入的账本记录带本桥的账号标签', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_ACCOUNT_LABEL: 'workbuddy-ai' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, '应当落盘至少一条记录');
    assert.equal(rows[rows.length - 1].acct, 'workbuddy-ai', '记录必须带本桥的账号标签');

    // /health 也要回传它：消费方靠这个字段把账本账号对上界面分组
    const health = await (await fetch(`${bridge.baseUrl}/health`, { headers: auth })).json();
    assert.equal(health.account, 'workbuddy-ai', '/health 必须回传账号标签');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 未配置本地令牌时，桥**不得**静默放行。
 *
 * 为什么必须钉住：`handleRequest` 的闸门写成
 * `if ((LOCAL_TOKEN || CLIENT_KEY_HASHES.size) && identifyClientId(req) === null)` ——
 * `LOCAL_TOKEN` 为空时整个 401 分支不执行，于是 `/health`、`/v1/chat/completions`
 * 等全部无鉴权可达。而夹具此前**永远**注入 `WORKBUDDY_LOCAL_TOKEN`（见 startBridge），
 * 这条默认路径从未被测过，所以漏洞能长期存在。
 *
 * 现场证据：用户直接 `node bridge/workbuddy-bridge.mjs`（不经控制台）时，
 * `config.mjs` 那份默认值不参与 —— 桥拿到的是空令牌，等于无鉴权。
 *
 * 断言的是**行为明确**：要么拒绝（401），要么启用了自动生成的替代令牌。
 * 唯一不允许的结果是「无令牌也 200」。
 */
test('桥：未配置 WORKBUDDY_LOCAL_TOKEN 时不得静默放行', { timeout: 30_000 }, async () => {
  const bridge = await startBridge({ WORKBUDDY_LOCAL_TOKEN: '' }, { auth: READABLE_FAKE_AUTH });
  try {
    // ① 不带任何凭据：绝不能 200
    const anon = await fetch(`${bridge.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    assert.notEqual(anon.status, 200,
      `未配置令牌时无凭据访问 /v1/models 不能成功（实际 ${anon.status}）—— 等于把账号对同机任意程序敞开`);

    // ② 不带凭据的对话请求更不能成功（这条会真的消耗上游额度）
    const anonChat = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.notEqual(anonChat.status, 200,
      `未配置令牌时无凭据对话请求不能成功（实际 ${anonChat.status}）`);
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 自动生成的令牌必须**可见**（从启动日志里能读出来），否则用户配不上客户端。
 *
 * 「拒绝一切」是安全但不可用；「随机生成 + 打印出来」才是可用的安全。
 * 这条与上一条配对：一个管「不能放行」，一个管「不能把用户锁在门外」。
 */
test('桥：自动生成令牌时必须把值打印到启动日志（否则用户无法接入客户端）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge({ WORKBUDDY_LOCAL_TOKEN: '' }, { auth: READABLE_FAKE_AUTH });
  try {
    // 生成出来的令牌必须能用于访问；并从启动输出里找得到，供用户复制
    const out = bridge.out();
    const m = out.match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/);
    assert.ok(m, `启动日志里必须给出自动生成的令牌（实际输出：\n${out}\n）`);

    const ok = await fetch(`${bridge.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ok.status, 200, '日志里打印的令牌必须真的能用');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 账本的数值字段必须**永远是数字**，NaN / Infinity / 字符串都不能进磁盘。
 *
 * 为什么必须钉住：账本由控制台「用量统计」直接聚合。一个 NaN 进去，
 * `合计` 会变成 NaN 并让整张表显示成 NaN —— 用户看到的是"统计坏了"，
 * 而根因是上游回了脏 usage。`usageOf` 用 `Number(x) || 0` 兜底，这里把它钉死。
 *
 * 上游回 `"prompt_tokens": "abc"`（字符串）、`Infinity`、缺字段，都是真实可能
 * 出现的脏数据（网关版本漂移 / 代理改写）。
 */
test('桥：上游 usage 是脏数据（字符串 / NaN / 缺字段）时账本不得落 NaN', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model'], {
    // 一坨脏 usage：字符串、null、缺字段混在一起
    chatRaw: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":"abc","completion_tokens":null,"total_tokens":1e999}}\n\n'
      + 'data: [DONE]\n\n',
    chatType: 'text/event-stream',
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();

    await new Promise((r) => setTimeout(r, 300));
    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length > 0, '应当记了一条账');

    const last = rows[rows.length - 1];
    for (const k of ['promptTokens', 'completionTokens', 'ms']) {
      if (k in last) {
        assert.equal(typeof last[k], 'number', `${k} 必须是数字（实际 ${typeof last[k]}）`);
        assert.ok(Number.isFinite(last[k]), `${k} 不能是 NaN / Infinity（实际 ${last[k]}）`);
      }
    }
    // 原始 JSON 里也不能出现 NaN/Infinity 字面量（JSON.stringify 会把它们变成 null）
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(last)), '账本行不得含 NaN/Infinity');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 超长错误原文必须被截断并压成单行。
 *
 * 上游的 401 会返回**整段 HTML**（APISIX 网关），若不截断：
 * ① 账本单行被撑到几十 KB；② 控制台「点失败标签复制错误详情」会复制出一坨 HTML。
 * `shortError` 同时做「压单行 + 截断 160」，这里双向钉住。
 */
test('桥：上游超长错误原文必须压成单行并截断（不得把整段 HTML 灌进账本）', { timeout: 120_000 }, async () => {
  /*
   * 超时给到 120 秒（而不是别的用例的 30 秒）：上游回 401 会**触发一次令牌刷新**，
   * 而刷新在测试桩上必然失败（桩没有 /v2/plugin/auth/token/refresh），
   * 走满 `refreshAuth` 的 8 秒超时 + 后续重试。这是**刻意保留的真实行为**
   * （生产里刷新成功就会重试），不该为了让测试快而去掉。
   *
   * **但请求侧必须自带超时**：本用例原先直接 `await fetch(...)` 且无 signal ——
   * 桥一旦不返回，整个用例就挂到 120 秒的测试上限才失败（实测如此，且与桥的
   * 业务逻辑无关）。带上 25 秒 signal 后，卡住时能立刻失败并给出可读原因，
   * 而不是把"测试框架超时"当成唯一线索。
   */
  const REQ_TIMEOUT_MS = 25_000;
  // 造一段带换行的长 HTML：既测截断，也测换行被压平
  const longHtml = '<html>\n  <head><title>401</title></head>\n  <body>\n'
    + 'x'.repeat(4000)
    + '\n  </body>\n</html>';
  const stub = await startStubUpstream(['stub-model'], { chatRaw: longHtml, chatStatus: 401, chatType: 'text/html' });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    let res;
    try {
      res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      await res.text();
    } catch (error) {
      assert.fail(`桥在 ${REQ_TIMEOUT_MS} ms 内没有响应（上游 401 + text/html 场景）：${error?.message || error}`);
    }
    assert.ok(res.status >= 400, '上游 401 时桥不能回 200');

    await new Promise((r) => setTimeout(r, 300));
    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    assert.equal(last.ok, false, '必须记失败');
    assert.ok(typeof last.error === 'string' && last.error.length <= 201,
      `错误原文必须被截断到 160 字符左右（实际 ${last.error?.length}）`);
    assert.ok(!last.error.includes('\n'), '错误原文必须压成单行（换行会被账本/CSV 吃掉）');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/*
 * ── 401 的自诊断 ────────────────────────────────────────────────────────
 *
 * 背景：令牌默认值从固定串 `wb-local-bridge` 改成随机值之后，**所有老用户
 * 升级后都会撞 401** —— 他们的客户端配置里还存着旧口令。断得毫无预兆，
 * 且原响应体只有一句 `bad or missing token`，用户根本不知道该去哪找新值。
 *
 * 契约（三条同时成立）：
 *   ① 401 必须说明「可能是升级前的旧令牌」并指出去哪拿新值；
 *   ② **绝不能**把真实令牌写进响应体 —— 那等于给同机攻击者直接送答案；
 *   ③ 用对令牌的请求不受影响（提示只在失败路径上）。
 */
test('桥：401 必须自带排查指引（升级后旧令牌失效是高频场景）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    // 老用户升级后的典型状态：配置里还存着历史默认值
    const stale = await fetch(bridge.baseUrl + '/v1/models', {
      headers: { authorization: 'Bearer wb-local-bridge' },
    });
    assert.equal(stale.status, 401, '旧令牌必须被拒绝（这正是本次安全修复的目的）');

    const body = await stale.text();
    // ① 必须给出可操作指引
    assert.match(body, /bridge-token|-token|客户端接入|clients/,
      `401 响应体要指出去哪拿新令牌，实际是：${body.slice(0, 200)}`);
    assert.match(body, /upgrade|升级|旧|stale|changed|变/i,
      `401 响应体要说明「令牌可能变了」，实际是：${body.slice(0, 200)}`);

    // ② 绝不能泄漏真实令牌。取启动日志里的自动生成值作为对照。
    const out = bridge.out();
    const real = out.match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
    if (real) {
      assert.ok(!body.includes(real), '401 响应体绝不能包含真实令牌（等于把答案送给攻击者）');
    }

    // ③ 用对令牌时正常，且提示不会污染成功响应
    const ok = await fetch(bridge.baseUrl + '/v1/models', { headers: auth });
    assert.equal(ok.status, 200, '正确令牌必须照常放行');
    const okBody = await ok.text();
    assert.ok(!/bridge-token|升级/.test(okBody), '成功响应里不该出现排查提示');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：完全没带凭据时也要给指引（新用户第一次接入手忙脚乱）', { timeout: 30_000 }, async () => {
  const bridge = await startBridge();
  try {
    const res = await fetch(bridge.baseUrl + '/v1/models');
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /bridge-token|-token|客户端接入|clients/,
      `无凭据的 401 同样要指路，实际是：${body.slice(0, 200)}`);

    // 同样地，不许泄漏真实令牌
    const real = bridge.out().match(/WORKBUDDY_LOCAL_TOKEN=([A-Za-z0-9._-]{16,})/)?.[1];
    if (real) assert.ok(!body.includes(real), '401 响应体绝不能包含真实令牌');
  } finally {
    await bridge.stop();
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

/**
 * 回归：**推理档位必须记进账本、并从 /v1/requests 与 /v1/usage 暴露出来。**
 *
 * 为什么需要：`reasoning_effort` 是用户唯一能在界面上调的"质量/成本"旋钮，
 * 而账本原来**完全不记**它 —— 面板「最近请求」看不出这次用没用推理、用的哪一档，
 * 用户没法核对"我在选择器里选了 high，到底发出去了没有"。
 *
 * 现场就是靠翻原始日志才确认的，非常费劲。这条测试钉住三个面：
 *   1. 账本里真的写了 effort（不是只在内存里）
 *   2. /v1/requests 回传它（面板要显示"思考档位"）
 *   3. /v1/usage 按档位聚合（回答"开 high 比不开发多花多少"）
 */
test('桥：推理档位记进账本并可从接口读出（回归：面板看不到用了哪档）', { timeout: 30_000 }, async () => {
  const stub = await startStubUpstream(['stub-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    const send = (extra) => fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });

    await send({ reasoning_effort: 'high' });
    await new Promise((r) => setTimeout(r, 250));
    await send({ reasoning_effort: 'low' });
    await new Promise((r) => setTimeout(r, 250));
    await send({}); // 不带档位
    await new Promise((r) => setTimeout(r, 400));

    // ① 账本文件里真的有 effort
    const rows = readFileSync(join(bridge.dir, 'usage.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
    const efforts = rows.map((r) => r.effort).filter((e) => e !== undefined);
    assert.ok(efforts.includes('high'), `账本里应当记下 high，实际 ${JSON.stringify(efforts)}`);
    assert.ok(efforts.includes('low'), `账本里应当记下 low，实际 ${JSON.stringify(efforts)}`);
    // 没发的**不写字段**（保持行紧凑），而不是写空串
    assert.equal(rows[rows.length - 1].effort, undefined,
      '没下发 reasoning_effort 时不该往账本写这个字段');

    // ② /v1/requests 回传（新的在前）
    const reqs = await (await fetch(`${bridge.baseUrl}/v1/requests?limit=10`, { headers: auth })).json();
    assert.equal(reqs.requests[0].effort, '', '不带档位的那条应回空串（前端显示 -）');
    const highRow = reqs.requests.find((r) => r.effort === 'high');
    assert.ok(highRow, '/v1/requests 必须回传 effort，否则面板无法显示"思考档位"');

    // ③ /v1/usage 按档位聚合，且各档之和 === total.calls
    const usage = await (await fetch(`${bridge.baseUrl}/v1/usage?days=1`, { headers: auth })).json();
    assert.ok(Array.isArray(usage.efforts), '/v1/usage 必须给出按档位的拆分');
    const byKey = Object.fromEntries(usage.efforts.map((e) => [e.effort, e.calls]));
    assert.equal(byKey.high, 1, `high 应统计到 1 次，实际 ${JSON.stringify(byKey)}`);
    assert.equal(byKey.low, 1, `low 应统计到 1 次，实际 ${JSON.stringify(byKey)}`);
    assert.equal(byKey['(默认)'], 1, '没发档位的归 "(默认)"，与显式选 low 不是一回事');
    const sum = usage.efforts.reduce((n, e) => n + e.calls, 0);
    assert.equal(sum, usage.total.calls, '各档位之和必须等于 total.calls');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：11-128 一次后重试成功 → 客户端无感（兜底重试）', { timeout: 90_000 }, async () => {
  /*
   * 说明：11-128 的已知成因都是**确定性**的（黑名单整句 / 消息结构 / 身份校验），
   * 桥在出站层已把 DSH 的两句指纹改写成非黑名单形态（见 AUDIT_TEMPLATE_REWRITES）。
   * 这里的重试只是**兜底**（集群节点间生效时间可能不同步）—— 实测它救不回
   * 确定性拦截，所以只给 2 次、不指望它解决问题。
   *
   * 以下 stub 模拟「先回 11-128、重试即成功」：
   *   400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
   *        "displayMsg":{"zh":"请求被拦截，请重新发送"}}
   * 上游自己让你「重新发送」，而它以前是直接透传给客户端的 —— 用户在 DSH 里看到
   * 一次拦截就得自己再发一遍。本用例钉死：桥自己重试一次，客户端只看到 200。
   */
  const stub = await startStubUpstream(['flaky-model'], {
    chatResponses: [
      {
        status: 400,
        // 用**上游原文**：code 是裸的 11-128（不是合法 JSON），桥按文本匹配错误码。
        // 若写成对象 { code: 11-128 }，JS 会把它求值成 -117 —— 测的就不是真实行为了。
        body: "{\"code\":11-128,\"msg\":\"Illegal API invocation from an unapproved channel\",\"requestId\":\"stub-11-128-1\",\"displayMsg\":{\"en\":\"Request blocked. Please send it again\",\"zh\":\"请求被拦截，请重新发送\"}}",
      },
      'sse',
    ],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1'); // 预热目录，让预校验认识 flaky-model

    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'flaky-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const bodyText = await res.text();

    assert.equal(res.status, 200, '11128 一次后重试成功：客户端必须拿到 200，而不是那个 400');
    assert.match(bodyText, /ok/, '重试成功的内容要真的回给客户端');
    assert.equal(stub.seen.length, 2, '上游应收到恰好 2 条聊天请求（原始 + 1 次重试）');
    const gap = stub.seen[1].at - stub.seen[0].at;
    assert.ok(gap >= 1200, `重试必须真的等过一次退避（约 1.5s），实测间隔 ${gap}ms`);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：11128 持续拦截 → 只重试 2 次就如实透传上游 400（不拖成 40 秒）', { timeout: 90_000 }, async () => {
  /*
   * 边界：身份若被**整体**拒绝（见 TROUBLESHOOTING「上游版本漂移」），11128 会一直回。
   * 那时多试无益 —— 契约是只重试 2 次（退避 1.5s / 5s），然后把上游 400 原文
   * 照原样交给客户端（含 requestId，用户可对账），**不得**吞成 500 或空响应，
   * 也**不得**退化成 11133 那样的 4 次长退避（1+4+10+25 秒）。
   */
  const stub = await startStubUpstream(['blocked-model'], {
    chatResponses: [
      {
        status: 400,
        // 用**上游原文**：code 是裸的 11-128（不是合法 JSON），桥按文本匹配错误码。
        // 若写成对象 { code: 11-128 }，JS 会把它求值成 -117 —— 测的就不是真实行为了。
        body: "{\"code\":11-128,\"msg\":\"Illegal API invocation from an unapproved channel\",\"requestId\":\"stub-11-128-persistent\",\"displayMsg\":{\"en\":\"Request blocked. Please send it again\",\"zh\":\"请求被拦截，请重新发送\"}}",
      },
    ],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const startedAt = Date.now();
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'blocked-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(60000),
    });
    const bodyText = await res.text();
    const elapsed = Date.now() - startedAt;

    assert.equal(res.status, 400, '持续 11128 时必须如实回 400，不得包装成 200/500');
    assert.ok(bodyText.includes('unapproved channel'), '上游原文（unapproved channel 那句）要透传给客户端');
    assert.ok(bodyText.includes('persistent'), 'requestId 也要透传，用户才能对账');
    assert.equal(stub.seen.length, 3, '只重试 2 次：上游总计应收到 3 条聊天请求');
    assert.ok(elapsed < 20_000, `两次退避合计约 6.5s，不能拖到 11133 那样的 40s+，实测 ${elapsed}ms`);
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：指纹改写命中计数经 /health 暴露（上游悄悄加黑名单的最早信号）', { timeout: 90_000 }, async () => {
  /*
   * 为什么需要这个计数：黑名单是**上游悄悄加的**（2026-10-21 那两句上线时没有任何
   * 公告），表现只是「突然全报 11-128」。有了计数，/health 的 fingerprints.rewrites
   * 一旦由 0 变正，说明上游又拉黑了新句子 —— 能在用户报错之前发现；byRule 还能
   * 直接指出是哪条规则在命中，省掉重新二分定位的功夫。
   *
   * 本用例钉三件事：① 没命中时计数是 0（不能瞎报）；② 命中后计数与 byRule 都对；
   * ③ 计数是**进程级累加**，第二次请求继续涨（不是每次重置）。
   */
  const stub = await startStubUpstream(['fp-model']);
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: stub.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const healthOf = () => fetch(bridge.baseUrl + '/health', { headers: auth, signal: AbortSignal.timeout(10000) }).then((r) => r.json());

    // ① 冷启动：还没人带指纹请求，计数必须为 0
    const before = await healthOf();
    assert.ok(before.fingerprints, '/health 必须带 fingerprints 段');
    assert.equal(before.fingerprints.rewrites, 0, '没有带指纹的请求时，rewrites 必须是 0（不得瞎报）');
    assert.ok(Array.isArray(before.fingerprints.byRule) && before.fingerprints.byRule.length > 0,
      'byRule 必须逐条列出改写规则（含 0 命中的），排查时才知道总共有几条在守');

    // ② 带指纹的请求：命中一次
    const chat = (sys) => fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fp-model',
        stream: true,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    const res1 = await chat('You are an AI agent powered by DeepSeek Harness.');
    assert.equal(res1.status, 200);
    await res1.text();

    const after1 = await healthOf();
    assert.equal(after1.fingerprints.rewrites, 1, '命中一次后 rewrites 应为 1');
    const dshRule = after1.fingerprints.byRule.find((r) => r.preview.startsWith('You are an AI agent powered by'));
    assert.ok(dshRule, 'byRule 里应能找到 DSH 开场白那条规则');
    assert.equal(dshRule.hits, 1, '该条规则命中数应为 1');

    // ③ 再发一次：进程级累加，不是重置
    const res2 = await chat('You are an AI agent powered by DeepSeek Harness.');
    assert.equal(res2.status, 200);
    await res2.text();
    const after2 = await healthOf();
    assert.equal(after2.fingerprints.rewrites, 2, '计数必须累加（第二次后为 2），不能每次请求重置');

    // ④ 不带指纹的请求不得让计数上涨（避免把普通对话误计成「上游又加黑名单」）
    const res3 = await chat('You are a helpful assistant.');
    assert.equal(res3.status, 200);
    await res3.text();
    const after3 = await healthOf();
    assert.equal(after3.fingerprints.rewrites, 2, '不含指纹的请求不得改变计数');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游长时间静默时必须发 SSE 心跳，且响应头要立刻到（否则客户端干等/被中间层掐断）', { timeout: 90_000 }, async () => {
  /*
   * 为什么必须有这条：上游在长上下文预填充 / 长时间 reasoning 时可能几十秒不出字节
   * （实测本机账本里有 132 秒才完成的请求）。这期间若桥也一声不吭，客户端只能干等；
   * 而反向代理/CDN/客户端读超时会把「长时间无数据的流」判死，表现为「答到一半断了」
   * 或「转圈后报网络错误」，且拿不到任何错误码。
   *
   * 钉住三件事：① 响应头立刻到（不等上游首字节）；② 静默期有注释帧心跳；
   * ③ 心跳是 SSE 注释（以 `:` 开头），不会产生 message 事件污染内容。
   */
  const stub = await startStubUpstream(['hb-model'], { chatSilentMs: 3000 });
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SSE_HEARTBEAT_MS: '400' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');

    const t0 = Date.now();
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hb-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const headerAt = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(headerAt < 2000, `响应头必须立刻到（实测 ${headerAt}ms），不能等上游首字节`);

    // 生效值必须可从 /health 读到：心跳默认 30s，短请求触发不到，
    // 没有这个字段就只能靠「等一个超过 30 秒的请求」来确认配置有没有被读取。
    const health = await fetch(bridge.baseUrl + '/health', { headers: auth }).then((r) => r.json());
    assert.equal(health.stream?.heartbeatMs, 400, '/health 必须回传心跳生效值（本用例设了 400ms）');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: Date.now() - t0, text: dec.decode(value, { stream: true }) });
    }

    const duringSilence = chunks.filter((c) => c.at < 2800);
    const heartbeats = duringSilence.filter((c) => c.text.trim().startsWith(':'));
    assert.ok(heartbeats.length > 0,
      `静默期必须有 SSE 注释帧心跳（实际 ${JSON.stringify(duringSilence.map((c) => c.at))}）`);
    assert.ok(heartbeats.every((c) => c.text.trim().startsWith(':')), '心跳必须是注释帧（以冒号开头），不能是 data: 事件');

    const all = chunks.map((c) => c.text).join('');
    assert.match(all, /"content":"ok"/, '心跳之后真实数据必须照常到达');
    assert.match(all, /\[DONE\]/, '流必须正常收尾');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：Anthropic 路径同样有静默期心跳，且心跳不插进 content_block 配对里', { timeout: 90_000 }, async () => {
  /*
   * Anthropic 流比 OpenAI 严格：每个 content_block 必须 start/delta/stop 配对。
   * 所以这里除了「有心跳」，还要钉住「心跳用的是注释帧、没有被伪装成 ping 事件」，
   * 且 message_start / message_stop 仍然成对出现。
   */
  const stub = await startStubUpstream(['hb-a-model'], { chatSilentMs: 2500 });
  const bridge = await startBridge(
    { CODEBUDDY_ENDPOINT: stub.base, WORKBUDDY_SSE_HEARTBEAT_MS: '400' },
    { auth: READABLE_FAKE_AUTH },
  );
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');
    const res = await fetch(bridge.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hb-a-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.match(text, /: keepalive/, 'Anthropic 路径静默期必须有注释帧心跳');
    assert.ok(!/^event: ping$/m.test(text), '心跳不得伪装成 ping 事件');
    assert.match(text, /event: message_start/, '仍必须有 message_start');
    assert.match(text, /event: message_stop/, '仍必须有 message_stop');
  } finally {
    await bridge.stop();
    try { await stub.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游 429 文案里的重置时刻 → 标准 Retry-After（解析不出就**不给**，不编造）', { timeout: 90_000 }, async () => {
  /*
   * 现场：本机 4599 次请求里有 100 次（2.2%）撞上游 429（code 6004/14003）。
   * 上游**不返回 Retry-After 头**，但文案里写着恢复时刻：
   *   `…your usage will reset at 2026-10-23 15:14:30 UTC+8…`
   * 客户端因此不知道等多久：智能退避只能瞎猜，简单客户端直接把错误甩给用户。
   *
   * 这里同时钉住**反面**：文案里没有可解析的时刻时，**不得**编一个 Retry-After ——
   * 给一个错的等待时间比不给更糟（客户端会等错方向）。
   */
  const future = (() => {
    // 造一个「1 小时后」的 UTC+8 时刻，按上游文案格式拼出来
    const t = new Date(Date.now() + 3600_000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    return t;
  })();

  const okay = await startStubUpstream(['ra-model'], {
    chatResponses: [
      {
        status: 429,
        body: {
          code: 6004,
          msg: `usage exceeds frequency limit, but don't worry, your usage will reset at ${future} UTC+8, alternatively, you can switch to the other models`,
        },
      },
    ],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: okay.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ra-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(res.status, 429);
    await res.text();
    const ra = res.headers.get('retry-after');
    assert.ok(ra !== null, '上游文案里有恢复时刻时，必须给出 Retry-After');
    const seconds = Number(ra);
    assert.ok(Number.isFinite(seconds) && seconds > 3000 && seconds <= 3700,
      `应换算出约 3600 秒（实测 ${ra}）`);
  } finally {
    await bridge.stop();
    try { await okay.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});

test('桥：上游 429 文案里没有可解析时刻 → 不得编造 Retry-After', { timeout: 90_000 }, async () => {
  /*
   * 反面用例。上游有时候只写「稍后重试」这类模糊文案，或者时间不带时区。
   * 那种情况**不猜**：猜本地时区会让客户端等错方向。
   */
  const vague = await startStubUpstream(['ra2-model'], {
    chatResponses: [{ status: 429, body: { code: 14003, msg: 'too many requests' } }],
  });
  const bridge = await startBridge({ CODEBUDDY_ENDPOINT: vague.base }, { auth: READABLE_FAKE_AUTH });
  try {
    await fetch(bridge.baseUrl + '/v1/models?all=1');
    const res = await fetch(bridge.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ra2-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(res.status, 429);
    await res.text();
    assert.equal(res.headers.get('retry-after'), null,
      '解析不出恢复时刻时不得给 Retry-After（错的等待时间比没有更糟）');
  } finally {
    await bridge.stop();
    try { await vague.close(); } catch { /* 忽略 */ }
    rmSync(bridge.dir, { recursive: true, force: true });
  }
});
