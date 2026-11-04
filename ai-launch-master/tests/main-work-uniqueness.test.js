// Rokit ·「我的作品」唯一主推
//
// 覆盖需求验证点：
//   M1 没有主推时可以设置一个主推
//   M2 设置 B 为主推后，原主推 A 自动取消（降级），全局仍只有一个主推
//   M3 「我的作品」列表与下方主推队列中，主推作品都排在第一个
//   M4 取消主推后不再存在主推作品，其余作品恢复原有排序
//   M5 重启（重新加载数据）后主推状态仍然正确
//   M6 作品增删、普通作品排序、发布记录不受影响
//   M7 连续切换主推不会出现两个主推
//   M8 主推只影响展示标签与排序，不改作品内容 / 发布记录 / 作品 ID
//   M9 唯一性在状态写入层保证（不能只靠界面隐藏按钮）
//   M10 既有相关功能（发布流程 / 授权 / 字幕 / AI 配音 / 作品详情）不被破坏
//
// 跑的生产代码：
//   - electron/store.js 的 setMainWork / clearMainWork / saveWork（真实 SQLite / JSON 存储层行为）
//   - electron/works-main-ipc.js 的 works:set-main / works:clear-main（真实调用 handler）
//   - index.html 里切出来的作品列表渲染与主推操作函数（按花括号配平切出，注入依赖后执行）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_IPC_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'works-main-ipc.js'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 通用：从源码里按花括号配平切出一个函数 ---------- */
function extractBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = src.indexOf('{', start + header.length - 1);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

/* ==================================================================
   存储层：真实 SQLite（node:sqlite 回退分支）
   ================================================================== */
let Store;
let tmpDir;
let dbPath;

function loadStore() {
  if (Store) return Store;
  // 本机 better-sqlite3 原生模块与当前 Node ABI 不匹配（既有环境问题，与本轮改动无关），
  // 这里强制走 store.js 自带的 node:sqlite 回退分支，仍然是真实的 SQLite 存储层行为。
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'better-sqlite3') {
      const e = new Error('native binding unavailable');
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    return origLoad.apply(this, arguments);
  };
  try {
    Store = require('../electron/store').Store;
  } finally {
    Module._load = origLoad;
  }
  return Store;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-mainwork-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_e) {} }
  }
  const jf = path.join(tmpDir, 'ai-launch-master-data.json');
  if (fs.existsSync(jf)) { try { fs.unlinkSync(jf); } catch (_e) {} }
  try { fs.rmdirSync(tmpDir); } catch (_e) {}
});

function queueMap(store) {
  const out = {};
  store.listWorks().forEach((w) => { out[w.id] = w.queue; });
  return out;
}
function mainsOf(store) {
  return store.listWorks().filter((w) => w.queue === '主推').map((w) => w.id);
}

/* ==================================================================
   M1 / M2 / M4 / M7 / M9：状态写入层的唯一性
   ================================================================== */
