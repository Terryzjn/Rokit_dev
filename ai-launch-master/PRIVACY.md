# 隐私政策 / Privacy Policy

最后更新：2026-09-25 · 适用于 Rokit v1.5（桌面端）

---

## 一、数据本地化承诺

Rokit 是**完全本地运行**的开源桌面应用：

- ❌ **没有任何云端账号系统**
- ❌ **不收集任何遥测 / 崩溃上报 / 使用统计**
- ❌ **不上传你的作品信息、文案、API Key、录屏文件、GitHub PAT**
- ✅ 所有数据存于你本机的 SQLite 中（路径见下方「数据存储」）
- ✅ 敏感凭据（API Key / GitHub PAT）自 v1.5 起存于**操作系统原生凭据管理器**（Windows Credential Manager via DPAPI / macOS Keychain / Linux libsecret）

你可以随时通过删除 `%APPDATA%/Rokit/` 目录来彻底擦除所有数据。

## 一点五、BYOK 原则（Bring Your Own Login）

Rokit 在推广渠道场景采用 **BYOK（Bring Your Own Login，自带登录态）** 原则：

- 13 个内置平台（GitHub / PH / V2EX / 掘金 / X / Facebook / 抖音 / 小红书 / B站 / 即刻 / 知乎 / 公众号 / YouTube）的发布页与自动填表脚本都**写死在程序里**（见 `electron/publishers.js`）。
- Rokit **不要求、不存储**你在这些平台的账号密码。你需要在 Rokit 内嵌的「发布浏览器」（Electron 嵌入的 Chromium 实例，`persist:pub` 分区）里手动登录一次。
- 登录态仅保存在本机：`%APPDATA%/Rokit/Partitions/pub/`，由 Chromium **加密**保存。
- Rokit 主进程**不会**读取 / 转发 / 上传这些 Cookie。
- 自定义渠道的 Webhook URL / API Key 同样仅存本机 SQLite，**仅**用于 Rokit 把文案以 POST JSON 推给你自己的服务（企业微信 / 钉钉 / 飞书机器人 / Discord / 自建 API 等）。

> 这不是妥协，是有意为之：
> 1. 账号不存本机 → 泄露面降低到你电脑磁盘加密 / 本身
> 2. 真实浏览器上下文 → 不容易被平台风控识别为机器人
> 3. 国内平台多数不开放公开发布 API → 浏览器方案是唯一可行路径
>
> 详细答疑见 [docs/channels-faq.md](../docs/channels-faq.md)。

## 二、数据存储

| 数据类型 | 存储位置 | 加密 |
|---|---|---|
| **API Key（BYOK）** | **OS 凭据管理器**（v1.5 起；v0.x 退路为 SQLite 明文） | **Windows DPAPI / macOS Keychain / Linux libsecret** |
| **GitHub PAT**（可选） | **OS 凭据管理器**（v1.5 起） | **同上** |
| 作品信息 | `%APPDATA%/Rokit/ai-launch-master.db` 表 `works` | 明文 |
| 发布记录 | 同上，表 `pubs` | 明文 |
| 反馈原始数据 | 同上，表 `feedback`（v1.5 新增） | 明文 |
| 反馈聚类 | 同上，表 `feedback_clusters`（v1.5 新增） | 明文 |
| 推广渠道配置 | 同上，表 `channels` | webhook / api_key 字段明文（仅本机使用） |
| 录制文件 | `%APPDATA%/Rokit/recorder/*.webm`（临时）+ `%APPDATA%/Rokit/video/{mp4,thumbs,trim}/`（转码后） | 明文（仅本地） |
| 自动发布浏览器登录态 | `%APPDATA%/Rokit/Partitions/pub/` | 浏览器标准 Cookies 加密 |
| 应用日志 | `%APPDATA%/Rokit/logs/rokit.log` | 明文 |

