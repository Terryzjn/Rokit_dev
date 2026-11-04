# Rokit 代码结构整理 · 讨论记录（2026-10-23）

> **状态：仅讨论，未改动任何代码。** 本文档是 2026-10-23 讨论的快照，用于暂停后恢复。
>
> - 仓库：`C:\workspace\rokit`
> - 应用目录：`ai-launch-master/`
> - 关联文档：
>   - `docs/architecture/current-architecture.md`（2026-10-19 基线）
>   - `docs/architecture/refactoring-roadmap.md`（2026-10-19 分批路线）
>   - `docs/architecture/module-inventory.md`
>   - `docs/architecture/dependency-map.md`

---

## 0. 结论与约束

### 0.1 这次讨论的结论

- 可以做结构整理，但目标定为 **“搬迁 + 薄胶水”**，不是重写架构。
- 业务逻辑、IPC 协议、UI 行为、数据格式都不改。
- 核心源码预计从 **22,688 行** 变为 **约 23,680 行（+4.4%）**；新增的主要是文件头尾、导出、注册胶水。
- `index.html` 从 **17,932 行** 降到 **约 700 行**。
- `electron/main.js` 从 **4,756 行** 降到 **约 230 行**。
- 最大文件从 17,932 行降到 3,600 行以内；如果继续细拆，可降到 1,700 行以内。

### 0.2 约束（继续遵守）

- 尽量不新增代码，除非是拆分必需的胶水。
- 不引入 React / Vue / TypeScript。
- 不引入 ESM `import/export`，不引入构建工具（与 2026-10-19 `refactoring-roadmap.md` 的约束一致）。
- 不改变用户可见行为、UI、IPC 协议、Preload 暴露接口、数据格式。
- 不删除未确认无用的代码。
- 工作区里有未提交的测试、调试 txt、fallback 视频等，属于用户工作，**不要清理**。
- 先讨论，得到明确确认后才动代码。

---

## 1. 项目定位（简述）

Rokit 是一个面向独立开发者的 Electron 桌面工具，目标是把作品从“做完”推进到“被看见”：

> 登记作品 → AI 诊断、生成文案 → 录屏配音做宣传视频 → 分发到多个平台 → 回收反馈和数据 → 看板复盘

本地优先：SQLite 在 `%APPDATA%\Rokit\ai-launch-master.db`，密钥走 keytar / 系统凭据，没有账号、云同步、遥测。

---

## 2. 当前结构（2026-10-23 实测）

### 2.1 仓库顶层

```
rokit/
├─ README.md
├─ docs/
│  ├─ architecture/
│  │  ├─ current-architecture.md
│  │  ├─ dependency-map.md
│  │  ├─ module-inventory.md
│  │  ├─ refactoring-roadmap.md
│  │  └─ structure-refactor-plan-2026-10-23.md   ← 本文档
│  └─ ...
└─ ai-launch-master/                              ← 真正的应用
   ├─ index.html
   ├─ package.json
   ├─ CHANGELOG.md
   ├─ electron/
   ├─ renderer-utils/
   ├─ scripts/
   ├─ tests/
   └─ docs/
```

### 2.2 关键文件（行数 / 大小）

| 文件 | 行数 | 大小 |
|---|---:|---:|
| `ai-launch-master/index.html` | 17,932 | 958.4 KB |
| `ai-launch-master/electron/main.js` | 4,756 | 225.4 KB |
| `electron/voice-engine.js` | 1,508 | 65.9 KB |
| `electron/oauth.js` | 979 | 44.0 KB |
| `electron/publishers.js` | 902 | 55.9 KB |
| `electron/store.js` | 811 | 35.5 KB |
| `electron/wechat.js` | 656 | 29.0 KB |
| `electron/browser/BrowserManager.js` | 559 | 24.0 KB |
| `electron/caption-burn.js` | 522 | 21.4 KB |
| `electron/video-source.js` | 486 | 20.7 KB |
| `electron/video.js` | 439 | 17.7 KB |
| `electron/preload.js` | 202 | 15.3 KB |
| `electron/queue.js` | 142 | 5.2 KB |
| `renderer-utils/format.js` | 19 | 0.9 KB |

数量：

- `electron/**/*.js`：61 个；
- `tests/*.js`：88 个；
- `scripts/*.js`：14 个；
- `renderer-utils/`：1 个（`format.js`）。

