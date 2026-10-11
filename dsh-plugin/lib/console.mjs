/**
 * 控制台的进程管理。
 *
 * 分工（这就是「插件 + 控制台」的结合方式）：
 *   插件  = 引擎：原生模型路由、桥的生命周期、工具、命令、入口
 *   控制台 = 界面：逐条请求、趋势图、账号切换、CSV 导出、签到、诊断 —— 它本来就更全
 *
 * 所以插件不再自己造一个仪表盘，而是把控制台一起管起来：已在跑就复用，
 * 没跑就拉起（与控制台自己的 `启动.cmd` 完全等价，都读同一个 `config.mjs`/`.env`），
 * 然后在 dsh 里给一个「打开控制台」的入口。
 *
 * 识别方式：控制台首页的 `<title>` 是 `WorkBuddy 中转控制台` —— 用它判断 8792
 * 上跑的到底是不是我们的控制台，而不是随便一个占着端口的 HTTP 服务。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 读 `console.pid`：**只认活着的 pid**。
 *
 * 进程可能早就退出了（崩溃、被杀、机器重启），残留的 pid 还会被复用给别的进程
 * —— 那种情况下拿它去 kill 就是误杀无关进程。所以这里顺手确认它还在。
 *
 * @param {string} file
 * @returns {number|null}
 */
function readPidFile(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // 信号 0 = 只探测存活，不真的发信号
    return pid;
  } catch {
    return null; // 文件不存在 / 内容坏了 / 进程已退出
  }
}

/** 记下"这个控制台是我们起的"。失败不该影响启动（只是下次认不出来而已）。 */
function writePidFile(file, pid) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(pid), 'utf8');
  } catch { /* 忽略 */ }
}

/** 清掉 pid 记录（进程已停 / 已确认不是我们的）。 */
function clearPidFile(file) {
  try { unlinkSync(file); } catch { /* 本来就不存在 */ }
}

/**
 * 从**端口**反查监听进程的 pid。
 *
 * 为什么需要：控制台不像桥那样在 `/health` 里自报 pid，所以 `stop()` 原先只能
 * 停「本进程亲手拉起的」那个 pid。而控制台是 **detached 的、活过 dsh 重启**的 ——
 * 重启 dsh 之后 `spawnedPid` 是 `null`，于是"重启控制台"永远做不到
 * （实测：点了重启，pid 23164 纹丝不动，控制台继续跑旧代码）。
 *
 * 有了端口反查，重启就能停掉"上一轮启动、现在还在跑"的那个控制台。
 * 拿不到 pid 时返回 null（调用方如实报错，不猜、不乱杀）。
 *
 * @param {number} port
 * @returns {number|null}
 */
