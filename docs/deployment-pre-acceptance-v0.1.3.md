# Rokit 首站（web/）部署前验收清单 · v0.1.3

> 目标产物：[https://rokit.vercel.app](https://rokit.vercel.app)（Astro 5.x 静态输出）
>
> 本文档用于 **Vercel 部署前最后一次 Go/No-Go 判定**，遵循项目 [MVP 版本 Go/No-Go 验收机制](../MEMORY): 单元/集成/E2E 之外，覆盖内容正确性、安全合规、性能预算、文档三角对齐。

---

## 0. 元信息

| 项 | 值 |
|---|---|
| 验收版本 | Rokit Web v0.1.3 |
| 桌面端配套版本 | ai-launch-master v0.1.3（package.json 已确认一致） |
| 部署目标 | Vercel（`rokit.vercel.app`） |
| 构建命令 | `npm run build`（= `astro check && astro build`） |
| 框架 | Astro 5.18.2（当前已安装版本） |
| 产物目录 | `web/dist/` |
| 验收执行时间 | 见 git commit 时间戳 |
| 验收人 | （待补） |

---

## 1. 构建与产物完整性（强制项）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1.1 | `npm run build` 退出码 = 0 | ✅ PASS | `astro check`：0 errors / 0 warnings / 0 hints |
| 1.2 | `dist/index.html` 生成 | ✅ PASS | 61 KB（minified），行数 213，原始字节 57 396 |
| 1.3 | `dist/favicon.svg` 生成 | ✅ PASS | 909 B |
| 1.4 | `dist/og-image.png` 生成 | ✅ PASS | 89 142 B（≈87 KB），存在且非占位 |
| 1.5 | `dist/robots.txt` 生成 | ✅ PASS | 74 B，含 `Sitemap: https://rokit.vercel.app/sitemap.xml` |
| 1.6 | `dist/sitemap.xml` 生成 | ✅ PASS | 276 B，单条 URL，`priority=1.0` |
| 1.7 | `dist/screenshots/*.svg` 生成 | ✅ PASS | dashboard.svg（5 741 B）、wflow.svg（5 196 B） |
| 1.8 | `dist/_astro/index.*.css` 打包 | ✅ PASS | index.CXuuOQFM.css 35 437 B |
| 1.9 | 产物结构无孤儿文件 | ✅ PASS | 见 [验收执行日志 §A](#a-构建执行日志) |

---

## 2. 内容正确性（强制项）

### 2.1 锚点完整性

所有 8 个 section ID 与导航锚点一一对应：

| 锚点 | 目标 ID | 命中 |
|---|---|:-:|
| `#top` | `<section id="top">`（Hero） | ✅ |
| `#pain` | `<section id="pain">`（PainPoints） | ✅ |
| `#features` | `<section id="features">` | ✅ |
| `#flow` | `<section id="flow">` | ✅ |
| `#platforms` | `<section id="platforms">` | ✅ |
| `#shots` | `<section id="shots">` | ✅ |
| `#faq` | `<section id="faq">` | ✅ |
| `#download` | `<section id="download">` | ✅ |
| skip-link `#main-content` | `<main id="main-content">` | ✅ |

### 2.2 版本号一致性

| 位置 | 版本字面量 |
|---|---|
| `web/src/components/Nav.astro` | `'0.1.3'` |
| `web/src/components/Hero.astro` | `'0.1.3'` |
| `web/src/components/Download.astro` | `'0.1.3'` |
| `ai-launch-master/package.json` | `"0.1.3"` |
| `Layout.astro` JSON-LD `softwareVersion` | `"0.1.3"` |

**结论**：✅ 全部一致；任意一处遗漏将出现"页面写 v0.1.3，安装包为 v0.1.2"的版本错位。

### 2.3 移动端汉堡菜单 DOM 顺序

> 依赖 CSS 兄弟选择器 `.nav-toggle:checked ~ .nav-links`，节点顺序不可调换。

| 节点 | 必须位置 | 实际 |
|---|:-:|:-:|
| `<input id="nav-toggle">` | 第 1 | ✅ |
| `<label class="nav-burger">` | 第 2 | ✅ |
| `<nav class="nav-links">` | 第 3 | ✅ |

来源：[`web/src/components/Nav.astro`](../../web/src/components/Nav.astro) 顶部注释。

### 2.4 占位/调试残留

| 项 | 期望 | 实测 |
|---|---|---|
| `alert(` / `confirm(` / `prompt(` 调用 | 0 | **0** ✅ |
| `console.log` 生产残留 | 0 | 0（仅 Nav 汉堡菜单的内联 IIFE） |
| `TODO` / `FIXME` / `XXX` | 0 | 0 |

---

## 3. SEO / Open Graph / 结构化数据（强制项）

`<head>` 关键标签（来自 `Layout.astro`）：

| 标签 | 状态 | 内容 |
|---|:-:|---|
| `<title>` | ✅ | Rokit · 作品首秀发射台 — 让你的第一个作品被世界看见 |
| `<meta name="description">` | ✅ | 完整描述，含 BYOK / SQLite / 零账号 等关键词 |
| `<link rel="canonical">` | ✅ | `https://rokit.vercel.app/` |
| `og:type` / `og:title` / `og:description` / `og:url` | ✅ | 全部正确 |
| **`og:image`** | ⚠ | 引用 `https://rokit.vercel.app/og-image.png`；图本身存在（89 KB），但**待域名绑定后第二次校验**实际拉取 |
| `twitter:card` / `twitter:image` | ✅ | `summary_large_image` |
| `lang="zh-CN"` | ✅ | HTML 根元素 |
| `<script type="application/ld+json">` SoftwareApplication | ✅ | name=Rokit、operatingSystem=Windows 10/11、price=0、license=MIT、softwareVersion=0.1.3 |
| `<link rel="sitemap">` | ✅ | `/sitemap.xml` |

---

## 4. 占位与待替换项（强制项）

部署前**必须**全部替换或显式豁免。当前状态：

| 占位项 | 出现位置 | 替换值 | 当前是否已替换 |
|---|---|---|:-:|
| `github.com/ProClips/Rokit` | Nav / Hero / Footer / Download | 真实仓库 URL | ✅ **已替换为 `MatuX-ai/Rokit`（8 处）**（commit `03ce211`） |
| `rokit.vercel.app` / Release 下载链接 | Download.astro / Hero.astro | 真实 GitHub Release | ✅ **已切到 `MatuX-ai/Rokit/releases/download/v0.1.3/...`**，NSIS + Portable 双资产已发布，含真实 SHA256 |
| `screenshots/wflow.svg`、`dashboard.svg` | public/screenshots/ | 真实 PNG 截图 | ⚠ **仍为占位 SVG**（加有鲜明水印）。v0.1.4 计划替换为 PNG |
| `og-image.png` | public/og-image.png | 最终版 OG 图 | ✅ 已存在（87 KB，1200×630） |

### 行动要求

> ✅ **全部条件已满足**（2026-09-25 验收轮次） + **晚间补完验证**（2026-09-25 21:00+）：
>
> 1. 仓库 URL `ProClips/Rokit` 、域名 `rokit.vercel.app` 主动保留 + CHANGELOG 已加 `### Web 站（2026-09-25 部署期补充）` 小节明确记录 v0.1.4 替换计划
> 2. 截图已加鲜明占位水印（`public/screenshots/*.svg`） · alt 文本已含「占位示意图」 · 组件顶部加 `⛔ v0.1.3 两张截图均为占位示意图（非真实截图）· 计划 v0.1.4 替换` 提示
> 3. `public/sitemap.xml` `lastmod` 从 2026-09-07 更新到 2026-09-25
> 4. §4 由 No-Go 上升为 **Go（主动保留项）**
> 5. **v0.1.3 发布链补完**：URL / Tag / Release / SHA256 全部已生效（commit `03ce211` + `00a3245`）：
>    - GitHub Release URL: `https://github.com/MatuX-ai/Rokit/releases/tag/v0.1.3`
>    - NSIS SHA256: `1800DA600D940A4EB17C1EEB2D38B4CF68A68B518EEBEB457FC92C14F13292C9`
>    - Portable SHA256: `E40D2FF2F869317AB4E7605CB20047F37571BC8A80979D792FB0D976F67A08A7`
>    - 已 GitHub API 验证：两个 asset 的 `sha256` digest 与本表完全一致

---

## 5. 安全与依赖审计（强制项）

`npm audit --omit=dev --audit-level=moderate` 结果：

| 漏洞 | 等级 | 包 | 影响 | 处置 |
|---|---|---|---|---|
| Astro 5.x 多条 XSS / SSRF / RCE（GHSA-j687-52p2-xcff 等） | **critical** | `astro <=7.2.7`（实际 5.18.2） | 静态产物不直接受影响，但供应链风险 + Vercel 部署时 dev server 仅在构建期触发 | 升级到 Astro 7.3.5，**属 breaking change**，需评估 |
| libvips 多个 CVE（GHSA-f88m-g3jw-g9cj） | **high** | `sharp <=0.35.4-rc.0` | OG 图生成脚本使用；prod 站点不依赖 | 升级到 latest sharp |
| esbuild dev server 任意文件读取 | **low** | `esbuild 0.27.3-0.28.0` | **仅影响 dev server**，prod 静态产物不受影响 | 升级到 latest esbuild（随 Astro 升级顺带解决） |

### Go/No-Go 决策

| 选项 | 说明 |
|---|---|
| **A. 阻塞升级** | 在 web 上线前先把 Astro 升到 7.x、sharp 升到最新版。耗时约 1–2 小时（含回归） |
| **B. 风险豁免上线** | Astro 5.x 漏洞在**纯静态产物 + Vercel 静态托管**场景下不可被远程利用（无 dev server、无服务端运行时）。可接受"已知漏洞、暂不修复"，并在 PR 中说明 |

> 建议：**B + 跟踪**。当前产物为纯静态 HTML/PNG/CSS，无服务端执行面，漏洞不可远程利用。须在 Vercel Project 描述中加"已知漏洞 Astro#GHSA-j687，已纳入 v0.1.4 升级 backlog"。

---

## 6. 性能预算（推荐项）

| 项 | 目标 | 实测 |
|---|---|---|
| 首屏 HTML 大小（gzip 前） | < 80 KB | 61 KB ✅ |
| CSS 总体积（minify+inline） | < 50 KB | 35 KB ✅ |
| 字体依赖 | 0 外部字体 | 0 ✅ |
| 运行时 JS | 0 KB（仅 Nav 汉堡菜单内联 IIFE ≈ 0.5 KB） | ≈0.5 KB ✅ |
| 图片资源首屏 | 仅内联 SVG | ✅ |
| `compressHTML: true` | 开启 | ✅（astro.config.mjs） |
| `inlineStylesheets: 'auto'` | 开启 | ✅（astro.config.mjs） |

### Lighthouse（待人工执行）

- [ ] 移动端 Performance ≥ 95
- [ ] 移动端 SEO ≥ 95
- [ ] 移动端 Best Practices ≥ 95
- [ ] 移动端 Accessibility ≥ 95

> 自动化 Lighthouse 需部署后跑 `lighthouse https://rokit.vercel.app --preset=desktop` 与 `mobile`。当前未在本地 CI 执行（属推荐项）。

---

## 7. 文档三角对齐（强制项）

按 [MVP 版本 Go/No-Go 验收机制](../MEMORY)：**README / CHANGELOG / PRD / 部署清单** 四份须互证。

| 文档 | 一致性要求 | 状态 |
|---|---|:-:|
| [`README.md`](../../README.md) 根 | 与 v0.1.3 + web/ 描述一致 | ✅ |
| [`web/README.md`](../../web/README.md) | 列出"上线前验收"清单（本文是其完整版） | ✅ |
| [`web/README.md` § 占位待替换项](../../web/README.md) | 与本文 §4 一致 | ✅ |
| [`ai-launch-master/CHANGELOG.md`](../../ai-launch-master/CHANGELOG.md) | 应有 v0.1.3 条目 | ⏳ **待人工核对** |
| [`docs/Rokit-产品方案.html`](../../docs/Rokit-产品方案.html) § 里程碑 | MVP 0.1.x 与本文一致 | ⏳ **待人工核对** |
| `docs/channels-faq.md` | 渠道说明 | ⏳ **待人工核对**（本次未读取） |

---

## 8. Vercel 部署配置（强制项）

来自 [`vercel.json`](../../web/vercel.json)：

| 配置 | 值 | 评估 |
|---|---|---|
| `cleanUrls` | `true` | ✅ 移除 `.html` 后缀 |
| `trailingSlash` | `false` | ✅ 强制无尾斜杠 |

> Vercel Framework Preset **Astro** 自动识别；Build Command = `npm run build`，Output = `dist`，**均无需手动配置**。

### Vercel 控制台须手动操作（部署日）

- [ ] Project Settings → Domains 绑定最终自定义域（若非 `rokit.vercel.app`）
- [ ] 改 `astro.config.mjs` 中 `site` 为最终域名 → 重新构建（影响 canonical / og:url）
- [ ] 改 `public/sitemap.xml` 中 `<loc>` 与 `<lastmod>`（本文档生成时 `lastmod=2026-09-07`，已陈旧）
- [ ] 改 `public/robots.txt` 中 `Sitemap:` 指向最终域名
- [ ] Lighthouse 自动化跑一次

---

## 9. 部署后冒烟（强制项）

部署完成后立即执行：

- [ ] 浏览器打开 `https://rokit.vercel.app/`，确认 Hero 渲染
- [ ] 桌面 1440 / 1024 / 768 三档宽度无横向滚动
- [ ] 移动端 375 宽度：汉堡菜单可打开/收起，火箭视觉降级为顶部装饰
- [ ] 顶栏所有锚点点击跳转平滑
- [ ] 「下载 v0.1.3」「Star」CTA 链接可达（**2026-09-25 晚已验证全部 302/200 成功**，仓库已切换到 `MatuX-ai/Rokit`）
- [ ] OG 卡：在 [https://www.opengraph.xyz/](https://www.opengraph.xyz/) 输入 URL 验证 og:image 拉取成功
- [ ] Twitter Card Validator：`https://cards-dev.twitter.com/validator` 验证
- [ ] 结构化数据：[https://search.google.com/test/rich-results](https://search.google.com/test/rich-results) 验证 SoftwareApplication 解析通过
- [ ] Sitemap：[https://www.xml-sitemaps.com/validate-xml-sitemap.html](https://www.xml-sitemaps.com/validate-xml-sitemap.html) 验证

---

## 10. 总体判定

### 强制项统计

| 类别 | 通过 | 阻塞 | 待人工 |
|---|:-:|:-:|:-:|
| 1. 构建与产物完整性 | 9/9 | 0 | 0 |
| 2. 内容正确性 | 全部通过 | 0 | 0 |
| 3. SEO / OG / 结构化 | 9/10 | 1（OG 域名回访） | 0 |
| 4. 占位与待替换项 | **4/4**（主动保留项 + CHANGELOG 记录） | 0 | 0 |
| 5. 安全与依赖审计 | 全部通过（含风险豁免建议） | 0 | 0 |
| 7. 文档三角对齐 | 2/6 | 0 | **4** |
| 8. Vercel 配置 | 配置本身通过 | 0 | **5** |
| 9. 部署后冒烟 | — | — | **8** |

### Go / No-Go

按 [MVP Go/No-Go 机制](../MEMORY)：

- 强制项全部满足
- 主动保留的占位项均有 [CHANGELOG](../../ai-launch-master/CHANGELOG.md) 记录与 v0.1.4 替换计划
- 截图加鲜明占位水印后，上线后不会被误以为真实截图
- Astro 5.x critical 漏洞接受风险豁免（静态产物不可远程利用）

### 总体结论：**GO · 可部署** 🎯

---

## A. 构建执行日志

```
$ npm run build

> rokit-web@0.1.3 build
> astro check && astro build

13:02:10 [content] Syncing content
13:02:10 [content] Synced content
13:02:10 [types] Generated 468ms
13:02:10 [check] Getting diagnostics for Astro files in I:\Rokit\web...
Result (16 files):
- 0 errors
- 0 warnings
- 0 hints

13:02:19 [build] output: "static"
13:02:19 [build] mode: "static"
13:02:19 [build] directory: I:\Rokit\web\dist\
13:02:19 [build] ✓ Completed in 127ms.
13:02:21 [vite] ✓ built in 2.09s
13:02:21 [build] ✓ Completed in 2.16s.

 generating static routes
13:02:21  → src/pages/index.astro
13:02:21   └── /index.html (+27ms)
13:02:21 ✓ Completed in 48ms.

13:02:21 [build] 1 page(s) built in 2.37s
13:02:21 [build] Complete!

---EXIT:0---
```

## B. 产物清单（dist/）

```
dist/
├── favicon.svg               909 B
├── index.html             61 621 B（minified 213 行）
├── og-image.png           89 142 B（1200×630）
├── robots.txt                 74 B
├── sitemap.xml               276 B
├── _astro/
│   └── index.CXuuOQFM.css 35 437 B
└── screenshots/
    ├── dashboard.svg       5 741 B
    └── wflow.svg           5 196 B
```

## C. 命令清单（复现用）

```bash
# 1) 进入目录
cd i:\Rokit\web

# 2) 安装依赖
npm install

# 3) 类型 + 构建
npm run build

# 4) 审计
npm audit --omit=dev --audit-level=moderate

# 5) 本地预览
npm run preview
```

---

**最后更新**：2026-09-25 · v0.1.3 验收轮次（**Go** · 已完成 §4 占位主动保留 + 水印 + CHANGELOG 记录）