# 账号登录模块设计

> 日期：2026-10-11
> 状态：**已实现**。范围：**国内版 only**。国际版留待后续（成功态响应未实测）。
>
> **实现后的修订**：原设计只有"用户在设置页手点 OAuth"这一条路径。实现过程中
> 发现它解决不了用户的真实处境 —— 用户希望的是"**在客户端里切账号，插件自动
> 接住**"。于是主路径改成了**自动存档**（见 §0），OAuth 保留为补充路径
> （用于客户端从没登录过的账号）。

## 0. 主路径：自动存档（实现后的修订）

### 0.1 为什么必须"提前"存档

客户端切账号是**覆盖** `workbuddy-desktop.info`。实测：用户 17:22 登录过的那个
账号（`6d2b5f6b…`），切走之后**在磁盘上彻底不存在了** —— 没有任何备份。

所以"切账号后旧账号还能用"这件事，**只能在切换发生之前**就把快照存下来。
任何"切换后再说"的方案（包括让用户手点按钮）都来不及。

### 0.2 做法

账号巡检每 15 秒读一次客户端快照（它本来就在读，用于对账），顺手做一件事：

```
发现客户端当前账号 = X（桥 /health 的 auth.userId）
  → 若 <uid>.info 不存在，或来源文件的 mtime 变了
      → 原样复制客户端快照到 $DSH_HOME/workbuddy-accounts/<uid>.info
        （加 managed / archivedFrom / sourceMtime 标记，原子写、0600）
  → 再由 activateManagedGroups() 把它注册成独立分组（排除主账号）
```

要点：

| 决策 | 理由 |
|---|---|
| **原样复制**，不重新加密 | 客户端写的本来就是同一套 AtRest 信封、同一把 build 密钥，桥原样能解。复制比重新封装简单，也不可能引入"封装格式与客户端不一致"这类新故障 |
| **滚动更新**（按来源 mtime 判断） | 当前活跃的账号跟着客户端一起刷新 → **不会 30 天过期**；只有不再活跃的才会自然过期 |
| **原子写**（临时文件 + rename） | 分组桥每次请求都在读这个文件；巡检 15 秒写一次，写到一半被读到就是半个 JSON → 桥 503 |
| **排除主账号** | 同一账号起两条桥既浪费，又会让两个进程并发刷新同一会话（上游轮换 refresh token，并发刷新可能吊销会话） |
| 不需要 OAuth | 存档只是复制文件，不涉及令牌获取 |

### 0.3 与 OAuth 路径的关系

| | 自动存档 | OAuth 登录 |
|---|---|---|
| 触发 | 自动（切换账号即积累） | 用户手点「添加账号」 |
| 适用 | 客户端登录过的账号 | 客户端**从没**登录过、但用户有凭据的账号 |
| 需要用户做什么 | 无 | 浏览器授权一次 |
| 令牌来源 | 客户端写的信封（原样） | 自己拿的令牌，用 `sealEncryptedField()` 封 |

两条路径产出**同一种文件**，下游（分组注册、面板、移除）完全共用。

---

## 1. 背景与目标

