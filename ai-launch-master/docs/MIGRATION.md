# Rokit 数据迁移指南（v0.x → v1.5）

> 适用版本：v0.1.0 ~ v0.1.3 → v1.5
>
> 本指南覆盖 v1.5 升级时的关键数据迁移行为。所有迁移均为**自动 + 幂等**，用户无需手动介入。如遇到迁移异常，请按本文档末的「回滚与排查」章节处理。

---

## 一、迁移总览

| 维度 | v0.x 行为 | v1.5 行为 | 迁移时机 |
|---|---|---|---|
| **API Key 存储** | SQLite 明文（`settings.api_key`） | OS 凭据管理器（keytar）+ 内存兜底 | 首次启动自动迁移 |
| **GitHub PAT** | 不支持（依赖浏览器登录态） | OS 凭据管理器（keytar） | 用户手动在设置中填入 |
| **数据看板** | 4 项硬编码 demo KPI | 真实本机数据 + 「未配置 API」提示 | 不需迁移 |
| **数据库 schema** | v2（settings/works/pubs/channels） | v3（新增 feedback / feedback_clusters / works 新字段） | 启动时自动 ALTER TABLE |
| **发布记录** | `pub_log` JSON 字段 | 同步写到 `pubs` 表 + 真实回填 | 不需迁移（增量同步） |
| **渠道发布浏览器** | 单一 `persist:pub` 分区 | 同左（v1.5 不动） | 不需迁移 |
| **示例作品** | 4 个 fake 作品会被写入 SQLite | 仅 UI 渲染，不入库 | 启动时跳过旧 fake 数据 |

---

## 二、API Key 明文迁移

### 自动迁移逻辑

v1.5 启动时（`main.js` → `secrets.migratePlaintextApiKey(store)`）按以下顺序执行：

1. 读取 `store.getSettings().api_key`
2. 若为空 → `migrated=false, reason=no-plaintext-key`，不做任何事
3. 若非空 → 调用 `secrets.getApiKey()` 检查 OS 凭据管理器
   - **凭据管理器已有同值** → 直接清空 SQLite 字段（`store.clearPlaintextApiKey()`），返回 `migrated=true, reason=already-in-keytar`
   - **凭据管理器为空 / 不同值** → `secrets.setApiKey(plaintext)` 写入凭据管理器 + 清空 SQLite 字段
4. 写入失败（keytar 不可用）→ 降级为内存单例 + warn 日志，**保留** SQLite 明文（下次启动重试）

### 用户可见变化

| 触发点 | v0.x 行为 | v1.5 行为 |
|---|---|---|
| 顶部 BYOK chip | 显示「● 已配置 keytar」 / 「● 未配置 API」 | 显示「● 模型 + GitHub PAT」 / 「● 未配置 API（点此填 Key）」 |
| 设置弹窗 | `cfgKey` 密码框明文来回写 | `cfgKey` + `cfgGithubPat` 两个密码框，**保存时即时写入凭据管理器**；再次打开弹窗密码框自动清空（防泄露），下方提示「● 已配置」 |
| 升级后第一次启动 | 立即生效 | 启动约 200ms 内完成迁移，UI 无感；用户在「数据看板」会看到 BYOK chip 仍是「已配置」（因为 SQLite 还有值，等迁移完才更新） |

### 验证迁移成功

打开 `%APPDATA%/Rokit/ai-launch-master.db`，查询：

```sql
SELECT api_key FROM settings;  -- 应当返回 '' 或 NULL
```

或在 PowerShell：

```powershell
cmdkey /list | findstr "Rokit"
# 应看到：
# Target: Rokit
#   User: llm-api-key
#   ...
```

### 回滚（万一需要）

如果你**回退到 v0.x 版本**，API Key 会从 SQLite 字段消失（因为 v1.5 已清空）。补救方法：

1. 暂时重新安装 v1.5，启动 → 在设置里重新填一次 Key（虽然会写入 keytar，但 SQLite 不会恢复）
2. 或者直接用 PowerShell 注入：
   ```powershell
   # 在 v0.x 环境下，把 Key 写回 SQLite
   # 1) 找到 keytar 里的 Key
   [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
   # Windows: 用 Credential Manager UI 查看「Rokit」凭据
   # 2) 手动填到设置弹窗
   ```

> **生产建议**：v0.x 已停止维护，请升级到 v1.5 后不再回退。

---

## 三、数据库 Schema v2 → v3

### 自动迁移逻辑（`store.js` → `migrate()`）

启动时通过 `PRAGMA user_version` 判断当前 schema 版本：

