# Rokit · 首站

Rokit v0.1.5 首发推广静态站。Astro 5.x 静态输出，零运行时 JS。

## 本地预览

```bash
# 进入此目录
cd web

# 安装依赖（首次）
npm install

# 启动开发服务（默认 http://localhost:4321）
npm run dev

# 构建生产产物到 dist/
npm run build

# 本地预览构建产物
npm run preview
```

> 国内网络下若 Electron 二进制下载慢，可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（仅 desktop 应用需要，本站不涉及）。

## 目录说明

```
web/
├── src/
│   ├── pages/index.astro          ← 唯一首页（组装所有 section）
│   ├── layouts/Layout.astro       ← <html>/<head>，SEO/OG/Twitter meta
│   ├── components/                ← 各 section 组件
│   │   ├── Nav.astro              ← 顶栏 + 锚点 + Star + 下载
│   │   ├── Hero.astro             ← 主视觉 + 火箭 SVG + CTA
│   │   ├── PainPoints.astro       ← 4 个痛点卡片
│   │   ├── Features.astro         ← 6 大功能模块
│   │   ├── Flow.astro             ← 3 步流程
│   │   ├── Platforms.astro        ← 13 平台网格
│   │   ├── Roadmap.astro          ← 1.0 / 1.5 / 2.0 路线图
│   │   ├── Screenshots.astro      ← 应用截图（v0.1.4 起为真实 PNG）
│   │   ├── Download.astro         ← 下载 CTA + 系统要求
│   │   └── Footer.astro           ← 页脚
│   ├── styles/global.css          ← 全局样式（颜色变量 + reset + 字体栈）
│   └── assets/rocket.svg          ← 火箭主视觉（青色 + 粉紫高光）
├── public/
│   └── favicon.svg                ← 浏览器图标
├── astro.config.mjs               ← output: 'static'，site: 待填
└── vercel.json                    ← cleanUrls + trailingSlash
```

## 部署到 Vercel

1. 把 `web/` 推到 GitHub 仓库（或将整个仓库推上去后指定 Root Directory 为 `web/`）
2. Vercel 控制台 → Import Project → 选择仓库
3. Framework Preset 自动识别为 **Astro**
4. Build Command：`npm run build`（默认）
5. Output Directory：`dist`（默认）
6. 点击 Deploy

首次部署完成后：
- 在 Project Settings → Domains 绑定自定义域
- 把 `astro.config.mjs` 中的 `site` 改为最终域名（影响 canonical / og:url）

## 内容编辑

### 修改文案
- 页面文案集中在各 `components/*.astro` 顶部的数组常量（如 `pains`、`features`、`steps`）
- 修改 Hero 标题/副标题：[src/components/Hero.astro](src/components/Hero.astro)
- 修改全局 SEO meta：[src/layouts/Layout.astro](src/layouts/Layout.astro)

### 替换截图占位
当前 `Screenshots.astro` 已在 v0.1.4 切为真实 PNG（桌面端 v0.1.4 GitHub Release 同款构建实拍）。若需要重新生成：
1. 启动桌面应用 [ai-launch-master/](../ai-launch-master/)，用截图工具截取主界面
2. 把截图放到 `public/screenshots/`（当前为 `wflow.png` 与 `dashboard.png`）
3. `Screenshots.astro` 中的 `screenshots` 数组定义文件路径与 alt 文本。CI 会在构建后检查 `dist/screenshots/*.png` 是否存在（[.github/workflows/web-ci.yml](../.github/workflows/web-ci.yml)）

### 替换 OG 分享卡
v0.1.4 起 `og-image.png`（1200×630）已由 [scripts/generate-og.mjs](scripts/generate-og.mjs) 生成。
脚本默认从 [../ai-launch-master/package.json](../ai-launch-master/package.json) 读版本号；如需手工覆盖：

```bash
node scripts/generate-og.mjs --version=0.1.5
# 或
ROKIT_VERSION=0.1.5 node scripts/generate-og.mjs
```
当前 meta 已声明 `og:image=${siteUrl}/og-image.png`，缓存刷新可能需要 Vercel Edge 几十分钟。

## v0.1.6 backlog（下一版本计划）

本节仅保留**未完成项**。v0.1.3 部署期占位（应用截图 / OG 图 / 仓库 URL / Release 资产）已于 v0.1.4–v0.1.5 全部补完，详见 [../ai-launch-master/CHANGELOG.md](../ai-launch-master/CHANGELOG.md)。

| 项 | 现状 | 预期完成 | 替换位置 | 备注 |
|---|---|---|---|---|
| Astro 5.x critical XSS/SSRF（GHSA-j687-52p2-xcff 等） | ⏸ 风险豁免生效中（静态产物不可远程利用） | v0.1.6 | `web/package.json` | 计划升至 Astro 7.x，需回归 test 验证 |
| macOS / Linux 版发布 | ⏸ MVP 2.0 路线（[Roadmap.astro](src/components/Roadmap.astro)） | MVP 2.0 / 预计 2026 Q4 后 | 桌面端 `electron-builder.yml` | 与营销站文案已对齐（[Download.astro](src/components/Download.astro)、[Faq.astro](src/components/Faq.astro)） |
| `web/CHANGELOG.md` 独立变更记录 | ⏸ 跟随主仓 CHANGELOG | v0.1.6 | 新建 `web/CHANGELOG.md` | 营销站变更与桌面端发版频次不同，建议拆开 |
| Lighthouse 自动化跑分 | ⏸ 部署后手动跑 | v0.1.6 | `.github/workflows/web-ci.yml` | 现仅"待人工执行" checklist |
| `dist/screenshots/*.png` 资源占位校验 | ⏸ CI 未覆盖 | v0.1.6 | `web-ci.yml` | 加 `test -f dist/screenshots/{wflow,dashboard}.png` |
| 其他平台 L1 直发 | ⏸ 路线图（MVP 2.0） | MVP 2.0 | `Platforms.astro` + audit-ux.js 白名单 | 届时扩展 `L1_WHITELIST` |

全局搜索 `https://github.com/MatuX-ai/Rokit` 即可验证当前所有链接已统一指向真实仓库。

## 技术栈

- Astro 5.x（静态输出）
- 纯 Astro 组件（无 React/Vue，无运行时 JS）
- 内联 SVG + CSS 动画
- 中文系统字体栈，无外部字体依赖
- 无外部图片资源（首屏 LCP < 2s）

## 验证清单（上线前）

- [ ] `npm run build` 通过，无 type 错误
- [ ] 桌面 1440 / 1024 / 768 三档宽度无横向滚动
- [ ] 移动端 375 宽度：导航汉堡菜单、火箭降级为顶部装饰
- [ ] 所有锚点跳转平滑
- [ ] 「下载」/「Star」CTA 链接可达
- [ ] Lighthouse（移动端）：Performance / SEO / Best Practices ≥ 95

## 开发约定

- ⚠ **修改 `src/components/Nav.astro` 节点顺序需重新验证汉堡菜单**：依赖 `checkbox#nav-toggle → label.nav-burger → nav.nav-links` 的 CSS 兄弟选择器，调换顺序会导致移动端菜单打不开 / 收不回（详见组件顶部注释）。
