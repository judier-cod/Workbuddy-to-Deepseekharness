/**
 * dsh-plugin-workbuddy —— 宿主端。
 *
 * 分工（插件 + 控制台的结合方式）：
 *   插件  = 引擎：原生模型路由、桥与控制台的生命周期、工具、命令、入口
 *   控制台 = 界面：逐条请求、趋势图、账号切换、CSV、签到、诊断（它本来就更全）
 *
 * 具体做这些事：
 *
 *   1. 桥的生命周期归插件管：启动时复用已在跑的桥，没跑就按配置拉起
 *      （桥仍是**独立进程**，控制台与其它 OpenAI 客户端照旧可用）；
 *   2. 控制台也一起管：复用/拉起 `dashboard/server.mjs`，让它常驻，
 *      这样 dsh 里一个链接就能进完整的控制台；
 *   3. 用 `ctx.llm.registerAdapter(['workbuddy'], adapter)` 注册一条原生路由：
 *      模型直接出现在 dsh 的模型选择器里，**不再需要**改 settings.yaml，
 *      也不再依赖 llm-pi-ai 那一行；
 *   4. 注册 5 个模型可见的工具（状态 / 模型 / 用量 / 签到 / 启停桥）；
 *   5. 注册 `/workbuddy` 斜杠命令，人可以直接在输入框里操作；
 *   6. 挂一组 `/workbuddy/*` 同源 HTTP 路由，给 dsh 里的入口页当数据面；
 *   7. 首次启动时把旧的 `llm-pi-ai.providers.workbuddy` 手写路由清理掉
 *      （先备份），否则两条路由会撞名。
 *
 * 这个文件刻意**不 import 任何 `@deepseek-ai/*` 包**：profile 的 node_modules
 * 里解析不到它们，而 llm 服务的注册路径也不要求适配器继承 LlmAdapter
 * （只调用 providerInfo / providerRetryPolicy，没有 instanceof 检查）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeClient, BridgeSupervisor, BRIDGE_SCRIPT_REL } from './bridge.mjs';
import { ConsoleSupervisor } from './console.mjs';
import { WorkBuddyAdapter } from './adapter.mjs';
import { toDirectory, pickDefaultModel } from './models.mjs';
import { createTools } from './tools.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';
import { listManagedAccounts } from './login.mjs';
import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';

export const name = 'workbuddy';
/** 硬依赖 llm：没有它就没有「原生路由」这件事，插件保持不激活比半激活好。 */
export const inject = ['llm'];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 面板勾选的模型显示偏好（哪些模型出现在 dsh 选择器里）。
 *
 * 为什么不存 .state.json：那份文件由**控制台**单写者维护（它有进程内缓存，
 * 外部写入会让缓存悄悄过期），而控制台没有"模型显示"这个概念。这是插件
 * 自己的功能，存自己的小文件最干净 —— 与控制台零耦合，也不会在 vendor
 * 分发形态下写脏仓库根。
 *
 * 文件位于插件目录旁（安装形态下是 profile 的 node_modules 内），与插件
 * 同生命周期；git 安装到 node_modules 里写文件是常见做法（pnpm 不清理）。
 */
const MODEL_PREFS_PATH = join(PLUGIN_DIR, '.model-prefs.json');

/**
 * 读某个 provider 的模型可见性白名单。
 *
 * **多账号下必须按 provider 分开存**：各分组的目录不同（国际版 27 个、
 * 国内版 31 个），用一份全局白名单会一刀切 —— 之前就是这样，勾了 3 个模型后
 * 三个分组各只剩 2 个，用户"改不了显示模型"。
 *
 * 兼容旧的全局 `visible` 键：它只用于主 provider，读不到分组键时回退到它。
 *
 * @param {string} provider provider 名（如 workbuddy / workbuddy-ai）
 * @param {string} [primaryProvider] 主 provider（旧 visible 键归属它）
 */
function readModelPrefs(provider, primaryProvider) {
  try {
    const j = JSON.parse(readFileSync(MODEL_PREFS_PATH, 'utf8'));
    // 分组键优先
    const perProvider = j?.visibleByProvider;
    if (perProvider && typeof perProvider === 'object' && Array.isArray(perProvider[provider])) {
      return perProvider[provider].map(String);
    }
    /**
     * 回退到旧版全局 `visible`：**只对主 provider 生效**。
     *
     * 注意这里刻意**不写** `!primaryProvider` 那种宽容分支 —— 那会让"调用方
     * 忘了传主 provider"变成静默回退到全局清单，所有分组都读到主 provider 的
     * 旧值。真踩过一次：路由直接传函数引用，第二个参数是 undefined，于是
     * 三个分组都显示同一份清单。宁可这里判为"没有偏好"，也不要静默串味。
     */
    if (Array.isArray(j.visible) && primaryProvider && provider === primaryProvider) {
      return j.visible.map(String);
    }
    return null;
  } catch { return null; }
}

/**
 * 读整个 prefs 对象（含未知键）。
 *
 * 为什么不能直接 `JSON.parse` 后只挑 visible/context 再写回：那样会**丢掉
 * 文件里其它一切键**。真出过一次 —— 写上下文覆盖时把用户勾选的可见清单
 * 冲掉了（23 个变 2 个）。所以写入一律走 {@link mergePrefs}，它保留未知键。
 */
function readPrefsFile() {
  try {
    const j = JSON.parse(readFileSync(MODEL_PREFS_PATH, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/**
 * 合并写 prefs：在**原文件基础上**改一个键，保留其余全部键（含未知键），
 * 再原子替换。
 *
 * 原子替换（写临时文件 + rename）是为了避免写一半崩溃留下截断的 JSON ——
 * 那份文件一坏，可见清单与上下文设置就全没了，且没有别的副本。
 */
function mergePrefs(patch) {
  try {
    const current = readPrefsFile();
    const next = { ...current, ...patch, at: Date.now() };
    const dir = dirname(MODEL_PREFS_PATH);
    const tmp = join(dir, `.model-prefs.json.tmp-${process.pid}`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, MODEL_PREFS_PATH);
    return true;
  } catch {
    /* 只读介质：本次运行生效，不持久化 */
    return false;
  }
}

/**
 * 写某个 provider 的可见性白名单。
 *
 * 写进 `visibleByProvider[provider]`，**不动**其它 provider 的键 ——
 * 这正是"给 A 组勾选不会影响 B 组"的关键。
 */
function writeModelPrefs(provider, visible) {
  const current = readPrefsFile();
  const map = (current.visibleByProvider && typeof current.visibleByProvider === 'object')
    ? { ...current.visibleByProvider }
    : {};
  map[provider] = Array.isArray(visible) ? visible.map(String) : [];
  // 注意保留旧的 visible 键（旧版兼容），只加 visibleByProvider
  return mergePrefs({ visibleByProvider: map });
}

/** 读持久化的上下文设置（逐模型覆盖 + 全局档位）。 */
function readContextPrefs() {
  try {
    const j = JSON.parse(readFileSync(MODEL_PREFS_PATH, 'utf8'));
    return {
      overrides: asContextOverrides(j?.context),
      maxTokens: Math.max(0, Math.floor(Number(j?.contextMaxTokens) || 0)),
    };
  } catch { return null; }
}

/**
 * 写上下文设置。
 *
 * 两个参数都可选：只传一个时**另一个保持原值**（走 mergePrefs 的合并写）——
 * 切档位不该抹掉逐模型覆盖，改单个模型也不该把档位复位。
 */
function writeContextPrefs(overrides, maxTokens) {
  const patch = {};
  if (overrides !== undefined) patch.context = asContextOverrides(overrides);
  if (maxTokens !== undefined) {
    const n = Math.floor(Number(maxTokens) || 0);
    patch.contextMaxTokens = n > 0 ? n : 0;
  }
  return mergePrefs(patch);
}

/**
 * 解析「模型 id → 布尔能力」的映射（图片输入、推理等级这类）。
 *
 * **只收布尔值**：`true`/`false` 才算数，字符串 "true" 一律丢弃 ——
 * 含糊的值被当成"支持"，会让用户贴了图/选了推理等级，却在调用时被上游拒绝。
 */
function asBoolOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const id = String(key || '').trim();
    if (!id) continue;
    if (raw === true) out[id] = true;
    else if (raw === false) out[id] = false;
  }
  return out;
}

/** 图片能力覆盖的解析（与 asBoolOverrides 同义，保留名字便于对照既有引用）。 */
function asVisionOverrides(value) {
  return asBoolOverrides(value);
}

/**
 * 布尔能力覆盖的**通用**读写 —— 图片输入与推理等级形状完全一致
 * （模型 id → true/false，按 provider 分桶），共用一份实现而不是复制两遍：
 * 这类"复制出来的平行代码"迟早分叉（可见性/倍率上已经各踩过一次）。
 *
 * 键布局：`<kind>ByProvider: { '<provider>': { '<modelId>': boolean } }`。
 * 兼容旧的全局键（仅 vision 有过）：只对主 provider 生效，且刻意**不写**
 * `!primaryProvider` 那种宽容分支 —— 那会让"调用方漏传主 provider"变成静默
 * 串味，所有分组都读到主 provider 的值（可见性偏好上真踩过）。
 */
const BOOL_KINDS = new Set(['vision', 'reasoning']);

/** 读某个 provider 的布尔能力覆盖；null = 没有偏好（走目录）。 */
function readBoolPrefs(kind, provider, primaryProvider) {
  if (!BOOL_KINDS.has(kind)) return null;
  try {
    const j = JSON.parse(readFileSync(MODEL_PREFS_PATH, 'utf8'));
    const perProvider = j?.[`${kind}ByProvider`];
    if (perProvider && typeof perProvider === 'object' && perProvider[provider] !== undefined) {
      return asBoolOverrides(perProvider[provider]);
    }
    // 旧全局键（历史上只有 vision 用过）
    if (j?.[kind] !== undefined && primaryProvider && provider === primaryProvider) {
      return asBoolOverrides(j[kind]);
    }
    return null;
  } catch { return null; }
}

/**
 * 写某个 provider 的布尔能力覆盖（不动其它 provider 的键）。
 *
 * `primaryProvider` 用于**安全迁移**旧的全局键：那个键只对主 provider 生效
 * （见 readBoolPrefs）。这里**曾经**无条件把它置 null —— 于是"用户切到分组账号
 * 随手存一次"就会把主账号还在读的旧声明**销毁**（实测复现：
 * `{"vision":{...}}` 写一次分组后主 provider 读到 `{}`，图片能力又被静默降级）。
 *
 * 正确做法：先把旧值**并入主 provider 的桶**，再清掉旧键。这样无论从哪个分组
 * 写，主账号的声明都被保留下来，且只迁移一次（迁移后 `current[kind]` 已是 null）。
 */
function writeBoolPrefs(kind, provider, overrides, primaryProvider) {
  if (!BOOL_KINDS.has(kind)) return false;
  const current = readPrefsFile();
  const key = `${kind}ByProvider`;
  const map = (current[key] && typeof current[key] === 'object') ? { ...current[key] } : {};
  map[provider] = asBoolOverrides(overrides);
  const patch = { [key]: map };
  /*
   * 迁移旧的全局键。只在它**真的带着值**时动手，且必须先落进主 provider 的桶：
   *   - 旧值 → visionByProvider[主 provider]（仅当该桶还没有键，不覆盖用户新设置）
   *   - 然后才把旧键置 null
   * 不传 primaryProvider 时（不该发生）保守处理：不动旧键，宁可留着也不要毁数据。
   */
  const legacy = current[kind];
  if (legacy !== undefined && legacy !== null && primaryProvider) {
    const legacyVals = asBoolOverrides(legacy);
    if (Object.keys(legacyVals).length && map[primaryProvider] === undefined) {
      map[primaryProvider] = legacyVals;
    }
    patch[kind] = null;
  }
  return mergePrefs(patch);
}

/**
 * 读持久化的图片能力覆盖，**按 provider 分开**。
 *
 * 为什么必须按 provider：图片能力是**账号维度**的属性 —— 同一个
 * `deepseek-v4.1-flash` 在国内版目录里 `supports_images: true`，在国际版目录里
 * 却漏报（为空）。用户在国际版手动声明 `true` 后，这份覆盖不该让国内版也跟着
 * 变成"手动指定"，更不该在用户想压掉某个分组的误报时连带影响另一组。
 * 与可见性、倍率同一套结构（`visionByProvider`）。
 *
 * 兼容旧的全局 `vision` 键：只对主 provider 生效。刻意**不写**
 * `!primaryProvider` 那种宽容分支 —— 那会让漏传参数变成静默串味
 * （可见性偏好上真踩过：漏传主 provider 时每个分组都读到主 provider 的清单）。
 *
 * @param {string} provider 要读的 provider 名
 * @param {string} [primaryProvider] 主 provider 名（判旧键归属用）
 */
function readVisionPrefs(provider, primaryProvider) {
  return readBoolPrefs('vision', provider, primaryProvider);
}

/**
 * 读持久化的**推理能力**覆盖，按 provider 分开。
 *
 * 与图片能力完全同源的坑：上游目录会漏报。实测国内版 `deepseek-v4.1-flash`
 * 带 `supports_reasoning: true`，国际版同一模型连这个字段都没有 —— 而实测
 * 国际版接受 `reasoning_effort: "high"` 且返回 200。不手动声明，dsh 的选择器
 * 就没有「推理等级」下拉，用户以为该模型不支持推理。
 */
function readReasoningPrefs(provider, primaryProvider) {
  return readBoolPrefs('reasoning', provider, primaryProvider);
}

/**
 * 写某个 provider 的推理能力覆盖（不动其它 provider 的键）。
 * 与 {@link writeVisionPrefs} 同构。
 */
function writeReasoningPrefs(provider, overrides, primaryProvider) {
  return writeBoolPrefs('reasoning', provider, overrides, primaryProvider);
}

/**
 * 解析「模型 id → 倍率」的映射（0 = 免费）。
 *
 * 只收**非负有限数**；数字字符串要认（表单与 YAML 常写成字符串）。
 * 负数 / NaN / 非数字一律丢弃 —— 宁可不标，也不能标个负数。
 */
function asCreditOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const id = String(key || '').trim();
    if (!id) continue;
    // 空白先排除再谈数值：Number('') === 0 会把"没填"误当成"免费"（标错价）
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    out[id] = n;
  }
  return out;
}

