# docs/ · 产品方案与设计文档

本目录收录 Rokit 的**产品定位、用户分析、功能架构、技术方案**等设计文档。
工程实现细节请前往 [`../ai-launch-master/`](../ai-launch-master/)。

---

## 当前文档

| 文件 | 状态 | 说明 |
|---|---|---|
| [`Rokit-产品方案.html`](./Rokit-产品方案.html) | ✅ **v1.5 定稿** | 产品 PRD：用户画像、痛点、六大功能模块、技术架构、MVP 里程碑与风险边界 |

## 历史版本

> 以下为过程稿，仅供查阅演进轨迹，请阅读上方 v1.5 定稿。

| 文件 | 版本 | 状态 |
|---|---|---|
| [`_backup_prd_v1.2.html`](./_backup_prd_v1.2.html) | v1.2 | 早期探索稿 |
| [`_backup_prd_v1.3.html`](./_backup_prd_v1.3.html) | v1.3 | 架构调整稿 |
| [`_backup_prd_v1.4.html`](./_backup_prd_v1.4.html) | v1.4 | 技术形态调研稿（开源 / 桌面 / SQLite / BYOK） |

---

## 文档维护约定

- **当前定稿**放在根目录，文件名带主版本号（如 `Rokit-产品方案.html`），不要在文件名上叠加次版本
- **历史版本**统一加 `_backup_` 前缀，**不删除**，便于追溯决策演进
- 每次升级 PRD 时，请在 [CHANGELOG](../ai-launch-master/CHANGELOG.md) 中记录「产品决策变更」
- HTML 是有意的格式：可在浏览器中阅读，也方便后续导出 PDF / 部署到静态站点

---

## 阅读建议

| 你是谁 | 先看哪一份 |
|---|---|
| 想了解 Rokit 是什么 | [根 README](../README.md) → [Rokit-产品方案.html](./Rokit-产品方案.html) §1–§4 |
| 想上手使用 | [根 README](../README.md) → [ai-launch-master/README.md](../ai-launch-master/README.md) |
| 想参与开发 | [根 README](../README.md) → [CONTRIBUTING.md](../CONTRIBUTING.md) → [ai-launch-master/README.md](../ai-launch-master/README.md) 开发命令段 |
| 想了解技术架构 | [Rokit-产品方案.html](./Rokit-产品方案.html) §12 技术架构 → [ai-launch-master/README.md](../ai-launch-master/README.md) 架构要点段 |

---

## 反馈文档问题

- 发现内容错漏 / 表述不清 → 在 GitHub Issue 提交，标题前缀 `[docs]`
- 文档结构 / 章节调整建议 → 在 GitHub Discussion 发起讨论
- 重大版本变更 → 提交 PR，并在 PR 描述中说明改动理由与影响范围