插件现在只能消费**客户端已登录**的账号快照。国内版客户端把登录态写死在
`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，
文件名是常量，登第二个国内版账号会覆盖第一个 —— 因此「同时用两个不同的
国内版账号」在当前设计下做不到。

产出**与客户端同格式的加密登录文件**，自动注册成新的账号分组。

### 目标

- 客户端切账号 → 旧账号**自动**被接住（见 §0）
- 设置页「添加账号」：走官方 OAuth，不依赖桌面端在场
- 支持国内版加任意多个**不同**账号，各自一组 provider，同时可用
- 桥**零改动**

### 非目标（明确不做）

- 不做账号池化 / 轮换 / 限流跳过（项目红线，见 CONTRIBUTING.md「不做清单」）
- 不做国际版（本次范围外）
- 不做桥侧凭据刷新写回（见 §6「已知取舍」）
- 不改动现有桌面端登录文件的读取路径

## 2. 上游契约（已实测）

两个域都验证过（国内 `copilot.tencent.com`）。

### 2.1 发起

```
POST /v2/plugin/auth/state?platform=CLI&nonce=<random>
→ 200 {"code":0,"msg":"OK","data":{"state":"<36字符>","authUrl":"https://copilot.tencent.com/login?platform=CLI&state=…"}}
```

### 2.2 轮询

```
GET /v2/plugin/auth/token?state=<state>
→ 等待中：200 {"code":11217,"msg":"11217:login ing..."}
→ 成功后：200 {"code":0,"msg":"OK","data":{…}}
```

### 2.3 成功响应体（国内版实测）

```jsonc
{
  "code": 0,
  "msg": "OK",
  "data": {
    "accessToken":      "<JWT>",
    "expiresIn":        2419198,   // 秒 ≈ 28.0 天
    "refreshToken":     "<JWT>",
    "refreshExpiresIn": 2591998,   // 秒 ≈ 30.0 天
    "tokenType":        "Bearer",
    "sessionState":     "<uuid>",
    "scope":            "openid profile offline_access email",
    "domain":           "www.codebuddy.cn"
  }
}
```

`expiresIn` / `refreshExpiresIn` 换算为 28 天 / 30 天，与桌面端登录文件的
数值一致 —— 说明 CLI 流程与桌面端共用同一套令牌服务。

**注意**：CLI 流程返回的 `domain` 是 `www.codebuddy.cn`，桌面端文件里是
`www.workbuddy.cn`。两者经 `bridge/workbuddy-bridge.mjs` 的 `pickUpstream()`
都落到 `https://copilot.tencent.com`，因此桥无需适配。

### 2.4 令牌可用性

用刚获取的 access token 请求 `GET /v2/enterprises/personal/models`
→ `200, code 0, 31 个模型`，与国内版目录数吻合。

## 3. 存储

```
$DSH_HOME/workbuddy-accounts/<uid>.info     权限 0600
```

- **刻意放在 dsh home 而非仓库内**：仓库是 git 检出，凭据进仓库有被
  `git add` 提交的风险。
- 文件名用 uid（JWT `sub`）而非序号：同一账号重复登录覆盖同一文件，
  不会攒出一堆重复凭据。
- 权限 `0600`（Windows 上尽力设置，失败不阻塞）。

### 文件形状

完全仿客户端登录文件，使桥的 `readStoredAuth()` 原样认得出：

```js
{
  account: { uin, nickname? },
  auth: {
    accessToken:  <AtRest 信封>,
    refreshToken: <AtRest 信封>,
    tokenType, scope, sessionState, domain,
    expiresAt:        <ms 时间戳>,   // = now + expiresIn*1000
    refreshExpiresAt: <ms 时间戳>,   // = now + refreshExpiresIn*1000
    lastRefreshTime:  <ms 时间戳>,
  },
  accounts: [], allAccounts: [],
}
```

**为什么不是明文**：项目红线是「凭据不落盘」，其真实意图（见 NOTICE.md
第 15 行）是禁止写入**明文**破坏客户端加密存储。这里存的是 AtRest 信封，
与客户端同款加密，桥照常解密 —— 红线精神未破。

## 4. 加密可行性（已验证）

`lib/atrest.mjs` 目前只有解密（`openEncryptedField`），需要新增
`sealEncryptedField()`。

已用一次性脚本验证（`C:\TEMP`，已删除，未落盘任何令牌）：

- seal ↔ open 往返：短串与 JWT 形状串**均 PASS**
- 派生 keyId = `9127dea1b44020a7`，与真实登录文件**完全一致**
- 信封字段集 `{suite,keyId,nonce,authTag,ciphertext}` + `$wbEncrypted: 1`
  包装，与真实文件同构

依赖：密钥仍从客户端原生绑定现取（`fetchKeyPayload`），**不内置任何密钥副本**
（维持 NOTICE.md 的承诺）。

## 5. 流程

