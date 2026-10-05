# Changelog

本项目所有显著变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

修复「调用系统浏览器不成功」——根因已定位为 **Low 完整性令牌下 Windows 拒绝把 URL 交给浏览器**（静默假成功），并据此修掉判定逻辑与 UI 提示。

### 根因（实测结论）

Rokit 的 Electron 主进程在受限 / 沙箱上下文里拿到的是 **Low 完整性令牌**（`S-1-16-4096`）。此时：

- `shell.openExternal()` 会让 `ShellExecuteW` 返回成功，但 `msedge.exe` 被启动后**立刻退出** —— 不弹标签页、也不报错（"假成功"）。用最小 Electron 脚本复现：本机临时 HTTP 服务**收不到任何请求**，即页面从未被加载；
- 直接以独立 `--user-data-dir` 启动一个全新浏览器实例同样无效：`spawn` 无错，但浏览器进程数归零、页面依旧未被加载；
- `cmd /c start` / `rundll32` / `explorer.exe` 三种兜底策略同属受限令牌，一样无效；
- 非受限上下文可以正常弹出标签页（实测 High 完整性下 `Start-Process` 正常开标签）；
- **Low 令牌的来源已实测定位：可执行文件所在目录被打了低完整性标签。** 同一个 `whoami.exe`：放 `C:\Windows\System32` 跑是 High（`S-1-16-12288`），复制进本工程目录就变 Low（`S-1-16-4096`），复制到 `%TEMP%` 又是 High。把 Electron 整个 `dist` 复制到 `%TEMP%` 运行后，完整性恢复 **High**，且浏览器**真的加载了页面**（本机 HTTP 探针收到请求）。

**结论：客户端没有任何代码级绕行方案；把应用放到未被低完整性标记的目录（例如 `C:\Rokit`，或安装到 Program Files）运行即可恢复自动弹浏览器。**

