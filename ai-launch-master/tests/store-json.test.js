// Rokit · Store 层 JSON 兜底模式单元测试
// 覆盖：settings/works/pubs/channels 在 JSON 驱动下的 CRUD、级联删除、损坏文件回退
// vitest 全局由 vitest.config.js globals:true 注入
// 当前测试环境默认有 node:sqlite，本文件通过 Module._load 钩子让 store.js 走 JSON 兜底
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 用 Module._load 钩子让 better-sqlite3 / node:sqlite "加载失败"，
// 强制 store.js 顶层 try/catch 进入 JSON 兜底分支。
// vitest 在 worker 线程跑测试，这里覆盖 Module._load 即可拦截该线程内的 require。
function installSqliteBlock() {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'better-sqlite3' || request === 'node:sqlite') {
      const e = new Error("Cannot find module '" + request + "'");
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    return orig.call(this, request, parent, isMain);
  };
  return function restore() { Module._load = orig; };
}

// 拿到清缓存后的 store 模块（避免被 sqlite 模式污染）
function loadStoreAsJson() {
  const id = require.resolve('../electron/store');
  delete require.cache[id];
  return require('../electron/store');
}

let tmpDir;
let dbPath;
let jsonFile;
let restoreSqlite;
let Store;

beforeEach(() => {
  restoreSqlite = installSqliteBlock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-store-json-'));
  dbPath = path.join(tmpDir, 'test.db');
  jsonFile = path.join(tmpDir, 'ai-launch-master-data.json');
  ({ Store } = loadStoreAsJson());
});

afterEach(() => {
  restoreSqlite();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  // 还原 store 缓存，让下一个测试前是干净状态
  const id = require.resolve('../electron/store');
  delete require.cache[id];
});

describe('Store JSON 兜底 · 初始化', () => {
  it('应当走 json 模式（sqlite 不可用时）', () => {
    const s = new Store(dbPath);
    expect(s.mode).toBe('json');
    expect(s.driver == null).toBe(true);
  });

  it('应将 jsonFile 指向 dbPath 同目录下的 ai-launch-master-data.json', () => {
    const s = new Store(dbPath);
    expect(s.jsonFile).toBe(path.join(path.dirname(dbPath), 'ai-launch-master-data.json'));
    expect(path.dirname(s.jsonFile)).toBe(tmpDir);
  });

  it('初次构造不应抛错（即使 jsonFile 不存在）', () => {
    expect(() => new Store(dbPath)).not.toThrow();
  });

  it('损坏的 JSON 文件应被静默回退到默认数据', () => {
    fs.writeFileSync(jsonFile, '{ broken json ::: ', 'utf8');
    const s = new Store(dbPath);
    expect(s.data.settings).toBeNull();
    expect(s.data.works).toEqual([]);
    expect(s.data.pubs).toEqual([]);
    expect(s.data.channels).toEqual([]);
  });
});