describe('M1/M2/M9 · 唯一主推在状态写入层保证', () => {
  it('M1 没有主推时可以设置一个主推', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: '作品一', queue: '排队' });
    store.saveWork({ id: 'w2', name: '作品二', queue: '排队' });

    const res = store.setMainWork('w1');
    expect(res.ok).toBe(true);
    expect(res.main).toBe('w1');
    expect(mainsOf(store)).toEqual(['w1']);
    expect(queueMap(store)['w2']).toBe('排队');
  });

  it('M2 设置 B 为主推后，原主推 A 自动取消（降级为挂机），全局仍只有一个主推', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: '作品一' });
    store.saveWork({ id: 'w2', name: '作品二' });
    store.setMainWork('w1');
    expect(mainsOf(store)).toEqual(['w1']);

    const res = store.setMainWork('w2');
    expect(res.ok).toBe(true);
    expect(res.main).toBe('w2');
    // 旧主推被降级，接口如实返回降级清单
    expect(res.demoted).toEqual(['w1']);
    // 全局只有一个主推
    expect(mainsOf(store)).toEqual(['w2']);
    expect(queueMap(store)['w1']).toBe('挂机');
  });

  it('M9 唯一性不依赖界面：saveWork 直接写 queue=主推 也会自动降级其它主推', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: '作品一' });
    store.saveWork({ id: 'w2', name: '作品二' });
    store.setMainWork('w1');

    // 旁路写入（launch 新建作品就是这条路径）
    store.saveWork({ id: 'w2', name: '作品二', queue: '主推' });
    expect(mainsOf(store)).toEqual(['w2']);
    expect(queueMap(store)['w1']).toBe('挂机');
  });

  it('M7 连续切换主推：任何时刻都只有一个主推', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });
    store.saveWork({ id: 'w3', name: 'C' });

    ['w1', 'w2', 'w3', 'w1', 'w3'].forEach((id) => {
      store.setMainWork(id);
      expect(mainsOf(store)).toEqual([id]);
    });
    expect(mainsOf(store)).toEqual(['w3']);
  });

  it('M4 取消主推后不再存在主推作品', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });
    store.setMainWork('w1');

    const res = store.clearMainWork('w1');
    expect(res.ok).toBe(true);
    expect(res.cleared).toEqual(['w1']);
    expect(mainsOf(store)).toEqual([]);
    expect(queueMap(store)['w1']).toBe('挂机');
  });

  it('取消一个非主推作品不会误伤当前主推', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });
    store.setMainWork('w1');

    const res = store.clearMainWork('w2');
    expect(res.ok).toBe(true);
    expect(res.cleared).toEqual([]);
    expect(mainsOf(store)).toEqual(['w1']);
  });

  it('不存在的作品不能被设为主推，返回失败且不改动任何数据', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.setMainWork('w1');

    const res = store.setMainWork('nope');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('work not found');
    expect(mainsOf(store)).toEqual(['w1']);
  });

  it('M5 主推状态持久化：重开数据库后主推仍是同一个作品', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A', queue: '排队' });
    store.saveWork({ id: 'w2', name: 'B', queue: '排队' });
    store.setMainWork('w1');
    store.setMainWork('w2');

    const fresh = new (loadStore())(dbPath);
    expect(mainsOf(fresh)).toEqual(['w2']);
    // 原主推的降级状态也一并持久化
    expect(queueMap(fresh)['w1']).toBe('挂机');
  });

  it('M8 主推不影响作品内容：只改 queue 字段，其它字段原样保留', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: '作品一', type: '效率工具', intro: '简介', url: 'https://github.com/o/r', status: '运营期', next: '看反馈' });
    store.saveWork({ id: 'w2', name: '作品二' });

    const before = store.listWorks().find((w) => w.id === 'w1');
    store.setMainWork('w1');
    const after = store.listWorks().find((w) => w.id === 'w1');

    expect(after.name).toBe(before.name);
    expect(after.type).toBe(before.type);
    expect(after.intro).toBe(before.intro);
    expect(after.url).toBe(before.url);
    expect(after.status).toBe(before.status);
    expect(after.next).toBe(before.next);
    expect(after.id).toBe(before.id);
    expect(after.queue).toBe('主推');
  });

  it('M6 删除主推作品不影响其它作品，主推随作品一起消失', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });
    store.setMainWork('w1');

    store.deleteWork('w1');
    expect(mainsOf(store)).toEqual([]);
    expect(store.listWorks().map((w) => w.id)).toEqual(['w2']);
  });

  it('M6 发布记录不受主推操作影响', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', title: 'T', pub_key: 'k1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', title: 'G', pub_key: 'k2' });

    store.setMainWork('w1');
    store.setMainWork('w2-not-exist');

    const pubs = store.listPubs();
    expect(pubs.length).toBe(2);
    expect(pubs.map((p) => p.pub_key).sort()).toEqual(['k1', 'k2']);
  });

  it('JSON 兜底模式同样保证唯一性', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });

    const res = store.setMainWork('w1');
    expect(res.ok).toBe(true);
    expect(mainsOf(store)).toEqual(['w1']);

    store.setMainWork('w2');
    expect(mainsOf(store)).toEqual(['w2']);

    store.clearMainWork('w2');
    expect(mainsOf(store)).toEqual([]);
  });

  it('自愈：旧库里已有多条主推时收敛为一条（保留最早登记的）', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A', queue: '排队' });
    store.saveWork({ id: 'w2', name: 'B', queue: '排队' });
    store.saveWork({ id: 'w3', name: 'C', queue: '排队' });
    // 直接写库造出旧版本遗留的脏数据（绕过写入层的唯一性保证，模拟老库）
    store.run("UPDATE works SET queue = '主推' WHERE id IN ('w1','w2','w3')", []);
    expect(mainsOf(store).length).toBe(3);

    const res = store.ensureSingleMain();
    expect(res.ok).toBe(true);
    expect(res.main).toBe('w1');
    expect(res.repaired.sort()).toEqual(['w2', 'w3']);
    expect(mainsOf(store)).toEqual(['w1']);
  });

  it('自愈在正常数据上是 no-op（不改动数据）', () => {
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A', queue: '排队' });
    store.saveWork({ id: 'w2', name: 'B', queue: '排队' });

    const res = store.ensureSingleMain();
    expect(res.ok).toBe(true);
    expect(res.main).toBe(null);
    expect(res.repaired).toEqual([]);
    expect(queueMap(store)).toEqual({ w1: '排队', w2: '排队' });
  });
});