### 2.3 `index.html` 内部结构

```
1–22          head
23–1343       <style>            1,321 行
1351–2007     HTML body            657 行
2008–17925    <script>           15,918 行
17926–17932   收尾
```

- 15,918 行 JS 全部包在 **一个 IIFE** 里（`index.html:2010` 到 `:17923`）。
- 357 个函数声明，249 个箭头函数常量。
- 233 处 `window.xxx = ...`，大量 HTML 内联 `onclick` 依赖它们。
- 16 步向导、6 个阶段；`STEP_DONE = 99` 表示流程结束。

### 2.4 `electron/main.js` 内部结构

| 行号 | 内容 | 行数 |
|---|---|---:|
| 1–191 | 启动、require、创建窗口 | 191 |
| 192–225 | 窗口控制 IPC | 34 |
| 226–248 | settings / works IPC | 23 |
| 249–940 | GitHub / YouTube 统计 | 692 |
| 941–1128 | 密钥 / 在线 TTS | 188 |
| 1129–1246 | 微信 | 118 |
| 1247–1303 | OAuth | 57 |
| 1304–1359 | 队列 / 反馈 | 56 |
| 1360–2076 | GitHub 发布 / Pages / 探测 | 717 |
| 2077–2194 | 发布窗口 | 118 |
| 2195–3896 | 小红书专用流程 | **1,702** |
| 3897–3991 | YouTube | 95 |
| 3992–4188 | X | 197 |
| 4189–4432 | 旧 `pubExec` | 244 |
| 4433–4489 | 录屏源选择 | 57 |
| 4490–4715 | 启动装配 | 226 |
| 4716–4756 | 生命周期 / 微信视频 | 41 |

热点：小红书 1,702 行（36%）、GitHub 发布/探测 717 行、统计 692 行。

---

## 3. 当前主要问题

1. **单文件过大**：`index.html` 17,932 行，`main.js` 4,756 行；定位、修改、review 成本高。
2. **单 IIFE 共享作用域**：15,918 行 JS 共用一个闭包，拆文件后不能直接互相访问局部变量。
3. **`window.*` 与内联事件耦合**：233 处全局赋值，HTML 里大量 `onclick="foo()"`。
4. **后期覆盖/二次赋值**：同名函数或 `window.*` 被再次赋值，加载顺序会影响行为。
5. **发布路径多套并存**：旧 `pubExec`、BrowserManager、GitHub API、YouTube API、微信 API、X/小红书/即刻/Product Hunt 专用流程。
6. **测试按文本扫描源码**：约 14 个测试直接 `readFileSync('index.html')` / `main.js`，拆分后需要改读取方式。
7. **打包清单**：`electron-builder.files` 目前只收录 `index.html` 和 `renderer-utils/**/*`，新增 `renderer/` 后必须同步。

---

## 4. 目标结构

### 4.1 renderer（粗粒度版，21 个文件）

```
ai-launch-master/
├─ index.html                          ~700   只留 head + body + link/script
└─ renderer/
   ├─ styles/                          ~1,320
   │  ├─ base.css                      ~450
   │  ├─ flow.css                      ~520
   │  ├─ modals.css                    ~200
   │  └─ voice-caption.css             ~150
   ├─ core/                            ~2,000
   │  ├─ state.js                      ~240   state / 常量 / 默认值
   │  ├─ ui.js                         ~900   弹窗 / toast / 主题 / 聊天 UI / cmdK
   │  ├─ nav.js                        ~380   go / STAGES / rail / renderStep
   │  ├─ steps.js                      ~30    新增：步骤注册表
   │  └─ init.js                       ~80    窗口控制 / loadStored / 启动
   ├─ settings/
   │  ├─ ai.js                         ~410   模型厂商 / BYOK / model picker
   │  └─ accounts.js                   ~990   GitHub / YouTube / TTS / 微信凭据
   ├─ steps/                           ~11,800
   │  ├─ onboarding.js                 ~185   0–4 步
   │  ├─ recording.js                  ~395   5 步 / 本地视频
   │  ├─ ai-demo.js                    ~2,310 AI 自动演示（可再拆 plan/run）
   │  ├─ shots-scripts.js              ~278   6–7 步
   │  ├─ voice.js                      ~1,190 8 步 / 录音 / 声音档案
   │  ├─ voice-engine.js               ~1,005 13 步
   │  ├─ captions.js                   ~3,620 14 步 / 时间轴 / 字幕（可再拆）
   │  ├─ final-video.js                ~685   15 步
   │  ├─ finish-plan.js                ~115   9–10 步
   │  ├─ plan-platforms.js             ~292   11 步
   │  ├─ publish.js                    ~1,650 12 步 / 发布队列
   │  └─ github-publish.js             ~335   GitHub L1 / Pages
   ├─ dashboard.js                     ~595   看板 / KPI / 反馈
   ├─ works.js                         ~445   作品 / 产品管理
   ├─ persistence.js                   ~335   本地存储 / SQLite
   └─ app.js                           ~100   新增：启动顺序
```