export function findPortPid(port) {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0 || !r.stdout) return null;
      for (const line of r.stdout.split('\n')) {
        // 形如：  TCP    127.0.0.1:8792    0.0.0.0:0    LISTENING    23164
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (!new RegExp(`[:.]${port}$`).test(cols[1])) continue;
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    }
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
    const pid = Number((r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 用来确认端口上**是我们自己的控制台**的标记。
 *
 * 原先用的是首页 `<title>`（`'WorkBuddy 中转控制台'`）—— 项目改定位成
 * 「WorkBuddy 本地 API 桥」后标题跟着改了，于是**插件再也认不出自己的控制台**：
 * 探活返回 `foreign`，进而拒绝复用、报「换个 DASHBOARD_PORT」。
 *
 * **品牌名会变，结构标记不会** —— 改用导航栏的 id。
 *
 * ⚠️ 它必须落在**首页首个数据块**内：下面的 `probe` 只读第一个 chunk 就断开
 * （首页 146KB，全读没必要）。`id="navTabs"` 在第 45 行，远早于正文，满足前提。
 */
export const CONSOLE_MARKER = 'id="navTabs"';
/**
 * probe() 读取首页的字节上限。
 *
 * 识别标记必须落在这段范围内（当前 index.html 146KB，标记在第 45 行，
 * 余量充足）。环回读取极廉价，给足上限；同时它是"有界"的保证 —— 不是
 * 我们控制台的 HTTP 服务不会让探活无限拖页。单测会交叉校验真产物里的
 * 标记在此上限之内（见 plugin.test.mjs 的交叉校验用例）。
 */
export const CONSOLE_READ_CAP = 512 * 1024;
/** 控制台脚本相对项目根的位置。 */
export const CONSOLE_SCRIPT_REL = join('dashboard', 'server.mjs');
/** 控制台日志相对项目根的位置。 */
export const CONSOLE_LOG_REL = join('dashboard', 'console.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ConsoleSupervisor {
  /**
   * @param {object} options
   * @param {string} options.projectRoot
   * @param {string} [options.scriptPath]
   * @param {string} [options.logPath]
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {boolean} [options.autoStart]
   * @param {string} [options.nodePath]
   * @param {Record<string,string|undefined>} [options.env]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.projectRoot = options.projectRoot;
    this.scriptPath = options.scriptPath || join(options.projectRoot, CONSOLE_SCRIPT_REL);
    this.logPath = options.logPath || join(options.projectRoot, CONSOLE_LOG_REL);
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 8792;
    this.autoStart = options.autoStart !== false;
    this.nodePath = options.nodePath || process.execPath;
    this.env = options.env || {};
    this.onLog = options.onLog || (() => {});
    /**
     * 只有「本进程亲手拉起的」控制台才由我们停；别人起的（双击 启动.cmd）不动。
     *
     * 但**控制台是 detached 的、活过 dsh 重启**，所以光靠内存里的 `spawnedPid`
     * 不够：重启 dsh 之后它是 null，于是"重启控制台"永远做不到（实测点了没反应）。
     * 因此把 pid 落盘到 `dashboard/console.pid`，下一轮启动仍能认出"这是我们起的"。
     */
    this.pidFile = options.pidFile || join(options.projectRoot, 'dashboard', 'console.pid');
    this.spawnedPid = readPidFile(this.pidFile);
    this.lastStartError = null;
    this.pendingEnsure = null;
    /** 探测结果缓存：面板每 5 秒问一次状态，没必要每次都把首页拉一遍。 */
    this.cache = { at: 0, state: null, error: '' };
    this.cacheTtlMs = options.cacheTtlMs ?? 20_000;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * 探测控制台是否在跑。**不抛错**。
   * @param {{signal?: AbortSignal, cached?: boolean}} [options]
   */
  async probe({ signal, cached = false } = {}) {
    if (cached && this.cache.state && Date.now() - this.cache.at < this.cacheTtlMs) {
      return { state: this.cache.state, error: this.cache.error, cached: true };
    }
    let result;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
      const onAbort = () => ac.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let text = '';
      try {
        const res = await fetch(`${this.url}/`, { signal: ac.signal, headers: { accept: 'text/html' } });
        /**
         * **有界读取**：逐块读，命中标记即停、到上限也停。
         *
         * 原实现只读"第一个 chunk"就判断 —— 前提是标记落在首块内，未经任何
         * 保证：标记位置下移、页面变大、走 gzip / 反向代理 / 流式渲染都会
         * 立刻复发（报告 §6.0 实测「标记前 110KB 填充」30/30 全部误判）。
         * 环回读取成本可忽略，读到匹配或 CONSOLE_READ_CAP 为止。
         */
        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let received = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            received += value?.length || 0;
            text += decoder.decode(value || new Uint8Array(), { stream: true });
            if (text.includes(CONSOLE_MARKER)) break; // 命中即停，不读完整页
            if (received >= CONSOLE_READ_CAP) break; // 上限内没有标记 = 不是我们
          }
          await reader.cancel().catch(() => {});
        } else {
          text = await res.text();
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      result = text.includes(CONSOLE_MARKER)
        ? { state: 'running', error: '' }
        : { state: 'foreign', error: `端口 ${this.port} 上有 HTTP 服务，但不是 WorkBuddy 控制台（换个 DASHBOARD_PORT）` };
    } catch (error) {
      result = { state: 'stopped', error: String(error?.message || error) };
    }
    this.cache = { at: Date.now(), state: result.state, error: result.error };
    return result;
  }

  async isRunning(options) {
    return (await this.probe(options)).state === 'running';
  }

  /**
   * 保证控制台可用：活着就复用，否则按配置拉起并等它就绪。
   *
   * `restart: true` 时**先停再起** —— 这是"改了控制台代码要生效"的唯一办法。
   * 原先没有这个开关，路由层的 `action: 'restart'` 落到这里就被当成"复用"，
   * 于是点了重启 pid 纹丝不动（实测 23164 → 23164），控制台继续跑旧代码；
   * 用户看到的现象是"代码改了但界面没变"（诊断页显示 5 个登录文件名那次
   * 就是这么被坑的：`lib/diagnostics.mjs` 改了，控制台进程 28 分钟前就起了）。
   *
   * @param {{signal?: AbortSignal, readyTimeoutMs?: number, restart?: boolean}} [options]
   */
  async ensure({ signal, readyTimeoutMs = 20_000, restart = false } = {}) {
    if (this.pendingEnsure) return this.pendingEnsure;
    this.pendingEnsure = this.#ensure({ signal, readyTimeoutMs, restart }).finally(() => { this.pendingEnsure = null; });
    return this.pendingEnsure;
  }

  async #ensure({ signal, readyTimeoutMs, restart }) {
    let status = await this.probe({ signal });
    if (status.state === 'running' && !restart) return { ok: true, started: false, reused: true, state: 'running', url: this.url };
    if (status.state === 'foreign') return { ok: false, started: false, reused: false, state: 'foreign', error: status.error };
    if (status.state === 'running' && restart) {
      /*
       * `adoptPort: true` —— 重启是**明确的用户动作**（"我要让新代码生效"），
       * 这时允许用端口反查认领控制台。控制台是 detached 的、活过 dsh 重启，
       * 光靠 spawnedPid / pid 文件认不出来（实测：点了重启，pid 纹丝不动，
       * 控制台继续跑旧代码 —— 诊断页显示 5 个登录文件名那次就是这么被坑的）。
       */
      const stopped = await this.stop({ adoptPort: true });
      if (!stopped.ok) {
        return { ok: false, started: false, reused: false, state: 'running', error: stopped.error };
      }
    }
    const started = await this.start();
    if (!started.ok) return { ok: false, started: false, reused: false, state: 'stopped', error: started.error };
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, started: true, reused: false, state: 'starting', error: 'aborted' };
      await sleep(250);
      const probe = await this.probe({ signal });
      if (probe.state === 'running') {
        return { ok: true, started: true, reused: false, restart, state: 'running', url: this.url, pid: started.pid };
      }
      if (probe.state === 'foreign') return { ok: false, started: true, reused: false, state: 'foreign', error: probe.error };
      lastError = probe.error || lastError;
    }
    return { ok: false, started: true, reused: false, state: 'starting', error: `控制台已拉起但 ${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪：${lastError}` };
  }

  /** 拉起控制台进程。stdout/stderr 落到 dashboard/console.log。 */
  async start() {
    if (!existsSync(this.scriptPath)) {
      return { ok: false, pid: null, error: `找不到控制台脚本：${this.scriptPath}` };
    }
    if (await this.isRunning({ cached: false })) return { ok: true, pid: null, reused: true };

    let logFd = null;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      logFd = openSync(this.logPath, 'a');
    } catch { /* 日志打不开不该阻止控制台启动 */ }

    const env = {
      ...process.env,
      // 同 bridge.start()：宿主是 Electron 时确保以 node 模式运行（不依赖
      // 环境变量继承）；真 node 环境下该变量无害。
      ELECTRON_RUN_AS_NODE: '1',
      // 桥的生命周期归插件管：插件拉起的这个控制台实例**不要**再去拉一次桥，
      // 否则两个进程会同时探测→同时 spawn，后到的那个以 EADDRINUSE 收场。
      // （控制台页面上的「启动桥服务」按钮不受影响，那是明确的用户动作。）
      // 想让控制台照旧自己拉桥，就在环境里显式设 DASHBOARD_AUTO_START_BRIDGE=1。
      DASHBOARD_AUTO_START_BRIDGE: process.env.DASHBOARD_AUTO_START_BRIDGE ?? '0',
      // 关键：不要让 dsh 每次启动都弹一个浏览器窗口
      DASHBOARD_OPEN_BROWSER: '0',
      ...this.env,
    };

    try {
      const child = spawn(this.nodePath, [this.scriptPath], {
        cwd: this.projectRoot,
        env,
        detached: true,
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.unref();
      this.spawnedPid = child.pid ?? null;
      // 落盘：控制台 detached、活过 dsh 重启，下一轮靠这个文件认出"这是我们起的"
      if (this.spawnedPid) writePidFile(this.pidFile, this.spawnedPid);
      this.lastStartError = null;
      this.cache = { at: 0, state: null, error: '' };
      this.onLog(`console spawned pid=${child.pid} ${this.url}`);
      child.on('error', (error) => {
        this.lastStartError = String(error?.message || error);
        this.onLog(`console spawn error: ${this.lastStartError}`);
      });
      return { ok: true, pid: child.pid ?? null, reused: false };
    } catch (error) {
      this.lastStartError = String(error?.message || error);
      return { ok: false, pid: null, error: this.lastStartError };
    } finally {
      if (logFd !== null) { try { closeSync(logFd); } catch { /* 忽略 */ } }
    }
  }

  /**
   * 只停「本进程亲手拉起的」控制台。
   *
   * 控制台不像桥那样在 `/health` 里自报 pid，所以对别人启动的实例（双击
   * `启动.cmd`）我们**不动它** —— 停别人起的东西不是插件该做的事。
   */
  /**
   * 停控制台。
   *
   * pid 来源按可信度排序：
   *   ① 内存里的 `spawnedPid`（本进程刚拉起的）；
   *   ② `console.pid` 落盘文件（**上一轮** dsh 拉起的，活过了重启）。
   *
   * ③ 端口反查**只在 `adoptPort` 时用**（`restart` 走这条）：控制台是 detached 的，
   * 重启 dsh 后 ①② 可能都没有，不反查就永远重启不了（实测点了重启 pid 纹丝不动）。
   * 但普通 `stop` 保持保守 —— 用户双击 `启动.cmd` 起的实例，插件不主动去停，
   * 那是原有设计意图（"停别人起的东西不是插件该做的事"）。
   *
   * @param {{adoptPort?: boolean}} [options]
   */
  async stop({ adoptPort = false } = {}) {
    const pid = this.spawnedPid || readPidFile(this.pidFile) || (adoptPort ? findPortPid(this.port) : null);
    if (!pid) {
      const status = await this.probe({ cached: false });
      return {
        ok: false,
        stopped: false,
        error: status.state === 'running'
          ? '这个控制台不是插件启动的（可能是你双击 启动.cmd 起的），插件不会去停它'
          : '控制台没有在运行',
      };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      clearPidFile(this.pidFile);
      return { ok: false, stopped: false, error: `无法结束 pid ${pid}：${error.message}` };
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(200);
      if ((await this.probe({ cached: false })).state === 'stopped') {
        this.spawnedPid = null;
        clearPidFile(this.pidFile);
        return { ok: true, stopped: true, pid };
      }
    }
    /*
     * SIGTERM 没让它退出（Windows 上 detached 进程常见）：升级到强杀。
     * 控制台没有需要优雅落盘的状态（账本在桥那边、它是只读展示），强杀安全。
     */
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* 已经退出了 */ }
    const hardDeadline = Date.now() + 5000;
    while (Date.now() < hardDeadline) {
      await sleep(200);
      if ((await this.probe({ cached: false })).state === 'stopped') {
        this.spawnedPid = null;
        clearPidFile(this.pidFile);
        return { ok: true, stopped: true, pid, forced: true };
      }
    }
    return { ok: false, stopped: false, error: `pid ${pid} 在 13 秒内没有退出（已尝试 SIGTERM 与 SIGKILL）` };
  }
}
