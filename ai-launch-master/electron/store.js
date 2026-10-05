// Rokit · 本地存储层（SQLite 优先，JSON 文件兜底）
// 设计目标：本地优先、无云端。作品 / 发布记录 / 设置全部存在本地。
// 驱动优先级：better-sqlite3（若已安装）→ Node 内置 node:sqlite（Electron 36+）→ JSON 文件

const fs = require('fs');
const path = require('path');

// 当前 schema 版本号。修改表结构时需追加新迁移，勿直接修改旧迁移。
//   v1：初始表结构
//   v2：新增 channels 表
//   v3：PRD 第七节「作品库 + 主推队列」与第十节「反馈闭环」
const CURRENT_VERSION = 3;

let Database = null;
let driver = null;
try {
  Database = require('better-sqlite3');
  driver = 'better-sqlite3';
} catch (_e) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    Database = DatabaseSync;
    driver = 'node-sqlite';
  } catch (_e2) {
    Database = null;
    driver = null;
  }
}

// ---------- 迁移列表（按版本号顺序）----------
// 每个迁移函数接收 db 实例（提供 run / get / all / exec 驱动无关接口）
const migrations = [
  {
    version: 1,
    up: function (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          base_url TEXT, api_key TEXT, model TEXT, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS works (
          id TEXT PRIMARY KEY, name TEXT, type TEXT, intro TEXT, url TEXT,
          status TEXT, queue TEXT, star INTEGER DEFAULT 0, dl INTEGER DEFAULT 0,
          play TEXT DEFAULT '0', next TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS pubs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, platform TEXT,
          title TEXT, body TEXT, tags TEXT, time TEXT, created_at TEXT
        );
      `);
    }
  },
  {
    // v2：新增推广渠道表。kind 为内置平台 id（github/ph/v2ex/...）或 'custom'。
    // enabled=0 时渠道在「首秀发射」中不出现；api_base / api_key / webhook 仅对 custom 生效。
    version: 2,
    up: function (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          api_base TEXT,
          api_key TEXT,
          webhook TEXT,
          tag TEXT,
          note TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
    }
  },
  {
    // v3：支撑 PRD 第七节「作品库 + 主推队列」与第十节「反馈闭环」。
    //   works:     状态机 status(queue_state 已扩展为 queue_state) + priority + launched_at
    //   milestones: 里程碑报喜去重表
    //   feedback:  GitHub Issues / V2EX 评论增量采集原始数据
    //   feedback_clusters: AI 聚类输出
    //   metrics_daily: 每日聚合指标
    //   settings_kv: 适配器健康度等独立 KV（不污染 settings 单行表）
    // 同时将 settings.api_key 标记为「废弃」（明文迁移提示用），详见 secrets.js。
    version: 3,
    up: function (db) {
      // works 表使用 ALTER TABLE ADD COLUMN（SQLite 不支持 IF NOT EXISTS ADD COLUMN），
      // 重复执行迁移时通过 try/catch 容忍「duplicate column name」。
      const alterWorks = [
        "ALTER TABLE works ADD COLUMN queue_state TEXT DEFAULT 'queued'",
        "ALTER TABLE works ADD COLUMN priority INTEGER DEFAULT 0",
        "ALTER TABLE works ADD COLUMN launched_at TEXT",
        "ALTER TABLE works ADD COLUMN last_active_at TEXT"
      ];
      for (const sql of alterWorks) {
        try { db.exec(sql); } catch (_e) { /* 列已存在 */ }
      }
      // 存量作品补全默认状态（status 列已存在但旧值是 'draft'/'launching'/'archived' 等自由文本）
      try {
        db.exec("UPDATE works SET queue_state = COALESCE(queue_state,'queued')");
        db.exec("UPDATE works SET status = CASE WHEN status IN ('launching','operating','stable','pending','archived') THEN status ELSE 'launching' END");
      } catch (_e) {}

      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          type TEXT,
          value INTEGER,
          reached_at TEXT,
          notified INTEGER DEFAULT 0
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          source TEXT,
          external_id TEXT,
          author TEXT,
          url TEXT,
          content TEXT,
          sentiment TEXT,
          category TEXT,
          priority TEXT,
          cluster_id TEXT,
          fetched_at TEXT,
          UNIQUE(source, external_id)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_clusters (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          title TEXT,
          count INTEGER DEFAULT 0,
          priority TEXT,
          sample_ids TEXT,
          summary TEXT,
          created_at TEXT
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_daily (
          work_id TEXT,
          date TEXT,
          platform TEXT,
          views INTEGER DEFAULT 0,
          stars INTEGER DEFAULT 0,
          comments INTEGER DEFAULT 0,
          PRIMARY KEY (work_id, date, platform)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings_kv (
          k TEXT PRIMARY KEY,
          v TEXT,
          updated_at TEXT
        );
      `);
    }
  }
];