如果要求单文件不超过 1,500 行，可以继续细拆：

- `settings.js` → `settings/ai.js` + `settings/accounts.js`
- `ai-demo.js` → `ai-demo-plan.js` + `ai-demo-run.js`
- `voice.js` → `voice-record.js` + `voice-studio.js`
- `captions.js` → `captions-editor.js` + `captions-timeline.js` + `captions-actions.js`

细拆后文件数 +7，胶水 +约 100 行，业务逻辑不变。

### 4.2 electron（15 个文件）

```
electron/
├─ main.js                             ~230   只留 app 生命周期 + 装配
├─ app/
│  ├─ context.js                       ~60    新增：store / mainWindow / browserManager
│  └─ startup.js                       ~240   whenReady 里的初始化
├─ ipc/
│  ├─ window.js                        ~50
│  ├─ store.js                         ~95    settings / works / queue / feedback
│  ├─ credentials.js                   ~265   secrets + OAuth
│  ├─ wechat.js                        ~175
│  └─ github.js                        ~545   GitHub 发布 / Pages
├─ github/
│  ├─ stats.js                         ~715   GitHub / YouTube 统计
│  └─ meta.js                          ~215   网页元数据 / shell
├─ publish/
│  ├─ legacy.js                        ~385   pubExec + 发布窗口
│  ├─ youtube.js                       ~115
│  ├─ x.js                             ~218
│  └─ xhs.js                           ~1,730 小红书专用流程
└─ capture.js                          ~75
```

### 4.3 设计原则

1. **`index.html` 只做壳**：head、body 静态标记、`<link>`、`<script src>`。
2. **classic script + `window.RK` 命名空间**：不引入 ESM/构建工具，兼容 `file://` 和现有无构建流程。
3. **步骤注册表**：`RK.steps[step] = renderFn`，加新步骤只需新增文件 + 一行注册。
4. **`main.js` 只做组合根**：创建 `ctx`、注册各领域 IPC、创建窗口；不承载具体业务。
5. **共享上下文**：`app/context.js` 统一持有 `store` / `mainWindow` / `browserManager`，避免模块级全局变量散落。
6. **先搬迁、后优化**：拆分阶段不改业务逻辑，不顺手“清理”重复代码。

---

## 5. 新旧对比

### 5.1 总量

| 部分 | 现在 | 拆分后 | 变化 |
|---|---:|---:|---:|
| `index.html` | 17,932 行 / 958 KB | ~700 行 / 45 KB | **−17,232** |
| renderer JS | 15,918 行（内嵌） | ~16,550 行 | +632（胶水） |
| renderer CSS | 1,321 行（内嵌） | ~1,321 行 | 0 |
| `electron/main.js` | 4,756 行 / 225 KB | ~230 行 / 12 KB | **−4,526** |
| electron 新模块 | 0 | ~4,880 行 | +4,880 |
| **核心源码合计** | **22,688 行 / 1,184 KB** | **~23,680 行 / ~1,160 KB** | **+4.4% 行数，体积基本持平** |

> 只算 `index.html + electron/main.js + 新拆出的核心源码`，不含 `tests/`、`docs/`、`node_modules/`。

### 5.2 renderer 明细

