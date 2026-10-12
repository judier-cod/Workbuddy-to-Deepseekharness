/**
 * 安全回归：本轮审计修掉的几条，钉在这里防止回退。
 *
 *   node --test dsh-plugin/tests/
 *
 * 覆盖：
 *   1. **YAML 注入**：模型 id 会被拼进 dsh 的 settings.yaml / cordis.patch.yml，
 *      含换行的 id 能注入顶层 YAML 键（cordis patch 的顶层条目 = 插件/适配器条目
 *      → 配置注入 → 潜在任意代码执行）。实测确认过，这里钉死"必须拒绝"。
 *   2. **读取回环**：id 现在带引号写入，读回时必须剥掉引号，否则「已注册模型」
 *      会全部错位（失效检测全误判）。
 *   3. **跨站来源**：控制台必须拒绝外来 Origin（DNS rebinding 防线），且不能
 *      误伤本机调用；静态备份文件不得可下载；基础安全响应头必须到位。
 *
 * DSH_HOME 指向临时目录：`config.mjs` 在 import 时求值，所以必须在**动态 import
 * 之前**设好，绝不能碰使用者真实的 ~/.dsh。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);
const REPO = dirname(PLUGIN_DIR);

const home = mkdtempSync(join(tmpdir(), 'wb-sec-home-'));
process.env.DSH_HOME = home;
process.env.WORKBUDDY_PORT = '0';

// patch 文件先建好：writeRegistration 只在它存在时才同步 patch 层
mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '# 用户自己的 patch 文件\n', 'utf8');

const dsh = await import('../../lib/dsh.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. YAML 注入 ────────────────────────────────────────────────────────

test('安全：模型 id 含换行/引号等必须被拒绝，绝不写进 YAML', async () => {
  const settingsPath = join(home, 'settings.yaml');
  const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const before = {
    settings: existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null,
    patch: readFileSync(patchPath, 'utf8'),
  };

  const hostile = [
    'evil\nmaliciousTopLevel:\n  enabled: true', // 顶层键
    'evil\n- id: injected-adapter\n  name: x',    // 顶层列表项（cordis 的插件条目）
    'evil" injected: 1',                          // 引号逃逸
    'evil model',                                 // 含空格
    '  leadingSpace',
    '',
  ];
  for (const id of hostile) {
    assert.throws(
      () => dsh.writeRegistration([{ id, name: 'n' }]),
      /不合法/,
      `hostile id 必须被拒绝：${JSON.stringify(id)}`,
    );
  }
  assert.equal(dsh.invalidModelIds(hostile).length, hostile.length);

  // "拒绝"意味着**一个字节都不写**（不是"写一半"）：settings 与 patch 都要原样
  const afterSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
  assert.equal(afterSettings, before.settings, '被拒绝时不得创建/改动 settings.yaml');
  assert.equal(readFileSync(patchPath, 'utf8'), before.patch, '被拒绝时不得改动 patch 文件');
});

test('安全：合法 id 正常写入，且生成物里没有顶层越权键', async () => {
  const ok = [{ id: 'deepseek-v4.1-flash', name: 'Flash' }, { id: 'glm-5.3', name: 'GLM' }];
  assert.deepEqual(dsh.invalidModelIds(ok), []);
  const out = dsh.writeRegistration(ok);
  assert.equal(out.saved, true);

  const text = readFileSync(join(home, 'settings.yaml'), 'utf8');
  // 顶层（0 缩进）只应有注释头与 llm-pi-ai: —— 任何其它顶层键都说明被注入
  const topLevel = text.split('\n').filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith('#'));
  assert.deepEqual(topLevel, ['llm-pi-ai:'], `出现了意外的顶层键：${JSON.stringify(topLevel)}`);

  // 纵深防御：即使有人绕过校验直接调 buildSettings，引号也要保证结构不被撑破
  const built = dsh.buildSettings([{ id: 'evil\nmaliciousTopLevel:\n  x: 1', name: 'n' }]);
  const builtTop = built.split('\n').filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith('#'));
  assert.deepEqual(builtTop, ['llm-pi-ai:'], 'buildSettings 也必须撑不破 YAML 结构');
});

// ── 2. 读取回环（id 带引号写入后必须能读回）────────────────────────────

test('安全/回归：带引号写入的 id 能原样读回（否则已注册模型会全部错位）', async () => {
  const ids = ['deepseek-v4.1-flash', 'glm-5.3', 'hy4-preview'];
  dsh.writeRegistration(ids.map((id) => ({ id, name: id })));

  const status = dsh.readDshStatus();
  assert.deepEqual(
    [...status.registeredModels].sort(),
    [...ids].sort(),
    '读回的 id 不得带引号（modelsUnder 必须容忍两种形式）',
  );
  assert.equal(status.routeLive, true);
});

// ── 2.5 分发包卫生：运行期数据绝不能进 vendor/ ───────────────────────────

/**
 * `vendor/` 是**要发出去**的快照（`npm pack` 会把它打进 tgz，用户装的就是它）。
 * 一旦混进使用者本人的运行期数据，等于把别人的使用记录发给了第三方。
 *
 * 回归（实测踩到）：`dashboard/console.pid` 混进了已发布的 v1.5.0 tgz ——
 * 那是插件自己写的控制台进程号（5 字节的本机 pid）。两个后果：
 *   ① 运行时状态发给用户，毫无意义；
 *   ② 它**只在本机存在**（`.gitignore` 忽略了），于是"本地打包 35 项、CI 打包
 *      34 项" —— **发布产物与门禁验的不是同一份**，这类偏差最难发现。
 *
 * 这里按**文件名模式**全面兜住，不只针对 pid：日志、账本、状态、备份、临时文件。
 */
