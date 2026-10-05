# Rokit · 开源桌面端 MVP

给独立开发者 / 学生开发者的「作品首发发射台」：登记作品 → AI 一键生成全套推广物料 → 引导分平台发布 → 采集反馈 → 生成迭代建议。

**技术形态（PRD v1.5 定稿）：开源软件 · 桌面端应用 · 本地 SQLite · BYOK（用户自带 API Key / PAT）· OS 凭据管理器加密存储**

## 快速开始

```bash
npm install     # 首次安装依赖
npm start       # 启动桌面应用
```

> 需要 Node.js 18+。Electron 二进制通过国内镜像下载（见下方「安装说明」）。

### 首次使用

1. 启动后，点右上角 **⚙** 打开「模型设置（BYOK）」
2. 填写 Base URL / API Key / 模型名（如 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`；本地 Ollama：`http://127.0.0.1:11434/v1` + `llama3`）
3. 点「测试连接」验证，保存
4. （可选）填入 GitHub PAT（需 `repo` scope），启用 L1 直发能力
5. 走一遍首秀向导：作品登记 → 诊断 → 录屏 → 拆条 → 计划 → 选平台 → 生成文案（此时会真实调用你的模型）→ 发布队列 → 发射

未配置 Key 时，文案生成会被主进程拦截并抛中文提示错，需先填好 Key。

## v1.5 新能力（已上线）

- **OS 凭据管理器**接入敏感凭据：API Key / GitHub PAT 从 SQLite 明文迁出，写入 Windows DPAPI（macOS Keychain / Linux libsecret）。keytar 加载失败时降级为内存单例 + 警告日志
- **主推队列状态机**：launching → pending → operating → stable → archived 五状态 + queue_state (main/parked/queued)，按 priority DESC + launched_at ASC 自动选主推
- **反馈采集 + AI 分析**：GitHub Issues / V2EX RSS 双源采集，词典情感 + Jaccard 聚类 + P0/P1/P2 优先级（可选 LLM 摘要）
- **屏幕录制 + 视频后处理**：WebM session 管理 → ffmpeg-static 转码 MP4（libx264 + aac + faststart） + 抽封面 + 掐头去尾
- **GitHub L1 直发**：在设置中填入 GitHub PAT 后，推广页可一键调用 `POST /repos/{owner}/{repo}/releases` 创建 Release
- **24 个新 IPC 通道**：secrets:5 + queue:1 + feedback:5 + recorder:6 + video:4 + github:3 + channels:health
- **数据看板 BYOK 强引导**：顶部 chip 按 OS 凭据真实状态变色（未配置时明确提示「点此填 Key」）

> 完整迁移说明：[docs/MIGRATION.md](docs/MIGRATION.md)

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 36（内置 Node 22，自带 `node:sqlite`，零原生编译依赖） |
| UI | 单文件 HTML/JS/CSS（`index.html`，交互原型直接演进为产品界面） |
| 本地存储 | SQLite（`node:sqlite`），WAL 模式；作品 / 发布记录 / 反馈 / 设置全部本地 |
| AI 接入 | BYOK：OpenAI 兼容 Chat Completions（Base URL / Key / 模型名可配）。Key 仅存本机 OS 凭据管理器 |
| 凭据存储 | keytar（Windows DPAPI / macOS Keychain / Linux libsecret）；keytar 不可用时降级为进程内存单例 |
| 平台发布 | L1 GitHub Release API（需 PAT）/ L2 深链 + 剪贴板跳转（13 平台） |
| 录屏 / 成片 | renderer MediaRecorder WebM → main ffmpeg-static 转码 MP4 + 抽封面 + 掐头去尾 |

## 目录结构