| 新文件 | 主要旧行号（index.html） | 旧行数 | 新行数（约） |
|---|---|---:|---:|
| `renderer/core/state.js` | 2008–2233 | 226 | 240 |
| `renderer/core/ui.js` | 3402–4268 | 867 | 900 |
| `renderer/core/nav.js` | 4269–4398、4564–4762 | 329 | 380 |
| `renderer/core/steps.js` | 新增 | 0 | 30 |
| `renderer/core/init.js` | 17863–17925 | 63 | 80 |
| `renderer/settings/ai.js` | 2234–2631 | 398 | 410 |
| `renderer/settings/accounts.js` | 2632–3401、16926–17123 | 968 | 990 |
| `renderer/steps/onboarding.js` | 4399–4563 | 165 | 185 |
| `renderer/steps/recording.js` | 4763–5137 | 375 | 395 |
| `renderer/steps/ai-demo.js` | 5138–7413 | 2,276 | 2,310 |
| `renderer/steps/shots-scripts.js` | 7414–7671 | 258 | 278 |
| `renderer/steps/voice.js` | 7672–8832 | 1,161 | 1,190 |
| `renderer/steps/voice-engine.js` | 8833–9812 | 980 | 1,005 |
| `renderer/steps/captions.js` | 9813–13392 | 3,580 | 3,620 |
| `renderer/steps/final-video.js` | 13393–14054 | 662 | 685 |
| `renderer/steps/finish-plan.js` | 14055–14150 | 96 | 115 |
| `renderer/steps/plan-platforms.js` | 14377–14648 | 272 | 292 |
| `renderer/steps/publish.js` | 14151–14376、14964–16354 | 1,617 | 1,650 |
| `renderer/steps/github-publish.js` | 14649–14963 | 315 | 335 |
| `renderer/dashboard.js` | 16355–16925 | 571 | 595 |
| `renderer/works.js` | 17124–17548 | 425 | 445 |
| `renderer/persistence.js` | 17549–17862 | 314 | 335 |
| `renderer/app.js` | 新增 | 0 | 100 |
| **合计** | | **15,918** | **~16,550** |

### 5.3 electron 明细

| 新文件 | 主要旧行号（main.js） | 旧行数 | 新行数（约） |
|---|---|---:|---:|
| `electron/main.js` | 1–191、4716–4720 | 196 | 230 |
| `electron/app/context.js` | 新增 | 0 | 60 |
| `electron/app/startup.js` | 4490–4715 | 226 | 240 |
| `electron/ipc/window.js` | 192–225 | 34 | 50 |
| `electron/ipc/store.js` | 226–248、1304–1359 | 79 | 95 |
| `electron/ipc/credentials.js` | 941–1128、1247–1303 | 245 | 265 |
| `electron/ipc/wechat.js` | 1129–1246、4721–4756 | 154 | 175 |
| `electron/ipc/github.js` | 1360–1882 | 523 | 545 |
| `electron/github/stats.js` | 249–940 | 692 | 715 |
| `electron/github/meta.js` | 1883–2076 | 194 | 215 |
| `electron/publish/legacy.js` | 2077–2194、4189–4432 | 362 | 385 |
| `electron/publish/youtube.js` | 3897–3991 | 95 | 115 |
| `electron/publish/x.js` | 3992–4188 | 197 | 218 |
| `electron/publish/xhs.js` | 2195–3896 | 1,702 | 1,730 |
| `electron/capture.js` | 4433–4489 | 57 | 75 |
| **合计** | | **4,756** | **~5,113** |

> 以上按现有代码块边界估算，误差约 ±5%；真正搬迁时以块的实际起止为准。
> 行号是 2026-10-23 的快照，代码变动后会漂移；定位时优先用函数名（见附录 A）。

### 5.4 新增文件 / 新增代码

- 新文件约 **39 个**：21 个 renderer JS + 4 个 CSS + 14 个 electron 模块。
- 其中绝大多数是“搬迁目的地”，真正全新的逻辑约 **200 行**：
  - `renderer/core/state.js` 里的 `window.RK` 命名空间（约 30 行）；
  - `renderer/core/steps.js` 的步骤注册表（约 30 行）；
  - `renderer/app.js` 的启动顺序（约 100 行）；
  - `electron/app/context.js` 的共享上下文（约 60 行）。
- 其余约 **800–900 行**是每个文件头尾的 IIFE、导出、`register(ctx)` 胶水。

---

## 6. 代码变动明细

### 6.1 `index.html`