test('分发包卫生：vendor/ 里不得有运行期数据（日志 / 账本 / 状态 / pid / 备份）', () => {
  const VENDOR = join(PLUGIN_DIR, 'vendor');
  assert.ok(existsSync(VENDOR), 'vendor/ 应当存在（发布物就是它）');

  /** 绝不该出现在分发包里的文件名模式。 */
  const FORBIDDEN = [
    [/\.log$/i, '日志（含用户调用记录）'],
    [/\.jsonl$/i, '用量账本（含每次调用的时间/模型/token）'],
    [/\.pid$/i, '进程号（运行时状态，且本机/CI 不一致）'],
    [/^\.state\.json$/i, '本地状态（含当前选中的账号）'],
    [/^\.env$/i, '使用者自己的配置'],
    [/\.bak($|-)/i, '备份文件'],
    [/^\.model-prefs\.json$/i, '本地模型偏好'],
    [/^usage\.jsonl$/i, '用量账本'],
  ];

  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === 'node_modules') continue;
        walk(full);
        continue;
      }
      for (const [re, why] of FORBIDDEN) {
        if (re.test(name)) offenders.push(`${relative(VENDOR, full)}（${why}）`);
      }
    }
  };
  walk(VENDOR);

  assert.deepEqual(offenders, [],
    `vendor/ 里混进了运行期数据，会被 npm pack 发给用户：\n  ${offenders.join('\n  ')}`);
});

test('分发包卫生：vendor.mjs 的 SKIP 覆盖了每一类运行期数据', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'scripts', 'vendor.mjs'), 'utf8');
  const skipBlock = src.match(/const SKIP = \[([\s\S]*?)\n\];/);
  assert.ok(skipBlock, '应当能定位到 vendor.mjs 的 SKIP 清单');

  // 每一类都要有对应规则 —— 少一条就会让对应文件混进分发包
  for (const [pattern, why] of [
    [/\\\.log\$/i, '日志'],
    [/\\\.jsonl\$/i, '用量账本'],
    [/\\\.pid\$/i, '进程号'],
    [/\\\.bak/i, '备份'],
  ]) {
    assert.match(skipBlock[1], pattern, `SKIP 必须排除${why}（否则会进分发包）`);
  }
});

/**
 * 插件的 `files` 清单里声明的每一项都必须**真实存在**。
 *
 * 回归（实测踩到）：清单里写了 `LICENSE` 与 `NOTICE.md`，但 `dsh-plugin/` 下没有
 * 这两个文件 —— npm **静默忽略**不存在的条目（不报错、不警告），于是：
 *   - 装 tgz 的用户拿到的包里**根目录没有许可证**（只有 `vendor/LICENSE`）；
 *   - 清单看起来"声明了"，实际没生效，谁也不知道。
 *
 * 修法是把根目录的两份复制进 `dsh-plugin/`。但复制会带来**漂移**风险，所以这里
 * 同时断言内容与根目录一致。
 */