/**
 * 读持久化的倍率覆盖，**按 provider 分开**。
 *
 * 为什么必须按 provider：倍率是**账号维度**的属性。实测 `deepseek-v4.1-flash`
 * 在国际版免费、国内版 0.11× —— 用一份全局覆盖会把国内版也标成免费。
 * 与可见性偏好同一套结构（`creditsByProvider`）。
 *
 * 兼容旧的全局 `credits` 键：只对主 provider 生效（不写 `!primaryProvider`
 * 那种宽容分支 —— 那会让漏传参数变成静默串味）。
 */
function readCreditPrefs(provider, primaryProvider) {
  try {
    const j = JSON.parse(readFileSync(MODEL_PREFS_PATH, 'utf8'));
    const perProvider = j?.creditsByProvider;
    if (perProvider && typeof perProvider === 'object' && perProvider[provider] !== undefined) {
      return asCreditOverrides(perProvider[provider]);
    }
    if (j?.credits !== undefined && primaryProvider && provider === primaryProvider) {
      return asCreditOverrides(j.credits);
    }
    return null;
  } catch { return null; }
}

/** 写某个 provider 的倍率覆盖（不动其它 provider 的键）。 */
function writeCreditPrefs(provider, overrides) {
  const current = readPrefsFile();
  const map = (current.creditsByProvider && typeof current.creditsByProvider === 'object')
    ? { ...current.creditsByProvider }
    : {};
  map[provider] = asCreditOverrides(overrides);
  return mergePrefs({ creditsByProvider: map });
}

/**
 * 写某个 provider 的图片能力覆盖（不动其它 provider 的键）。
 *
 * 与 {@link writeCreditPrefs} 同构：按 provider 分桶存。顺带**清掉旧的全局
 * `vision` 键** —— 它只对主 provider 生效，留着会让"主 provider 读到旧全局值"
 * 与"分组读到新分桶值"两套语义并存；用户第一次在面板上操作后，意图就完整
 * 落在 `visionByProvider` 里了。
 *
 * **导出供测试**：这条写入路径有个只在"从分组账号保存"时才暴露的缺陷（旧全局
 * 键被无条件清掉，销毁主账号的声明），必须能直接测真实实现 —— 用桩测不出
 * "调用方漏绑主 provider"这类接线问题（可见性偏好上正是这么漏过一次）。
 */
export function writeVisionPrefs(provider, overrides, primaryProvider) {
  return writeBoolPrefs('vision', provider, overrides, primaryProvider);
}

/**
 * 解析多账号分组配置。
 *
 * 只接受**有 id 的条目**；id 会被规范化成 provider 名可用的字符
 * （字母数字，其余换成 `-`），因为 provider 名要进 dsh 的路由键。
 * 另做三项防呆：
 *   - id 去重（重名会让后一个静默覆盖前一个的路由）
 *   - 端口去重（两个分组抢同一个端口 = 必有一个起不来）
 *   - 端口必须落在合法范围，否则丢弃该条（宁可少一个分组，也不要一个起不来的）
 *
 * @param {unknown} value 原始配置
 * @param {string} prefix provider 名前缀（config.accountProviderPrefix）
 * @param {number} basePort 主桥端口（未指定 port 时按序 +1 +2 …）
 */
export function asAccounts(value, prefix = 'workbuddy', basePort = 8790) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seenId = new Set();
  const seenPort = new Set([basePort]);
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = String(raw.id ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id || seenId.has(id)) continue;
    let port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      // 未给或非法：从小到大的空闲序号里挑一个
      port = basePort + out.length + 1;
      while (seenPort.has(port) && port < 65535) port += 1;
    }
    if (seenPort.has(port)) continue;
    seenId.add(id);
    seenPort.add(port);
    out.push({
      id,
      provider: `${prefix}${id}`,
      displayName: String(raw.displayName || `WorkBuddy ${id}`),
      authFile: String(raw.authFile || ''),
      port,
      token: raw.token === undefined ? '' : String(raw.token),
    });
  }
  return out;
}