- 删除 `<style>...</style>`（1,321 行）→ 换成 4 个 `<link rel="stylesheet">`。
- 删除内联 `<script>...</script>`（15,918 行）→ 换成约 21 个 `<script src="renderer/...">`。
- **HTML body、class、id、内联 `onclick` 全部不动。**
- `renderer-utils/format.js` 第一阶段保持原位不动；如果以后要统一到 `renderer/core/`，单独做一次路径迁移。

### 6.2 renderer 文件：只加“头尾”

每个搬迁文件大致长这样（示例，未应用）：

```js
(function (RK) {
  'use strict';

  // 原来的一段代码，原样搬进来

  RK.steps[14] = renderCaptionsStep;   // 步骤注册
  RK.captions = { captionFinalize, captionSaveDraft };
})(window.RK);
```

- 每个文件新增约 **15–25 行**：IIFE 头、`'use strict'`、导出/注册。
- 函数名、变量名、`window.xxx = ...` 全部保持。
- 跨文件调用统一走 `RK.xxx`，避免继续增加全局变量。
- 对 HTML 内联事件：继续保留 `window.foo = foo`，不改 HTML。

### 6.3 步骤注册表（唯一建议新增的结构代码）

现在是 `renderStep` 里一大段 `if/else`。建议改成：

```js
// renderer/core/steps.js
RK.steps = {};
RK.registerStep = function (n, fn) { RK.steps[n] = fn; };

// renderer/core/nav.js
var fn = RK.steps[state.step];
if (fn) fn(ctrl);
```

以后加第 17 步，只需要**新增一个文件 + 一行注册**，不用再去几千行的 `renderStep` 里改分支。

### 6.4 `electron/main.js`

只保留：

- `ensureUserData`、`repairChromiumCacheDirs`、`createWindow`；
- `app.whenReady()` 里创建 `store`、`browserManager`；
- 依次调用 `registerWindowIpc(ctx)`、`registerGithubIpc(ctx)`……；
- `window-all-closed`。

每个拆分模块：

```js
// electron/ipc/wechat.js
module.exports = function registerWechatIpc(ctx) {
  const { ipcMain, logger, wechat } = ctx;

  // 原来的 ipcMain.handle('wechat:*', ...) 原样放这里
};
```

- 每个模块新增约 **10–20 行**：注册函数外壳、`module.exports`。
- handler 内部逻辑不动。
- 共享的 `store` / `mainWindow` / `browserManager` 统一从 `app/context.js` 取。

### 6.5 配置与测试（必须一起改）

| 位置 | 动作 | 影响 |
|---|---|---|
| `package.json` → `build.files` | 加 `"renderer/**/*"` | **不加会导致打包后白屏** |
| `package.json` → `format` | 加 `"renderer/**/*.js"` | 新文件能被格式化 |
| `eslint.config.js` | 加 `renderer/**/*.js` 浏览器脚本分组 | 否则新文件不被 lint |
| `tests/` | 约 14 个测试把 `index.html` / `main.js` 当文本扫描 | 需要改成读新文件或拼接源 |

受影响的测试（2026-10-23 观察）：

`ai-demo-next-enabled.js`、`ai-demo-voice-flow.test.js`、`ai-scroll-capture-v120.test.js`、`audit-ux.js`、`audit.js`、`cfg-nav-dom.test.js`、`fmt-check.js`、`gh-pages-publish.test.js`、`github-video-publish.test.js`、`local-video-flow.test.js`、`online-tts-no-key-boot.test.js`、`online-tts-ui-static.test.js`、`producthunt-publisher.test.js`、`github-stats.test.js`。

建议加一个 `tests/_source.js`，统一把 `renderer/**/*.js` 按加载顺序拼起来；测试里只改一行读取方式，不要每个测试手写路径。

---

## 7. 分阶段路线

| 阶段 | 内容 | `index.html` | `main.js` | 风险 |
|---|---|---:|---:|---|
| 0 | 基线：跑测试、16 步烟测、记录当前行为 | 17,932 | 4,756 | 无 |
| 1 | CSS + HTML 壳 | ~16,600 | 4,756 | 低 |
| 2 | renderer 核心 + 低耦合功能（settings / dashboard / works / persistence / github） | ~12,100 | 4,756 | 中低 |
| 3 | 16 步流程（recording / ai-demo / voice / captions / publish） | ~700 | 4,756 | 中高 |
| 4 | `main.js` IPC 拆分 | ~700 | ~230 | 中 |
| 5 | 可选：发布链路收敛（旧 `pubExec` vs BrowserManager） | ~700 | ~230 | 高，独立设计 |