describe('Store JSON 兜底 · Settings', () => {
  it('默认应返回 deepseek 占位配置', () => {
    const s = new Store(dbPath);
    const out = s.getSettings();
    expect(out.base_url).toBe('https://api.deepseek.com/v1');
    expect(out.api_key).toBe('');
    expect(out.model).toBe('deepseek-chat');
  });

  it('saveSettings 后应落盘到 jsonFile', () => {
    const s = new Store(dbPath);
    s.saveSettings({ api_key: 'k1', model: 'm1', base_url: 'https://x.com/v1' });
    expect(fs.existsSync(jsonFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    expect(data.settings.api_key).toBe('k1');
    expect(data.settings.model).toBe('m1');
    expect(data.settings.base_url).toBe('https://x.com/v1');
  });

  it('部分字段缺失时应回退到默认值并写盘', () => {
    const s = new Store(dbPath);
    s.saveSettings({ api_key: 'only-key' });
    expect(s.getSettings().api_key).toBe('only-key');
    expect(s.getSettings().base_url).toBe('https://api.deepseek.com/v1');
    expect(s.getSettings().model).toBe('deepseek-chat');
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    expect(data.settings.api_key).toBe('only-key');
  });

  it('连续多次 saveSettings 应保持单条记录（upsert 语义）', () => {
    const s = new Store(dbPath);
    s.saveSettings({ api_key: 'k1' });
    s.saveSettings({ api_key: 'k2' });
    expect(s.getSettings().api_key).toBe('k2');
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    // 只应有 1 条 settings
    expect(data.settings.api_key).toBe('k2');
  });

  it('updated_at 字段应在每次保存时被刷新', () => {
    const s = new Store(dbPath);
    s.saveSettings({ api_key: 'a' });
    const t1 = s.getSettings().updated_at;
    expect(t1).toBeTruthy();
    // 等 10ms 保证 ISO 时间戳差
    return new Promise((resolve) => {
      setTimeout(() => {
        s.saveSettings({ api_key: 'b' });
        const t2 = s.getSettings().updated_at;
        expect(t2 > t1).toBe(true);
        resolve();
      }, 15);
    });
  });
});

describe('Store JSON 兜底 · Works', () => {
  it('空库应返回空数组', () => {
    const s = new Store(dbPath);
    expect(s.listWorks()).toEqual([]);
  });

  it('saveWork + listWorks 应正常', () => {
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: '作品A', type: '效率工具' });
    const list = s.listWorks();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('作品A');
    expect(list[0].type).toBe('效率工具');
  });

  it('upsert：相同 id 应更新而非新增', () => {
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'A', status: '待启动' });
    s.saveWork({ id: 'w1', name: 'A-改', status: '首秀中' });
    expect(s.listWorks()).toHaveLength(1);
    expect(s.listWorks()[0].name).toBe('A-改');
  });

  it('缺 id 的作品应被静默忽略（不抛错，不入库）', () => {
    const s = new Store(dbPath);
    const r = s.saveWork({ name: 'no-id' });
    // saveWork 在缺 id 时直接 return 原对象，不会写盘也不会修改 in-memory
    expect(r.name).toBe('no-id');
    expect(s.listWorks()).toHaveLength(0);
    // 不应触发 saveJson()：jsonFile 仍不存在
    expect(fs.existsSync(jsonFile)).toBe(false);
  });

  it('数字字段（star/dl）应被强制转换', () => {
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'A', star: '99', dl: undefined });
    const w = s.listWorks()[0];
    expect(Number(w.star)).toBe(99);
    expect(Number(w.dl)).toBe(0);
  });
});

describe('Store JSON 兜底 · Pubs + 级联删除', () => {
  it('addPub 应自动填 created_at', () => {
    const s = new Store(dbPath);
    const r = s.addPub({ work_id: 'w1', platform: 'GitHub', title: 't', body: 'b' });
    expect(r.created_at).toBeTruthy();
    expect(new Date(r.created_at).toString()).not.toBe('Invalid Date');
  });

  it('listPubs 应包含所有添加的记录', () => {
    const s = new Store(dbPath);
    s.addPub({ work_id: 'w1', platform: 'A', title: 'first' });
    s.addPub({ work_id: 'w1', platform: 'B', title: 'second' });
    const pubs = s.listPubs();
    expect(pubs).toHaveLength(2);
    const titles = pubs.map((p) => p.title);
    expect(titles).toContain('first');
    expect(titles).toContain('second');
  });

  it('deleteWork 应级联清除 pubs（JSON 模式）', () => {
    const s = new Store(dbPath);
    s.saveWork({ id: 'w1', name: 'A' });
    s.addPub({ work_id: 'w1', platform: 'GitHub', title: 't1' });
    s.addPub({ work_id: 'w1', platform: 'V2EX', title: 't2' });
    s.saveWork({ id: 'w2', name: 'B' });
    s.addPub({ work_id: 'w2', platform: 'GitHub', title: 't3' });

    s.deleteWork('w1');

    expect(s.listWorks()).toHaveLength(1);
    const pubs = s.listPubs();
    expect(pubs).toHaveLength(1);
    expect(pubs[0].work_id).toBe('w2');
    // 持久化到 jsonFile 后也应体现级联
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    expect(data.works).toHaveLength(1);
    expect(data.pubs).toHaveLength(1);
  });
});

