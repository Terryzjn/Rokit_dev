# 贡献指南 · Contributing to Rokit

感谢你有兴趣让 Rokit 变得更好！🎉
Rokit 是一款**纯本地、零账号、无云端**的桌面应用。我们特别欢迎以下几类贡献：

- 🐛 反馈 Bug、复现路径
- 💡 提出产品建议与新平台适配
- 🔧 适配新的发布平台 / 修复现有平台失效的自动填表脚本
- 🌐 翻译文档与界面文案
- 📖 完善产品方案、设计文档
- 🎨 设计图标、动效、录屏引导脚本

---

## 一、行为准则

参与本项目即视为同意以下原则：

- **尊重**：对事不对人；接受多元背景的贡献者。
- **本地优先**：不要提议增加需要云端账号、需上传数据的功能。
- **隐私敏感**：默认零遥测；任何新增网络请求必须在 PR 描述中显式说明。
- **安全敏感**：任何涉及 IPC、`shell.openExternal`、录屏/麦克风权限的改动都需要额外 review。

---

## 二、提 Issue

### 2.1 反馈 Bug

请包含：

- 系统版本（Windows 10 / 11 + 构建号）、Electron 版本、Rokit 版本
- 复现步骤（截图 / 录屏更佳）
- 预期行为 vs 实际行为
- 应用日志：`%APPDATA%\Rokit\logs\rokit.log`
- 如可能，附 SQLite 库文件（`%APPDATA%\Rokit\ai-launch-master.db`，脱敏后）

### 2.2 提建议

建议模板：

- 你在做什么？
- 你期望 Rokit 帮你做什么？
- 你尝试过哪些替代方案？各自的痛点是什么？

避免「我觉得加一个 XX 功能挺好」这类无场景描述。

### 2.3 适配新平台

告诉我们：

- 平台名 + 发布页 URL
- 平台是否提供官方发布 API（OAuth / Token 方式）？如果提供，请给出开发者文档链接
- 平台登录态要求（手机 / 邮箱 / 第三方）
- 你已经尝试过的填表字段或自动化方案

---

## 三、提 Pull Request

### 3.1 开发流程

```bash
# 1. Fork 并克隆
git clone git@github.com:<你的账号>/Rokit.git
cd Rokit/ai-launch-master

# 2. 安装依赖
npm install

# 3. 启动开发态
npm start

# 4. 修改代码（建议每改一个文件就 npm run lint + npm test）

# 5. 提交（建议中文 / 英文 commit msg 均可，但需描述清楚做了什么）
git commit -m "feat(github): 增加 release draft 支持"

# 6. 推送并发起 PR
git push origin feature/xxx
```

### 3.2 分支约定

| 分支类型 | 命名 | 说明 |
|---|---|---|
| 功能分支 | `feature/<简述>` 或 `feat/<简述>` | 新增能力、平台适配 |
| 修复分支 | `fix/<简述>` 或 `bugfix/<简述>` | Bug 修复 |
| 文档分支 | `docs/<简述>` | 仅文档变更 |
| 重构分支 | `refactor/<简述>` | 不改行为的代码重构 |

PR 目标分支：**`main`**

### 3.3 Commit 规范

参考 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(scope): 新增能力简述
fix(scope): 修复问题简述
docs(scope): 文档变更简述
refactor(scope): 重构简述
test(scope): 测试变更简述
chore(scope): 构建/工具链变更简述
```

允许的 scope：`store` / `llm` / `publishers` / `ui` / `main` / `preload` / `docs` / `release` 等。

### 3.4 PR 自检清单

提 PR 前请确认：

- [ ] `npm run lint` 通过
- [ ] `npm test` 全部通过（50 个用例）
- [ ] 新增功能附带单元测试（`tests/`）
- [ ] 修改了 `electron/publishers.js` 的，附上手动验证截图
- [ ] 修改了 schema（`electron/store.js`）的，**追加迁移条目**而非改旧迁移
- [ ] 修改了网络请求的，PR 描述中说明发往哪里、携带什么
- [ ] 修改了权限 / IPC 暴露面的，附安全影响评估
- [ ] 文档同步更新（README / CHANGELOG / PRIVACY）

### 3.5 平台适配 PR 特别说明

修改 `electron/publishers.js` 时请：

1. 优先用 Chrome DevTools 录制发布页表单的 selector（不要硬编码 `[0]` 这类脆弱下标）
2. 注入脚本必须捕获异常并返回 `{status: 'manual', error: '...'}`，不要让 Promise reject
3. 等待元素出现使用通用的 `waitFor(sel, ms)`，不要写死 setTimeout
4. 登录态用内置发布浏览器（`session.fromPartition('persist:pub')`），不要另起 session
5. **平台条款**：禁止绕过平台反爬 / 风控；如平台禁止自动化，必须 `status: 'manual'` 兜底

---

## 四、目录结构与代码组织

```
ai-launch-master/
├── index.html                # 渲染层：所有 UI + 交互
├── electron/
│   ├── main.js               # 主进程：BrowserWindow + IPC handlers
│   ├── preload.js            # contextBridge 暴露的最小 window.api
│   ├── store.js              # SQLite（+ JSON 兜底）+ schema 迁移
│   ├── llm.js                # BYOK 接入（OpenAI 兼容 Chat Completions）
│   ├── publishers.js         # 13 平台自动/半自动发布适配器
│   └── logger.js             # 日志（落盘 + 全局异常兜底）
└── tests/                    # vitest 单元测试
```

### 4.1 IPC 契约

`preload.js` 暴露的 `window.api` 是**唯一**渲染层可调用的能力。新增 IPC 时：

1. 先在 `preload.js` 中加 `ipcRenderer.invoke` 包装
2. 再在 `main.js` 加 `ipcMain.handle` 实现
3. 在 `tests/` 中为关键逻辑（URL 拼接、参数校验、错误处理）加测试
4. **禁止**在渲染层直接 `require('electron')`

### 4.2 SQLite 迁移

修改 schema 时，**永远不要改旧迁移**。在 `migrations` 数组追加新条目：

```js
{
  version: 2,
  up: function (db) {
    db.exec('ALTER TABLE works ADD COLUMN cover_url TEXT');
  }
}
```

并把文件顶部 `CURRENT_VERSION` 改成 2。`store.test.js` 中需新增迁移幂等性测试。

### 4.3 命名与代码风格

- JS：`eslint.config.js` 规则；提交前 `npm run lint:fix`
- 缩进：2 空格（项目统一）
- 命名：camelCase（变量/函数）、PascalCase（类）、UPPER_SNAKE（常量）
- 文件名：kebab-case（除类文件外）
- 中文注释：允许；模块顶部用一行中文简述用途

---

## 五、安全披露

发现安全问题时，请**不要**直接提公开 Issue。
请通过 GitHub Security Advisories 私密提交（[链接](https://github.com/MatuX-ai/Rokit/security/advisories/new)），我们会在 48 小时内回复。

常见安全敏感区域：

- IPC handler（`electron/main.js`）
- `shell.openExternal` 白名单
- 录屏 / 麦克风权限申请路径
- API Key 存储与日志脱敏

---

## 六、协议

向本仓库贡献代码即视为同意以 [MIT](ai-launch-master/LICENSE) 协议授权。
贡献者保留署名权（在 `AUTHORS` 或 commit history 中）。

---

## 七、致谢

每一位贡献者都在让独立开发者的「第一个作品」更容易被看见。
谢谢！🌱