class Store {
  constructor(file) {
    this.file = file;
    // better-sqlite3 要求父目录已存在；兜底创建，避免全新环境首次启动失败
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_e) {}
    if (driver) {
      this.mode = 'sqlite';
      this.driver = driver;
      this.db = new Database(file);
      try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch (_e) {}
      this.migrate();
    } else {
      this.mode = 'json';
      this.jsonFile = path.join(path.dirname(file), 'ai-launch-master-data.json');
      this.data = this.loadJson();
      this.version = CURRENT_VERSION; // JSON 兜底模式下视为最新
    }
  }

  // ---------- 驱动无关的执行封装 ----------
  run(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).run(...args);
    const st = this.db.prepare(sql);
    try { return st.run(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  get(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).get(...args);
    const st = this.db.prepare(sql);
    try { return st.get(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  all(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).all(...args);
    const st = this.db.prepare(sql);
    try { return st.all(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  exec(sql) {
    // 两个驱动都提供 .exec()，无需分支
    return this.db.exec(sql);
  }

  // ---------- SQLite 迁移 ----------
  migrate() {
    // 读取当前 schema 版本（PRAGMA user_version）
    let currentVersion = 0;
    try {
      const row = this.get('PRAGMA user_version');
      currentVersion = row && typeof row.user_version === 'number' ? row.user_version : 0;
    } catch (_e) {
      currentVersion = 0;
    }
    this.version = currentVersion;

    // 已是最新版本则跳过
    if (currentVersion >= CURRENT_VERSION) return;

    // 按顺序应用所有 pending 迁移
    for (const m of migrations) {
      if (m.version <= currentVersion) continue;
      if (m.version > CURRENT_VERSION) {
        console.error('[store] migration version ' + m.version + ' exceeds CURRENT_VERSION ' + CURRENT_VERSION + ', skipping');
        continue;
      }
      try {
        // better-sqlite3 显式事务；node:sqlite DatabaseSync.exec 本身在事务中
        if (this.driver === 'better-sqlite3') {
          this.db.exec('BEGIN');
        }
        m.up(this);
        if (this.driver === 'better-sqlite3') {
          this.db.exec('COMMIT');
        }
        // 设置 user_version（标准 SQLite 迁移习惯）
        this.run('PRAGMA user_version = ' + m.version);
        this.version = m.version;
      } catch (e) {
        try {
          if (this.driver === 'better-sqlite3') {
            this.db.exec('ROLLBACK');
          }
        } catch (_e2) {}
        throw new Error('migration v' + m.version + ' failed: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  // ---------- JSON 兜底 ----------
  loadJson() {
    const empty = {
      settings: null, works: [], pubs: [], channels: [],
      milestones: [], feedback: [], feedback_clusters: [], metrics_daily: [], settings_kv: {}
    };
    try {
      if (fs.existsSync(this.jsonFile)) {
        return Object.assign(empty, JSON.parse(fs.readFileSync(this.jsonFile, 'utf8')));
      }
    } catch (_e) {}
    return empty;
  }
  saveJson() {
    try { fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2)); } catch (_e) {}
  }

  // ---------- 设置（BYOK） ----------
  // 注：自 v1.5 起，api_key 不再写入 SQLite。改为由 secrets.js 写入 Windows 凭据管理器（DPAPI）。
  // 这里仍保留对 base_url / model 的存储；迁移过程中若发现 settings.api_key 仍存在，
  // 由 main.js 触发一次性明文迁移（详见 secrets.migratePlaintextApiKey）。
  getSettings() {
    const def = { base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', updated_at: '' };
    if (this.mode === 'sqlite') {
      const row = this.get('SELECT base_url, api_key, model, updated_at FROM settings WHERE id = 1');
      return row
        ? { base_url: row.base_url, api_key: row.api_key || '', model: row.model, updated_at: row.updated_at }
        : def;
    }
    const s = this.data.settings || def;
    return { base_url: s.base_url, api_key: s.api_key || '', model: s.model, updated_at: s.updated_at };
  }
  saveSettings(s) {
    const now = new Date().toISOString();
    const row = {
      base_url: (s && s.base_url) || 'https://api.deepseek.com/v1',
      api_key: (s && s.api_key) || '',
      model: (s && s.model) || 'deepseek-chat',
      updated_at: now
    };
    if (this.mode === 'sqlite') {
      // v1.5 起仅写入 base_url / model，api_key 一律由 secrets.js 负责
      // 仍保留 api_key 列的写入，仅当调用方显式传入时（例如一次性迁移或回退路径）
      this.run(`
        INSERT INTO settings (id, base_url, api_key, model, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          base_url = excluded.base_url, api_key = excluded.api_key,
          model = excluded.model, updated_at = excluded.updated_at
      `, [1, row.base_url, row.api_key, row.model, row.updated_at]);
    } else {
      this.data.settings = row;
      this.saveJson();
    }
    return this.getSettings();
  }
  // 显式清空 settings.api_key（迁移完成后调用）。返回受影响行数。
  clearPlaintextApiKey() {
    if (this.mode === 'sqlite') {
      const r = this.run("UPDATE settings SET api_key = '' WHERE id = 1");
      return r && typeof r.changes === 'number' ? r.changes : 1;
    }
    if (this.data.settings) this.data.settings.api_key = '';
    this.saveJson();
    return 1;
  }

  // ---------- 作品 ----------
  listWorks() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM works ORDER BY created_at ASC');
    }
    return this.data.works;
  }
  saveWork(w) {
    if (!w || !w.id) return w;
    const row = {
      id: w.id, name: w.name || '', type: w.type || '', intro: w.intro || '',
      url: w.url || '', status: w.status || 'draft', queue: w.queue || '0',
      queue_state: w.queue_state || 'queued',
      priority: Number(w.priority) || 0,
      launched_at: w.launched_at || null,
      last_active_at: w.last_active_at || null,
      star: Number(w.star) || 0, dl: Number(w.dl) || 0,
      play: String(w.play || '0'), next: w.next || '',
      created_at: w.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (this.mode === 'sqlite') {
      this.run(`
        INSERT INTO works (id, name, type, intro, url, status, queue, queue_state, priority, launched_at, last_active_at, star, dl, play, next, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, type=excluded.type, intro=excluded.intro, url=excluded.url,
          status=excluded.status, queue=excluded.queue, queue_state=excluded.queue_state, priority=excluded.priority,
          launched_at=COALESCE(excluded.launched_at, works.launched_at),
          last_active_at=excluded.last_active_at,
          star=excluded.star, dl=excluded.dl,
          play=excluded.play, next=excluded.next, updated_at=excluded.updated_at
      `, [row.id, row.name, row.type, row.intro, row.url, row.status, row.queue, row.queue_state, row.priority, row.launched_at, row.last_active_at, row.star, row.dl, row.play, row.next, row.created_at, row.updated_at]);
    } else {
      const i = this.data.works.findIndex(x => x.id === row.id);
      if (i >= 0) {
        // JSON 兜底：合并保留旧字段（不覆盖 launched_at 为空时）
        const old = this.data.works[i];
        this.data.works[i] = Object.assign({}, old, row);
        if (!row.launched_at) this.data.works[i].launched_at = old.launched_at || null;
      } else this.data.works.push(row);
      this.saveJson();
    }
    return row;
  }
  deleteWork(id) {
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM works WHERE id = ?', [id]);
      this.run('DELETE FROM pubs WHERE work_id = ?', [id]);
    } else {
      this.data.works = this.data.works.filter(w => w.id !== id);
      this.data.pubs = this.data.pubs.filter(p => p.work_id !== id);
      this.saveJson();
    }
    return true;
  }

  // ---------- 发布记录 ----------
  listPubs() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM pubs ORDER BY created_at DESC');
    }
    return this.data.pubs;
  }
  addPub(r) {
    const row = {
      work_id: (r && r.work_id) || '', platform: (r && r.platform) || '',
      title: (r && r.title) || '', body: (r && r.body) || '',
      tags: (r && r.tags) || '', time: (r && r.time) || '',
      created_at: new Date().toISOString()
    };
    if (this.mode === 'sqlite') {
      this.run(
        'INSERT INTO pubs (work_id, platform, title, body, tags, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.work_id, row.platform, row.title, row.body, row.tags, row.time, row.created_at]
      );
    } else {
      this.data.pubs.push(row);
      this.saveJson();
    }
    return row;
  }

  // ---------- 推广渠道 ----------
  // 列出所有渠道（按 created_at 升序，让用户后加的显示在下面，UI 可自行重排）
  listChannels() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM channels ORDER BY created_at ASC');
    }
    return Array.isArray(this.data.channels) ? this.data.channels : [];
  }
  // upsert：缺 id 自动生成；enabled 强制 0/1；空字符串统一存 null 便于搜索
  saveChannel(c) {
    if (!c || !c.name || !c.kind) throw new Error('渠道名称与类型必填');
    const norm = function (v) {
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      return s ? s : null;
    };
    const now = new Date().toISOString();
    const row = {
      id: c.id || ('ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: String(c.name).trim(),
      kind: String(c.kind).trim(),
      enabled: c.enabled === false || c.enabled === 0 || c.enabled === '0' ? 0 : 1,
      api_base: norm(c.api_base),
      api_key: norm(c.api_key),
      webhook: norm(c.webhook),
      tag: norm(c.tag),
      note: norm(c.note),
      created_at: c.created_at || now,
      updated_at: now
    };
    if (this.mode === 'sqlite') {
      this.run(`
        INSERT INTO channels (id, name, kind, enabled, api_base, api_key, webhook, tag, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, kind=excluded.kind, enabled=excluded.enabled,
          api_base=excluded.api_base, api_key=excluded.api_key, webhook=excluded.webhook,
          tag=excluded.tag, note=excluded.note, updated_at=excluded.updated_at
      `, [row.id, row.name, row.kind, row.enabled, row.api_base, row.api_key, row.webhook, row.tag, row.note, row.created_at, row.updated_at]);
    } else {
      // JSON 兜底：找到同 id 则替换，否则追加
      if (!Array.isArray(this.data.channels)) this.data.channels = [];
      const i = this.data.channels.findIndex(function (x) { return x.id === row.id; });
      if (i >= 0) this.data.channels[i] = row; else this.data.channels.push(row);
      this.saveJson();
    }
    return row;
  }
  deleteChannel(id) {
    if (!id) return false;
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM channels WHERE id = ?', [id]);
    } else {
      this.data.channels = (this.data.channels || []).filter(function (c) { return c.id !== id; });
      this.saveJson();
    }
    return true;
  }

  // ---------- 里程碑 ----------
  // type: first_star / first_download / first_review / first_100 ...
  addMilestone(m) {
    const row = {
      id: m.id || ('ms_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      work_id: m.work_id || '',
      type: m.type || '',
      value: Number(m.value) || 0,
      reached_at: m.reached_at || new Date().toISOString(),
      notified: m.notified ? 1 : 0
    };
    if (this.mode === 'sqlite') {
      this.run('INSERT OR IGNORE INTO milestones (id, work_id, type, value, reached_at, notified) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, row.work_id, row.type, row.value, row.reached_at, row.notified]);
    } else {
      if (!Array.isArray(this.data.milestones)) this.data.milestones = [];
      if (!this.data.milestones.find(function (x) { return x.id === row.id; })) this.data.milestones.push(row);
      this.saveJson();
    }
    return row;
  }
  listMilestones(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM milestones WHERE work_id = ? ORDER BY reached_at DESC', [workId]);
      return this.all('SELECT * FROM milestones ORDER BY reached_at DESC');
    }
    return (this.data.milestones || []).filter(function (m) { return !workId || m.work_id === workId; });
  }
  markMilestoneNotified(id) {
    if (this.mode === 'sqlite') {
      this.run('UPDATE milestones SET notified = 1 WHERE id = ?', [id]);
    } else {
      const i = (this.data.milestones || []).findIndex(function (m) { return m.id === id; });
      if (i >= 0) { this.data.milestones[i].notified = 1; this.saveJson(); }
    }
  }

  // ---------- 反馈原始数据 ----------
  // upsertFeedback：增量写入；同 (source, external_id) 会被忽略
  upsertFeedback(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    let n = 0;
    if (this.mode === 'sqlite') {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO feedback (id, work_id, source, external_id, author, url, content, sentiment, category, priority, cluster_id, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const f of items) {
        const row = {
          id: f.id || ('fb_' + (f.source || '') + '_' + (f.external_id || '') + '_' + Math.random().toString(36).slice(2, 6)),
          work_id: f.work_id || '',
          source: f.source || '',
          external_id: String(f.external_id || ''),
          author: f.author || '',
          url: f.url || '',
          content: (f.content || '').slice(0, 4000),
          sentiment: f.sentiment || '',
          category: f.category || '',
          priority: f.priority || '',
          cluster_id: f.cluster_id || '',
          fetched_at: f.fetched_at || new Date().toISOString()
        };
        try {
          let res = null;
          if (this.driver === 'better-sqlite3') res = stmt.run(row.id, row.work_id, row.source, row.external_id, row.author, row.url, row.content, row.sentiment, row.category, row.priority, row.cluster_id, row.fetched_at);
          else { res = stmt.run([row.id, row.work_id, row.source, row.external_id, row.author, row.url, row.content, row.sentiment, row.category, row.priority, row.cluster_id, row.fetched_at]); }
          // INSERT OR IGNORE 静默跳过重复时 changes 为 0；仅在真正插入时 n++
          if (res && typeof res.changes === 'number') {
            if (res.changes > 0) n++;
          } else {
            n++;
          }
        } catch (_e) { try { stmt.finalize(); } catch (_e2) {} }
      }
      try { stmt.finalize(); } catch (_e) {}
    } else {
      if (!Array.isArray(this.data.feedback)) this.data.feedback = [];
      for (const f of items) {
        const dup = this.data.feedback.find(function (x) { return x.source === (f.source || '') && x.external_id === String(f.external_id || ''); });
        if (dup) continue;
        this.data.feedback.push({
          id: f.id || ('fb_' + (f.source || '') + '_' + (f.external_id || '') + '_' + Math.random().toString(36).slice(2, 6)),
          work_id: f.work_id || '',
          source: f.source || '',
          external_id: String(f.external_id || ''),
          author: f.author || '',
          url: f.url || '',
          content: (f.content || '').slice(0, 4000),
          sentiment: f.sentiment || '',
          category: f.category || '',
          priority: f.priority || '',
          cluster_id: f.cluster_id || '',
          fetched_at: f.fetched_at || new Date().toISOString()
        });
        n++;
      }
      this.saveJson();
    }
    return n;
  }
  listFeedback(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM feedback WHERE work_id = ? ORDER BY fetched_at DESC', [workId]);
      return this.all('SELECT * FROM feedback ORDER BY fetched_at DESC');
    }
    return (this.data.feedback || []).filter(function (f) { return !workId || f.work_id === workId; });
  }

  // ---------- 反馈聚类（AI 写入） ----------
  saveFeedbackClusters(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM feedback_clusters WHERE work_id = ?', [items[0].work_id || '']);
      for (const c of items) {
        this.run(`INSERT INTO feedback_clusters (id, work_id, title, count, priority, sample_ids, summary, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.id, c.work_id, c.title, Number(c.count) || 0, c.priority || 'P2',
           JSON.stringify(c.sample_ids || []), c.summary || '',
           c.created_at || new Date().toISOString()]);
      }
    } else {
      if (!Array.isArray(this.data.feedback_clusters)) this.data.feedback_clusters = [];
      const wid = items[0].work_id || '';
      this.data.feedback_clusters = this.data.feedback_clusters.filter(function (c) { return c.work_id !== wid; });
      for (const c of items) this.data.feedback_clusters.push(c);
      this.saveJson();
    }
    return items.length;
  }
  listFeedbackClusters(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM feedback_clusters WHERE work_id = ? ORDER BY CASE priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 ELSE 2 END, count DESC', [workId]);
      return this.all('SELECT * FROM feedback_clusters ORDER BY CASE priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 ELSE 2 END, count DESC');
    }
    return (this.data.feedback_clusters || []).filter(function (c) { return !workId || c.work_id === workId; });
  }

  // ---------- 每日指标 ----------
  bumpMetric(workId, date, platform, fields) {
    if (!workId || !date || !platform) return null;
    const keys = ['views', 'stars', 'comments'];
    if (this.mode === 'sqlite') {
      const existing = this.get('SELECT * FROM metrics_daily WHERE work_id = ? AND date = ? AND platform = ?', [workId, date, platform]);
      if (existing) {
        const updates = keys.map(function (k) {
          return k + ' = ' + (Number(existing[k]) || 0) + (fields && Number(fields[k]) > 0 ? ' + ' + Number(fields[k]) : ' + 0');
        }).join(', ');
        this.run('UPDATE metrics_daily SET ' + updates + ' WHERE work_id = ? AND date = ? AND platform = ?', [workId, date, platform]);
      } else {
        const row = { views: 0, stars: 0, comments: 0 };
        if (fields) keys.forEach(function (k) { row[k] = Number(fields[k]) || 0; });
        this.run('INSERT INTO metrics_daily (work_id, date, platform, views, stars, comments) VALUES (?, ?, ?, ?, ?, ?)',
          [workId, date, platform, row.views, row.stars, row.comments]);
      }
    } else {
      if (!Array.isArray(this.data.metrics_daily)) this.data.metrics_daily = [];
      const idx = this.data.metrics_daily.findIndex(function (m) { return m.work_id === workId && m.date === date && m.platform === platform; });
      if (idx >= 0) {
        keys.forEach(function (k) {
          this.data.metrics_daily[idx][k] = (Number(this.data.metrics_daily[idx][k]) || 0) + (fields ? Number(fields[k]) || 0 : 0);
        }.bind(this));
      } else {
        const row = { work_id: workId, date: date, platform: platform, views: 0, stars: 0, comments: 0 };
        if (fields) keys.forEach(function (k) { row[k] = Number(fields[k]) || 0; });
        this.data.metrics_daily.push(row);
      }
      this.saveJson();
    }
  }
  listMetrics(workId, days) {
    days = Number(days) || 30;
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM metrics_daily WHERE work_id = ? ORDER BY date DESC LIMIT ?', [workId, days * 20]);
      return this.all('SELECT * FROM metrics_daily ORDER BY date DESC LIMIT ?', [days * 20]);
    }
    return (this.data.metrics_daily || []).slice(-days * 20);
  }

  // ---------- 适配器健康度 ----------
  // 用 settings 表的 base_url 字段不冲突；这里新增独立表 settings_kv（key-value）
  ensureSettingsKvTable() {
    if (this.mode === 'sqlite') {
      try {
        this.run(`CREATE TABLE IF NOT EXISTS settings_kv (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)`);
      } catch (_e) {}
    }
  }
  upsertSettingKv(key, value) {
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      this.run('INSERT INTO settings_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
        [key, value == null ? null : String(value), new Date().toISOString()]);
    } else {
      if (!this.data.settings_kv) this.data.settings_kv = {};
      this.data.settings_kv[key] = value;
      this.saveJson();
    }
  }
  getSettingKv(key) {
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      const row = this.get('SELECT v FROM settings_kv WHERE k = ?', [key]);
      return row ? row.v : null;
    }
    return this.data.settings_kv ? this.data.settings_kv[key] : null;
  }
}

module.exports = { Store, CURRENT_VERSION, migrations };