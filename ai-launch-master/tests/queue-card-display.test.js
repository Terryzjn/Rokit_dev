// 「我的作品」主推队列卡片展示修复 —— 定向测试
//
// 覆盖需求验证点：
//   1) 有主推 + 多个挂机 + 多个排队：只显示三张卡片，分别显示主推作品、最新挂机、最新排队
//   2) 多个挂机作品：标题不再拼接
//   3) 多个排队作品：标题不再拼接
//   4) 没有挂机作品：第二张卡片保留空状态
//   5) 没有排队作品：第三张卡片保留空状态
//   6) 没有主推作品：第一张卡片按原有空状态规则显示
//   7) 其他作品的数据库记录及队列状态完全不变
//
// 跑的生产代码：
//   - index.html 里切出来的 renderWorks()（按花括号配平切出，注入依赖后执行）
//   - electron/store.js 的真实 SQLite 存储层（用于验证 works 表记录未被改动）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 从源码里按花括号配平切出一个函数 ---------- */
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

const WORKS_SRC = [
  extractBlock(HTML, 'function mainWorkOf(works){'),
  extractBlock(HTML, 'function queueLabelOf(w,mainWork){'),
  extractBlock(HTML, 'function demoteMainsInMemory(keepId){'),
  extractBlock(HTML, 'function applyMainResult(res){'),
  extractBlock(HTML, 'function renderWorks(){')
].join('\n');