/** 默认值集中在一处，README 与面板都读它。 */
export const DEFAULTS = {
  projectRoot: '',
  bridgeHost: '127.0.0.1',
  bridgePort: 8790,
  localToken: 'wb-local-bridge',
  nodePath: '',
  /** 登录文件：留空 = 交给桥自己探测（多账号时应显式指定）。 */
  authFile: '',
  /** 每日自动签到：undefined = 用桥的默认值（开）。 */
  autoCheckin: undefined,
  autoStart: true,
  autoStartTimeoutMs: 30_000,
  /** 控制台（数据界面）也由插件复用/拉起：dsh 里给个入口就够了，不重复造仪表盘。 */
  consoleAutoStart: true,
  consoleHost: '127.0.0.1',
  consolePort: 8792,
  provider: 'workbuddy',
  fallbackProvider: 'workbuddy-native',
  displayName: 'WorkBuddy',
  catalogTtlMs: 60_000,
  /** 桥「已确认活着」结论的缓存时长（ensureReady 短路用）。对话失败会立即作废。 */
  bridgeAliveTtlMs: 5_000,
  modelAllow: [],
  modelDeny: [],
  /**
   * 模型选择器里给每个模型标出消耗倍率（如「DeepSeek-V4.1-Flash · 0.11×」）。
   * 选择器只渲染 `name`，所以标记编在展示名里；`id` 是路由键，不受影响。
   */
  showCredits: true,
  /**
   * 上下文上限覆盖：`{ '<modelId>': <tokens> }`。
   *
   * dsh 的「设置 → 模型」只能编辑**配置层声明**的模型；插件是运行时注册的
   * provider（没有 settingsNs），所以那页里的上下文输入框对它不可用。
   * 这里补一个插件自己的覆盖：既能写在 cordis.patch.yml 里，也能在 WorkBuddy
   * 面板里改并持久化。
   *
   * 语义是**上限**（cap），不是"声称的窗口"：
   *   - 目录下限 > 覆盖值 → 用覆盖值（这才是用户想压小的场景）
   *   - 目录下限 <= 覆盖值 → 保持原值（不能把 96k 的模型吹成 1M，
   *     那只会让 dsh 以为能塞更多、然后在上游拿到 context 错误）
   */
  contextOverrides: {},
  /** 全局上下文上限（token）。0 = 不限制（用目录里的真实值）。 */
  contextMaxTokens: 0,
  /**
   * 图片能力覆盖：`{ '<modelId>': true | false }`。
   *
   * 上游目录会漏报多模态能力 —— 实测国际版账号下 `deepseek-v4.1-flash` 的
   * `supports_images` 为空（国内版为 true），而该模型在国际版客户端里确实能看图。
   * 照搬目录字段会让用户在 DSH 里贴不了图，所以留一个手动声明的口子。
   * `true` = 强制声明支持；`false` = 强制声明不支持；未列出 = 按目录走。
   */
  visionOverrides: {},
  /**
   * 推理能力覆盖：`{ '<modelId>': true | false }`。
   *
   * 与 visionOverrides 完全同源的坑：上游目录会漏报 `supports_reasoning`。
   * 实测国内版 `deepseek-v4.1-flash` 带该字段（true），国际版同一模型整个
   * 字段都没有 —— 而实测国际版接受 `reasoning_effort: "high"` 并返回 200。
   * 照搬目录会让选择器少一个「推理等级」下拉。
   */
  reasoningOverrides: {},
  /**
   * 倍率覆盖：`{ '<modelId>': number }`（0 = 免费）。
   *
   * 上游目录会**漏报倍率**：实测国际版目录里 `deepseek-v4.1-flash` 连
   * `credits` 字段都没有，但实测 32433 tokens 扣分恒为 0（真免费）。
   * 漏报会让展示名没有价 —— 用户既怕贵不敢用、又不知道它免费。
   * 这里允许手动声明；只收非负数，其余忽略（按目录走）。
   */
  creditOverrides: {},
  /**
   * 多账号分组：让**同一个插件同时暴露多个账号**，各自一组 provider。
   *
   * 形状：`[{ id, displayName?, authFile?, port?, token? }, ...]`
   *   - `id`         分组后缀，provider 名 = `<provider><id>`（如 workbuddy1）
   *   - `displayName` 模型选择器里的分组名（默认 `WorkBuddy <id>`）
   *   - `authFile`   该账号的登录文件（留空 = 用主账号那份）
   *   - `port`       该分组自己的桥端口（留空 = bridgePort + 序号）
   *
   * **与"账号池化"不同**：每个分组驱动**一个**账号、各自独立的桥与端口，
   * 不做轮询、不做负载均衡 —— 用户只是不想来回点"切换"，想同时用两个账号。
   * 默认空数组 = 保持原有的单账号行为，一个字节都不变。
   */
  accounts: [],
  /** 多账号分组的命名前缀；provider 名 = `<前缀><分组 id>`。 */
  accountProviderPrefix: 'workbuddy',
  /**
   * 给 agent 实际调用模型时的默认参数（对话测试面板另有独立的即时控制）。
   * undefined = 不下发该字段，交给上游默认 —— 刻意不猜：不同模型对
   * reasoning_effort 的接受度不同，硬发可能 400。
   */
  defaultMaxTokens: undefined,
  defaultTemperature: undefined,
  defaultReasoningEffort: undefined,
  migrateLegacy: true,
  tools: true,
  commands: true,
  routes: true,
  panel: true,
  log: true,
};

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', ''].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function asStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * 解析「模型 id → 上下文上限」的映射。
 *
 * 只接受**正整数的 token 数**。非法值（负数、小数、字符串、0）一律丢弃 ——
 * 宁可少一条覆盖，也不能塞一个 dsh 会拒绝的值（`INVALID_MODEL_CONTEXT`
 * 要求正整数，传错会让整个 resolveModel 抛错，模型直接不可用）。
 */
function asContextOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const id = String(key || '').trim();
    const n = Number(raw);
    if (!id || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) continue;
    out[id] = n;
  }
  return out;
}

/** 合并 patch 里给的 config 与默认值。 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...cfg,
    projectRoot: String(cfg.projectRoot || ''),
    bridgeHost: String(cfg.bridgeHost || DEFAULTS.bridgeHost),
    bridgePort: Number(cfg.bridgePort) || DEFAULTS.bridgePort,
    localToken: String(cfg.localToken ?? DEFAULTS.localToken),
    nodePath: String(cfg.nodePath || ''),
    authFile: String(cfg.authFile || ''),
    autoCheckin: cfg.autoCheckin === undefined || cfg.autoCheckin === null
      ? undefined
      : asBool(cfg.autoCheckin, undefined),
    autoStart: asBool(cfg.autoStart, DEFAULTS.autoStart),
    autoStartTimeoutMs: Number(cfg.autoStartTimeoutMs) || DEFAULTS.autoStartTimeoutMs,
    consoleAutoStart: asBool(cfg.consoleAutoStart, DEFAULTS.consoleAutoStart),
    consoleHost: String(cfg.consoleHost || DEFAULTS.consoleHost),
    consolePort: Number(cfg.consolePort) || DEFAULTS.consolePort,
    provider: String(cfg.provider || DEFAULTS.provider),
    fallbackProvider: String(cfg.fallbackProvider || DEFAULTS.fallbackProvider),
    displayName: String(cfg.displayName || DEFAULTS.displayName),
    catalogTtlMs: Number(cfg.catalogTtlMs) || DEFAULTS.catalogTtlMs,
    bridgeAliveTtlMs: Number(cfg.bridgeAliveTtlMs) || DEFAULTS.bridgeAliveTtlMs,
    modelAllow: asStringArray(cfg.modelAllow),
    modelDeny: asStringArray(cfg.modelDeny),
    showCredits: asBool(cfg.showCredits, DEFAULTS.showCredits),
    contextOverrides: asContextOverrides(cfg.contextOverrides),
    contextMaxTokens: Math.max(0, Math.floor(Number(cfg.contextMaxTokens) || 0)),
    visionOverrides: asVisionOverrides(cfg.visionOverrides),
    reasoningOverrides: asBoolOverrides(cfg.reasoningOverrides),
    creditOverrides: asCreditOverrides(cfg.creditOverrides),
    accountProviderPrefix: String(cfg.accountProviderPrefix || DEFAULTS.accountProviderPrefix)
      .replace(/[^A-Za-z0-9_-]+/g, '') || DEFAULTS.accountProviderPrefix,
    accounts: asAccounts(cfg.accounts, String(cfg.accountProviderPrefix || DEFAULTS.accountProviderPrefix), Number(cfg.bridgePort) || DEFAULTS.bridgePort),
    defaultMaxTokens: cfg.defaultMaxTokens === undefined || cfg.defaultMaxTokens === null || cfg.defaultMaxTokens === ''
      ? undefined
      : (Number(cfg.defaultMaxTokens) > 0 ? Number(cfg.defaultMaxTokens) : undefined),
    defaultTemperature: cfg.defaultTemperature === undefined || cfg.defaultTemperature === null || cfg.defaultTemperature === ''
      ? undefined
      : (Number.isFinite(Number(cfg.defaultTemperature)) ? Number(cfg.defaultTemperature) : undefined),
    defaultReasoningEffort: ['low', 'medium', 'high'].includes(String(cfg.defaultReasoningEffort))
      ? String(cfg.defaultReasoningEffort)
      : undefined,
    migrateLegacy: asBool(cfg.migrateLegacy, DEFAULTS.migrateLegacy),
    tools: asBool(cfg.tools, DEFAULTS.tools),
    commands: asBool(cfg.commands, DEFAULTS.commands),
    routes: asBool(cfg.routes, DEFAULTS.routes),
    panel: asBool(cfg.panel, DEFAULTS.panel),
    log: asBool(cfg.log, DEFAULTS.log),
  };
}

/**
 * 定位 workbuddy-to-dsh 检出目录：桥脚本在里面。
 *
 * 顺序：显式配置 → 环境变量 → 插件目录的上一级（插件就在仓库里）→
 * **插件自带的 vendor/**（分发给别人时用它，见 scripts/vendor.mjs）→
 * node_modules 上溯三级（安装在 profile 里时）→ 常见位置。
 *
 * 仓库优先于 vendor 是有意的：本机开发时改 bridge/dashboard 立刻生效，
 * 不会被一份快照盖住。vendor 只在「仓库不在旁边」时兜底。
 */
export function projectRootCandidates(configured = '') {
  const candidates = [];
  if (configured) candidates.push({ path: configured, kind: 'configured' });
  if (process.env.WORKBUDDY_ROOT) candidates.push({ path: process.env.WORKBUDDY_ROOT, kind: 'env' });
  candidates.push({ path: dirname(PLUGIN_DIR), kind: 'repo' });                    // <root>/dsh-plugin → <root>
  candidates.push({ path: join(PLUGIN_DIR, 'vendor'), kind: 'vendor' });           // 自带副本（分发用）
  candidates.push({ path: resolve(PLUGIN_DIR, '..', '..', '..'), kind: 'node_modules' });
  candidates.push({ path: resolve(process.cwd(), '..'), kind: 'cwd' });
  candidates.push({ path: join(homedir(), 'workbuddy-to-dsh'), kind: 'home' });
  return candidates;
}

export function detectProjectRoot(configured = '') {
  for (const candidate of projectRootCandidates(configured)) {
    if (!candidate.path) continue;
    try {
      if (existsSync(join(candidate.path, BRIDGE_SCRIPT_REL))) return resolve(candidate.path);
    } catch { /* 忽略不可访问的候选 */ }
  }
  return configured ? resolve(configured) : '';
}

/**
 * 读项目根的 `.env`（与 config.mjs 同一套极简语法：KEY=VALUE、# 注释、可选引号）。
 *
 * 为什么插件要自己读：桥进程只认环境变量，而用户可能把端口 / 登录文件写在了
 * `.env` 里（config.mjs 的「统一配置真源」）。插件是另一个进程，必须补上这一层，
 * 否则会出现「控制台起在 8888、插件却去连 8790」这种对不上的情况。
 */