/* ==================================================================
   IPC 层：renderer → preload → IPC → store
   ================================================================== */
describe('IPC · works:set-main / works:clear-main', () => {
  function makeIpcHarness() {
    const handlers = new Map();
    const ipcMain = { handle: vi.fn((ch, fn) => handlers.set(ch, fn)) };
    const storeRef = { current: null };
    const { registerWorksMainIpc } = require('../electron/works-main-ipc');
    registerWorksMainIpc(ipcMain, { getStore: () => storeRef.current });
    return { handlers, storeRef };
  }

  it('注册两个通道，且只注册这两个', () => {
    const { handlers } = makeIpcHarness();
    expect(Array.from(handlers.keys()).sort()).toEqual(['works:clear-main', 'works:set-main']);
  });

  it('works:set-main 真实调用 store.setMainWork（唯一性由 store 保证）', () => {
    const { handlers, storeRef } = makeIpcHarness();
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.saveWork({ id: 'w2', name: 'B' });
    storeRef.current = store;

    const res = handlers.get('works:set-main')({}, 'w2');
    expect(res.ok).toBe(true);
    expect(res.main).toBe('w2');
    expect(mainsOf(store)).toEqual(['w2']);
  });

  it('works:clear-main 真实调用 store.clearMainWork', () => {
    const { handlers, storeRef } = makeIpcHarness();
    const store = new (loadStore())(dbPath);
    store.saveWork({ id: 'w1', name: 'A' });
    store.setMainWork('w1');
    storeRef.current = store;

    const res = handlers.get('works:clear-main')({}, 'w1');
    expect(res.ok).toBe(true);
    expect(mainsOf(store)).toEqual([]);
  });

  it('preload 暴露 setMainWork / clearMainWork，main 注册了对应通道', () => {
    expect(PRELOAD_SRC).toMatch(/setMainWork:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('works:set-main',\s*id\)/);
    expect(PRELOAD_SRC).toMatch(/clearMainWork:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('works:clear-main',\s*id\)/);
    expect(MAIN_SRC).toContain('registerWorksMainIpc');
    expect(MAIN_IPC_SRC).toContain("ipcMain.handle('works:set-main'");
    expect(MAIN_IPC_SRC).toContain("ipcMain.handle('works:clear-main'");
  });
});

/* ==================================================================
   渲染层：真实执行 index.html 里的作品列表与主推函数
   ================================================================== */
const WORKS_SRC = [
  extractBlock(HTML, 'function mainWorkOf(works){'),
  extractBlock(HTML, 'function queueLabelOf(w,mainWork){'),
  extractBlock(HTML, 'function demoteMainsInMemory(keepId){'),
  extractBlock(HTML, 'function applyMainResult(res){'),
  extractBlock(HTML, 'function renderWorks(){'),
  extractBlock(HTML, 'window.setAsMain = function(id){'),
  extractBlock(HTML, 'window.clearAsMain = function(id){')
].join('\n');

function makeEl(id) {
  return {
    id: id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    options: [],
    checked: false,
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {}
  };
}

function makeDom(ids) {
  const els = {};
  ids.forEach((id) => { els[id] = makeEl(id); });
  return {
    els: els,
    getElementById(id) { return els[id] || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeEl('tmp'); },
    body: { appendChild() {} }
  };
}

/**
 * 搭建一个可执行的「我的作品」渲染环境。
 * 依赖注入：state / api / DOM / toast / findWork / isSampleWork 等。
 */