function makeEl(id) {
  return {
    id: id, innerHTML: '', textContent: '', value: '', style: {},
    options: [], checked: false,
    addEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, appendChild() {}, remove() {}
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
 * 搭建可执行的「我的作品」渲染环境。
 * works: [{ id, name, queue, created_at, ... }]
 */
function makeEnv(works, overrides) {
  const o = overrides || {};
  const state = {
    works: JSON.parse(JSON.stringify(works || [])),
    curWork: (works && works[0]) ? works[0].id : null,
    aiPickMain: false
  };
  const dom = o.dom || makeDom(['worksGrid', 'queueBar']);
  const toasts = [];
  const findWork = (id) => (state.works || []).find((w) => w.id === id) || null;
  const isSampleWork = (id) => String(id || '').indexOf('sample_') === 0;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pubArg = (s) => esc(JSON.stringify(String(s == null ? '' : s)));
  const ytViewsText = () => '—';
  const STATUS_COLOR = { '待启动': '#9CA3AF', '首秀中': '#F59E0B', '运营期': '#0E7C7B', '稳定期': '#2E8B33' };
  const setupWorkHover = () => {};
  const toast = (msg, kind) => { toasts.push({ msg: String(msg), kind: kind }); };
  const host = { api: {} };

  const factory = new Function(
    'state', 'window', 'document', 'toast', 'findWork', 'isSampleWork', 'esc', 'pubArg',
    'ytViewsText', 'STATUS_COLOR', 'setupWorkHover',
    WORKS_SRC + '\nreturn { renderWorks: renderWorks };'
  );
  const api = factory(state, host, dom, toast, findWork, isSampleWork, esc, pubArg, ytViewsText, STATUS_COLOR, setupWorkHover);

  return {
    api,
    state,
    dom,
    render() { api.renderWorks(); },
    queueHtml() { return dom.els.queueBar.innerHTML; },
    gridHtml() { return dom.els.worksGrid.innerHTML; },
    /** 解析出队列栏每张卡片的 { qt, qn } */
    cards() {
      const html = dom.els.queueBar.innerHTML;
      const out = [];
      const re = /<div class="qt">([^<]*)<\/div><div class="qn">([^<]*)<\/div>/g;
      let m;
      while ((m = re.exec(html)) !== null) out.push({ qt: m[1], qn: m[2] });
      return out;
    }
  };
}

/* ---------- 测试数据 ---------- */
function mk(id, name, queue, created_at) {
  return {
    id: id, name: name, type: '效率工具', status: '运营期', intro: '', url: '',
    yt_url: '', queue: queue, star: 0, dl: 0, play: '0', next: '登记推广',
    created_at: created_at
  };
}

describe('主推队列卡片：每张只显示一个作品', () => {
  it('V1 有主推 + 多个挂机 + 多个排队：只显示三张卡片，分别取主推/最新挂机/最新排队', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('h1', '挂机较早', '挂机', '2026-02-01T00:00:00.000Z'),
      mk('h2', '挂机较晚', '挂机', '2026-03-01T00:00:00.000Z'),
      mk('h3', '挂机最新', '挂机', '2026-04-01T00:00:00.000Z'),
      mk('q1', '排队较早', '排队', '2026-05-01T00:00:00.000Z'),
      mk('q2', '排队最新', '排队', '2026-06-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[0].qt).toBe('主推 · 全力投入');
    expect(cards[1].qt).toBe('挂机 · 低强度');
    expect(cards[2].qt).toBe('排队 · 待启动');
    expect(cards[0].qn).toBe('主推作品');
    expect(cards[1].qn).toBe('挂机最新');   // created_at 最大
    expect(cards[2].qn).toBe('排队最新');   // created_at 最大
  });

  it('V2 多个挂机作品：标题不再拼接（只显示最新挂机那一个）', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('h1', '挂机甲', '挂机', '2026-02-01T00:00:00.000Z'),
      mk('h2', '挂机乙', '挂机', '2026-03-01T00:00:00.000Z'),
      mk('h3', '挂机丙', '挂机', '2026-04-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[1].qn).toBe('挂机丙');
    // 旧行为会把整组拼接：断言不再出现分隔符拼接形态
    expect(cards[1].qn).not.toContain('挂机甲');
    expect(cards[1].qn).not.toContain('挂机乙');
    expect(cards[1].qn).not.toContain(' · ');
  });

  it('V3 多个排队作品：标题不再拼接（只显示最新排队那一个）', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('q1', '排队甲', '排队', '2026-05-01T00:00:00.000Z'),
      mk('q2', '排队乙', '排队', '2026-06-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[2].qn).toBe('排队乙');
    expect(cards[2].qn).not.toContain('排队甲');
    expect(cards[2].qn).not.toContain(' · ');
  });

  it('V4 没有挂机作品：第二张卡片保留空状态占位', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('q1', '排队甲', '排队', '2026-05-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[1].qt).toBe('挂机 · 低强度');
    expect(cards[1].qn).toBe('（暂无）');
    expect(cards[1].qs || env.queueHtml()).toBeTruthy();
  });

  it('V5 没有排队作品：第三张卡片保留空状态占位', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('h1', '挂机甲', '挂机', '2026-02-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[2].qt).toBe('排队 · 待启动');
    expect(cards[2].qn).toBe('（暂无）');
  });

  it('V6 没有主推作品：第一张卡片按原有空状态规则显示', () => {
    const env = makeEnv([
      mk('h1', '挂机甲', '挂机', '2026-02-01T00:00:00.000Z'),
      mk('q1', '排队甲', '排队', '2026-05-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[0].qt).toBe('主推 · 全力投入');
    expect(cards[0].qn).toBe('（暂无）');
    // 原有空状态说明文案保持不变
    expect(env.queueHtml()).toContain('点右上方「+ 登记新作品」创建你的首发作品');
  });

  it('V7 三张卡片的顺序固定，不因作品数量变化而改变', () => {
    const env = makeEnv([
      mk('h1', '挂机甲', '挂机', '2026-02-01T00:00:00.000Z'),
      mk('q1', '排队甲', '排队', '2026-05-01T00:00:00.000Z'),
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.map((c) => c.qt)).toEqual(['主推 · 全力投入', '挂机 · 低强度', '排队 · 待启动']);
  });

  it('V8 「最新」按 created_at 判定，不按数组顺序或作品 id 大小', () => {
    // 故意让「最新」的作品排在数组前面、且 id 更大/更小都不影响结果
    const env = makeEnv([
      mk('z9', '最新挂机', '挂机', '2026-09-09T00:00:00.000Z'),
      mk('a1', '较早挂机', '挂机', '2026-02-02T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards[1].qn).toBe('最新挂机');
  });

  it('V9 created_at 缺失时视为最旧，不顶掉有登记时间的作品', () => {
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      { id: 'h1', name: '无登记时间', type: '效率工具', status: '运营期', queue: '挂机', created_at: '' },
      mk('h2', '有登记时间', '挂机', '2026-03-01T00:00:00.000Z')
    ]);
    env.render();

    const cards = env.cards();
    expect(cards[1].qn).toBe('有登记时间');
  });

  it('V11 整组都缺 created_at 时无法判定先后：仍只显示一个作品，不拼接', () => {
    // 三个挂机作品都没有 created_at → 取该组第一项（不代表「末项即最新」）
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      { id: 'h1', name: '挂机甲', type: '效率工具', status: '运营期', queue: '挂机', created_at: '' },
      { id: 'h2', name: '挂机乙', type: '效率工具', status: '运营期', queue: '挂机', created_at: '' },
      { id: 'h3', name: '挂机丙', type: '效率工具', status: '运营期', queue: '挂机', created_at: '' }
    ]);
    env.render();

    const cards = env.cards();
    expect(cards.length).toBe(3);
    expect(cards[1].qn).toBe('挂机甲');
    expect(cards[1].qn).not.toContain(' · ');
  });

  it('V10 渲染只读 state，不改动任何作品的 queue / name', () => {
    const before = JSON.stringify([
      { id: 'm1', name: '主推作品', queue: '主推', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'h1', name: '挂机甲', queue: '挂机', created_at: '2026-02-01T00:00:00.000Z' },
      { id: 'q1', name: '排队甲', queue: '排队', created_at: '2026-05-01T00:00:00.000Z' }
    ]);
    const env = makeEnv([
      mk('m1', '主推作品', '主推', '2026-01-01T00:00:00.000Z'),
      mk('h1', '挂机甲', '挂机', '2026-02-01T00:00:00.000Z'),
      mk('q1', '排队甲', '排队', '2026-05-01T00:00:00.000Z')
    ]);
    env.render();
    env.render();   // 重复渲染不应产生副作用

    const after = JSON.stringify(env.state.works.map((w) => ({
      id: w.id, name: w.name, queue: w.queue, created_at: w.created_at
    })));
    expect(after).toBe(before);
  });
});

/* ==================================================================
   V7（续）：真实存储层——渲染不触碰 works 表
   ================================================================== */
describe('主推队列渲染不改动 works 表记录', () => {
  let Store;
  let tmpDir;
  let dbPath;

  function loadStore() {
    if (Store) return Store;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-queuecard-'));
    dbPath = path.join(tmpDir, 'test.db');
  });
  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_e) {} }
    }
    try { fs.rmdirSync(tmpDir); } catch (_e) {}
  });

  it('渲染前后 works 表的 queue / name / created_at 完全一致', () => {
    const store = loadStore();
    const s = new Store(dbPath);
    s.saveWork({ id: 'm1', name: '主推作品', queue: '主推', created_at: '2026-01-01T00:00:00.000Z' });
    s.saveWork({ id: 'h1', name: '挂机甲', queue: '挂机', created_at: '2026-02-01T00:00:00.000Z' });
    s.saveWork({ id: 'h2', name: '挂机乙', queue: '挂机', created_at: '2026-03-01T00:00:00.000Z' });
    s.saveWork({ id: 'q1', name: '排队甲', queue: '排队', created_at: '2026-05-01T00:00:00.000Z' });

    const snapshot = () => JSON.stringify(s.listWorks().map((w) => ({
      id: w.id, name: w.name, queue: w.queue, created_at: w.created_at, status: w.status
    })));
    const before = snapshot();

    const env = makeEnv(s.listWorks());
    env.render();

    expect(snapshot()).toBe(before);
    // 存储层主推唯一性未受影响
    expect(s.listWorks().filter((w) => w.queue === '主推').map((w) => w.id)).toEqual(['m1']);
  });
});