```
ai-launch-master/
├── index.html            # 产品界面（首秀向导 / 数据看板 / 我的作品）
├── electron/
│   ├── main.js           # 主进程：窗口 + IPC + 错误兜底 + 启动调度（queue/secret 迁移）
│   ├── preload.js        # 安全桥接（contextBridge → window.api）；v1.5 暴露 24 个新通道
│   ├── store.js          # 本地存储层（SQLite schema v3 + JSON 兜底）
│   ├── llm.js            # BYOK LLM 接入（从 secrets.getApiKey 读 Key）
│   ├── secrets.js        # OS 凭据管理器封装（keytar） + 明文迁移
│   ├── queue.js          # 主推队列状态机（pickMain + schedule）
│   ├── feedback-collector.js  # GitHub Issues / V2EX RSS 双源采集
│   ├── feedback-analyzer.js   # 词典情感 + Jaccard 聚类 + LLM 摘要
│   ├── recorder.js       # WebM session 管理 + ffmpeg 探测
│   ├── video.js          # ffmpeg-static 转码 / 抽封面 / 掐头去尾（串行队列）
│   ├── publisher-extensions.js  # GitHub Release L1 直发 + 扩展适配器接口
│   ├── publishers.js     # 13 个平台发布适配器
│   └── logger.js         # 极简日志（落盘到 userData/logs/）
├── tests/                # vitest 单元测试（store / llm / publishers）
├── build/                # electron-builder 资源（icon.ico 需自备）
├── LICENSE               # MIT 许可
├── CHANGELOG.md          # 版本变更记录
├── PRIVACY.md            # 隐私政策
├── eslint.config.js      # ESLint flat config
├── vitest.config.js      # vitest 配置
└── package.json          # 入口 + 脚本 + electron-builder 配置
```

## 架构要点

- **零账号 / 无云端**：所有数据存本机 SQLite（`%APPDATA%/Rokit/ai-launch-master.db`），不设账号、不做云同步
- **BYOK 接入**：与 DeepSeek Harness 同思路——用户自带 Key，本地直连任意 OpenAI 兼容端点
- **浏览器降级**：直接双击打开 `index.html` 也可用（演示模式，无 window.api，不发起真实请求、不持久化）
- **schema 演进**：数据库迁移走 `PRAGMA user_version` + 版本化迁移列表，后续字段变更可向后兼容

## 开发命令

```bash
npm start              # 启动 Electron 应用（开发态）
npm run lint           # 运行 ESLint 检查
npm run lint:fix       # 自动修复可修 lint 问题
npm test               # 运行 vitest 单元测试（一次性）
npm run test:watch     # vitest 监听模式（开发循环）
npm run format         # Prettier 格式化
```

## 打包发布

```bash
npm run bump          # 仅自增板号（0.1.0 -> 0.1.1 ...），不打包
npm run pack          # 自增板号 + 打 Windows 本地安装包（NSIS + Portable）
npm run pack:portable # 自增板号 + 仅打绿色版（Portable）
npm run dist:win      # 不自增板号，仅打 Windows 安装包
```

产物输出到 **项目根 `RELEASE/`** 目录（即 `../RELEASE`，相对 `ai-launch-master/`）。

> **板号自增规则**（写在 `scripts/bump-version.js`，16 个单元测试覆盖）：
> - 起始版本号：`0.1.0`（语义化版本 MAJOR.MINOR.PATCH）
> - 每次打包：尾数 PATCH +1
> - PATCH 上限为两位数；一旦下一步会超过两位数（≥100），立即进位到 MINOR（前一位），PATCH 归零；如果 MINOR 也超过两位数则继续进 MAJOR。
> - 例：`0.1.0 → 0.1.1 → … → 0.1.99 → 0.2.0 → …`

> **首次打包注意**：
> - Windows 上需先准备 `build/icon.ico`（多尺寸 PNG 转 ICO，详见 `build/README.md`）
> - electron-builder 会从 GitHub 下载 Electron 二进制（~100MB），国内网络请设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> - 当前未做代码签名，Win 上首次启动会触发 SmartScreen 拦截（用户点「仍要运行」即可）

## 测试覆盖

