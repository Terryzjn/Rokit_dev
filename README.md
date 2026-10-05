# Rokit · 作品首秀发射台

> 给独立开发者 / 学生开发者的「**作品首秀运营闭环**」：登记作品 → AI 一键生成全套推广物料 → 引导分平台发布 → 采集反馈 → 生成迭代建议。

**技术形态**：开源软件 · 桌面端应用 · 本地 SQLite · BYOK（用户自带 API Key）

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](ai-launch-master/LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.3-success.svg)](ai-launch-master/CHANGELOG.md)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-blueviolet.svg)](#)
[![Electron](https://img.shields.io/badge/electron-36-47848F?logo=electron&logoColor=white)](#)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](#)

---

## 一句话定位

让每一个认真做出第一个作品的年轻人，都能被「看见」，并有动力做出第二个、第三个作品。
**用户只做一件事——专注开发。** 推广、文案、发布、数据、复盘、迭代建议，全部由 Rokit 接管。

## 仓库结构

```
Rokit/
├── README.md                  ← 你在这里（仓库总入口）
├── .gitignore                 ← 全局忽略规则
│
├── ai-launch-master/          ← ★ MVP 1.0 桌面端实现（Electron 应用）
│   ├── README.md              ← 应用层使用与开发文档
│   ├── CHANGELOG.md           ← 版本变更记录
│   ├── PRIVACY.md             ← 隐私政策
│   ├── LICENSE                ← MIT 许可
│   ├── package.json           ← 入口 + 脚本 + electron-builder 配置
│   ├── index.html             ← 产品界面（首秀向导 / 数据看板 / 我的作品）
│   ├── electron/              ← 主进程 / 预加载 / 存储 / LLM / 发布适配器
│   ├── tests/                 ← vitest 单元测试（50 个用例）
│   └── build/                 ← electron-builder 资源（图标等）
│
├── docs/                      ← ★ 产品方案与设计文档
│   ├── README.md              ← 文档目录索引
│   └── Rokit-产品方案.html    ← 产品 PRD（v1.5 定稿）
│
├── web/                       ← ★ 首发推广静态站（Astro，部署至 Vercel）
│   └── README.md              ← 本地预览 / 部署 / 编辑说明
│
└── CONTRIBUTING.md            ← 如何参与贡献
```

> 在线介绍页：部署后在仓库首页加占位链接（详见 [web/README.md](web/README.md)）。

## 快速开始

### 我想用 Rokit

前往 [ai-launch-master/README.md](ai-launch-master/README.md) —— 应用的使用、配置、打包、测试全部在其中。

> 30 秒摘要：
> ```bash
> cd ai-launch-master
> npm install
> npm start
> ```
> 启动后点右上角 ⚙ 配置你的模型 API Key（支持 DeepSeek / OpenAI / 通义 / Ollama 等任意 OpenAI 兼容端点），即可走完首秀向导。

### 我想了解产品

阅读 [docs/Rokit-产品方案.html](docs/Rokit-产品方案.html)（v1.5 PRD）——
包含用户画像、痛点分析、六大功能模块、技术架构、MVP 里程碑与风险边界。

### 我想贡献代码 / 反馈

阅读 [CONTRIBUTING.md](CONTRIBUTING.md) —— 提 Issue / PR / 适配新平台 / 翻译文档的指引。

## 核心亮点

| 维度 | 设计选择 | 为什么 |
|---|---|---|
| 🛡️ **数据主权** | 完全本地 SQLite，无账号、无云同步、无遥测 | 创作者最在意作品与素材的所有权；零账号零摩擦 |
| 🔌 **AI 接入** | BYOK：用户自配 Base URL / Key / 模型名 | 与 DeepSeek Harness 同思路；可接任意 OpenAI 兼容端点（DeepSeek / OpenAI / 通义 / Ollama / LM Studio …） |
| 🖥️ **运行形态** | Electron 36 单桌面壳，内置 Node 22 + `node:sqlite` | 零原生编译依赖；启动即用；离线可用 |
| 🌐 **平台发布** | 13 平台适配器，统一为 L2（AI 备料 + 浏览器自动填表），最终点击需用户确认 | v0.1.1 全部平台均通过浏览器自动化实现；真正的 L1（API 直发）规划在 MVP 1.5 |
| 📦 **分发** | electron-builder 出 NSIS + Portable 双产物 | Windows 用户既可安装也可单文件运行 |
| 🔒 **安全** | `contextIsolation` + `nodeIntegration:false` + 白名单 `openExternal` | 渲染进程无 Node 能力，外链仅 http/https |

## 路线图

| 版本 | 状态 | 核心能力 |
|---|---|---|
| **MVP 1.0**（当前 v0.1.3） | ✅ | 桌面壳 + BYOK + 对话向导 + 本地 SQLite + 多平台文案 + L2 自动填表 + 发布队列 + 自动发布浏览器 + 真实数据看板 |
| **MVP 1.5** | 🚧 规划 | 落地页生成 · L1 直发（本地 OAuth）· 数据看板 · 里程碑报喜 · 录屏成片 · 多作品库 · 数据导出/导入 |
| **MVP 2.0** | 📋 后续 | 反馈采集 + AI 分析 · 多画幅多版本渲染 · 开源发布与社区案例库 |

详见 [docs/Rokit-产品方案.html](docs/Rokit-产品方案.html) 与 [ai-launch-master/CHANGELOG.md](ai-launch-master/CHANGELOG.md)。

## 13 个发布平台

GitHub · Product Hunt · V2EX · 掘金 · X(Twitter) · Facebook · YouTube · 抖音 · 小红书 · B站 · 即刻 · 知乎 · 微信公众号

> 当前 13 平台均为 L2（浏览器自动填正文 + 自动跳转，最后一步需用户手动点击发布）。
> API 直发（L1）和 RPA 兜底（L3）规划在 MVP 1.5 / 2.0。

## 安全与隐私

- 🟢 **零账号**：不注册、不登录、不收集任何账号信息
- 🟢 **零遥测**：无崩溃上报、无使用统计、无任何后台请求
- 🟢 **API Key 仅存本机**：SQLite 明文存储于 `%APPDATA%\Rokit\`
- 🟢 **录屏/麦克风**：每次用户主动触发，未授权不录制
- 🟢 **一键擦除**：删除 `%APPDATA%\Rokit\` 即可彻底清除所有数据

完整说明：[ai-launch-master/PRIVACY.md](ai-launch-master/PRIVACY.md)

## 协议

[MIT](ai-launch-master/LICENSE) · Copyright © 2026 ProClips+

## Star History

如果 Rokit 对你有帮助，欢迎 ⭐ Star，让更多独立开发者看到它。