test('分发包卫生：插件 files 清单声明的文件都存在，且许可证与根目录一致', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  const missing = (pkg.files || []).filter((f) => !existsSync(join(PLUGIN_DIR, f)));
  assert.deepEqual(missing, [],
    `package.json 的 files 声明了不存在的条目（npm 会静默忽略）：${missing.join(', ')}`);

  // 许可证必须与根目录逐字节一致（复制来的，不能各改各的）
  for (const f of ['LICENSE', 'NOTICE.md']) {
    const rootFile = join(REPO, f);
    const pluginFile = join(PLUGIN_DIR, f);
    if (!existsSync(rootFile)) continue; // 根目录没有就不要求
    assert.ok(existsSync(pluginFile), `插件目录缺 ${f}（files 里声明了它）`);
    assert.equal(readFileSync(pluginFile, 'utf8'), readFileSync(rootFile, 'utf8'),
      `${f} 与根目录不一致 —— 复制件漂移了，改一处要同步另一处`);
  }
});

// ── 3. 控制台：跨站来源 / 静态备份 / 安全头 ──────────────────────────────

test('安全：控制台拒绝外来 Origin、拒绝备份文件、带基础安全头（起真进程打真 HTTP）', { timeout: 60_000 }, async () => {
  const port = 23000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, [join(REPO, 'dashboard', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(port),
      WORKBUDDY_PORT: '0',
      // 别在测试里动本机真实的桥 / 触发签到 / 改使用者的 .state.json
      DASHBOARD_AUTO_START_BRIDGE: '0',
      DASHBOARD_OPEN_BROWSER: '0',
      WORKBUDDY_AUTO_CHECKIN: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      await sleep(250);
      try { ready = (await fetch(`${base}/api/overview`)).ok; } catch { /* 还没起来 */ }
    }
    assert.equal(ready, true, '控制台未能在 15 秒内就绪');

    // ① 外来 Origin 的写操作：在到达路由之前就被拒（连面板头都轮不到检查）
    const crossOrigin = await fetch(`${base}/api/checkin/settings`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ auto: true }),
    });
    assert.equal(crossOrigin.status, 403, '外来 Origin 必须 403（DNS rebinding 防线）');
    await crossOrigin.text();

    // ② 回环 Origin 但缺面板头：仍要 403（面板头这道防线不能被 Origin 顶替）
    const noHeader = await fetch(`${base}/api/checkin/settings`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true }),
    });
    assert.equal(noHeader.status, 403, '缺面板头的写操作必须 403');
    await noHeader.text();

    // ③ 本机 CLI（无 Origin）的读操作不受影响
    const readOk = await fetch(`${base}/api/overview`);
    assert.equal(readOk.status, 200, '无 Origin 的读操作必须照常');

    // ④ 静态备份文件不得可下载
    const bak = await fetch(`${base}/index.html.bak`);
    assert.equal(bak.status, 404, '备份文件必须 404（不要把工作副本当发布物发出去）');
    await bak.text();

    // ⑤ 正常静态资源不受影响 + 安全头到位
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await page.text();

    // ⑥ 日志行数参数必须做数值校验：`Number('abc')` 是 NaN，而 `slice(-NaN)` 等价于
    //    `slice(0)` —— 会把整份日志返回（实测曾返回全部 1919 行而不是 80 行）。
    for (const [q, limit] of [['lines=abc', 80], ['lines=0', 80], ['lines=80', 80], ['lines=999999', 2000]]) {
      const j = await (await fetch(`${base}/api/bridge/log?${q}`)).json();
      const n = (j.lines || []).length;
      assert.ok(n <= limit, `${q} 返回了 ${n} 行，超过上限 ${limit}（参数没有被 clamp）`);
    }
  } finally {
    child.kill();
    await sleep(200);
  }
});

after(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 已清理 */ }
});
