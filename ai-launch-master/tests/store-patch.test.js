// Rokit · Store.saveWork PATCH 语义单元测试（v1.10）
//
// 修复背景：旧 saveWork 把"未传入"的字段默认 ''/'draft'/0，覆盖已有数据。
// 新行为：只更新传入对象**显式拥有**的字段；未传入的字段保留原值。
//
// 测试策略：直接 require electron/store.js，让 Store 跑在内存 SQLite 上。

const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-store-patch-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
  }
  try { fs.rmdirSync(tmpDir); } catch (_) {}
});

describe('Store.saveWork · PATCH 语义（v1.10）', () => {
  it('INSERT 新记录：使用传入的字段', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    expect(s.mode).toBe('sqlite');
    const r = s.saveWork({ id: 'w1', name: 'Rokit', type: '效率工具', url: 'https://github.com/u/r' });
    expect(r.name).toBe('Rokit');
    expect(r.url).toBe('https://github.com/u/r');
  });

  it('UPDATE 仅传 star：不重置 name/type/url', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'Rokit', type: '效率工具', url: 'https://github.com/u/r', star: 10 });
    // 模拟"GitHub Star 刷新时只传 id+star"的场景
    s.saveWork({ id: 'w1', star: 99 });
    const list = s.listWorks();
    expect(list[0].name).toBe('Rokit'); // 不应被覆盖
    expect(list[0].type).toBe('效率工具');
    expect(list[0].url).toBe('https://github.com/u/r');
    expect(list[0].star).toBe(99);
  });

  it('UPDATE 仅传 id+star+dl：不重置 name/type/url', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'Rokit', type: '工具', url: 'https://github.com/u/r' });
    s.saveWork({ id: 'w1', star: 50, dl: 200 });
    const list = s.listWorks();
    expect(list[0].name).toBe('Rokit');
    expect(list[0].type).toBe('工具');
    expect(list[0].url).toBe('https://github.com/u/r');
    expect(list[0].star).toBe(50);
    expect(list[0].dl).toBe(200);
  });

  it('UPDATE 显式传 name=""：把 name 清空（PATCH 语义：传入即更新）', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'Rokit' });
    s.saveWork({ id: 'w1', name: '' });
    const list = s.listWorks();
    expect(list[0].name).toBe('');
  });

  it('UPDATE 多次：字段独立更新，不互相干扰', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'A', type: 't1', url: 'u1', star: 1, dl: 2 });
    s.saveWork({ id: 'w1', star: 11 });
    s.saveWork({ id: 'w1', dl: 22 });
    s.saveWork({ id: 'w1', url: 'https://github.com/x/y' });
    const list = s.listWorks();
    expect(list[0].name).toBe('A');
    expect(list[0].type).toBe('t1');
    expect(list[0].url).toBe('https://github.com/x/y');
    expect(list[0].star).toBe(11);
    expect(list[0].dl).toBe(22);
  });

  it('UPDATE 不会重置 updated_at 为更早时间', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'A' });
    const t0 = s.listWorks()[0].updated_at;
    // 等几毫秒
    const later = new Date(Date.now() + 10).toISOString();
    s.saveWork({ id: 'w1', star: 1 });
    const t1 = s.listWorks()[0].updated_at;
    expect(t1 >= t0).toBe(true);
    expect(later >= t0).toBe(true); // sanity
  });

  it('INSERT 默认值兜底：未传入字段用空/0', () => {
    const { Store } = require('../electron/store');
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'OnlyName' });
    const list = s.listWorks();
    expect(list[0].name).toBe('OnlyName');
    expect(list[0].type).toBe('');
    expect(list[0].url).toBe('');
    expect(list[0].star).toBe(0);
    expect(list[0].dl).toBe(0);
  });
});
