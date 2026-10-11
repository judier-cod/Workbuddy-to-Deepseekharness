/**
 * 「添加账号」的区域必须**自动判断**，界面上不出现任何区域字样。
 *
 * ## 背景（用户连续三次反馈的演进）
 *
 *   ① `国内版 | 国际版` 切换器 + 一个「添加账号」按钮
 *      → 用户："不要这个切换按钮了"
 *   ② 两个按钮（「添加国内版账号」/「添加国际版账号」）
 *      → 用户："两个明确的按钮也不需要"
 *   ③ 一个「添加账号」按钮，区域由插件自动判断  ← 现在
 *
 * 这个演进指向一个结论：**"该加哪个区域"有确定答案** —— 你正在用的客户端是哪个
 * 域，就是要补登的那个域。让用户去选一个他自己都不知道该怎么选的东西，是设计失误。
 *
 * 判据用主桥 `/health` 的 `auth.endpoint`（实测：国内版 `https://copilot.tencent.com`、
 * 国际版 `https://www.workbuddy.ai`）。
 *
 * 这个文件钉住三件事：
 *   1. 路由层 `action: 'start'` 在没传 region 时会去探测；
 *   2. 域 → 区域的映射认得已知的等价域，且**不认识的域不猜**（返回空）；
 *   3. 面板只渲染一个按钮，且请求体里**不带** region。
 *
 *   node --test dsh-plugin/tests/region-detect.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(p, 'utf8');
const ROUTES = join(HERE, '..', 'lib', 'routes.mjs');
const CLIENT = join(HERE, '..', 'lib', 'client.js');

test('路由层：action=start 没传 region 时必须自动探测（不能写死 cn）', () => {
  const src = read(ROUTES);

  assert.match(src, /async function detectRegion\(\)/,
    '应当有 detectRegion()（按当前客户端判断区域）');
  assert.match(src, /body\?\.region \|\| await detectRegion\(\)/,
    'start 应当在没传 region 时自动探测 —— 显式传仍被尊重（诊断/脚本用得上）');

  // 判据必须是主桥报告的 endpoint/domain，而不是猜
  assert.match(src, /probe\.health\?\.auth\?\.endpoint/, '应当读主桥的 auth.endpoint');
  assert.match(src, /probe\.health\?\.auth\?\.domain/, 'endpoint 缺失时应回退到 auth.domain');
  assert.match(src, /return 'cn'/, '都拿不到时要有明确兜底（不能返回空 → startLogin 会报错）');
});

/**
 * 域 → 区域的映射。这里**把实现抽出来单独跑**，因为它是纯逻辑，且错一次的
 * 代价是"用户去错的上游登一次"。
 */
test('域 → 区域：认得已知等价域，不认识的域不猜', async () => {
  const src = read(ROUTES);
  const start = src.indexOf('const regionByHost = (host) => {');
  const end = src.indexOf('\n    };', start) + 6;
  assert.ok(start > 0 && end > start, '应当能抽出 regionByHost');
  const REGIONS = {
    cn: { id: 'cn', base: 'https://copilot.tencent.com' },
    global: { id: 'global', base: 'https://www.workbuddy.ai' },
  };
  const regionByHost = new Function('REGIONS', `${src.slice(start, end)}; return regionByHost;`)(REGIONS);

  // 与 REGIONS[*].base 精确匹配
  assert.equal(regionByHost('copilot.tencent.com'), 'cn');
  assert.equal(regionByHost('www.workbuddy.ai'), 'global');
  // 大小写不敏感（endpoint 里的大小写不该影响判断）
  assert.equal(regionByHost('WWW.WorkBuddy.AI'), 'global');

  // 已知等价域（实测上游在不同版本用过这些域）
  assert.equal(regionByHost('workbuddy.ai'), 'global');
  assert.equal(regionByHost('codebuddy.ai'), 'global');
  assert.equal(regionByHost('www.codebuddy.cn'), 'cn');
  assert.equal(regionByHost('workbuddy.cn'), 'cn');

  // **不认识的域不猜** —— 返回空，由调用方落到默认区域
  assert.equal(regionByHost('example.com'), '');
  assert.equal(regionByHost(''), '');
  assert.equal(regionByHost(undefined), '');
  // 别把"看起来像"的域误判成国际版（后缀必须真正匹配）
  assert.equal(regionByHost('notworkbuddy.ai.evil.com'), '');
  assert.equal(regionByHost('workbuddy.ai.evil.com'), '');
});

test('面板：只有一个「添加账号」按钮，界面上没有区域字样，请求不带 region', () => {
  const src = read(CLIENT);

  // 不该再有区域状态与分段控件
  assert.doesNotMatch(src, /const \[region, setRegion\]/, '不该再有 region 状态');
  assert.doesNotMatch(src, /ariaLabel: '登录区域'/, '不该再有区域选择控件');

  // begin() 不该再接收/传递 region
  const begin = src.match(/const begin = async \(([^)]*)\) => \{[\s\S]*?\n      \};/);
  assert.ok(begin, '应当能定位到 begin()');
  assert.equal(begin[1].trim(), '', 'begin() 不该再接收参数（区域由宿主判断）');
  assert.match(begin[0], /post\(\{ action: 'start' \}\)/,
    "begin() 应当只发 action:'start'，不带 region");
  assert.doesNotMatch(begin[0], /region/,
    'begin() 里不该再出现 region —— 界面不参与区域决定');

  // 按钮文字里不该出现区域字样
  const btn = src.match(/'添加账号'/);
  assert.ok(btn, '应当有「添加账号」按钮');
  assert.doesNotMatch(src, /'添加国内版账号'|'添加国际版账号'|`添加\$\{r\.label\}账号`/,
    '不该再按区域渲染多个按钮');
});
