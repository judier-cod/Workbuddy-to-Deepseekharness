/**
 * 面板的 HTTP 数据面 —— 客户端半边（lib/client.js）通过同源 fetch 调它。
 *
 * 为什么走 webServer 路由而不是 RPC/typert：客户端半边只要求「读状态 + 触发
 * 启停」，用普通 HTTP 路由最简单、最好调试，也不必为它维护一套严格反射定义。
 *
 * 安全边界：
 *   - 路由挂在 dsh 自己的 Web 载体上（只监听回环地址）；
 *   - **写操作**额外要求 `x-workbuddy-panel: 1` 头：这会让跨站表单/简单请求
 *     直接打不进来（带自定义头会触发 CORS 预检，而预检不会被放行），
 *     等于用最小代价挡掉 CSRF；读操作只暴露非敏感元数据。
 */
import { writeFileSync } from 'node:fs';

import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';
import { toDirectory } from './models.mjs';
import { createConsoleApiHandler, CONSOLE_API_PREFIX } from './consoleApi.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/**
 * @param {object} deps
 * @param {() => object} deps.snapshot 运行态快照
 * @param {() => object} deps.supervisor 桥管理器
 * @param {() => object} deps.consoleSupervisor 控制台管理器
 * @param {() => object} deps.client 桥客户端
 * @param {() => object} deps.adapter
 * @param {object} deps.paths { settingsPath, patchPath }
 * @param {string} deps.provider
 * @param {(line: string, detail?: unknown) => void} deps.log
 */