export function readProjectEnv(projectRoot) {
  const out = {};
  if (!projectRoot) return out;
  const file = join(projectRoot, '.env');
  if (!existsSync(file)) return out;
  try {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch { /* .env 不可读就当作没有 */ }
  return out;
}

/** dsh home / profile 目录（旧路由清理要用）。 */
function resolveDshPaths() {  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  const profileDir = process.env.DSH_PROFILE_DIR || join(home, 'profiles', profile);
  return {
    home,
    profileDir,
    settingsPath: join(home, 'settings.yaml'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
  };
}

/**
 * 客户端半边是否已被 dsh 组装进 Web 引导图。
 *
 * 这是「面板为什么没出现」最关键的一条诊断：宿主端把每个声明了 `dsh.client`
 * 的 Loader 条目组装成一条引导行，`ctx.clientModules.graph()` 就是那张表。
 */
export function clientGraphSummary(clientModules, packageName = 'dsh-plugin-workbuddy') {
  if (!clientModules || typeof clientModules.graph !== 'function') {
    return { available: false, reason: 'clientModules 服务不可用（当前不是 Web 组合）' };
  }
  let graph;
  try {
    graph = clientModules.graph();
  } catch (error) {
    return { available: false, reason: `读取引导图失败：${error?.message || error}` };
  }
  const ids = new Set();
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (typeof node.id === 'string') ids.add(node.id);
    if (typeof node.packageName === 'string') ids.add(node.packageName);
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value, depth + 1);
  };
  visit(graph, 0);
  let composed = ids.has(packageName);
  if (!composed) {
    try { composed = JSON.stringify(graph).includes(packageName); } catch { /* 循环引用等，忽略 */ }
  }
  return { available: true, composed, ids: [...ids].slice(0, 300) };
}

/**
 * 图片附件 → data URL（多模态消息用；失败就退化成文字占位）。
 *
 * 抽成导出的工厂函数是为了可测：这块逻辑出过一次线上问题 —— 只传
 * `{ attachmentId, mediaType }` 这个**残缺**引用给 `attachments.readImage()`，
 * 而真实实现（dsh-attachment-local）会拿引用里的 width/height/bytes 与落盘
 * 对象的元数据逐项核对，对不上就抛 ATTACHMENT_CORRUPT。调用方
 * `.catch(() => null)` 把异常吞成 null，表现就是**每一张图**都退化成
 * "[图片：无法读取该附件]" —— 模型于是完全看不到图。
 *
 * **不要把失败原因静默吞掉**：上面那个问题花了很久才定位，就是因为异常
 * 被吞成了 null。这里经 `onError` 上报一行原因（不含图片内容），日志里能直接看到。
 *
 * @param {(name: string) => any} get 取宿主服务（测试里可以塞桩）
 * @param {(reason: string, detail?: unknown) => void} [onError] 失败上报（诊断用）
 * @returns {(ref: object) => Promise<string|null>}
 */
export function makeResolveImage(get, onError) {
  const fail = (reason, detail) => {
    try { onError?.(reason, detail); } catch { /* 上报失败不影响降级 */ }
    return null;
  };
  return async (ref) => {
    if (!ref?.attachmentId) return fail('ref 缺少 attachmentId');
    const attachments = get('attachments');
    if (!attachments) return fail('attachments 服务不可用（可能尚未挂载）');
    // 整份引用原样透传：少任何一个字段都会被元数据核对判为 CORRUPT。
    let stored;
    try {
      stored = await attachments.readImage(ref);
    } catch (error) {
      // 这里最值得记：ATTACHMENT_CORRUPT / 文件不存在等都从这条路径漏出去
      return fail('readImage 抛错：' + String(error?.message || error), error);
    }
    const bytes = stored?.data ?? stored?.bytes ?? stored?.buffer;
    if (!bytes) return fail('readImage 未返回字节（键：' + Object.keys(stored || {}).join(',') + '）');
    // 以落盘对象自称的 mediaType 为准（data URL 的头必须和字节一致）。
    const mediaType = stored?.ref?.mediaType || stored?.mediaType || ref.mediaType || 'image/png';
    const base64 = Buffer.from(bytes).toString('base64');
    return `data:${mediaType};base64,${base64}`;
  };
}