```
设置页「添加账号」
  ├─ 1. POST /v2/plugin/auth/state?platform=CLI&nonce=   → { state, authUrl }
  ├─ 2. 面板显示 authUrl（可点开 / 可复制），等待用户授权
  ├─ 3. 宿主端轮询 GET /v2/plugin/auth/token?state=  （11217 = 继续等）
  └─ 4. code 0 → 封装信封 → 写 <uid>.info → 注册分组 → 起桥
```

轮询在**宿主端**而非浏览器：authUrl 含一次性 state，浏览器直接打上游会撞
CORS，且轮询状态需要跨页面刷新保留。

### 超时与取消

- 单次轮询超时 15 秒；总时长上限 5 分钟，超时即作废本次 state
- 用户可「取消」，作废 state 并停止轮询（上游 state 会自然过期）

## 6. 已知取舍

### 30 天重登

桥的 `persistRefreshed()`（bridge/workbuddy-bridge.mjs:828）是**故意的 no-op**，
理由是「写入明文会破坏客户端凭据」。刷新结果只留在**内存**（`memoryAuth`）。

因此纳管账号的副本**不会自刷新**：access 28 天、refresh 30 天。桥停了超过
refresh 有效期，副本即失效，需重新登录一次。**用户已接受此取舍。**

> 升级选项（本次不做）：既然纳管文件是**我们自己的**而非客户端的，
> 「会破坏客户端凭据」的理由对它不成立。让桥在刷新后重写**纳管文件**
> 可彻底消除 30 天限制，代价是桥要改。留待后续。

### 只做国内版

国际版成功态响应体**未实测**（只探到 pending `11217`）。按国内版结构推定
即可大概率工作，但未经证实，故本次不做。

## 7. 改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `lib/atrest.mjs` | **+** `sealEncryptedField()` | 新增加密（现只有解密） |
| `dsh-plugin/lib/login.mjs` | **新建** | OAuth 状态机：start / poll / complete / remove |
| `dsh-plugin/lib/routes.mjs` | **改** | + `/login/start`、`/login/poll`、`/accounts/remove` |
| `dsh-plugin/lib/index.js` | **改** | 纳管账号并入 `config.accounts`；`resolveDshPaths()` 已有 dsh home |
| `dsh-plugin/lib/client.js` | **改** | 账号页「添加账号」卡片 + 纳管账号的删除入口 |
| `lib/diagnostics.mjs` | **改** | `listAccounts()` 纳入纳管账号 |
| `dsh-plugin/tests/login.test.mjs` | **新建** | 见 §8 |

写入口（`routes.mjs`）沿用现有约定：写操作要求 `x-workbuddy-panel: 1` 头。

`resolveDshPaths()`（dsh-plugin/lib/index.js:672）已解析 `DSH_HOME`，
纳管目录复用它，不新增配置源。

## 8. 测试

| 用例 | 断言 |
|---|---|
| `sealEncryptedField` ↔ `openEncryptedField` 往返 | 明文一致 |
| 封出的 keyId 与真实登录文件一致 | `9127dea1b44020a7` |
| 登录状态机：`11217` 时继续轮询 | 不误判为成功/失败 |
| 登录状态机：超时 | 作废 state，不写文件 |
| 登录状态机：取消 | 同上，且不残留轮询定时器 |
| 纳管文件权限 | `0600` |
| 纳管路径不落在仓库内 | 路径断言（防误提交） |
| 令牌不进日志 | 日志输出断言 |
| 面板：添加 / 删除 / 未授权态 | 渲染扫描 |

## 9. 风险

| 风险 | 说明 |
|---|---|
| 依赖上游非公开接口 | 上游变更需随之调整（同类项目均如此标注） |
| 30 天重登 | 用户已接受；升级路径见 §6 |
| 密钥依赖客户端在场 | 取密钥要启动客户端二进制；**客户端不存在则无法封装信封** |
| 国际版未验证 | 本次不做 |

## 10. 未验证项

- 国际版成功态响应体结构
- 同一账号重复登录时的覆盖行为
- 上游对「频繁发起 CLI 登录」是否有风控