| 版本 | 触发条件 | 动作 |
|---|---|---|
| 0（不存在） | 全新安装 | CREATE TABLE 全套 v3 表 + `user_version=3` |
| 2（v0.x 升级） | 检测到旧 schema | CREATE 新表（feedback / feedback_clusters / works 新字段）+ ALTER TABLE ADD COLUMN + `user_version=3` |
| 3（v1.5 升级） | 同版本 | 直接跳过 |

### v3 新增表 / 字段

#### 表：`feedback`（反馈原始记录）
```sql
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'github' | 'v2ex'
  external_id TEXT NOT NULL,       -- GitHub issue id / V2EX 链接
  author TEXT,
  url TEXT,
  title TEXT,
  content TEXT,                    -- 已经 stripHtml 处理的纯文本
  sentiment TEXT,                  -- 'positive' | 'neutral' | 'negative'（v1.5 反馈分析回填）
  category TEXT,                   -- 'bug' | 'feature' | 'question' | 'doc' | 'discussion'
  priority TEXT,                   -- 'P0' | 'P1' | 'P2'
  cluster_id TEXT,                 -- 反馈聚类 id（关联 feedback_clusters.id）
  fetched_at TEXT NOT NULL,
  UNIQUE(source, external_id)      -- 增量去重
);
```

#### 表：`feedback_clusters`（反馈聚类）
```sql
CREATE TABLE feedback_clusters (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  title TEXT NOT NULL,             -- 聚类关键词拼成的简短标题
  count INTEGER NOT NULL,
  priority TEXT NOT NULL,          -- 'P0' | 'P1' | 'P2'
  sample_ids TEXT,                 -- JSON 数组字符串
  summary TEXT,                    -- 可选 LLM 摘要（≤200 字）
  created_at TEXT NOT NULL
);
```

#### 表：`works` 新增列
```sql
ALTER TABLE works ADD COLUMN queue_state TEXT;       -- 'main' | 'parked' | 'queued'
ALTER TABLE works ADD COLUMN launched_at TEXT;
ALTER TABLE works ADD COLUMN last_active_at TEXT;
ALTER TABLE works ADD COLUMN priority INTEGER DEFAULT 0;
ALTER TABLE works ADD COLUMN cover_image TEXT;
ALTER TABLE works ADD COLUMN recording_path TEXT;
ALTER TABLE works ADD COLUMN video_mp4_path TEXT;
ALTER TABLE works ADD COLUMN video_thumb_path TEXT;
```

> ALTER TABLE ADD COLUMN 在 SQLite 中**不幂等**：第二次启动若字段已存在会抛 `duplicate column`。`store.migrate()` 已用 `try/catch` 容忍此错误，可放心多次启动。

### 验证迁移成功

打开 SQLite CLI 或 `sqlite3` 工具：

```bash
sqlite3 "%APPDATA%/Rokit/ai-launch-master.db" "PRAGMA user_version;"
# 应输出 3

sqlite3 "%APPDATA%/Rokit/ai-launch-master.db" ".schema feedback"
# 应看到完整 feedback 表定义

sqlite3 "%APPDATA%/Rokit/ai-launch-master.db" "SELECT name FROM PRAGMA_TABLE_INFO('works') WHERE name='queue_state';"
# 应输出 queue_state
```

---

## 四、主推队列（v1.5 新增）

### 状态机

```
launching (0)  ──┐
                 │
pending (1)   ──┤  按 status 优先级 + priority DESC + launched_at ASC 排序
                 │
operating (2)  ──┤
                 │
stable (3)     ──┤  ageDays >= 14 → 排除
                 │
archived (4)   ─── 排除
```

`queue_state`（在 `works` 表中独立字段）：
- `main`：当前主推（同时只能有 1 个）
- `parked`：曾是主推但被替换
- `queued`：候选池

### 升级后默认行为

v1.5 启动时调用 `queue.schedule(store)`：
1. 拉取所有 `works`
2. 应用排序规则选出主推 → mutate `works[i].queue_state = 'main'`
3. 旧主推标 `parked`
4. 写回 SQLite

升级前如果 works 表是空的（用户首次升级）→ schedule 返回 `{main: null, demoted: [], promoted: []}`，UI 不显示主推。

升级前已经有作品 → 按状态优先级自动选出主推，**用户无需操作**。

---

## 五、示例作品迁移（v0.1.1 → v1.5）

v0.1.1 的「示例作品」会写入 SQLite（4 个：`sample_*` 前缀）。v1.5 的 store 在 `saveWork()` 中拦截：