/**
 * cordis 插件入口。
 * @param {any} ctx
 * @param {object} rawConfig patch 里给的 config
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const log = (...args) => { if (config.log) ctx.logger?.info?.('[workbuddy]', ...args); };

  const projectRoot = detectProjectRoot(config.projectRoot);
  const dshPaths = resolveDshPaths();

  // 项目根 `.env` 补默认值：优先级 = 插件 config（显式）> .env > 进程环境变量 > 内置默认。
  // 只在用户**没有显式**在 config 里写这一项时才补，避免覆盖用户意图。
  const explicit = new Set(Object.keys(rawConfig || {}));
  const projectEnv = readProjectEnv(projectRoot);
  const reconcile = (key, envName, coerce) => {
    if (explicit.has(key)) return;
    const raw = projectEnv[envName] ?? process.env[envName];
    if (raw === undefined || raw === '') return;
    config[key] = coerce ? coerce(raw, config[key]) : String(raw);
  };
  reconcile('bridgeHost', 'WORKBUDDY_HOST');
  reconcile('bridgePort', 'WORKBUDDY_PORT', (raw, fallback) => Number(raw) || fallback);
  reconcile('localToken', 'WORKBUDDY_LOCAL_TOKEN');
  reconcile('authFile', 'WORKBUDDY_AUTH_FILE');
  // 控制台端口跟项目自己的 config.mjs 同源（读同一个 DASHBOARD_PORT）
  reconcile('consolePort', 'DASHBOARD_PORT', (raw, fallback) => Number(raw) || fallback);
  if (!explicit.has('autoCheckin') && (projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN) !== undefined) {
    config.autoCheckin = asBool(projectEnv.WORKBUDDY_AUTO_CHECKIN ?? process.env.WORKBUDDY_AUTO_CHECKIN, true);
  }

  const supervisor = new BridgeSupervisor({
    projectRoot: projectRoot || process.cwd(),
    host: config.bridgeHost,
    port: config.bridgePort,
    token: config.localToken,
    authFile: config.authFile || '',
    autoCheckin: config.autoCheckin,
    autoStart: config.autoStart,
    nodePath: config.nodePath || undefined,
    timeoutMs: 8000,
    // 账本按账号分桶：桥把 provider 名写进每条记录的 acct，面板/控制台才能
    // 分开统计"哪个账号花了多少分"。多账号时两个桥写**同一个**账本文件，
    // 不打标签就只能得到两个账号的合计（实测两个端口返回过完全相同的 total）。
    // 用 provider 名而不是登录文件名：与模型选择器里的分组名一一对应。
    env: { WORKBUDDY_ACCOUNT_LABEL: config.provider },
    onLog: (line) => log(line),
  });
  const client = new BridgeClient({
    baseUrl: supervisor.baseUrl,
    token: config.localToken,
    timeoutMs: 8000,
  });
  /** 控制台（数据界面）：插件只负责让它常驻 + 给入口，界面本身仍是它自己的。 */
  const consoleSupervisor = new ConsoleSupervisor({
    projectRoot: projectRoot || process.cwd(),
    host: config.consoleHost,
    port: config.consolePort,
    autoStart: config.consoleAutoStart,
    nodePath: config.nodePath || undefined,
    onLog: (line) => log(line),
  });

  /** 运行态：注册结果、错误、迁移记录都放这里，入口页与工具读它。 */
  const state = {
    config,
    projectRoot,
    dshPaths,
    route: { registered: false, provider: config.provider, error: '', fallback: false },
    legacy: { found: false, files: [], detail: [], cleaned: null },
    readyPromise: null,
    lastEnsure: null,
    lastConsoleEnsure: null,
    quotaCache: { at: 0, value: null, error: '', account: null },
    checkinCache: { at: 0, value: null, error: '', account: null },
    checkinInflight: null,
    bridgeAccount: null,
    /** 桥最近一次确认「活着」的时刻；ensureReady 的短 TTL 缓存用。 */
    bridgeAliveAt: 0,
  };

  /**
   * 等某个可选服务就绪后再注册（服务可能比本插件晚挂载）。
   * cordis 的 `ctx.inject(names, cb)` 是标准做法；它不在时退回即时 `get`，
   * 这样纯 Node 的装配测试也能跑。
   */
  const useService = (serviceName, fn) => {
    if (typeof ctx.inject === 'function') {
      ctx.inject([serviceName], (scope) => {
        const service = scope?.[serviceName] ?? scope?.get?.(serviceName);
        if (service) fn(service, scope);
      });
      return;
    }
    const service = ctx.get(serviceName);
    if (service) fn(service, ctx);
  };

  /**
   * 图片附件 → data URL（多模态消息用；失败就退化成文字占位）。
   *
   * **必须延迟取 `attachments` 服务**，不能 `ctx.get('attachments')` 同步拿：
   * 服务由别的插件提供，挂载顺序不保证 —— 插件加载那一刻它可能还没就绪，
   * 同步 get 会返回 undefined，于是**每一张图**都退化成
   * "[图片：无法读取该附件]"，模型完全看不到图。这正是实测到的故障。
   *
   * 做法：把服务句柄缓存起来，首次取不到时用 `ctx.inject` 等它就绪；
   * 后续调用直接用缓存。`get` 每次现取也行，但缓存能避开重复的 inject 注册。
   */
  let attachmentsService = null;
  const getAttachments = () => {
    if (attachmentsService) return attachmentsService;
    const direct = ctx.get?.('attachments');
    if (direct) {
      attachmentsService = direct;
      return direct;
    }
    // 还没挂载：注册一次等待，拿到后缓存；本次调用先返回 null（由调用方降级）
    useService('attachments', (service) => { attachmentsService = service; });
    return null;
  };
  const resolveImage = makeResolveImage(getAttachments, (reason, detail) => {
    // 图片读取失败必须留痕：它被吞成 null 后用户只看到"[图片：无法读取该附件]"，
    // 完全不知道是哪一步断了。这里记一行原因（不含图片内容）。
    log('图片附件读取失败：' + reason, detail ? String(detail?.code || detail?.name || '') : '');
    state.lastImageError = { at: Date.now(), reason, code: String(detail?.code || '') };
  });

  const adapter = new WorkBuddyAdapter({
    provider: config.provider,
    displayName: config.displayName,
    client,
    resolveImage,
    log: (message, detail) => log(message, detail),
    // 对话出现 TRANSPORT 失败 = 桥可能刚挂：立刻作废「活着」缓存，
    // 下一次对话重新探测/拉起，而不是在 5 秒 TTL 内对着死桥空转。
    onTransportFailure: () => { state.bridgeAliveAt = 0; },
    filter: { allow: config.modelAllow, deny: config.modelDeny },
    showCredits: config.showCredits,
    contextOverrides: config.contextOverrides,
    contextMaxTokens: config.contextMaxTokens,
    visionOverrides: config.visionOverrides,
    reasoningOverrides: config.reasoningOverrides,
    creditOverrides: config.creditOverrides,
    defaults: {
      maxTokens: config.defaultMaxTokens,
      temperature: config.defaultTemperature,
      reasoningEffort: config.defaultReasoningEffort,
    },
    catalogTtlMs: config.catalogTtlMs,    ensureReady: async () => {
      // 每次取用前保证桥在跑：桥挂了自动拉起来，用户不必管。
      // 桥刚被确认活着的一小段时间内直接复用结论 —— 省掉每次对话前那次
      // 串行的 /health 探测（本机回环也要 2-3ms，且在请求关键路径上）。
      // 对话失败时 reset() 会立刻作废缓存（见 stream 的 TRANSPORT 路径）。
      if (!config.autoStart) return client;
      if (state.readyPromise) return state.readyPromise;
      const now = Date.now();
      if (now - (state.bridgeAliveAt || 0) < config.bridgeAliveTtlMs) return client;
      const probe = await supervisor.probe();
      if (probe.state === 'running') {
        state.bridgeAliveAt = now;
        return client;
      }
      state.readyPromise = (async () => {
        const result = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
        state.lastEnsure = { at: Date.now(), ...result };
        if (!result.ok) throw new Error(result.error || '桥不可用');
        adapter.invalidate();
        return client;
      })().finally(() => { state.readyPromise = null; });
      return state.readyPromise;
    },
  });

  // ── 0. 应用面板勾选的模型显示偏好 ─────────────────────────────────────
  // 用户勾选的"在 dsh 中显示"清单持久化在 .model-prefs.json。
  // **按 provider 分开存**（visibleByProvider）：多账号下各分组目录不同，
  // 一份全局清单会一刀切，把非主分组的模型几乎全滤掉。
  const savedPrefs = readModelPrefs(config.provider, config.provider);
  if (savedPrefs) {
    adapter.setFilter({ allow: savedPrefs });
    state.modelVisibility = { source: 'prefs', allow: savedPrefs };
    log(`已应用模型显示偏好：${savedPrefs.length} 个模型（provider=${config.provider}）`);
  }

  // ── 0b. 应用面板里保存的上下文上限覆盖 ─────────────────────────────────
  // 与可见清单同文件（.model-prefs.json）但不同键；面板改完持久化到这里，
  // 重启后依然生效。配置文件的 contextOverrides 与它合并，面板的优先
  // （同样是"用户在界面上表达的最新意图优先"）。
  //
  // 注意：上下文覆盖目前是**全局**的（不按 provider 分桶），所以下面分组
  // adapter 也要吃到同一份 —— 否则面板里设的上限对分组账号静默失效
  // （实测过：主 adapter 有 200000，分组是 {}）。
  const savedContext = readContextPrefs();
  if (savedContext) {
    // 逐模型覆盖：配置文件的与面板保存的合并，面板的优先（用户最新意图）
    if (savedContext.overrides && Object.keys(savedContext.overrides).length) {
      adapter.setContextOverrides({ ...config.contextOverrides, ...savedContext.overrides });
      log(`已应用上下文上限覆盖：${Object.keys(savedContext.overrides).length} 个模型`);
    }
    // 全局档位：面板存过就用它，否则用配置里的
    if (savedContext.maxTokens > 0) {
      adapter.setContextMaxTokens(savedContext.maxTokens);
      log(`已应用全局上下文上限：${savedContext.maxTokens} tokens`);
    }
  }

  // ── 0c. 应用面板里保存的图片能力覆盖（按 provider 分开）──────────────────
  // 与可见清单、上下文同文件（.model-prefs.json）但不同键。
  // 用途：上游目录漏报多模态能力时手动补声明（如国际版的 deepseek-v4.1-flash）。
  // **必须按 provider 读**：图片能力是账号维度属性 —— 国内版目录已声明 true、
  // 国际版漏报，用一份全局覆盖会让两边互相串味。
  const savedVision = readVisionPrefs(config.provider, config.provider);
  if (savedVision && Object.keys(savedVision).length) {
    adapter.setVisionOverrides({ ...config.visionOverrides, ...savedVision });
    log(`已应用图片能力覆盖：${Object.keys(savedVision).length} 个模型（provider=${config.provider}）`);
  }

  // ── 0c-2. 应用面板里保存的推理能力覆盖（按 provider 分开）────────────────
  // 与图片能力完全同源的坑：上游目录漏报 supports_reasoning。实测国内版
  // deepseek-v4.1-flash 带该字段（true），国际版同一模型整个字段都没有 ——
  // 而实测国际版接受 reasoning_effort=high 并返回 200。不声明，选择器就没有
  // 「推理等级」下拉。
  const savedReasoning = readReasoningPrefs(config.provider, config.provider);
  if (savedReasoning && Object.keys(savedReasoning).length) {
    adapter.setReasoningOverrides({ ...config.reasoningOverrides, ...savedReasoning });
    log(`已应用推理能力覆盖：${Object.keys(savedReasoning).length} 个模型（provider=${config.provider}）`);
  }

  // ── 0d. 应用面板里保存的倍率覆盖（按 provider 分开）──────────────────────
  // 用途：上游目录漏报倍率时手动补声明（如国际版的 deepseek-v4.1-flash 实测免费）。
  // **必须按 provider 读**：倍率是账号维度属性，全局一份会把国内版也标成免费。
  const savedCredits = readCreditPrefs(config.provider, config.provider);
  if (savedCredits && Object.keys(savedCredits).length) {
    adapter.setCreditOverrides({ ...config.creditOverrides, ...savedCredits });
    log(`已应用倍率覆盖：${Object.keys(savedCredits).length} 个模型（provider=${config.provider}）`);
  }

  // ── 1. 旧路由清理（必须在注册自己的路由之前） ──────────────────────────
  try {
    const detected = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
    state.legacy = { ...detected, cleaned: null };
    if (detected.found) {
      if (config.migrateLegacy) {
        const result = cleanLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
        // 清理后**重新探测**：否则面板/工具会一直拿着加载时的旧结论报警告
        const after = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
        state.legacy = {
          found: after.found,
          files: after.files,
          detail: after.detail,
          cleaned: result,
          cleanedAt: new Date().toISOString(),
        };
        log(`已清理旧的 llm-pi-ai ${config.provider} 路由：`, JSON.stringify(result.files));
      } else {
        log(`检测到旧的 llm-pi-ai ${config.provider} 路由（migrateLegacy=false，未清理）：`, detected.files.join(', '));
      }
    }
  } catch (error) {
    log('旧路由探测失败（不影响启动）', error);
  }

  // ── 2. 注册原生 LLM 路由 ───────────────────────────────────────────────
  // `ctx.llm` 的访问**必须**走属性（服务代理会把 this.ctx 绑到调用方 fiber），
  // 提前取到局部变量再在异步重试里调用，绑定关系保持不变。
  const llm = ctx.llm;
  let adapterHandle = null;

  const registerRoute = (providerName) => {
    adapterHandle = llm.registerAdapter([providerName], adapter);
    state.route = { registered: true, provider: providerName, error: '', fallback: providerName !== config.provider };
    return adapterHandle;
  };

  /**
   * 通知 dsh 的 UI「模型拓扑变了」，让模型选择器重拉 listModels()。
   *
   * 为什么需要它：模型选择器不在每次打开时重查目录 —— 它订阅
   * `llm/adapters-updated` 事件（settings/document-updated、凭据变更、连接重置
   * 也会触发）。保存模型显示偏好只改了 adapter 内部的 filter，不产生任何事件，
   * UI 就一直显示旧清单 —— 用户保存完看到"模型数量没变"，就是这个原因。
   *
   * 实现取巧但安全：emitAdaptersUpdated() 本是 registerAdapter 的内部通知，
   * 这里把它当作"拓扑可能变了"的公开通知来用。防御式调用 —— 它不是文档化
   * 的公开 API，旧版 dsh 可能没有；没有就静默跳过，面板上会提示"重启一次 dsh
   * 后生效"作为兜底（见 onWritePrefs 的返回）。
   */
  const notifyAdaptersUpdated = () => {
    try {
      if (typeof llm?.emitAdaptersUpdated === 'function') {
        llm.emitAdaptersUpdated();
        return true;
      }
    } catch (error) {
      log('广播 llm/adapters-updated 失败（不影响偏好已保存）', error);
    }
    return false;
  };

  try {
    registerRoute(config.provider);
    log(`已注册原生模型路由：provider=${config.provider}（${config.displayName}）`);
  } catch (error) {
    const code = error?.code || '';
    state.route = { registered: false, provider: config.provider, error: String(error?.message || error), fallback: false, code };
    log(`注册 provider "${config.provider}" 失败：`, error?.message || error);
    // 撞名的典型原因是 llm-pi-ai 还握着旧路由（热重载需要一点时间），
    // 因此退避重试；仍失败则换一个不撞名的 route，保证功能可用。
    void (async () => {
      for (let attempt = 0; attempt < 6 && !state.route.registered; attempt += 1) {
        await sleep(400);
        try {
          registerRoute(config.provider);
          adapter.invalidate();
          log(`重试成功：provider=${config.provider}`);
          return;
        } catch (retryError) {
          state.route.error = String(retryError?.message || retryError);
        }
      }
      if (state.route.registered) return;
      try {
        registerRoute(config.fallbackProvider);
        log(`provider "${config.provider}" 被占用，已改用 "${config.fallbackProvider}" 兜底（模型选择器里仍显示 ${config.displayName}）`);
      } catch (fallbackError) {
        state.route = {
          registered: false,
          provider: config.provider,
          error: `注册失败：${state.route.error}；兜底 "${config.fallbackProvider}" 也失败：${fallbackError?.message || fallbackError}`,
          fallback: false,
        };
        log(state.route.error);
      }
    })();
  }

  // ── 2b. 多账号分组：每个分组 = 独立桥 + 独立 provider ───────────────────
  /**
   * 让同一个插件同时暴露多个账号，各自一组 provider（`workbuddy1`/`workbuddy2`…）。
   *
   * 与"账号池化"的区别：**每个分组驱动一个账号、各有独立的桥与端口**，
   * 不轮询、不负载均衡。用户只是不想来回点"切换"，想同时用两个账号。
   *
   * 失败隔离：某个分组起不来**不影响其它分组**，也不影响主账号 —— 它只在
   * `state.accountGroups` 里留下 error，面板与工具如实显示。
   */
  const accountGroups = [];
  state.accountGroups = accountGroups;

  // 插件自己纳管的账号（设置页「添加账号」走 OAuth 拿到的）与 cordis.patch.yml
  // 里手写的 accounts 合并 —— 用户不必为了用纳管账号再去改配置文件。
  //
  // 合并而非替换：手写的配置是**显式意图**，纳管的是**运行时新增**，两者可以
  // 共存。asAccounts() 会去重 id 与端口，所以重复配置不会撞车。
  try {
    const managed = listManagedAccounts(dshPaths.home);
    if (managed.length) {
      config.accounts = asAccounts([
        ...config.accounts.map((a) => ({ id: a.id, displayName: a.displayName, authFile: a.authFile, port: a.port, token: a.token })),
        ...managed.map((a) => ({
          id: `m${a.uid.slice(0, 8)}`,
          displayName: `纳管账号 ${a.uid.slice(0, 8)}`,
          authFile: a.path,
        })),
      ], config.accountProviderPrefix, config.bridgePort);
      log(`并入 ${managed.length} 个纳管账号`);
    }
  } catch (error) {
    log('读取纳管账号失败（不影响手写配置）', error);
  }

  for (const account of config.accounts) {
    const group = {
      id: account.id,
      provider: account.provider,
      displayName: account.displayName,
      authFile: account.authFile,
      port: account.port,
      registered: false,
      error: '',
      supervisor: null,
      adapter: null,
    };
    accountGroups.push(group);

    try {
      // 每个分组一条独立桥：端口与登录文件都与主账号隔离。
      const groupSupervisor = new BridgeSupervisor({
        projectRoot: projectRoot || process.cwd(),
        host: config.bridgeHost,
        port: account.port,
        token: account.token || config.localToken,
        authFile: account.authFile || '',
        // 独立日志：所有分组共用 bridge.log 会互相覆盖，排障时看不到各自的原因
        logPath: join(projectRoot || process.cwd(), 'bridge', `bridge-${account.id}.log`),
        autoCheckin: config.autoCheckin,
        autoStart: config.autoStart,
        nodePath: config.nodePath || undefined,
        timeoutMs: 8000,
        // 分组桥的账号标签 = 该分组的 provider 名（如 workbuddy-ai）。
        // 与主桥同一个键，但各进程独立注入 —— 这正是"账本能分清谁是谁"的依据：
        // 两个桥写同一个文件，只靠标签区分。
        env: { WORKBUDDY_ACCOUNT_LABEL: account.provider },
        onLog: (line) => log(`[${account.id}]`, line),
      });
      const groupClient = new BridgeClient({
        baseUrl: groupSupervisor.baseUrl,
        token: account.token || config.localToken,
        timeoutMs: 8000,
      });
      const groupAdapter = new WorkBuddyAdapter({
        provider: account.provider,
        displayName: account.displayName,
        client: groupClient,
        resolveImage,
        log: (message, detail) => log(`[${account.id}]`, message, detail),
        onTransportFailure: () => { group.aliveAt = 0; },
        filter: { allow: config.modelAllow, deny: config.modelDeny },
        showCredits: config.showCredits,
        contextOverrides: config.contextOverrides,
        contextMaxTokens: config.contextMaxTokens,
        visionOverrides: config.visionOverrides,
        reasoningOverrides: config.reasoningOverrides,
        creditOverrides: config.creditOverrides,
        defaults: {
          maxTokens: config.defaultMaxTokens,
          temperature: config.defaultTemperature,
          reasoningEffort: config.defaultReasoningEffort,
        },
        catalogTtlMs: config.catalogTtlMs,
        ensureReady: async () => {
          if (!config.autoStart) return groupClient;
          const probe = await groupSupervisor.probe();
          if (probe.state === 'running') return groupClient;
          const result = await groupSupervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
          if (!result.ok) throw new Error(result.error || '桥不可用');
          groupAdapter.invalidate();
          return groupClient;
        },
      });
      group.supervisor = groupSupervisor;
      group.adapter = groupAdapter;
      /** 分组自己的桥客户端：查该账号的积分/健康用（与主账号互不干扰）。 */
      group.client = groupClient;
      group.quotaCache = { at: 0, value: null, error: '' };
      /** 该分组的账号（桥起来后探测填入；仅用于展示）。 */
      group.account = null;
      // 分组自己的可见性白名单（与主 provider 的互不影响）——
      // 不应用的话，主 provider 的白名单语义不会串到分组（每个 adapter 有独立 filter），
      // 但用户之前为分组勾过的清单要能恢复。
      const groupPrefs = readModelPrefs(account.provider, config.provider);
      if (groupPrefs) {
        groupAdapter.setFilter({ allow: groupPrefs });
        log(`分组「${account.displayName}」应用显示偏好：${groupPrefs.length} 个模型`);
      }
      // 上下文上限覆盖：**全局一份**（不按 provider 分桶），所以分组也要吃到。
      // 这里**曾经漏掉过**：面板里设的上限只喂给主 adapter，分组账号静默失效 ——
      // 实测主 adapter 有 {deepseek-v4.1-flash:200000}/maxTokens 500000，
      // 而分组是 {}/0。用户以为设了 1M 上限，实际分组仍按目录原值跑。
      const groupContextOverrides = {
        ...config.contextOverrides,
        ...(savedContext?.overrides || {}),
      };
      if (Object.keys(groupContextOverrides).length) {
        groupAdapter.setContextOverrides(groupContextOverrides);
        log(`分组「${account.displayName}」应用上下文上限覆盖：${Object.keys(groupContextOverrides).length} 个模型`);
      }
      const groupContextMax = savedContext?.maxTokens > 0 ? savedContext.maxTokens : config.contextMaxTokens;
      if (groupContextMax > 0) {
        groupAdapter.setContextMaxTokens(groupContextMax);
        log(`分组「${account.displayName}」应用全局上下文上限：${groupContextMax} tokens`);
      }
      // 分组自己的倍率覆盖（同样按 provider 分开）——
      // 实测国际版 deepseek-v4.1-flash 免费、国内版 0.11×，一码归一码。
      const groupCredits = readCreditPrefs(account.provider, config.provider);
      if (groupCredits && Object.keys(groupCredits).length) {
        groupAdapter.setCreditOverrides({ ...config.creditOverrides, ...groupCredits });
        log(`分组「${account.displayName}」应用倍率覆盖：${Object.keys(groupCredits).length} 个模型`);
      }
      // 分组自己的图片能力覆盖（同样按 provider 分开）。
      //
      // 这里**曾经漏掉过**，后果很隐蔽：面板上的覆盖只喂给了主 adapter
      // （见 0c 段），分组 adapter 拿到的是空的 config.visionOverrides，
      // 于是"目录漏报 + 用户手动声明 true"的模型在分组下依然被判成纯文本，
      // dsh 侧把它降级成 "(image omitted: model does not support images)" ——
      // 用户贴了图却像没贴，还不报错。默认模型走分组 provider 时必现。
      const groupVision = readVisionPrefs(account.provider, config.provider);
      if (groupVision && Object.keys(groupVision).length) {
        groupAdapter.setVisionOverrides({ ...config.visionOverrides, ...groupVision });
        log(`分组「${account.displayName}」应用图片能力覆盖：${Object.keys(groupVision).length} 个模型`);
      }
      // 分组自己的推理能力覆盖 —— 与上面图片能力**同一个坑**：不喂给分组，
      // 分组下的模型就没有「推理等级」下拉。默认模型走分组 provider 时必现
      // （本项目正是 workbuddy-ai）。
      const groupReasoning = readReasoningPrefs(account.provider, config.provider);
      if (groupReasoning && Object.keys(groupReasoning).length) {
        groupAdapter.setReasoningOverrides({ ...config.reasoningOverrides, ...groupReasoning });
        log(`分组「${account.displayName}」应用推理能力覆盖：${Object.keys(groupReasoning).length} 个模型`);
      }
      // 每个分组一条独立路由：模型选择器里就是独立的一组
      llm.registerAdapter([account.provider], groupAdapter);
      group.registered = true;
      log(`已注册分组路由：provider=${account.provider}（${account.displayName}，端口 ${account.port}）`);
    } catch (error) {
      group.error = String(error?.message || error);
      log(`分组 "${account.id}" 注册失败（不影响其它分组）：`, group.error);
    }
  }

  // ── 3. 运行态快照（入口页 / 工具共用） ─────────────────────────────────
  const CHECKIN_TTL_MS = 30 * 60 * 1000;
  const QUOTA_TTL_MS = 120 * 1000;

  /**
   * 桥当前服务的是**哪个账号**。
   *
   * 来源（按可靠度）：/health 的 userId > 令牌剩余与 health.auth 一致性。
   * 拿不到时返回 null（探测未就绪 / 旧桥），调用方此时**不要**误判成"账号变了"。
   */
  function bridgeAccountOf(probe) {
    const userId = probe?.health?.auth?.userId;
    return typeof userId === 'string' && userId ? userId : null;
  }

  /**
   * 账号身份变化时的缓存失效。
   *
   * 这是「换账号后积分还是上一个的」那个 bug 的根治点：控制台切账号只清**它自己**
   * 进程里的缓存（`invalidateQuotaCache()`），插件进程里的 quotaCache（120s）/
   * checkinCache（30min）没人清 —— 面板就会把 A 账号的积分挂在 B 账号头上。
   * 现在所有跨账号的缓存值都打上账号标记，快照时发现身份不一致立即作废并强制重取。
   */
  function reconcileAccount(probe) {
    const account = bridgeAccountOf(probe);
    // 桥还没就绪 / 旧桥没有 userId：保留现状（不能用 null 去作废有效缓存）
    if (account === null) return { changed: false, account: state.bridgeAccount };
    if (state.bridgeAccount === null) {
      // 首次观察到身份：只记录，不清缓存（缓存可能本来就是空的）
      state.bridgeAccount = account;
      return { changed: false, account };
    }
    if (state.bridgeAccount !== account) {
      log(`桥的登录账号已变化（${state.bridgeAccount} → ${account}）：作废积分/签到缓存`);
      state.quotaCache = { at: 0, value: null, error: '', account: null };
      state.checkinCache = { at: 0, value: null, error: '', account: null };
      // 模型目录也属于"账号视角"的数据（不同账号可见模型可能不同）
      adapter.invalidate();
      state.bridgeAccount = account;
      return { changed: true, account };
    }
    return { changed: false, account };
  }

  /**
   * 发起一次签到状态刷新（不 await）。在途去重：并发调用只会打一次上游。
   * 快照里始终返回缓存值，最坏情况是"少一次数据"，绝不会把状态查询拖慢。
   */
  function maybeRefreshCheckin(bridgeState) {
    if (bridgeState !== 'running') return;
    if (state.checkinInflight) return;
    // 缓存里记录的账号与当前账号不一致时必须刷新（换账号后的第一次快照就要新值）
    const stale = state.checkinCache.value && state.checkinCache.account !== state.bridgeAccount;
    if (state.checkinCache.value && !stale && Date.now() - state.checkinCache.at < CHECKIN_TTL_MS) return;
    if (!state.checkinCache.value && Date.now() - state.checkinCache.at < 5_000) return; // 刚失败过，别打爆
    const account = state.bridgeAccount;
    state.checkinInflight = (async () => {
      try {
        const value = await client.checkin({});
        // 只有身份没再变时才入缓存（极端：刷新期间又切了账号）
        if (state.bridgeAccount === account) {
          state.checkinCache = { at: Date.now(), value, error: '', account };
        }
      } catch (error) {
        if (state.bridgeAccount === account) {
          state.checkinCache = { ...state.checkinCache, at: Date.now(), error: String(error?.message || error), account };
        }
      } finally {
        state.checkinInflight = null;
      }
    })();
    // 明确吞掉 rejection：这是后台刷新，失败了只记在缓存里
    state.checkinInflight.catch(() => {});
  }

  async function snapshot({ signal, quota = false } = {}) {
    const probe = await supervisor.probe(signal);
    const consoleProbe = await consoleSupervisor.probe({ signal, cached: true });
    // 先对账号：身份变了就作废全部跨账号缓存（含模型目录）
    const reconciliation = reconcileAccount(probe);
    let quotaValue = state.quotaCache.value;
    let quotaError = state.quotaCache.error;
    const staleQuota = state.quotaCache.value && state.quotaCache.account !== state.bridgeAccount;
    const wantQuota = quota
      || !state.quotaCache.value
      || staleQuota
      || Date.now() - state.quotaCache.at > QUOTA_TTL_MS;
    if (probe.state === 'running' && wantQuota) {
      try {
        quotaValue = await client.quota(signal);
        // 身份没再变才入缓存（避免"取的是新账号、标记却是旧账号"的错位）
        if (state.bridgeAccount === reconciliation.account) {
          state.quotaCache = { at: Date.now(), value: quotaValue, error: '', account: reconciliation.account };
        }
        quotaError = '';
      } catch (error) {
        quotaError = String(error?.message || error);
        if (state.bridgeAccount === reconciliation.account) {
          state.quotaCache = { ...state.quotaCache, at: Date.now(), error: quotaError, account: reconciliation.account };
        }
      }
    }
    /**
     * 各分组的积分（多账号时每个账号一份）。
     *
     * **必须带 TTL 缓存且不阻塞 status**：这个接口打到上游计费端点，而
     * /workbuddy/status 每 8 秒应答一次。用与主 quota 同一套策略：过期才在
     * 后台重取，快照返回当前缓存值（下一次快照自然拿到新值）。
     *
     * 失败只记 per-group 的 error，**不影响其它分组与主账号** —— 一个账号
     * 欠费（429）不该让整页显示不出来。
     *
     * `quota === true`（面板「刷新积分」）时**改为 await**：那个按钮的语义是
     * "现在就给我最新值"，而分组积分若是后台发起就返回旧缓存，按钮刷的只是
     * 主账号、分组数字纹丝不动 —— 用户看到"刷新了但国际版还是 0"会以为
     * 那个账号真的没额度。刷新是有意的用户动作，等它一下是对的；
     * 8 秒轮询那条路径仍然走后台，不受影响。
     */
    const groupQuotaTasks = [];
    for (const g of accountGroups) {
      if (!g.registered || !g.client) continue;
      const stale = !g.quotaCache.value || Date.now() - g.quotaCache.at > QUOTA_TTL_MS;
      // 强制刷新时**无条件重取**（TTL 内也要重取），否则按钮点下去没有效果
      if (!quota && !stale) continue;
      const task = (async () => {
        try {
          const value = await g.client.quota(signal);
          g.quotaCache = { at: Date.now(), value, error: '' };
        } catch (error) {
          g.quotaCache = { ...g.quotaCache, at: Date.now(), error: String(error?.message || error) };
        }
      })();
      // 非强制：后台跑、不 await（status 每 8 秒一次，不能被计费端点拖住）
      if (quota) groupQuotaTasks.push(task);
      else void task;
    }
    // 强制刷新才等：并行等待，一个账号慢/失败不影响其它（各自 catch 过）
    if (groupQuotaTasks.length) await Promise.all(groupQuotaTasks);

    // 签到状态：TTL 30 分钟，而且**绝不阻塞** status。
    //
    // 这个接口会打到上游计费端点，而 /workbuddy/status 每 8 秒就要应答一次；
    // 一旦上游慢，await 它会把状态页一起拖住。所以这里只"发起"刷新（带在途
    // 去重），快照永远返回当前缓存值 —— 下一次快照自然拿到新值。
    maybeRefreshCheckin(probe.state);
    /**
     * 最近失败请求：概览页的待办提醒只需要"有几条失败"，不必把 20 条明细
     * 搬给客户端（那会每 15 秒重复搬一遍，且与 status 的 8 秒轮询重叠）。
     * 从本地账本现算，成本极低；桥没跑时给空数组（不阻塞、不报错）。
     */
    let recentFailed = [];
    if (probe.state === 'running') {
      try {
        const recent = await client.requests({ limit: 20, signal });
        recentFailed = (recent?.requests || []).filter((r) => !r.ok)
          .map((r) => ({ t: r.t, model: r.model, status: r.status, code: r.code, error: r.error }));
      } catch { /* 账本读不到就当"没有失败"，不要因此让整页报错 */ }
    }
    const catalog = adapter.catalogCache.models;
    return {
      bridge: { state: probe.state, health: probe.health || null, error: probe.error || '' },
      /** 控制台：数据界面在它那儿，插件只报状态与地址。 */
      console: {
        state: consoleProbe.state,
        url: consoleSupervisor.url,
        error: consoleProbe.error || '',
        /** true = 这个实例是插件拉起的（插件有权停它） */
        managed: consoleSupervisor.spawnedPid !== null,
        autoStart: config.consoleAutoStart,
      },
      config: {
        provider: state.route.provider,
        configuredProvider: config.provider,
        fallbackProvider: config.fallbackProvider,
        displayName: config.displayName,
        bridgeUrl: supervisor.baseUrl,
        consoleUrl: consoleSupervisor.url,
        projectRoot,
        autoStart: config.autoStart,
        consoleAutoStart: config.consoleAutoStart,
        migrateLegacy: config.migrateLegacy,
        logPath: supervisor.logPath,
        scriptPath: supervisor.scriptPath,
        modelAllow: config.modelAllow,
        modelDeny: config.modelDeny,
        showCredits: adapter.showCredits,
        // 生效的上下文上限覆盖（面板据此显示"已改"；不含任何凭据）
        contextOverrides: adapter.contextOverrides || {},
        contextMaxTokens: adapter.contextMaxTokens || 0,
      },
      /**
       * 多账号分组的状态（面板与工具据此显示"哪几组可用"）。
       * 只回传**身份与端口**，不含任何凭据；authFile 只给文件名，不给完整路径。
       */
      accountGroups: accountGroups.map((g) => ({
        id: g.id,
        provider: g.provider,
        displayName: g.displayName,
        port: g.port,
        authFile: g.authFile ? g.authFile.split(/[\\/]/).pop() : '',
        registered: g.registered,
        error: g.error,
      })),
      route: { ...state.route },
      // 带上覆盖：快照里的目录也要与适配器同口径，否则入口页显示的能力/价格
      // 会和 dsh 实际收到的不一致（见 toDirectory 注释）。
      directory: toDirectory(catalog, {
        visionOverrides: adapter.visionOverrides,
        reasoningOverrides: adapter.reasoningOverrides,
        creditOverrides: adapter.creditOverrides,
      }),
      catalogAt: adapter.catalogCache.at ? new Date(adapter.catalogCache.at).toISOString() : null,
      catalogError: adapter.catalogError || '',
      legacy: { found: state.legacy.found, files: state.legacy.files, cleaned: state.legacy.cleaned },
      quota: quotaValue,
      quotaError,
      /** 上次成功读到积分的时刻（ISO）；面板用它显示"更新于" */
      quotaAt: state.quotaCache.at ? new Date(state.quotaCache.at).toISOString() : null,
      /** 这份积分属于哪个账号（health.auth.userId）；与 bridgeAccount 不一致说明缓存还没换新 */
      quotaAccount: state.quotaCache.account,
      /** 桥当前登录的账号（本快照探测到的）——重启 dsh 后可在面板核对它与 quotaAccount 一致 */
      bridgeAccount: state.bridgeAccount,
      /**
       * 各分组的积分（多账号概览用）：每个账号一份，互不影响。
       * 只回传展示所需字段，不含任何凭据。
       */
      groupQuotas: accountGroups.filter((g) => g.registered).map((g) => {
        const q = g.quotaCache.value;
        return {
          provider: g.provider,
          displayName: g.displayName,
          account: g.account || null,
          total: typeof q?.total === 'number' ? q.total : null,
          packages: Array.isArray(q?.packages) ? q.packages : [],
          error: g.quotaCache.error || '',
          at: g.quotaCache.at ? new Date(g.quotaCache.at).toISOString() : null,
        };
      }),
      checkin: state.checkinCache.value,
      checkinError: state.checkinCache.error || '',
      checkinAccount: state.checkinCache.account,
      /** 最近 20 条里的失败（概览页待办提醒用；避免客户端为"数几条"再拉一次明细） */
      recentFailed,
      dsh: { home: dshPaths.home, profileDir: dshPaths.profileDir, settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath },
      client: clientGraphSummary(ctx.get('clientModules')),
      runtime: { node: process.version, pid: process.pid, pluginDir: PLUGIN_DIR },
      sampleModel: pickDefaultModel(catalog),
    };
  }

  // ── 4. 工具 ────────────────────────────────────────────────────────────
  if (config.tools) {
    useService('tools', (tools) => {
      let count = 0;
      for (const definition of createTools({ snapshot, supervisor, consoleSupervisor, client, adapter, accountGroups })) {
        try {
          tools.register(definition);
          count += 1;
        } catch (error) {
          log(`注册工具 ${definition.name} 失败`, error);
        }
      }
      log(`已注册 ${count} 个工具（workbuddy_status/models/usage/checkin/bridge）`);
    });
  }

  // ── 5. 斜杠命令 ────────────────────────────────────────────────────────
  if (config.commands) {
    useService('commands', (commands) => {
      try {
        commands.register({
          name: 'workbuddy',
          description: 'WorkBuddy 中转：状态 / 模型 / 用量 / 签到 / 启停桥 / 打开控制台 / 清理旧路由',
          input: { hint: 'status | models | usage | checkin | console | start | stop | restart | cleanup' },
          async handler({ rawInput, signal }) {
            const arg = String(rawInput || '').trim().split(/\s+/)[0] || 'status';
            try {
              if (arg === 'console' || arg === 'ui') {
                const result = await consoleSupervisor.ensure({ signal });
                return result.ok
                  ? { kind: 'success', text: `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}\n逐条请求、趋势图、CSV 导出、账号切换、签到与诊断都在那里。` }
                  : { kind: 'error', text: `控制台启动失败：${result.error}` };
              }
              if (arg === 'start' || arg === 'restart') {
                const result = await supervisor.ensure({ restart: arg === 'restart', signal });
                adapter.invalidate();
                return result.ok
                  ? { kind: 'success', text: `桥已就绪：${supervisor.baseUrl}/v1（pid ${result.health?.pid}${result.reused ? '，复用已有实例' : ''}）` }
                  : { kind: 'error', text: `桥启动失败：${result.error}` };
              }
              if (arg === 'stop') {
                const result = await supervisor.stop(signal);
                adapter.invalidate();
                return result.ok
                  ? { kind: 'success', text: result.stopped ? '桥已停止。' : '桥本来就没在运行。' }
                  : { kind: 'error', text: `停止失败：${result.error}` };
              }
              if (arg === 'cleanup') {
                const detected = detectLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
                if (!detected.found) return { kind: 'success', text: '没有检测到旧的 llm-pi-ai workbuddy 路由，无需清理。' };
                const result = cleanLegacyRoutes({ settingsPath: dshPaths.settingsPath, patchPath: dshPaths.patchPath, provider: config.provider });
                const lines = result.files.map((f) => `${f.path}：${f.changed ? `已清理（备份 ${f.backup}）` : f.reason}`);
                return { kind: 'success', text: `旧路由清理完成：\n${lines.join('\n')}` };
              }
              if (arg === 'models') {
                const catalog = await adapter.catalog({ signal });
                const lines = catalog.slice(0, 40).map((m) => `- ${m.id}${m.name ? `（${m.name}）` : ''}`);
                return { kind: 'success', text: `可用模型 ${catalog.length} 个：\n${lines.join('\n')}${catalog.length > 40 ? '\n…' : ''}` };
              }
              if (arg === 'usage') {
                const usage = await client.usage({ days: 7, signal });
                const total = usage?.total || {};
                return { kind: 'success', text: `最近 7 天：${total.calls || 0} 次调用，失败 ${total.failed || 0} 次，输入 ${total.promptTokens || 0} / 输出 ${total.completionTokens || 0} tokens，积分 ${typeof total.credit === 'number' ? total.credit.toFixed(2) : 0}` };
              }
              if (arg === 'checkin') {
                const result = await client.checkin({ signal });
                const s = result?.status || {};
                return { kind: 'success', text: `签到：${s.todayCheckedIn ? '今日已签' : '今日未签'}${typeof s.streakDays === 'number' ? `，连续 ${s.streakDays} 天` : ''}` };
              }
              const snap = await snapshot({ signal, quota: true });
              const lines = [
                `桥：${snap.bridge.state}${snap.bridge.health ? `（pid ${snap.bridge.health.pid}，已运行 ${Math.round((snap.bridge.health.uptimeMs || 0) / 60000)} 分钟）` : ''}`,
                `地址：${snap.config.bridgeUrl}/v1`,
                `路由：${snap.route.registered ? `已注册 provider=${snap.route.provider}` : `未注册（${snap.route.error}）`}`,
                `模型：桥目录 ${snap.directory.length} 个`,
                `控制台：${snap.console.state === 'running' ? snap.console.url : `未运行（${snap.console.error || '未启动'}）`}`,
                snap.quota?.total !== undefined ? `积分：${snap.quota.total}` : '',
                snap.legacy.found ? `注意：仍有旧路由 ${snap.legacy.files.join('、')}（用 /workbuddy cleanup 清理）` : '',
              ].filter(Boolean);
              return { kind: 'success', text: lines.join('\n') };
            } catch (error) {
              return { kind: 'error', text: `执行失败：${error?.message || error}` };
            }
          },
        });
        log('已注册 /workbuddy 命令');
      } catch (error) {
        log('注册 /workbuddy 命令失败', error);
      }
    });
  }

  /**
   * 上游会发生"余额/状态改变"的操作（领取签到等）成功后调用：
   * 立即作废插件侧的积分/签到缓存，让下一次快照重新打上游。
   * 没有它，面板在领取后最长 120 秒还显示旧余额（与换号 bug 同源的缓存一致性缺口）。
   */
  function invalidateUpstreamCaches() {
    state.quotaCache = { ...state.quotaCache, at: 0, value: null };
    state.checkinCache = { ...state.checkinCache, at: 0, value: null };
  }

  // ── 6. HTTP 数据面（入口页用） ─────────────────────────────────────────
  /**
   * provider 名 → { id, adapter }。面板的所有"按 provider"操作都经它解析，
   * 只认**已注册**的 provider —— 否则会写进一个永远读不到的键。
   * 缺省（空串）解析到主 provider。
   */
  const resolveProvider = (name) => {
    const wanted = String(name || '').trim();
    if (!wanted || wanted === config.provider) {
      return { id: config.provider, adapter, isPrimary: true };
    }
    const g = accountGroups.find((x) => x.provider === wanted && x.registered && x.adapter);
    return g ? { id: g.provider, adapter: g.adapter, isPrimary: false, group: g } : null;
  };

  if (config.routes) {
    useService('webServer', (webServer) => {
      const routes = createRouteTable({
        snapshot,
        supervisor,
        consoleSupervisor,
        client,
        adapter,
        // 供 restart 连分组桥一起重启（桥 detached，重启 dsh 不会换代码）
        accountGroups,
        paths: dshPaths,
        provider: config.provider,
        resolveProvider,
        log,
        onUpstreamMutation: invalidateUpstreamCaches,
        // readPrefs 由路由以 `readPrefs(providerId)` 单参调用 —— 这里**必须**
        // 把主 provider 绑进去。直接传函数引用会让 primaryProvider 变成 undefined，
        // 于是回退分支 `!primaryProvider` 恒真 → 每个分组都读到主 provider 的旧清单，
        // 表现就是"改不了显示模型"。
        readPrefs: (providerId) => readModelPrefs(providerId, config.provider),
        onWritePrefs: writeModelPrefs,
        writeContextPrefs,
        // 写入也要绑主 provider：迁移旧的全局键时要把它并进**主 provider** 的桶。
        // 不绑的话，从分组账号存一次就会把主账号还在读的旧声明销毁（实测复现过）。
        writeVisionPrefs: (providerId, overrides) => writeVisionPrefs(providerId, overrides, config.provider),
        // 同 readPrefs 的理由：路由以单参调用。不绑主 provider，旧全局 `vision`
        // 键的回退分支就永远不成立，升级用户保存过的图片声明会凭空消失。
        readVisionPrefs: (providerId) => readVisionPrefs(providerId, config.provider),
        writeReasoningPrefs: (providerId, overrides) => writeReasoningPrefs(providerId, overrides, config.provider),
        readReasoningPrefs: (providerId) => readReasoningPrefs(providerId, config.provider),
        writeCreditPrefs,
        readCreditPrefs,
        notifyAdaptersUpdated,
      });
      const disposeRoutes = mountRoutes(webServer, routes, log);
      ctx.effect(() => disposeRoutes, 'workbuddy.panel-routes');
    });
  }

  // ── 7. 后台把桥与控制台拉起来（不阻塞插件加载） ────────────────────────
  if (config.autoStart) {
    void (async () => {
      try {
        const result = await supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
        state.lastEnsure = { at: Date.now(), ...result };
        if (result.ok) {
          adapter.invalidate();
          log(`桥已就绪：${supervisor.baseUrl}/v1（pid ${result.health?.pid}${result.reused ? '，复用已有实例' : '，本次新拉起'}）`);
        } else {
          log(`桥未能就绪：${result.error}`);
        }
      } catch (error) {
        log('自动启动桥失败', error);
      }
    })();
  }
  if (config.consoleAutoStart) {
    void (async () => {
      try {
        const result = await consoleSupervisor.ensure({});
        state.lastConsoleEnsure = { at: Date.now(), ...result };
        log(result.ok
          ? `控制台已就绪：${consoleSupervisor.url}${result.reused ? '（复用已在运行的实例）' : '（本次新拉起）'}`
          : `控制台未能就绪：${result.error}`);
      } catch (error) {
        log('自动启动控制台失败', error);
      }
    })();
  }

  // ── 7b. 多账号分组的桥：各自独立拉起（互不阻塞、互不影响） ──────────────
  if (config.autoStart) {
    for (const group of accountGroups) {
      if (!group.registered || !group.supervisor) continue;
      void (async () => {
        try {
          const result = await group.supervisor.ensure({ readyTimeoutMs: config.autoStartTimeoutMs });
          group.lastEnsure = { at: Date.now(), ...result };
          if (result.ok) {
            group.adapter?.invalidate();
            // 记下该分组服务的账号（仅用于展示 "哪个分组是哪个账号"）
            group.account = result.health?.auth?.userId || null;
            log(`分组「${group.displayName}」桥已就绪：${group.supervisor.baseUrl}/v1（端口 ${group.port}，账号 ${String(group.account || '?').slice(0, 8)}…）`);
          } else {
            log(`分组「${group.displayName}」桥未能就绪：${result.error}`);
          }
        } catch (error) {
          log(`分组「${group.displayName}」自动启动桥失败`, error);
        }
      })();
    }
  }

  log(`插件已加载：projectRoot=${projectRoot || '(未找到)'} bridge=${supervisor.baseUrl} console=${consoleSupervisor.url} provider=${state.route.provider}`);
  return { supervisor, consoleSupervisor, client, adapter, state, snapshot };
}

export default { name, inject, apply, DEFAULTS, resolveConfig, detectProjectRoot };