`tests/` 下 12 个测试文件，238 个用例覆盖核心不变量：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/store.test.js` | 24 | settings / works / pubs / channels CRUD + 级联删除 + schema 迁移幂等 + 损坏 JSON 兑底 |
| `tests/store-json.test.js` | 28 | Store JSON 兑底模式全量兑底（通过 `Module._load` 拦截 `node:sqlite`） |
| `tests/llm.test.js` | 11 | URL 拼接 / HTTP 错误映射 / AbortController 超时 / 缺 Key 拦截 |
| `tests/publishers.test.js` | 39 | 13 平台注入脚本合法性 + launch URL + payload 序列化鲁棒性 |
| `tests/secrets.test.js` | 12 | keytar 封装（set/get/delete） + API Key/PAT 专属接口 + 明文迁移 + 降级路径 |
| `tests/queue.test.js` | 17 | pickMain 五状态优先级 + priority DESC + launched_at ASC + stable 14 天过滤 + schedule 写回 |
| `tests/feedback-analyzer.test.js` | 29 | tokenize / classify / sentiment / Jaccard / clusterItems / priorityOf / analyzeForWork |
| `tests/feedback-collector.test.js` | 26 | decodeHtml / stripHtml / parseRss / ghRepoFromWork / v2exTopicId / collectForWork 降级 |
| `tests/recorder.test.js` | 12 | WebM session CRUD + finalized/error 状态 + probeDurationMs |
| `tests/video.test.js` | 7 | ffmpeg 可用性 + 输入校验 + trim 参数 + processRecording 降级 |
| `tests/logger.test.js` | 17 | init 幂等 + 4 级输出分流 + rotate（保留 3 备份） + 全局异常兜底 |
| `tests/bump-version.test.js` | 16 | CLI 自动板号 + 00/99 进位边界 + --check 只读模式 |

运行 `npm test` 应当看到 `Test Files 12 passed (12)` / `Tests 238 passed`。

## 平台发布深度（当前实现）

- **L2 跳转**（已实现）：为 13 个平台生成专属文案 → 复制全文 → 「打开平台」走系统浏览器跳转到发布页粘贴
- **L1 直发**（v1.5 已上线）：GitHub Release API 本地 OAuth（PAT 仅存 OS 凭据管理器）
- **L3 RPA**（兑底）：留给自动化能力不足的平台

## 安全 / 隐私

详见 [PRIVACY.md](PRIVACY.md)。要点：
- **v1.5 起**：API Key / GitHub PAT 仅存本机 **OS 凭据管理器**（Windows DPAPI / macOS Keychain / Linux libsecret）；keytar 不可用时降级为进程内存单例。SQLite 不再保存明文
- 不收集遥测、不上报崩溃
- 录屏 / 麦克风权限每次用户主动触发，未授权不录制
- 第三方资源仅飞书字体（CDN）与 BYOK 模型端点 + GitHub Releases API
- 完整迁移说明：[docs/MIGRATION.md](docs/MIGRATION.md)

## 协议

[MIT](LICENSE) · Copyright © 2026 ProClips+

## 安装说明（国内网络）

Electron 二进制默认从 GitHub 下载较慢，建议用镜像：

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

## 路线图（详见 docs/Rokit-产品方案.html v1.5）

- **MVP 1.0**（已交付）：桌面壳 + BYOK + 对话向导 + 本地 SQLite + 多平台文案生成 + L2 跳转发布 + 发布队列回填
- **MVP 1.5**（v1.5 已交付，详见 CHANGELOG）：OS 凭据管理器接入 + 主推队列状态机 + 反馈采集 + AI 分析 + 屏幕录制 + 视频后处理（ffmpeg）+ GitHub L1 直发 + 数据看板 BYOK 强引导 + 12 个测试文件 238 个单测
- **MVP 2.0**（后续推进）：Remotion 服务端渲染拆条 / 成片 + 13 平台官方统计 API 接入数据看板 + i18n 多语言 + macOS / Linux 打包