说明：

- **阶段 1 只动 CSS，零 JS 风险。**
- 阶段 2 先跑通 `window.RK` 命名空间；阶段 3 才是真正的大头；阶段 4 可以独立并行。
- 阶段 5 不建议和结构整理一起做；发布链路需要单独设计。

---

## 8. 拆分前必须注意的耦合点

### 8.1 单 IIFE 作用域

15,918 行共用一个闭包。拆文件后，一个文件里的函数看不到另一个文件的局部变量。所以要么用 `window.RK` 命名空间（推荐，不需要构建），要么上 esbuild 打包。

**不要直接上原生 `<script type="module">` 加载 `file://`**：在 Electron 的 `file://` 下容易被 CORS 拦，除非改协议或打包。

### 8.2 233 个 `window.*` 和内联 `onclick`

这些名字不能改。拆分时把 `window.foo = foo` 跟着函数一起搬走，HTML 里不用动。

### 8.3 后期覆盖 / 二次赋值

这些地方顺序一变，行为就会变：

| 符号 | 位置（2026-10-23） | 说明 |
|---|---|---|
| `window.saveVoiceVersion` | 7611 / 8354 | 先包装，后被重新定义 |
| `window.reloadVoiceProfiles` | 7593 / 8476 | 先包装，后被重新定义 |
| `window.renderFlow` | 7602 包装 4564 的版本 | 只包装了 `window.renderFlow`，内部调用仍走局部 `renderFlow` |
| `fmtDur` | 4444 / 4888 | 两份定义，输出格式不同 |
| `__recState` | 7913 / 8121 | 两份声明 |
| `PLATFORM_HINT` | 2223 / 2286 | 两份声明 |
| `window._capPxpsRetry` | 11010 / 11012 | 调试/重算标记 |

**拆分时先保留原顺序，不要顺手“清理”这些覆盖。**

### 8.4 状态簇不能拆散

- `state`（2028）
- `__recState`
- `_cap*`（9802–9812）
- `__aiDemo*`（6822–6831）

每一组状态必须待在同一个文件里，否则跨文件读写会很难追。

### 8.5 测试是按文本扫描的

很多测试不是真的跑 DOM，而是 `readFileSync('index.html')` 然后正则匹配。拆分本身不会弄坏功能，但会让这些测试误报。必须先加 source helper。

### 8.6 打包清单

`electron-builder` 的 `build.files` 目前没有 `renderer/**/*`。忘了加，开发环境正常，打包后直接白屏。

---

## 9. 最小试点（建议先做这个）

如果不想一上来就拆 39 个文件，可以先做一个 **约 2,300 行** 的试点：

1. 抽 CSS（1,321 行）；
2. 新增 `renderer/core/runtime.js`（约 80 行），只暴露 `state`、`esc`、`toast`、`openModal`、`closeModal`、`api`；
3. 抽 `renderer/dashboard.js`（571 行）和 `renderer/works.js`（425 行）；
4. `index.html` 从 17,932 降到 **约 15,600**；
5. 跑现有测试 + 16 步烟测。

这个试点能验证三件事：

- `window.RK` 命名空间够不够用；
- `window.*` 会不会冲突；
- 测试改动量有多大。

验证通过，再按阶段 2/3 推进。

---

## 10. 与现有 2026-10-19 文档的关系

现有文档：

- `current-architecture.md`：2026-10-19 的架构基线。
- `refactoring-roadmap.md`：2026-10-19 的分批路线，已完成第一批（`esc` → `renderer-utils/format.js`）。
- `module-inventory.md`：模块清单与第二批候选。
- `dependency-map.md`：依赖关系与字幕核心约束。

本文档与它们的关系：

- **不替代**现有分批路线；本文档是更完整的“目标结构”。
- 现有路线图的“明确禁止事项”继续有效（不一次性重写、不改行为、不改 IPC、不升级依赖、不引入 ESM/TS/构建工具等）。
- 现有第二批（字幕纯函数抽取）与本文档的 `renderer/steps/captions.js` 目标兼容，可以作为前置步骤。
- 真正开始实施前，建议把本文档的链接补进 `refactoring-roadmap.md`，并二选一：
  - **A.** 按现有分批路线继续（保守，先纯函数，后大模块）；
  - **B.** 按本文档的阶段 1–4 推进（更系统，但一次动得多）。

