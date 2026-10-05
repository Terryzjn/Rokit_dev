# Rokit 营销网站（web/）变更记录

> 营销站变更与桌面端发版频次不同：本文件仅记录 [web/](../web/) 目录内的变更（含 SEO/OG/CI/构建脚本）。
> 桌面端发版（Electron 应用）变更统一记录在 [../ai-launch-master/CHANGELOG.md](../ai-launch-master/CHANGELOG.md)。

版本号与 [../ai-launch-master/package.json](../ai-launch-master/package.json) `version` 字段保持一致，由 CI（[.github/workflows/web-ci.yml](../.github/workflows/web-ci.yml)）三道关强制。

---

## [0.1.5] - 2026-09-26

随桌面端 v0.1.5 一同发版：顶栏窗口控制 IPC 加固 + 桌面端品牌资产与营销站对齐。

### Fixed
- **Nav / Hero / Download `releaseUrl` 从 `/releases/latest` 统一改为 `v0.1.5/Rokit-0.1.5-x64.exe` 直链**
  - 旧版依赖 GitHub alias `/releases/latest`，在某些场景会因 alias 规则变更返回 404；
  - 现统一与 `Download.astro` SHA256 校验源对齐，版本锁死 + 直链 SEO；
  - 文件：[Nav.astro](src/components/Nav.astro)、[Hero.astro](src/components/Hero.astro)、[Download.astro](src/components/Download.astro)
- **macOS / Linux ETA 三处文案对齐（解决 P1-1 三角对不齐）**
  - `Download.astro` 的 `otherPlatforms` + `Faq.astro` 第 3 条 + `Roadmap.astro` MVP 1.5/2.0 描述：原"约 2 个月 / MVP 1.5"过期文案统一改为"MVP 2.0 · 预计 2026 Q4"
- **OG 图硬编码 v0.1.0 修正**
  - [scripts/generate-og.mjs](scripts/generate-og.mjs) 版本号从硬编码 `v0.1.0` 改为参数化（CLI `--version=...` > 环境变量 `ROKIT_VERSION` > 默认读 [../ai-launch-master/package.json](../ai-launch-master/package.json)）；
  - 副标题"15 分钟搞定" → "1 小时搞定"（与 Hero 副标题"一条龙搞定"对齐）；
  - 重新生成 [public/og-image.png](public/og-image.png)（1200×630 · 86.5 KB · version=0.1.5）
- **Footer 年份冗余修复**
  - [src/components/Footer.astro](src/components/Footer.astro) `Copyright © 2026–{year}` 在同一年输出"2026–2026"；现仅当 `year > 2026` 才输出连字符区间
- **JSON-LD `softwareVersion` 与桌面端对齐**
  - [src/layouts/Layout.astro](src/layouts/Layout.astro) JSON-LD `softwareVersion: '0.1.5'`，与桌面端版本一致
- **web/README.md "占位待替换项"表改写为 v0.1.6 backlog**
  - 原 v0.1.3 部署期占位（应用截图 / OG 图 / 仓库 URL / Release 资产）已于 v0.1.4–v0.1.5 全部补完；现仅保留未完成项（Astro 5.x 漏洞 / macOS / Lighthouse / 资源占位校验 / 其他平台 L1）
- **CI 版本号校验范围扩展（解决 P2-2 漏检）**
  - [`.github/workflows/web-ci.yml`](../.github/workflows/web-ci.yml) `Verify version sync` 步骤从"仅 grep `Nav.astro`"扩展为"web/package.json + `const version = '...'` 全量 + JSON-LD `softwareVersion`"三道关

### Changed
- **audit-ux.js 守门脚本更新**
  - §2 `Features.astro` 数据看板 badge 断言反转：v0.1.4 起已上线，断言从"不能是已上线"改为"必须是已上线"（防 v0.1.1 误标回归）
  - §3 `Platforms.astro` L1 平台标记改为白名单机制：仅 GitHub 可标 L1（v0.1.4 已对接 GitHub Release API），其余 12 平台仍强制 L2
- **Screenshots.astro 头部注释更新**：v0.1.3 占位说明改为 v0.1.4 起为真实 PNG

---

## [0.1.4] - 2026-09-25

MVP 1.5 全量上线 + 首秀向导渲染管线加固 + 实拍截图替换占位。

### Added
- **实拍截图替换占位**：[public/screenshots/wflow.png](public/screenshots/wflow.png) + [public/screenshots/dashboard.png](public/screenshots/dashboard.png)，由桌面端 v0.1.4 GitHub Release 同款构建实拍
- **OG 分享卡生成**：[scripts/generate-og.mjs](scripts/generate-og.mjs)（sharp + SVG → PNG 1200×630）

### Changed
- **版本号对齐 v0.1.4**：`Nav.astro` / `Hero.astro` / `Download.astro` / `Layout.astro` JSON-LD 全量同步
- **sitemap lastmod 同步**：[public/sitemap.xml](public/sitemap.xml) `2026-09-25`

### Fixed
- **首秀向导文案渲染 XSS 加固**（同步自桌面端 v0.1.4）

---

## [0.1.3] - 2026-09-22

首发推广静态站首版（v0.1.3 部署期）。

### Added
- 11 个组件（Nav / Hero / PainPoints / Features / Flow / Platforms / Roadmap / Screenshots / Download / Footer / Faq）
- 全套 SEO（canonical / Open Graph / Twitter Card）+ JSON-LD（SoftwareApplication）
- WCAG focus-visible 焦点环 + skip-link
- CI 工作流（[.github/workflows/web-ci.yml](../.github/workflows/web-ci.yml)）：版本号校验 + astro check + astro build + Vercel 部署

### 占位（v0.1.3 部署期）
- 应用截图：占位 SVG + PLACEHOLDER 水印（v0.1.4 替换）
- OG 分享卡：缺失（v0.1.4 生成）
- 下载链接：`/releases/latest`（v0.1.4 改为具体版本直链）
- 仓库 URL：`https://github.com/ProClips/Rokit` 占位（v0.1.3 commit `03ce211` 切到 `https://github.com/MatuX-ai/Rokit`）

---

[../ai-launch-master/CHANGELOG.md]: ../ai-launch-master/CHANGELOG.md "桌面端主 CHANGELOG"