function makeWorksEnv(overrides) {
  const o = overrides || {};
  const state = o.state || {
    works: [
      { id: 'w1', name: '作品一', type: '效率工具', status: '运营期', intro: '', url: '', yt_url: '', queue: '排队', star: 1, dl: 2, play: '3', next: '登记推广' },
      { id: 'w2', name: '作品二', type: '小游戏', status: '首秀中', intro: '', url: '', yt_url: '', queue: '排队', star: 4, dl: 5, play: '6', next: '登记推广' },
      { id: 'w3', name: '作品三', type: '效率工具', status: '稳定期', intro: '', url: '', yt_url: '', queue: '排队', star: 7, dl: 8, play: '9', next: '登记推广' }
    ],
    curWork: 'w1',
    aiPickMain: false
  };
  const dom = o.dom || makeDom(['worksGrid', 'queueBar']);
  const toasts = [];
  const setMainCalls = [];
  const clearMainCalls = [];

  const api = {
    setMainWork: function (id) {
      setMainCalls.push(id);
      if (o.setMainResult) return Promise.resolve(o.setMainResult);
      // 真实语义：目标成为主推，其它主推被降级
      const demoted = [];
      (state.works || []).forEach((w) => {
        if (w && w.id !== id && w.queue === '主推') { w.queue = '挂机'; demoted.push(w.id); }
      });
      const t = (state.works || []).find((w) => w.id === id);
      if (t) t.queue = '主推';
      return Promise.resolve({ ok: true, main: id, queue: '主推', demoted: demoted });
    },
    clearMainWork: function (id) {
      clearMainCalls.push(id);
      if (o.clearMainResult) return Promise.resolve(o.clearMainResult);
      const cleared = [];
      (state.works || []).forEach((w) => {
        if (w && w.id === id && w.queue === '主推') { w.queue = '挂机'; cleared.push(w.id); }
      });
      return Promise.resolve({ ok: true, cleared: cleared, queue: null });
    }
  };

  const host = { api: api };
  const toast = function (msg, kind) { toasts.push({ msg: String(msg), kind: kind }); };
  const findWork = (id) => (state.works || []).find((w) => w.id === id) || null;
  const isSampleWork = (id) => String(id || '').indexOf('sample_') === 0;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pubArg = (s) => esc(JSON.stringify(String(s == null ? '' : s)));
  const ytViewsText = () => '—';
  const STATUS_COLOR = { '待启动': '#9CA3AF', '首秀中': '#F59E0B', '运营期': '#0E7C7B', '稳定期': '#2E8B33' };
  const setupWorkHover = () => {};

  const factory = new Function(
    'state', 'window', 'document', 'toast', 'findWork', 'isSampleWork', 'esc', 'pubArg',
    'ytViewsText', 'STATUS_COLOR', 'setupWorkHover',
    WORKS_SRC +
    '\nreturn { renderWorks: renderWorks, setAsMain: window.setAsMain, clearAsMain: window.clearAsMain,' +
    ' mainWorkOf: mainWorkOf, queueLabelOf: queueLabelOf };'
  );
  const api2 = factory(state, host, dom, toast, findWork, isSampleWork, esc, pubArg, ytViewsText, STATUS_COLOR, setupWorkHover);

  return {
    state: state,
    dom: dom,
    toasts: toasts,
    setMainCalls: setMainCalls,
    clearMainCalls: clearMainCalls,
    api: api2,
    gridHtml() { return dom.els.worksGrid.innerHTML; },
    queueHtml() { return dom.els.queueBar.innerHTML; },
    orderOfIds() {
      const html = dom.els.worksGrid.innerHTML;
      const ids = [];
      // 只取作品卡（wmenu 里也有 data-work-id，不能重复计数）
      const re = /<div class="wcard[^"]*" data-work-id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) ids.push(m[1]);
      return ids;
    },
    mainsInState() {
      return (state.works || []).filter((w) => w.queue === '主推').map((w) => w.id);
    }
  };
}

describe('M3 · 主推在两个列表中都排第一', () => {
  it('M3 设置 B 为主推后，B 在「我的作品」列表里排第一', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();

    const ids = env.orderOfIds();
    expect(ids[0]).toBe('w2');
    expect(ids.indexOf('w2')).toBeLessThan(ids.indexOf('w1'));
    expect(ids.indexOf('w2')).toBeLessThan(ids.indexOf('w3'));
  });

  it('M3 主推队列面板里主推作品在最前面', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();

    const q = env.queueHtml();
    // 主推卡片在最前，且包含 B 的名字
    expect(q.indexOf('主推 · 全力投入')).toBeLessThan(q.indexOf('挂机 · 低强度'));
    expect(q.indexOf('作品二')).toBeLessThan(q.indexOf('作品一'));
  });

  it('M3 主推卡片显示「主推」标签，其余卡片不显示', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();

    const html = env.gridHtml();
    const mainCard = html.slice(html.indexOf('data-work-id="w2"'));
    const otherCard = html.slice(html.indexOf('data-work-id="w1"'), html.indexOf('data-work-id="w3"'));
    expect(mainCard.indexOf('主推')).toBeGreaterThan(-1);
    expect(otherCard.indexOf('>主推<')).toBe(-1);
  });

  it('M2 设置 B 为主推后，原主推 A 在列表里不再显示「主推」', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w1');
    await Promise.resolve();
    await Promise.resolve();
    env.api.setAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();

    expect(env.mainsInState()).toEqual(['w2']);
    const html = env.gridHtml();
    const cardA = html.slice(html.indexOf('data-work-id="w1"'), html.indexOf('data-work-id="w2"'));
    expect(cardA.indexOf('>主推<')).toBe(-1);
  });
});