---

## 11. 下次继续

### 11.1 当前状态

- **未改动任何代码。**
- 仅新增本文档。
- 工作区原本就有未提交的测试、调试 txt、fallback 视频等，不要清理。

### 11.2 恢复步骤

1. 读本文档第 0、10、11 节。
2. `git status` 确认工作区状态（不要清理未提交文件）。
3. 跑一次 `npm test`，记录基线。
4. 选择下一步：
   - **A.** 最小试点（CSS + `runtime.js` + dashboard/works）；
   - **B.** 阶段 1（只抽 CSS + HTML 壳）；
   - **C.** 先补一张 `index.html` JS 的跨块调用关系图，再定边界。

### 11.3 推荐的下一步

**先做 A（最小试点）。** 它只动约 2,300 行，能验证命名空间、`window.*` 冲突和测试改动量，风险最低。

---

## 附录 A：函数锚点（行号会漂移，优先用函数名）

| 功能块 | 起始函数 / 标记 | 2026-10-23 行号 |
|---|---|---:|
| 默认计划、state | `defaultPlan()` / `var state` | 2016 / 2028 |
| 模型厂商 | `MODEL_PROVIDERS` | 2240 |
| BYOK / 设置 | `hasApi()` | 2315 |
| GitHub 凭据 UI | `cfgGhRefreshStatus()` | 2638 |
| YouTube 凭据 UI | `cfgYtRefreshStatus()` | 2841 |
| 在线 TTS | `ONLINE_TTS` | 2885 |
| AI 文案 / 聊天 UI | `pf()` / `genCopy()` | 3433 / 3445 |
| 弹窗 / confirm | `openModal()` / `confirmModal()` | 4144 / 4184 |
| 导航 | `go()` / `STAGES` | 4215 / 4269 |
| 步骤分发 | `renderStep()` | 4595 |
| 录屏 / 本地视频 | `renderRecStage()` / `renderLocalVideoStage()` | 4765 / 5003 |
| AI 自动演示 | `aiResetFunctionMap()` / `runAiDemoScript()` | 5488 / 6482 |
| 分镜 / 脚本 | `renderShots()` / `renderScripts()` | 7416 / 7622 |
| 配音 | `renderVoice()` / `renderVoiceStudio()` | 7674 / 8618 |
| 声音引擎 | `renderVoiceEngineStep()` | 8836 |
| 字幕编辑器 | `renderCaptionsStep()` | 9813 |
| 字幕时间轴 | `renderCaptionsTimelineHeader()` | 10953 |
| 字幕素材库 | `renderCaptionsSubtitleBank()` | 11458 |
| 字幕动作 | `captionBankAdd()` / `captionFinalize()` | 12535 / 12969 |
| 成片 | `renderCaptionsPlayback()` | 13450 |
| 完成 / 计划 | `renderFinish()` / `planItem()` | 14057 / 14117 |
| 平台选择 | `renderPlatforms()` | 14413 |
| 发布 | `openRocket()` / `_runWechatPublishFlow()` | 15212 / 15951 |
| 看板 | dashboard 区块 | 16355 |
| 作品管理 | 产品管理区块 | 17124 |
| 本地持久化 | 持久化区块 | 17549 |
| 初始化 | `initWindowControls()` / `loadStored()` | 17871 / 17913 |

## 附录 B：本次讨论中明确“不做”的事

- 不重写业务逻辑。
- 不引入 React / Vue / TypeScript / ESM / 构建工具。
- 不一次性拆完所有文件。
- 不在拆分时“顺手”合并重复函数或清理覆盖逻辑。
- 不改 IPC 协议、Preload API、数据格式。
- 不动发布链路（旧 `pubExec` vs BrowserManager）——那是独立的后续任务。
- 不清空或整理用户工作区里的未提交文件。
- 不因为代码难拆就把整套实现复制到新文件里。

---

*本文档由 2026-10-23 讨论整理；如后续方案变化，请直接更新本文档或在文末追加“修订记录”。*