```js
if (work.id && /^sample_/.test(String(work.id))) {
  return work;  // 静默跳过
}
```

升级后：
- 旧示例作品仍在 SQLite 里（不影响功能）
- 新的 UI 不再渲染它们（UI 只显示 `state.works.filter(w => !w.isSample)`）
- 用户可手动删除：`DELETE FROM works WHERE id LIKE 'sample_%';`

> 推荐：升级后跑一次上述 SQL 清理，避免数据看板计数偏差。

---

## 六、发布记录（pub_log → pubs）

v0.x 的发布记录在 SQLite 中以 `pub_log` 字段保存（部分早期版本）。v1.5 的 store 在 `addPub()` 时**双写**：

```js
// 同时写 pub_log JSON 字段（兼容 v0.x UI）+ pubs 表（新）
addPub({ work_id, platform, title, body }) → INSERT INTO pubs + UPDATE works SET pub_log = ?
```

升级后：
- 旧发布记录（仅在 pub_log）→ UI 读取 `state.pubLog = JSON.parse(works.pub_log)`，仍可见
- 新发布记录 → 写 pubs 表 + 回填 pub_log

---

## 七、回滚与排查

### 7.1 迁移失败的常见原因

| 现象 | 可能原因 | 排查方法 |
|---|---|---|
| 启动白屏 / 卡 onboarding | SQLite 文件被其他进程占用 | 关闭所有 Rokit 实例 + 删除 `%APPDATA%/Rokit/ai-launch-master.db-wal` / `.db-shm` 后重启 |
| 「未配置 API」始终不消失 | keytar 加载失败（缺少原生构建） | 查看 `%APPDATA%/Rokit/logs/rokit.log` 中 `[secrets] keytar 模块加载失败` 警告；Windows 应自动安装，Linux 需 `apt install libsecret-1-dev` |
| 数据看板 KPI 全是 0 | 旧 fake 数据未清理 | 跑 `DELETE FROM works WHERE id LIKE 'sample_%';` |
| 主推始终为空 | 所有作品都是 `archived` 状态 | `UPDATE works SET status = 'launching' WHERE id = 'YOUR_ID';` |
| pub_log 与 pubs 表数据不一致 | v0.x 升级路径 + 多次手动发布 | 跑 `INSERT INTO pubs (work_id, platform, title, body, created_at) SELECT work_id, platform, title, body, created_at FROM ...` 同步 |

### 7.2 完整回退到 v0.x（生产前请三思）

不建议。若必须：

1. **保留数据**：导出 `%APPDATA%/Rokit/ai-launch-master.db` 备份
2. **回退版本**：重新安装 Rokit v0.x
3. **API Key 丢失**：v1.5 把 api_key 从 SQLite 清空，v0.x 无法读取 → 需在 v0.x 设置弹窗重新填一次
4. **works 字段丢失**：queue_state / priority 等 v1.5 新字段在 v0.x 不识别 → v0.x 会忽略这些字段，不报错

---

## 八、给开发者的迁移脚本参考

如果你要在 CI / 自动化中处理用户升级：

```js
const { Store } = require('./electron/store');

// 1) 创建实例，自动跑 migrate()
const store = new Store(dbPath);

// 2) 检查 schema 版本
const version = store.getSchemaVersion();  // 应为 3
if (version !== 3) {
  console.error('Migration incomplete:', version);
  process.exit(1);
}

// 3) 触发 API Key 明文迁移
const r = await require('./electron/secrets').migratePlaintextApiKey(store);
console.log('Migrated:', r);

// 4) 触发主推队列调度
const q = await require('./electron/queue').schedule(store);
console.log('Main:', q.main);
```

---

## 九、迁移 checklist（QA 验收用）

升级 v1.5 后在测试机上跑一遍：

- [ ] 启动约 1s 内完成（迁移 + 调度）
- [ ] `%APPDATA%/Rokit/logs/rokit.log` 无 ERROR 级别日志
- [ ] `PRAGMA user_version` 返回 3
- [ ] `settings.api_key` 为空（迁移成功）
- [ ] `cmdkey /list | findstr Rokit` 能看到凭据条目
- [ ] 数据看板 BYOK chip 显示「● 模型 + GitHub PAT」或「● 未配置 API」
- [ ] 设置弹窗里 cfgKey 输入框留空、cfgGithubPat 输入框留空、cfgGithubPatHint 显示「● 已配置」
- [ ] 关闭应用再打开，凭据仍在（keytar 持久化生效）
- [ ] 跑 `npm test`（vitest）全绿，238 用例通过