### Fixed
- **受限上下文不再谎报成功，改走剪贴板兜底**（[electron/oauth.js](electron/oauth.js) + [index.html](index.html)）：`shell.openExternal` resolve 在 Low 完整性下并不代表浏览器真的打开了。此时强制置 `via='clipboard'` 并回传 `restricted: true`，UI 如实说明"Windows 拦截了把链接交给浏览器的动作"，并引导用户自己打开浏览器粘贴（用户从任务栏启动的浏览器是 Medium 完整性，粘贴可正常工作）
- **新增运行上下文探测模块**（[electron/platform-context.js](electron/platform-context.js)）：按完整性 SID 判定 `low / medium / high / system`，供 main.js（启动告警）与 oauth.js（决定是否兜底）共用，避免两处实现漂移
- **浏览器启动判定改用调用结果，不再拿进程数当判据**（[electron/oauth.js](electron/oauth.js)）：旧实现要求 `shell.openExternal` 调度后 1.5s 内浏览器进程数必须增长才算成功，有两个致命缺陷——①浏览器已在运行时新标签页复用已有进程，进程数不变，真开成功也被判失败；②`tasklist` 调用一旦失败（受限令牌 / PATH 不全）会静默返回 `0`，调用方无法区分「这次没测出来」和「一个浏览器都没有」，4 种策略被依次判失败。后果是 UI 误报「⚠ 浏览器启动失败，URL 已复制到剪贴板」，且 4 种策略各弹一次、重复打开多个相同标签页。现在 `shell.openExternal` resolve 即判成功，只有 reject 才降级到下一种策略
- **`countBrowserProcs()` 降级为纯日志观测**（[electron/oauth.js](electron/oauth.js)）：查询全部失败时返回 `null` 而非 `0`，从类型上杜绝「测量失败」被当成「没有浏览器」；`tasklist.exe` 改用 `%SystemRoot%\System32\` 绝对路径（main.js 的 whoami 早已这么做），并去掉只匹配英文的 `/No tasks are running/i` 判断（中文系统输出的是本地化提示行）
- **提权检测改用完整性 SID**（[electron/main.js](electron/main.js)）：原实现匹配英文 `High/Medium Mandatory Level` 字样，在非英文系统、或令牌为 Low 完整性时都匹配不到，于是恒定打印误导性的「whoami 不可用」。改为匹配 `S-1-16-4096 / 8192 / 12288 / 16384`，并对 Low 完整性（受限 / 沙箱上下文）给出明确告警，避免再去排查错误的「浏览器坏了」
- **`secrets:status` 在健康路径上必抛 `TypeError`**（[electron/main.js](electron/main.js)）：`keytar` 正常加载时 `secrets._keytarError()` 返回 `null`（secrets.js 里 `keytarLoadError` 初值即 `null`），旧写法直接读 `.message` 会抛 `Cannot read properties of null (reading 'message')`，使该 IPC 每次都失败、渲染端拿不到 API Key / GitHub PAT 的「已配置 / 未配置」状态。改为经 `keytarErrorMessage()` 做空值 + 异常双重兜底

### Tests
- 新增 `tests/oauth-browser-launch.test.js`（8 用例）：openExternal 成功则不降级且不动剪贴板 / `tasklist` 查询失败与进程数不增长均不影响判定（旧实现的两类误报回归）/ reject 才降级到 `cmd /c start` / 全部失败走剪贴板 / 剪贴板不可用返回 `browser_open_failed` / **受限（Low 完整性）上下文强制走剪贴板且不谎报成功** / 非受限上下文 `restricted` 为 false

## [0.1.5] - 2026-09-26

无边框顶栏窗口控制 IPC 加固 + 桌面端品牌资产与营销站对齐。

### Fixed (窗口控制 IPC 加固)
- **macOS `activate` 路径漏挂 `attachWindowControls`**（[electron/main.js](electron/main.js)）：原本仅在 `app.whenReady` 里调用一次，macOS Dock 点击重开新窗口后控制 IPC 仍是旧闭包，新窗口的 min/max/close 全部失效。改为在 `createWindow()` 内部挂载，保证任何路径创建窗口都能拿到当前 win 的 handler
- **`ipcMain.handle` 重复注册会推 `second handler`**（[electron/main.js](electron/main.js)）：入口 `ipcMain.removeHandler(ch)` 幂等保护，窗口 `closed` 时反注册所有控制 channel 名，避免僵尸闭包占用 channel；HMR / 单测 / 多窗口场景不再会拖溃进程
- **`window:maximize-changed` 与 `windowIsMaximized` 双轨同步竞态**（[electron/main.js](electron/main.js)）：`push()` 加 `lastIsMax` 去重；删除冗余的 `did-finish-load` 推送（渲染端已在初始化时主动查询过），避免 aria-label / icon 闪烁

### Changed (桌面端品牌资产与营销站对齐)
- **顶栏 logo 换成极简火箭 SVG**（[index.html](index.html)）：与 `web/public/favicon.svg` 统一品牌调色板（`#94D4D0→#0E7C7B` 主体 / `#0a0e14+#4DD0E1` 舱窗 / `#F472B6→#8B5CF6` 尾焰 / `#1F9C9A` 翼）
- **`assets/logo.svg` 作为统一品牌源**：从 `web/public/favicon.svg` 复制，同一资产被顶栏 logo / ICO 生成脚本共同引用，避免 3 处独立实现发散
- **`assets/icon.png` + `icon-light.png` 重新生成**（[scripts/IconRenderer.cs](scripts/IconRenderer.cs)）：1024×1024 双版本（深色 / 亮色背景），与 favicon 矢量风格一致；`build/icon.ico` 同步重新生成（多尺寸收敛）
- **PowerShell 脚本参数化**（[scripts/render-icon.ps1](scripts/render-icon.ps1)）：新增 `-CscPath` / `-Root` 参数；csc.exe 路径从硬编码改成 `-CscPath` → `%WINDIR%\Framework64\v4.0.30319` → `%ProgramFiles%\dotnet\sdk\*\Roslyn\bincore` 三级自动 fallback；编译 / 使用 $LASTEXITCODE` 判断（不再依赖 Test-Path），失败明确退出码 + 中文提示
- **WPF 资源释放修正**（[scripts/IconRenderer.cs](scripts/IconRenderer.cs)）：`RenderTargetBitmap` / `PngBitmapEncoder` / `BitmapFrame` 不实现 IDisposable（原评审基于错误假设），改用 `Render + Freeze()` 加快 GC finalizer 回收；`FileStream` 仍 `using` 包裹。`System.Windows.Shapes.Path` 与 `System.IO.Path` 的歧义以 `using Path = System.Windows.Shapes.Path;` 别名彻底解决

### Added (无障碍)
- **`.wc-btn:focus-visible` 焦点环**（[index.html](index.html)）：全局 `:focus-visible{outline:none}` 会抹掉窗口控制按钮焦点环，改为 `.wc-btn:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}`；`.wc-close` 额外覆盖 `outline-color:var(--danger)`。键盘用户 Tab 聚焦后可见反馈，符合 WCAG 2.4.7

### Web 站（2026-09-26 增量 · 跟随本版本发版）
- **版本号全站对齐 v0.1.5**：`web/package.json` version / description 同步；`Nav.astro` / `Hero.astro` / `Download.astro` `const version` 与 `Layout.astro` JSON-LD `softwareVersion` 统一为 `0.1.5`，CI 校验范围从仅 Nav.astro 扩展至全量（避免某一处漂移被漏检）
- **GitHub L1 直发正式上线**：v0.1.4 起 GitHub Release API 直发能力已上线；`Platforms.astro` 中 GitHub 标记为 L1（仅 GitHub，在 audit-ux.js 白名单内），其余 12 平台仍强制 L2（浏览器自动填表）。同步更新 `audit-ux.js` §3：原“全部平台禁用 L1”改为“仅 GitHub 可标 L1（白名单机制）”，避免 v0.1.4 能力上线后被误判
- **其他平台 ETA 修正**：`Download.astro` 中 `macOS / Linux` 从过期的 “MVP 1.5 · 约 2 个月” 改为 “MVP 2.0 · 预计 2026 Q4”；`Faq.astro` 同步；从 RoadMap 已有的 MVP 2.0 路线保持一致
- **JSON-LD / OG / Hero 版本号一致**：Download.astro 下载按钮链接与 JSON-LD `softwareVersion` 同步为 `v0.1.5`；`generate-og.mjs` 参数化版本号（默认读 `ai-launch-master/package.json`），避免未来发版 OG 图需手工改
- **Sitemap lastmod 同步**：`public/sitemap.xml` lastmod 从 2026-09-25 更新到 2026-09-26，与部署日一致；CI `web-ci.yml` 仍保留 180 天陈旧警告机制
- **Footer 年份合并**：构建年与起始年相同时不再输出 “2026–2026” 冗余连字符，仅当年起始才输出
- **v0.1.5 GitHub Release SHA256 溯源**（同步随本次发版合并·本表为官方源）：
  - NSIS:    `FD6F07195940B92C31734022B68C61F2BB72638B2D0BBB13B8DD480402C18C6C`
  - Portable: `00CEB007C168647D3AA4FFAB876450E668B8246C5D9FD03677C5976934228B48`
  - 描述说明：`Download.astro` 中 SHA256 为本次重打后复检值；用户可 `Get-FileHash .\Rokit-0.1.5-{x64,portable}.exe -Algorithm SHA256` 校验；与 GitHub Release `v0.1.5` asset `digest` 完全一致（产线下于 2026-09-26 21:30 拉取 GitHub Releases API 交叉验证）
- **营销站点 web/README.md “占位待替换项”表改写为 v0.1.6 backlog**：原 v0.1.3 部署期占位记录中“应用截图 / OG 图”已于 v0.1.4 补完，“Astro 5.x 漏洞”仍在 v0.1.5 风险豁免状态（未升级 Astro 7.x）；表重命名并仅保留 v0.1.6 backlog，避免误导后续维护者

## [0.1.4] - 2026-09-25

MVP 1.5 全量上线 + 首秀向导文案 / 渲染管线加固。

### Added (MVP 1.5 · 本机推广引擎全量上线)
- **OS 凭据管理器接入敏感凭据**（secrets.js）：API Key / GitHub PAT 从 SQLite 明文迁出，写入 Windows DPAPI（macOS Keychain / Linux libsecret）。keytar 加载失败降级为进程内存单例 + 警告日志。首次启动自动迁移现有明文 Key，迁移成功即清空 SQLite 字段
- **主推队列状态机**（queue.js）：launching → pending → operating → stable → archived 五状态 + queue_state (main/parked/queued)。定时 schedule(store) 根据状态名次 + priority DESC + launched_at ASC + 14 天稳定期过滤选主推；包底返回 least-bad 避免主推为空
- **反馈采集**（feedback-collector.js）：GitHub Issues 公开 API + V2EX 主题 RSS。内置 `decodeHtml` / `stripHtml` / `parseRss` 极简解析；增量去重依赖 `store.upsertFeedback` 的 UNIQUE(source, external_id)；单源失败不拖垮主流程
- **反馈分析**（feedback-analyzer.js）：纯规则可跑 —— 中文按字 / 英文按词 tokenize + 词典情感 + Jaccard 距离单链接聚类 + P0/P1/P2 优先级。可选 LLM 摘要（异常不阻断主流程）
- **屏幕录制**（recorder.js）：WebM session 管理（createSession / appendChunk / stopSession / discardSession）。桌面端用 `desktopCapturer` + `MediaRecorder` 录屏，主进程仅负责顺序追加 buffer 与 ffmpeg 探测。临时文件落 `%APPDATA%/Rokit/recorder/`
- **视频后处理**（video.js）：`ffmpeg-static` 转封装 / 转码 WebM → MP4（libx264 + aac + faststart） + 抽封面（`scale=1280:-2`） + 掐头去尾（`-ss/-t`）。单文件串行队列避免并发 ffmpeg 把 CPU 打满
- **GitHub L1 直发**（publisher-extensions.js）：`POST /repos/{owner}/{repo}/releases` 创建 Release。PAT 仅从 OS 凭据管理器读取，明文不入 settings JSON；SDK 错误 → 友好中文提示
- **IPC 全面升级**（main.js + preload.js）：新增 24 个 IPC 通道（secrets: 5 + queue: 1 + feedback: 5 + recorder: 6 + video: 4 + github: 3 + channels:health）；预加载脚本仅暴露最小表面，保持 `contextIsolation`
- **数据看板 BYOK 升级**：顶部"未配置 API（点此填 Key）"按 OS 凭据管理器真实状态变色；设置弹窗新增 GitHub PAT 输入字段 + “已配置/未配置”状态提示（输入框始终留空防泄露）
- **移除“1.5 规划中”提示卡**：v1.5 交付后移除 dashboard 顶部占位卡，提示改为常规文案
- **单测覆盖**（tests/*.test.js）新增 6 个测试文件 · 130 用例：secrets (12) / queue (17) / feedback-analyzer (29) / feedback-collector (26) / recorder (12) / video (7)；另修复 llm.test.js 中“缺 api_key 仍发空 Bearer”的旧行为 → 改为主动抛中文提示错

### Fixed (首秀向导文案 / 渲染管线加固)
- **首条欢迎语泄漏 HTML 字面字符**：原写法 `pushAI('你好<br>把作品交给我——<b>文案</b>')` 会过 `miniMd()` 转义，变成 `&lt;br&gt;&lt;b&gt;...` 显示给用户。改为 markdown 写法（`\n` 转 `<br>`，`**文本**` 转 `<b>`），并加注释提醒“不能直接写 HTML 标签”
- **渲染管线分化：原生 HTML 通道 `pushAIHtml`**：新增 `pushAIHtml(t)` 入栈函数，会给消息加 `html:true` 标记。`renderFlow` 按 `m.html` 分叉：标记为 `true` 的原 HTML 跳过 `miniMd` 转义。动态数据由调用方自己 `esc()` 负责转义
- **“发射成功”卡片**改用 `pushAIHtml`：依赖原生 HTML 结构（`.launch-wrap` 居中布局 + `.launch-rocket` 脉冲动画 + 嵌入 button）。原写法会被 miniMd 转义为字面源码
- **同类 bug 全面修复**（均同样原因：HTML 标签经 miniMd 转义后丢失）：
  - L3902：确认作品类型后的“打字机三点动画” `<span class="typing">` —— 改 `pushAIHtml`
  - L5119：切换作品时重放的“打字机三点动画” —— 消息对象加 `html:true`
  - L3844：填入 GitHub 链接后的“抓取结果卡片” `<div class="grab-card">` —— 改 `pushAIHtml`
- **XSS 修复**：两处 AI 消息拼接用户可控的 `w.name` 作品名时未 `esc()`，恶意作品名（如含 `<script>`）可注入 HTML —— L5100、L5190 两处补 `esc(w.name)`
- **单测覆盖**新增 `tests/render-flow.test.js` · 28 用例：`miniMd` 转义 / markdown 转换（11）、`pushAI` / `pushAIHtml` 入栈语义（3）、`render` 分叉渲染（6）、回归保护（5：欢迎语修复前后、发射成功、打字机、抓取卡片）、`esc` 基础（3）。测试直接从 `index.html` 提取函数体，零新依赖（不引 happy-dom / jsdom）

### Added (BYOK 说明补强 · 同步随本次发版合并)
- **推广渠道 BYOK 说明补强**（UX 改进，避免用户晕菜）：
  - 推广渠道 tab 顶部新增「本地优先 + BYOK」常驻说明卡
  - 「渠道说明」面板补入 3 条常见疑问（为什么不填账号 / 登录态存哪 / 换电脑怎么办）
  - 编辑内置渠道时 `chKindHint` 统一显示 BYOK 解释（不存你的账号密码）
  - 「🚀 火箭发送」弹窗内插入发布浏览器 + 登录态说明
  - 新增 [docs/channels-faq.md](../docs/channels-faq.md)（8 个常见问题答疑）
  - `PRIVACY.md` 增补「一点五、BYOK 原则」章节
- **推广渠道开关启用态变色**：启用态（●）背景改为绿色 `primary-soft` + `primary-dark` 描边 + 阴影环；停用态保持 `muted` 灰色。区分更明显，并加 `aria-pressed` 无障碍属性。

### Planned (MVP 2.0 · 后续推进)
- 数据导出 / 导入
- Remotion 服务端渲染拆条 / 成片
- 13 平台官方统计 API 接入数据看板
- i18n 多语言
- macOS / Linux 打包

## [0.1.3] - 2026-09-07

测试覆盖补强。

### Added
- `tests/logger.test.js`（17 用例）：logger 模块单元测试 —— init 幂等 / 4 级别输出分流（debug + info 走 stdout，warn + error 走 stderr）/ 时间戳格式 / extra 序列化（对象 / 字符串 / falsy）/ 单文件 1MB rotate 滚动（保留 3 个备份，.3 被淘汰）/ 全局异常兜底（uncaughtException + unhandledRejection）
- `tests/store-json.test.js`（28 用例）：Store 层 JSON 兜底模式单元测试（通过 `Module._load` 钩子拦截 `node:sqlite` 加载）—— settings / works / pubs / channels CRUD + 级联删除 + 损坏 JSON 文件静默回退 + 进程重启后持久化往返 + pretty-print 格式校验

### Changed
- `tests/publishers.test.js`：新增 101 行测试用例 —— 重点覆盖 GitHub 适配器 `launch()` 在 URL 带 query / fragment / http / www 子域 / 非 GitHub 域名等边界情况下的行为一致性；并补充 payload 序列化对控制字符 / 反斜杠 / HTML 标签 / 空对象 / 空数组的鲁棒性

### Tests
- 单测用例数：50 → **135**（6 个测试文件全部通过，`npm run lint` 0 error）

### Web 站（2026-09-25 部署期补充 → 2026-09-25 晚补完）
**部署状态**：v0.1.3 首站已上 Vercel（[rokit.vercel.app](https://rokit.vercel.app)）。

**部署期主动保留、后已补完**（原 v0.1.3 占位项状态变更）：
- ~~仓库 URL `github.com/ProClips/Rokit`~~ → **已替换为真实仓库 `github.com/MatuX-ai/Rokit`**：同步更新 `Nav.astro` / `Hero.astro` / `Download.astro` / `Footer.astro` 共 8 处 URL，GitHub Release `v0.1.3` 已创建并发布两个资产（NSIS + Portable）
- 应用截图 `public/screenshots/wflow.svg` + `dashboard.svg` —— v0.1.3 采用 SVG 加 “占位示意 · PLACEHOLDER” 鲜明水印，加底部说明 “v0.1.3 占位示意图（非真实截图）· 计划 v0.1.4 替换”；避免上线后被误以为真实截图
- `public/sitemap.xml` `lastmod=2026-09-25`（同步部署日）
- **Astro 5.x critical XSS/SSRF 漏洞**：当前已知 9 条 critical（GHSA-j687-52p2-xcff 等），静态产物不可远程利用，已接受风险豁免上线，纳入 v0.1.4 升级 Astro 7.x backlog

**2026-09-25 晚补完详情**：
- `npm run dist:win` 构建产物（electron-builder 25.1.8 + electron 36.9.5 + Node 22）：`Rokit-0.1.3-x64.exe` (108 MB) + `Rokit-0.1.3-portable.exe` (108 MB)
- `git tag -a v0.1.3` 已推送到 `origin`
- `gh release create v0.1.3` 已发布，两个二进制均含真实 SHA256：
  - NSIS:     `1800DA600D940A4EB17C1EEB2D38B4CF68A68B518EEBEB457FC92C14F13292C9`
  - Portable: `E40D2FF2F869317AB4E7605CB20047F37571BC8A80979D792FB0D976F67A08A7`
- `Download.astro` 的 nsisSha256 / portableSha256 常量已同步更新为真实值（替换原 v0.1.3 部署期硬编码占位）
- 营销站与真实 GitHub 仓库 / Release 完全打通，下次部署（v0.1.4 增量）即生效

**严格与桌面端版本对齐**：web `Nav.astro` / `Hero.astro` / `Download.astro` 中 `version='0.1.3'` 与本仓 `package.json` 一致，JSON-LD `softwareVersion` 同步。

## [0.1.2] - 2026-09-07

设置弹窗 z-index 冲突修复 + 安装包重打。

### Fixed
- 模型选择弹窗与设置弹窗同时唤起时偶发层叠错乱（z-index 冲突修复，`fix(electron): 模型选择弹窗 z-index 与设置弹窗冲突`）

## [0.1.1] - 2026-09-07

交付前 UX 审计 + 假功能 / 假数据 / 误导文案专项修复。

### Changed
- **数据看板**：移除 4 项硬编码 demo KPI（12,480 / 342 / 156 / 92%），改为绑定本机会话真实计数（总发布、被启用渠道、首发作品、最近发布）；渠道条形图与里程碑报喜改为读 `state.pubByPlatform` / `state.milestones`，无数据时显示空态
- **示例作品**：4 个示例作品（便签天气 / 校园课表助手 / 像素猫小游戏 / 单词卡速记）加「示例」角标；**不再写入 SQLite**；点击弹 toast「这是示例作品，不可直接首秀」；`persistCurrentWork` 强制拦截 `sample_` 前缀
- **智能拆条 / 合成成片**：所有按钮加「DEMO」角标 + 黄色提示横条 + 完成后 toast 标注「拆条 / 成片为模拟数据 · 正式版由服务端 Remotion 渲染」
- **L1/L2 命名**：13 平台全部按真实能力修正为 L2（AI 备料 + 浏览器自动填表）；ph / juejin / facebook / youtube 4 个原本 `auto:true` 的平台按实际依赖改为 `auto:false` + `manualReason`
- **Web 站文案**：「数据看板」徽章从「已上线」改为「MVP 1.5」；「15 分钟搞定」改为「一条龙搞定」；GitHub chip 从 L1 直发改 L2；首秀耗时从 15 分钟上调为「1 小时 · 熟练后更快」
- **Web 站订阅表单**：彻底移除，改为 GitHub Watch 引导（不再假装能"订阅"）
- **Web 站截图区**：从 CSS 画的伪截图改为 2 张真实 UI 占位 SVG（v0.1.2 替换为 PNG）
- **审计脚本**：`tests/audit.js` 移除强制导航顺序断言；新增 `tests/audit-ux.js` 守门"营销文案与代码能力一致"

### Fixed
- `index.html` 移除 4 条写死的里程碑报喜和 6 条假渠道条形图
- `index.html` 示例作品 `star/dl/play` 从伪造数据归零
- `publishers.js` 误导性 `auto:true` 标注
- `audit.js` 不再强制错误的"首秀→数据看板→推广渠道→我的作品"DOM 顺序
- 桌面端首次启动不再向 `%APPDATA%/Rokit/ai-launch-master.db` 写入示例作品
- Web 站底部版权年份从 2024 改为 2026

### Known Limitations（仍然存在）
- 智能拆条与合成成片为 demo 流程（v0.1.1 不包含 Remotion 服务端）
- 13 平台 L1 直发（API 直发）尚未实现
- 应用未做代码签名，Windows 首次启动会触发 SmartScreen 拦截

## [0.1.0] - 2026-09-05

MVP 1.0 首发。本版本在原 `ai-launch-master` 原型基础上完成上线前加固。

### Added
- 桌面端 Electron 36 壳（内置 Node 22 + `node:sqlite`）
- BYOK 模型接入：兼容 OpenAI Chat Completions 协议（DeepSeek / OpenAI / Ollama / 通义 / LM Studio 等）
- 单文件产品界面 `index.html`（首秀向导 · 数据看板 · 我的作品）
- SQLite 本地存储（`%APPDATA%/Rokit/ai-launch-master.db`，WAL 模式）
- JSON 文件兜底（当 SQLite 不可用时降级）
- 13 个平台自动 / 半自动发布适配器（GitHub / PH / V2EX / 掘金 / X / Facebook / YouTube / 即刻 / B站 / 小红书 / 抖音 / 知乎 / 微信公众号）
- L2 跳转发布（生成文案 + 复制 + 打开平台）
- 内置发布浏览器持久化分区（`persist:pub`，登录态落盘）
- 历史版本目录迁移（`AI推广大师` / `推广火箭` → `Rokit`）
- LICENSE（MIT）、CHANGELOG、隐私政策

### Security
- 渲染进程开启 `contextIsolation`，禁用 `nodeIntegration`
- 所有 IPC 走 `contextBridge`，仅暴露最小 API 表面
- `shell.openExternal` 强制白名单（仅 http/https）
- API Key 仅存本机 SQLite，明文存储（用户自负；如需加密存储见 1.5 路线图）

### Known Limitations
- 智能拆条 + 合成成片为 demo 流程（v0.1.1 不含 Remotion 服务端，正式版规划在 MVP 1.5）
- L1 直发（GitHub OAuth / 平台开放 API）尚未实现；当前 13 平台均为 L2（浏览器自动填表），自动发布成功后最后一步需用户在发布窗口点击"发布"完成提交
- 应用未做代码签名，Windows 首次启动会触发 SmartScreen 拦截
- `node:sqlite` 为 Electron 36 新特性，< 36 版本会回退 JSON 兜底