> Windows 默认 `%APPDATA%` 为 `C:\Users\<你>\AppData\Roaming\`。
>
> **v1.5 迁移说明**：升级后首次启动会自动把 SQLite 中的明文 API Key 写入凭据管理器，然后清空 SQLite 字段。卸载时建议手动删除 `%APPDATA%/Rokit/` 目录以彻底清除；如要连同凭据一起删，Windows 可在「凭据管理器 → Windows 凭据」中删除以 `Rokit` 开头的条目。详细：[docs/MIGRATION.md](../docs/MIGRATION.md)。

## 三、网络请求

应用主动发起的网络请求**仅限以下场景**，全部由用户操作触发：

1. **BYOK 模型调用**：用户配置 Base URL 后，每次生成文案时向该 URL 发送 `POST /chat/completions`。请求体仅含作品名 / 介绍 / 用户提示词，**不携带用户身份信息**。
2. **抓取作品信息**：用户输入 GitHub / 普通网址后，向 `api.github.com` 或该网址发送一次 `GET` 请求以读取公开仓库元数据。
3. **反馈采集（v1.5）**：用户点击「采集反馈」时，向 `api.github.com/repos/{owner}/{repo}/issues` 与 `v2ex.com/feed/topic/{id}.xml` 发送公开查询。
4. **GitHub L1 直发（v1.5）**：用户在设置中填入 GitHub PAT 后，点击「创建 Release」时向 `api.github.com/repos/{owner}/{repo}/releases` 发送 `POST`。请求携带 PAT，**仅存本机凭据管理器，不上传到任何其他服务器**。
5. **打开第三方平台**：用户在「发布队列」点击「打开平台」时，调用系统默认浏览器打开对应平台发布页。

应用主进程**不会**主动向任何地址上报任何数据。

## 四、媒体录制权限

应用使用浏览器标准的 `getDisplayMedia` / `getUserMedia` API：

- 录屏：用户每次点击「开始录屏」时，操作系统会弹出授权对话框，**未经授权不会录制任何内容**。
- 麦克风：配音环节需要麦克风权限，仅在用户点击「开始配音」时申请。
- 录制的 WebM 视频**仅存于本机临时文件**（`%APPDATA%/Rokit/recorder/`），**不会上传任何服务器**。
- 转码后的 MP4 / 封面图保存到 `%APPDATA%/Rokit/video/{mp4,thumbs,trim}/`，**仅本机**。
- 停止录制或关闭应用时，相关 stream track 会被 `stop()`，内存被回收。

## 五、第三方字体

界面使用了飞书提供的 Noto Sans SC / Space Grotesk 字体（CDN 加载）。首次访问时会请求字体文件，浏览器会缓存。如你处于离线环境，可手动替换为本地字体。

## 六、未成年人

本应用**不设账号、不验证年龄**。但请注意：

- 使用 BYOK 模型时，调用的是用户自配的第三方服务，相关使用条款由该服务方约束。
- 录屏 / 配音时请遵守当地法律法规，**未经授权请勿录制他人内容**。

## 七、协议变更

本协议如有变更，会在 CHANGELOG 中记录。我们**不会**在未明确告知的情况下变更数据收集范围（目前为零）。

## 八、联系方式

如有隐私相关疑问，请在 GitHub Issues 提交。

## 九、关键凭据说明（v1.5 起）

为避免误导，补充以下技术细节：

### API Key 流向
1. 用户在设置弹窗填入 Key → 写入 **OS 凭据管理器**（服务名 `Rokit`，账号名 `llm-api-key`）
2. 文案生成时，主进程 `llm.chatComplete()` 调用 `secrets.getApiKey()` 读取
3. 拼成 `Authorization: Bearer sk-...` 发到 BYOK 端点
4. SQLite 中 `settings.api_key` 字段被 `store.clearPlaintextApiKey()` 清空
5. **任何时刻都不会被写到任何其他文件**

### GitHub PAT 流向
1. 用户在设置弹窗「GitHub 发布」区域填入 PAT（需 `repo` scope）→ 写入 **OS 凭据管理器**（账号名 `github-pat`）
2. 「创建 Release」时，主进程 `publisher-extensions.githubCreateRelease()` 调用 `secrets.getGithubPat()` 读取
3. 拼成 `Authorization: token ghp_...` 发到 `api.github.com`
4. **设置弹窗再次打开时，PAT 输入框自动留空**（防止旁路偷看），下方提示「● 已配置」
5. SQLite 中**不存** PAT 明文

### keytar 不可用时
- 降级为进程内存单例（重启即丢）
- UI 顶部 BYOK chip 仍显示「● 已配置」，但**重启后需要重新填一次**
- 日志里会有 `keytar 模块加载失败` 警告
- Linux 上需要 `apt install libsecret-1-dev`；macOS 上需允许钥匙串访问对话框

---

**TL;DR**：本应用=「你的数据你的电脑」，不联网、不上传、不收集。要彻底删除只需删除 `%APPDATA%/Rokit/` 目录。