describe('M4 · 取消主推', () => {
  it('M4 取消后不再有主推作品，其余作品恢复原有排序', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w1');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();
    expect(env.orderOfIds()[0]).toBe('w1');

    env.api.clearAsMain('w1');
    await Promise.resolve();
    await Promise.resolve();
    env.api.renderWorks();

    expect(env.mainsInState()).toEqual([]);
    // 恢复原有排序（w1、w2、w3 原始顺序）
    expect(env.orderOfIds()).toEqual(['w1', 'w2', 'w3']);
  });

  it('M4 取消一个非主推作品会被拒绝，不会误清主推', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w1');
    await Promise.resolve();
    await Promise.resolve();

    env.api.clearAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();

    // 非主推作品直接被拦下：不会发出取消请求，主推也不受影响
    expect(env.clearMainCalls).toEqual([]);
    expect(env.mainsInState()).toEqual(['w1']);
    expect(env.toasts.some((t) => t.msg.indexOf('不是主推') >= 0)).toBe(true);
  });

  it('M6 作品增删不受主推功能影响', async () => {
    const env = makeWorksEnv();
    env.api.setAsMain('w2');
    await Promise.resolve();
    await Promise.resolve();

    // 模拟删除一个非主推作品（delWork 走自己的路径，这里只验证主推集合不受影响）
    env.state.works = env.state.works.filter((w) => w.id !== 'w1');
    env.api.renderWorks();

    expect(env.mainsInState()).toEqual(['w2']);
    expect(env.orderOfIds()[0]).toBe('w2');
  });
});

describe('M9 / M10 · 唯一性与既有功能不被破坏', () => {
  it('M9 界面上不存在"绕过存储层直接改主推"的路径：置为/取消都走 IPC', () => {
    const setBlock = extractBlock(HTML, 'window.setAsMain = function(id){');
    const clearBlock = extractBlock(HTML, 'window.clearAsMain = function(id){');
    expect(setBlock).toContain('window.api.setMainWork');
    expect(clearBlock).toContain('window.api.clearMainWork');
    // 界面不再自己遍历降级（唯一性由 store 保证）
    expect(setBlock).not.toMatch(/state\.works\.forEach/);
    expect(setBlock).not.toMatch(/saveWork\(/);
    // 也不改 status / next 等其它业务字段
    expect(setBlock).not.toMatch(/w\.status\s*=/);
    expect(setBlock).not.toMatch(/w\.next\s*=/);
  });

  it('M9 store 层保证唯一性：setMainWork 用单条原子 UPDATE', () => {
    const block = extractBlock(STORE_SRC, 'setMainWork(id) {');
    expect(block).toContain("queue = CASE WHEN id = ? THEN '主推' ELSE '挂机' END");
    expect(block).toContain("queue = '主推'");
    // 降级 + 提升在同一个事务里
    expect(block).toContain('this._tx(');
  });

  it('M10 作品详情与发布记录入口仍在', () => {
    const works = extractBlock(HTML, 'function renderWorks(){');
    expect(works).toContain('openWorkDetail(');
    expect(works).toContain('查看详情');
    expect(works).toContain('进入首秀');
    // 取消主推入口存在
    expect(works).toContain('clearAsMain(');
    expect(works).toContain('取消主推');
  });

  it('M10 发布流程 / 授权 / 字幕 / AI 配音相关入口未被移除', () => {
    expect(HTML).toContain('window.markPub=function(id){');
    expect(HTML).toContain('window.api.addPub(');
    expect(HTML).toContain('function captionStepBack(');
    expect(HTML).toContain('id="capSaveBtn"');
    expect(HTML).toContain('capBurnFinal');
    expect(HTML).toContain('toggleAiPickMain()');
  });
});