export function createRouteTable(deps) {
  // onWritePrefs / writeXxxPrefs 一律经 deps 取用（它们要带 provider 参数），
  // 因此这里不解构 —— 解构出来只会是个未使用的变量（ESLint no-unused-vars）。
  const { snapshot, supervisor, consoleSupervisor, client, adapter, paths, provider, log, onUpstreamMutation = () => {}, notifyAdaptersUpdated = () => false } = deps;
  /**
   * 已注册的账号分组。restart / stop 要**连分组桥一起**处理：桥是 detached 的、
   * 故意活过 dsh 重启，只管主桥会让分组继续跑旧代码（两边行为不一致）。
   */
  const accountGroups = Array.isArray(deps.accountGroups) ? deps.accountGroups : [];

  /** 写操作的准入检查。 */
  const guard = (req) => req.headers['x-workbuddy-panel'] === '1';

  /**
   * 只读路由的方法守门：只允许 GET/HEAD。
   * 目前非 GET 走进去也只是"当成读"（没有副作用），但显式拒绝更严谨 ——
   * 免得将来有人在某个读分支里加写逻辑，而代理/表单又恰好能打到它。
   */
  const readOnly = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    sendJson(res, 405, { ok: false, error: `${req.method} not allowed on a read-only route` });
    return true;
  };

  return [
    {
      kind: 'exact',
      path: '/workbuddy/status',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          // ?quota=1：**强制**重读积分（平时 120 秒缓存；面板上的"刷新"按钮要立刻看到新值）
          const url = new URL(req.url, 'http://127.0.0.1');
          const forceQuota = url.searchParams.get('quota') === '1';
          sendJson(res, 200, { ok: true, ...(await snapshot({ quota: forceQuota })) });
        } catch (error) {
          log('panel status failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 积分专用：GET 读缓存，POST 强制刷新（要面板头，避免跨站触发上游调用）
      kind: 'exact',
      path: '/workbuddy/quota',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const snap = await snapshot({ quota: true });
            // 一并回传分组账号的积分：面板靠它如实说明"这次刷了几个账号、
            // 哪几个失败"。少了这个字段，前端只能含糊地报"已刷新"，
            // 而分组可能一个都没读到（用户以为都刷新了）。
            return sendJson(res, 200, {
              ok: snap.quota?.ok !== false,
              quota: snap.quota,
              quotaError: snap.quotaError,
              at: snap.quotaAt,
              groupQuotas: snap.groupQuotas || [],
              refreshed: true,
            });
          }
          if (readOnly(req, res)) return;
          const snap = await snapshot({});
          sendJson(res, 200, { ok: snap.quota?.ok !== false, quota: snap.quota, quotaError: snap.quotaError, at: snap.quotaAt });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 模型目录。多账号下用 `?provider=<name>` 查**某个分组**的目录 ——
       * 各分组是独立的桥与账号，目录内容也不同（国际版 27 个 / 国内版 31 个）。
       * 缺省 = 主 provider。
       */
      kind: 'exact',
      path: '/workbuddy/models',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const refresh = url.searchParams.get('refresh') === '1';
          const asked = String(url.searchParams.get('provider') || '').trim();
          const target = deps.resolveProvider ? deps.resolveProvider(asked) : null;
          if (!target) {
            return sendJson(res, 400, { ok: false, models: [], error: `未知 provider：${asked || '(空)'}` });
          }
          const catalog = await target.adapter.catalog({ refresh });
          // 返回**归一化后**的目录（contextWindow/maxTokens/images/free…），
          // 不退上游原始字段名（context_window/max_output_tokens）：
          // 面板与其它消费者只认一种形状，免得两处各说一套。
          // images / credits 都必须带上该 provider 的覆盖 —— 否则面板显示的
          // 能力与价格会和 dsh 实际收到的（inputModalities / 展示名）对不上
          // （见 toDirectory 注释）。
          sendJson(res, 200, {
            ok: true,
            provider: target.id,
            models: toDirectory(catalog, {
              visionOverrides: target.adapter.visionOverrides,
              reasoningOverrides: target.adapter.reasoningOverrides,
              creditOverrides: target.adapter.creditOverrides,
            }),
            at: target.adapter.catalogCache.at,
            error: target.adapter.catalogError || '',
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, models: [], error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 模型显示偏好：GET 读当前生效清单，POST 写并即时生效（无需重启）。
       *
       * **按 provider 分开**：多账号下各分组目录不同（国际版 27 个 / 国内版 31 个），
       * 一份全局清单会一刀切，把非主分组的模型几乎全滤掉 —— 那正是"改不了显示
       * 模型"的原因。provider 走查询串（`?provider=workbuddy-ai`），缺省为主 provider。
       *
       * 读：任何 GET 都行（非敏感）；写：要面板头（挡跨站，与其它写路由一致）。
       * 注意这里**没有**碰 .state.json —— 那份文件是控制台的单写者领地，
       * 偏好存在插件自己的 .model-prefs.json（见 index.js 里的说明）。
       */
      kind: 'exact',
      path: '/workbuddy/model-visibility',
      async handler(req, res) {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const asked = String(url.searchParams.get('provider') || '').trim();
          // 只认已注册的 provider：不认的话写操作会写进一个永远读不到的键
          const target = deps.resolveProvider ? deps.resolveProvider(asked) : null;
          if (!target) {
            return sendJson(res, 400, { ok: false, error: `未知 provider：${asked || '(空)'}` });
          }
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const visible = Array.isArray(body?.visible) ? body.visible.map(String).filter(Boolean) : [];
            // 目录里不存在的 id 也照存：上游目录可能暂时没抓到，用户勾选的意图优先，
            // 目录恢复后自然重新生效。
            target.adapter.setFilter({ allow: visible });
            const persisted = typeof deps.onWritePrefs === 'function' ? deps.onWritePrefs(target.id, visible) : false;
            // 广播 llm/adapters-updated：dsh 的模型选择器**不轮询**目录，只认这个
            // 事件。不广播的话 filter 虽已生效，但 UI 会一直显示旧清单 —— 用户保存
            // 完看模型数量没变，报的就是这个。返回 applied 让前端如实告知：
            // 旧版 dsh 没有这个内部方法时 applied=false，前端提示"重启一次 dsh"。
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, { ok: true, provider: target.id, visible, count: visible.length, applied, persisted });
          }
          if (readOnly(req, res)) return;
          const current = typeof deps.readPrefs === 'function' ? deps.readPrefs(target.id) : null;
          sendJson(res, 200, { ok: true, provider: target.id, visible: current, at: target.adapter.catalogCache.at });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 上下文上限覆盖：GET 读当前生效值，POST 写并即时生效（无需重启）。
       *
       * 与 model-visibility 同一套约定：读开放、写要面板头；写操作都要广播
       * adapters-updated，否则 UI 一直显示旧值。
       */
      kind: 'exact',
      path: '/workbuddy/context-overrides',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const raw = body?.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides
              : {};
            /**
             * 全局档位（`maxTokens`）：面板上那排「262k / 1M」快捷按钮写的就是它。
             * 语义是**上限** —— 只压小、不放大，所以 "1M" 等于"不限制"
             * （目录里没有超过 1M 的模型）。0 / 缺省 = 不限。
             */
            /*
             * 上下文上限是**全局**设置（不按 provider 分桶），所以必须同时写进
             * 主 adapter 与每个分组 adapter —— 否则面板上改完只对主账号生效，
             * 分组要等 dsh 重启才跟上（启动时 index.js 会统一派发一次）。
             * 审计把这条列为"文案说是当前分组、实现却是全局"的不一致。
             *
             * 目标集 = 主 adapter + 已注册分组里那些真的持有 adapter 的。
             */
            const targets = [adapter, ...accountGroups.filter((g) => g.adapter).map((g) => g.adapter)];
            if (body?.maxTokens !== undefined) {
              for (const a of targets) a.setContextMaxTokens(body.maxTokens);
            }
            // overrides 显式给了才动它 —— 只切档位时不该把逐模型覆盖抹掉
            const touchesOverrides = body?.overrides !== undefined;
            if (touchesOverrides) for (const a of targets) a.setContextOverrides(raw);
            const applied = typeof deps.writeContextPrefs === 'function'
              ? deps.writeContextPrefs(
                touchesOverrides ? adapter.contextOverrides : undefined,
                body?.maxTokens !== undefined ? adapter.contextMaxTokens : undefined,
              )
              : false;
            const broadcast = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true,
              overrides: adapter.contextOverrides,
              maxTokens: adapter.contextMaxTokens,
              // 让前端/用户能看出这次改了哪几个（全局设置应当命中全部）
              appliedTo: targets.length,
              persisted: applied,
              applied: broadcast,
            });
          }
          if (readOnly(req, res)) return;
          sendJson(res, 200, {
            ok: true,
            overrides: adapter.contextOverrides || {},
            maxTokens: adapter.contextMaxTokens || 0,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 图片能力覆盖：GET 读当前值，POST 写并即时生效。
       *
       * 为什么需要：上游目录会漏报多模态能力（实测国际版账号下
       * `deepseek-v4.1-flash` 的 supports_images 为空，但该模型确实能看图）。
       * 不手动声明，用户在这个模型下就贴不了图。
       *
       * **按 provider 分开**（与 /credit-overrides 同构）：图片能力是账号维度
       * 属性 —— 国内版目录已声明 true、国际版漏报，一份全局覆盖会让两边互相
       * 串味。缺省（不传 provider）落在主 provider 上。
       */
      kind: 'exact',
      path: '/workbuddy/vision-overrides',
      async handler(req, res) {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const asked = String(url.searchParams.get('provider') || '').trim();
          const target = deps.resolveProvider ? deps.resolveProvider(asked) : null;
          if (!target) {
            return sendJson(res, 400, { ok: false, error: `未知 provider：${asked || '(空)'}` });
          }
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const raw = body?.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides
              : {};
            target.adapter.setVisionOverrides(raw);
            const persisted = typeof deps.writeVisionPrefs === 'function'
              ? deps.writeVisionPrefs(target.id, target.adapter.visionOverrides)
              : false;
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true, provider: target.id, overrides: target.adapter.visionOverrides, persisted, applied,
            });
          }
          if (readOnly(req, res)) return;
          sendJson(res, 200, {
            ok: true, provider: target.id, overrides: target.adapter.visionOverrides || {},
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 推理能力覆盖：GET 读当前值，POST 写并即时生效。
       *
       * 与 /vision-overrides 完全同源的坑：上游目录会漏报 `supports_reasoning`。
       * 实测国内版 `deepseek-v4.1-flash` 带该字段（true），国际版同一模型连
       * 这个字段都没有 —— 而实测国际版接受 `reasoning_effort: "high"` 并返回
       * 200。不手动声明，dsh 的选择器就没有「推理等级」下拉。
       *
       * **按 provider 分开**（与 vision / credit 同构）：能力是账号维度属性。
       */
      kind: 'exact',
      path: '/workbuddy/reasoning-overrides',
      async handler(req, res) {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const asked = String(url.searchParams.get('provider') || '').trim();
          const target = deps.resolveProvider ? deps.resolveProvider(asked) : null;
          if (!target) {
            return sendJson(res, 400, { ok: false, error: `未知 provider：${asked || '(空)'}` });
          }
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const raw = body?.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides
              : {};
            target.adapter.setReasoningOverrides(raw);
            const persisted = typeof deps.writeReasoningPrefs === 'function'
              ? deps.writeReasoningPrefs(target.id, target.adapter.reasoningOverrides)
              : false;
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true, provider: target.id, overrides: target.adapter.reasoningOverrides, persisted, applied,
            });
          }
          if (readOnly(req, res)) return;
          sendJson(res, 200, {
            ok: true, provider: target.id, overrides: target.adapter.reasoningOverrides || {},
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      /**
       * 倍率覆盖：GET 读当前值，POST 写并即时生效。
       *
       * 为什么需要：上游目录会漏报倍率 —— 实测国际版目录里
       * `deepseek-v4.1-flash` 连 `credits` 都没有，而实测 32433 tokens 扣分
       * 恒为 0（真免费）。漏报导致展示名光秃秃没有价。
       */
      kind: 'exact',
      path: '/workbuddy/credit-overrides',
      async handler(req, res) {
        try {
          // 按 provider 分开：倍率是**账号维度**属性（国际版免费 ≠ 国内版免费）。
          // 用一份全局覆盖会把国内版也标成免费 —— 实测过这个坑。
          const url = new URL(req.url, 'http://127.0.0.1');
          const asked = String(url.searchParams.get('provider') || '').trim();
          const target = deps.resolveProvider ? deps.resolveProvider(asked) : null;
          if (!target) {
            return sendJson(res, 400, { ok: false, error: `未知 provider：${asked || '(空)'}` });
          }
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const raw = body?.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides
              : {};
            target.adapter.setCreditOverrides(raw);
            const persisted = typeof deps.writeCreditPrefs === 'function'
              ? deps.writeCreditPrefs(target.id, target.adapter.creditOverrides)
              : false;
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true, provider: target.id, overrides: target.adapter.creditOverrides, persisted, applied,
            });
          }
          if (readOnly(req, res)) return;
          sendJson(res, 200, {
            ok: true, provider: target.id, overrides: target.adapter.creditOverrides || {},
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/usage',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 账本由桥维护（内存副本 + 文件），必须让桥自己清 —— 与控制器同一条路径
            await client.clearUsage();
            return sendJson(res, 200, { ok: true, cleared: true });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
          const hours = url.searchParams.get('hours') === '1';
          sendJson(res, 200, { ok: true, ...(await client.usage({ days, hours })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/requests',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
          sendJson(res, 200, { ok: true, ...(await client.requests({ limit })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/log',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 桥持有 bridge.log 的追加 fd：截断后它从新文件末尾继续（O_APPEND），与控制器一致
            try {
              writeFileSync(supervisor.logPath, '');
              return sendJson(res, 200, { ok: true, cleared: true });
            } catch (error) {
              return sendJson(res, 500, { ok: false, cleared: false, error: String(error?.message || error) });
            }
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 1), 2000);
          sendJson(res, 200, { ok: true, ...supervisor.readLog({ lines }) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/checkin',
      async handler(req, res) {
        try {
          // GET = 读状态；POST?claim=1 = 领取（写，需要面板头）；其它方法拒绝
          if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const claim = req.method === 'POST' && url.searchParams.get('claim') === '1';
          if (claim && !guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const result = await client.checkin({ claim });
          // 领取成功 = 上游余额变了：作废插件侧积分/签到缓存（下一次快照重取新值），
          // 否则面板最长 120 秒还显示领取前的余额
          if (claim && result?.ok !== false) onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/bridge',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const action = String(body?.action || 'status');
          if (action === 'start') {
            const result = await supervisor.ensure({});
            adapter.invalidate();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'stop') {
            // 主桥 + 全部分组桥：桥是 detached 的，只停主桥会留下每个分组桥
            // 继续占端口/进程 —— 与 restart 的语义必须对称（审计发现的不一致）。
            const result = await supervisor.stop();
            adapter.invalidate();
            const groups = [];
            for (const g of accountGroups) {
              if (!g.supervisor) { groups.push({ provider: g.provider, ok: false, error: '未注册' }); continue; }
              try {
                const r = await g.supervisor.stop();
                if (g.adapter) g.adapter.invalidate();
                groups.push({ provider: g.provider, ok: r.ok, stopped: !!r.stopped, error: r.error || '' });
              } catch (err) {
                groups.push({ provider: g.provider, ok: false, error: String(err?.message || err) });
              }
            }
            return sendJson(res, 200, { ok: result.ok, action, result, groups });
          }
          if (action === 'restart') {
            // 主桥 + 全部分组桥：桥是 detached 的，重启 dsh 不会让它们换代码
            const result = await supervisor.ensure({ restart: true });
            adapter.invalidate();
            const groups = [];
            for (const g of accountGroups) {
              if (!g.supervisor) { groups.push({ provider: g.provider, ok: false, error: '未注册' }); continue; }
              try {
                const r = await g.supervisor.ensure({ restart: true });
                if (g.adapter) g.adapter.invalidate();
                groups.push({ provider: g.provider, ok: r.ok, pid: r.health?.pid, error: r.error || '' });
              } catch (err) {
                groups.push({ provider: g.provider, ok: false, error: String(err?.message || err) });
              }
            }
            return sendJson(res, 200, { ok: result.ok, action, result, groups });
          }
          const probe = await supervisor.probe();
          return sendJson(res, 200, { ok: true, action: 'status', result: probe });
        } catch (error) {
          log('panel bridge action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/console',
      async handler(req, res) {
        try {
          if (req.method !== 'POST') {
            if (readOnly(req, res)) return;
            const probe = await consoleSupervisor.probe({ cached: false });
            return sendJson(res, 200, { ok: true, url: consoleSupervisor.url, state: probe.state, error: probe.error || '', managed: consoleSupervisor.spawnedPid !== null });
          }
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const body = await readJsonBody(req);
          const action = String(body?.action || 'start');
          if (action === 'stop') {
            const result = await consoleSupervisor.stop();
            return sendJson(res, 200, { ok: result.ok, action, url: consoleSupervisor.url, result });
          }
          const result = await consoleSupervisor.ensure({});
          return sendJson(res, 200, { ok: result.ok, action: 'start', url: consoleSupervisor.url, result });
        } catch (error) {
          log('panel console action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/migrate',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const dryRun = body?.dryRun === true;
            const result = cleanLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider, dryRun });
            log(`legacy cleanup ${dryRun ? '(dry-run) ' : ''}changed=${result.changed}`);
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (readOnly(req, res)) return;
          const detected = detectLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider });
          sendJson(res, 200, { ok: true, ...detected });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    // 控制台域的功能（账号 / 诊断 / 体检 / 对话测试 / 自动签到开关）原样透传，
    // 白名单见 consoleApi.mjs —— 单写者，两边状态才不会各说一套。
    {
      kind: 'prefix',
      path: CONSOLE_API_PREFIX,
      handler: createConsoleApiHandler({ consoleSupervisor, log, onUpstreamMutation }),
    },
  ];
}

/**
 * 把路由表挂到 dsh 的 Web 载体上。
 * @param {object} target 要么是 webServer 服务本身，要么是一个能 `get('webServer')` 的 ctx
 * @returns {() => void} 幂等 disposer
 */
export function mountRoutes(target, routes, log = () => {}) {
  const webServer = typeof target?.register === 'function' ? target : target?.get?.('webServer');
  if (!webServer) {
    log('webServer 服务不可用，面板数据面未挂载（GUI 面板会显示离线）');
    return () => {};
  }
  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }));
    } catch (error) {
      log(`挂载路由 ${route.path} 失败`, error);
    }
  }
  log(`已挂载 ${disposers.length}/${routes.length} 条面板路由`);
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* 忽略 */ } } };
}
