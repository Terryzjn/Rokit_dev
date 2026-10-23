// Rokit · Store 防御性 schema 补全单元测试
//
// 背景：
//   旧 db 可能被早期版本设到 user_version=5 但缺 yt_url 列（"逻辑 v5 物理缺列"）。
//   修复方案：store.js 在 migrate() 早返前调用 ensureWorksColumns()，
//   扫描 PRAGMA table_info，缺的列就地补上（幂等）。
//
// 测试策略：
//   1) 直接用 node-sqlite 构造一个 user_version=5 但缺列的"旧 db"
//   2) 通过 Module._load 钩子强制 better-sqlite3 抛错，回退到 node-sqlite
//   3) 实例化 Store → 期望列被自动补齐
//   4) saveWork 写入含 yt_url 的记录，重新读取必须持久化
//   5) 重新实例化 Store（模拟应用重启）必须仍然存在该记录

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-yt-repair-'));
  dbPath = path.join(tmpDir, 'simulated.db');

  // Force better-sqlite3 to throw → fallback to node-sqlite
  delete require.cache[require.resolve('better-sqlite3')];
  const origLoad = Module._load;
  Module._load = function (req, _parent, _isMain) {
    if (req === 'better-sqlite3') throw new Error('forced-fallback');
    return origLoad.apply(this, arguments);
  };
  // Build a simulated "old database" with user_version=5 but missing v3+ columns
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE works (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, intro TEXT, url TEXT,
      status TEXT, queue TEXT, star INTEGER DEFAULT 0, dl INTEGER DEFAULT 0,
      play TEXT DEFAULT '0', next TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO works (id, name, type, url, star, dl)
      VALUES ('legacy-1', '老作品 A', '效率工具', 'https://github.com/u/old1', 42, 17);
    INSERT INTO works (id, name, type, url, star, dl)
      VALUES ('legacy-2', '老作品 B', '笔记工具', 'https://github.com/u/old2', 5, 0);
    INSERT INTO works (id, name, type, url, star, dl, status, created_at, updated_at)
      VALUES ('legacy-3', '老作品 C', '其他工具', 'https://github.com/u/old3', 99, 31, 'launching', '2026-09-15T08:00:00Z', '2026-09-15T08:00:00Z');
    PRAGMA user_version = 5;
  `);
  raw.close();
});

afterEach(() => {
  // clean up
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  try { fs.rmdirSync(tmpDir); } catch (_) {}
  // Reset Module._load so other tests aren't affected
  // (vitest re-requires modules anyway, so this is defensive)
});

describe('Store · 防御性 schema 补全', () => {
  it('"逻辑 v5 物理缺列" 旧库首次实例化时自动补齐 yt_url / yt_views / yt_updated_at', () => {
    const { Store } = require('../electron/store');
    const store = new Store(dbPath);
    expect(store.mode).toBe('sqlite');
    const cols = store.all('PRAGMA table_info(works)').map((c) => c.name);
    expect(cols).toContain('yt_url');
    expect(cols).toContain('yt_views');
    expect(cols).toContain('yt_updated_at');
  });

  it('补齐列时不影响预存行的 star/dl/name/status 等老字段', () => {
    const { Store } = require('../electron/store');
    const store = new Store(dbPath);
    const list = store.listWorks();
    expect(list).toHaveLength(3);
    const a = list.find((w) => w.id === 'legacy-1');
    expect(a.name).toBe('老作品 A');
    expect(Number(a.star)).toBe(42);
    expect(Number(a.dl)).toBe(17);
    const c = list.find((w) => w.id === 'legacy-3');
    expect(c.status).toBe('launching');
  });

  it('works:save 现在可以写入 yt_url 字段（不再抛 SqliteError: no such column: yt_url）', () => {
    const { Store } = require('../electron/store');
    const store = new Store(dbPath);
    const r = store.saveWork({
      id: 'new-1',
      name: '新作品',
      type: 'AI 应用',
      url: 'https://github.com/u/new1',
      yt_url: 'https://www.youtube.com/watch?v=abcd1234',
      yt_views: 12345
    });
    expect(r).toBeTruthy();
    expect(r.id).toBe('new-1');
    expect(r.yt_url).toBe('https://www.youtube.com/watch?v=abcd1234');
    expect(Number(r.yt_views)).toBe(12345);
  });

  it('应用重启后再次读取：yt_url/yt_views 必须从磁盘还原', () => {
    const { Store } = require('../electron/store');
    const s1 = new Store(dbPath);
    s1.saveWork({
      id: 'persist-1',
      name: '持久化测试',
      type: '工具',
      url: 'https://github.com/u/persist',
      yt_url: 'https://youtu.be/persist',
      yt_views: 9999
    });
    // 模拟应用重启：清掉 require cache 后重新 Store 实例化
    delete require.cache[require.resolve('../electron/store')];
    const storeMod2 = require('../electron/store');
    const s2 = new storeMod2.Store(dbPath);
    const list = s2.listWorks();
    const row = list.find((w) => w.id === 'persist-1');
    expect(row).toBeTruthy();
    expect(row.yt_url).toBe('https://youtu.be/persist');
    expect(Number(row.yt_views)).toBe(9999);
  });

  it('ensureWorksColumns 幂等：第二次实例化不会再触发 ALTER（重复启动不报错）', () => {
    const { Store } = require('../electron/store');
    new Store(dbPath);
    delete require.cache[require.resolve('../electron/store')];
    const storeMod2 = require('../electron/store');
    // 第二次实例化必须成功，不能抛 duplicate column name
    expect(() => new storeMod2.Store(dbPath)).not.toThrow();
  });
});