describe('Store JSON 兜底 · Channels', () => {
  it('空库应返回空数组', () => {
    const s = new Store(dbPath);
    expect(s.listChannels()).toEqual([]);
  });

  it('saveChannel / listChannels 应正常', () => {
    const s = new Store(dbPath);
    const r = s.saveChannel({ name: '钉钉机器人', kind: 'custom', enabled: 1 });
    expect(r.id).toMatch(/^ch_/);
    expect(s.listChannels()).toHaveLength(1);
    // 持久化
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0].name).toBe('钉钉机器人');
  });

  it('upsert：相同 id 应替换而非新增', () => {
    const s = new Store(dbPath);
    const c1 = s.saveChannel({ name: '原名', kind: 'github' });
    s.saveChannel({ id: c1.id, name: '新名', kind: 'github' });
    const list = s.listChannels();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('新名');
  });

  it('必填字段缺失时应抛错', () => {
    const s = new Store(dbPath);
    expect(() => s.saveChannel({})).toThrow();
    expect(() => s.saveChannel({ name: 'x' })).toThrow();
    expect(() => s.saveChannel({ kind: 'custom' })).toThrow();
  });

  it('enabled 应被规范化为 0 / 1', () => {
    const s = new Store(dbPath);
    s.saveChannel({ name: 'A', kind: 'github', enabled: false });
    s.saveChannel({ name: 'B', kind: 'github', enabled: true });
    const list = s.listChannels();
    expect(Number(list.find((c) => c.name === 'A').enabled)).toBe(0);
    expect(Number(list.find((c) => c.name === 'B').enabled)).toBe(1);
  });

  it('空字符串应被规范化为 null', () => {
    const s = new Store(dbPath);
    const r = s.saveChannel({
      name: 'X', kind: 'wechat',
      api_base: '   ', api_key: '', webhook: '', tag: '', note: ''
    });
    expect(r.api_base).toBeNull();
    expect(r.api_key).toBeNull();
    expect(r.webhook).toBeNull();
    expect(r.tag).toBeNull();
    expect(r.note).toBeNull();
  });

  it('deleteChannel 应仅移除指定 id', () => {
    const s = new Store(dbPath);
    const a = s.saveChannel({ name: 'A', kind: 'github' });
    s.saveChannel({ name: 'B', kind: 'v2ex' });
    s.deleteChannel(a.id);
    expect(s.listChannels()).toHaveLength(1);
    expect(s.listChannels()[0].name).toBe('B');
  });

  it('deleteChannel 传入空 id 应安全 noop', () => {
    const s = new Store(dbPath);
    expect(() => s.deleteChannel('')).not.toThrow();
    expect(() => s.deleteChannel(null)).not.toThrow();
    expect(() => s.deleteChannel(undefined)).not.toThrow();
  });

  it('channels 字段在 JSON 中应为数组（不存在时应自动初始化）', () => {
    // 写一个不含 channels 字段的损坏 json
    fs.writeFileSync(jsonFile, JSON.stringify({ settings: null, works: [], pubs: [] }), 'utf8');
    const s = new Store(dbPath);
    expect(Array.isArray(s.data.channels)).toBe(true);
    s.saveChannel({ name: 'X', kind: 'custom' });
    expect(s.data.channels).toHaveLength(1);
  });
});

describe('Store JSON 兜底 · 持久化往返', () => {
  it('关闭再打开后所有数据应可恢复（模拟进程重启）', () => {
    let s1 = new Store(dbPath);
    s1.saveSettings({ api_key: 'persist-key' });
    s1.saveWork({ id: 'w1', name: '持久化作品' });
    s1.addPub({ work_id: 'w1', platform: 'GitHub', title: 't' });
    s1.saveChannel({ name: '钉钉', kind: 'custom' });

    // 模拟进程重启：丢弃 in-memory 实例，重新构造
    s1 = null;
    const s2 = new Store(dbPath);
    expect(s2.getSettings().api_key).toBe('persist-key');
    expect(s2.listWorks()).toHaveLength(1);
    expect(s2.listWorks()[0].name).toBe('持久化作品');
    expect(s2.listPubs()).toHaveLength(1);
    expect(s2.listChannels()).toHaveLength(1);
    expect(s2.listChannels()[0].name).toBe('钉钉');
  });

  it('JSON 文件体积应保持人可读（pretty-printed）', () => {
    const s = new Store(dbPath);
    s.saveSettings({ api_key: 'k' });
    s.saveWork({ id: 'w1', name: 'A' });
    const raw = fs.readFileSync(jsonFile, 'utf8');
    // 含换行和缩进（pretty-printed）
    expect(raw).toMatch(/\n\s{2}"settings"/);
  });
});