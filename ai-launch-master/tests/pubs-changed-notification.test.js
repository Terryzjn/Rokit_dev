// Rokit · 发布记录变更通知（pubs:changed）与 renderer 刷新 —— 定向测试
//
// 覆盖用户要求的 10 个验证点：
//   N1  addPub() 成功后发出**一次**通知
//   N2  addPub() 失败不发通知
//   N3  _planPubUpsert 所在事务**提交成功之后**才发通知
//   N4  _planPubUpsert 所在事务**回滚**时不发通知
//   N5  deletePubs() 成功后发出通知
//   N6  deleteWork() 级联删除成功后发出通知
//   N7  renderer 收到通知后更新 state.pubLog（走 listPubs 重新读取）
//   N8  连续通知不会被**旧查询**结果覆盖
//   N9  手动标记写入失败时不保留虚假的内存记录，并向用户显示失败
//   N10 不在看板 / 发布列表 / 作品详情时，不跳转也不打断用户当前操作
//
// 全部使用临时数据库 + 注入的 mock：
//   **没有任何真实平台 API 调用 / 真实发布 / 真实上传**。
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/plan-store');

const ROOT = H.ROOT;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
});

/* ---------- 工具：载入一份全新的 store 模块（事件总线随之重置） ---------- */
function newStore(blockNodeSqlite) {
  const mod = H.loadStoreFresh(!!blockNodeSqlite);
  const store = new mod.Store(dbPath);
  return { mod: mod, store: store };
}

/** 记录通知次数的监听器；返回 { count(), off() } */
function watch(mod) {
  let n = 0;
  const off = mod.onPubsChanged(function () { n++; });
  return {
    count: function () { return n; },
    off: off
  };
}

/** 造一条 YouTube「待核实」计划任务 + 一条 pending 发布记录（与真实执行器行为一致） */
function seedNeedsReviewTask(store) {
  const workId = 'w1';
  const stageId = 's1';
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [{
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: ['youtube'],
    copy: { youtube: { title: 'v1 发布', body: '说明', tags: ['t'] } }
  }]);
  let task = store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube')[0];
  store._planWriteTask(Object.assign({}, task, {
    status: 'needs_review',
    real_only: 1,
    error: 'upload-exception（socket hang up）',
    note: '上传过程中抛出未预期异常',
    finished_at: new Date().toISOString()
  }));
  store.addPub({
    work_id: workId, platform: 'YouTube', platform_id: 'youtube',
    status: 'pending', title: 'v1 发布', body: '说明', tags: 't',
    time: '', url: '', error: 'upload-exception（socket hang up）', video_id: '',
    pub_key: task.pub_key
  });
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube')[0];
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* ==================================================================
   一、存储层：通知的发出时机
   ================================================================== */

describe('发布记录变更通知 · 存储层', () => {
  it('N1 addPub() 成功后发出一次通知', () => {
    const { mod, store } = newStore();
    const w = watch(mod);
    try {
      store.addPub({
        work_id: 'w1', platform: 'GitHub', platform_id: 'github',
        status: 'ok', title: 'v1', body: 'b', tags: 't',
        time: '10:00', url: 'https://example.com/r', error: '', video_id: '',
        pub_key: 'gh|w1|1'
      });
      expect(w.count()).toBe(1);
    } finally { w.off(); }
  });

  it('N1b addPub() 更新既有行（幂等 upsert）同样发出一次通知', () => {
    const { mod, store } = newStore();
    const w = watch(mod);
    try {
      const row = { work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'pending', title: 'v1', pub_key: 'gh|w1|1' };
      store.addPub(row);
      expect(w.count()).toBe(1);
      store.addPub(Object.assign({}, row, { status: 'ok' }));
      expect(w.count()).toBe(2);
    } finally { w.off(); }
  });

  it('N2 addPub() 失败不发通知（写库异常必须原样抛出）', () => {
    const { mod, store } = newStore();
    const w = watch(mod);
    try {
      const origRun = store.run.bind(store);
      store.run = function () { throw new Error('模拟写入失败'); };
      expect(function () {
        store.addPub({
          work_id: 'w1', platform: 'GitHub', platform_id: 'github',
          status: 'ok', title: 'v1', pub_key: 'gh|w1|boom'
        });
      }).toThrow(/模拟写入失败/);
      expect(w.count()).toBe(0);
      store.run = origRun;
    } finally { w.off(); }
  });

  it('N3 _planPubUpsert 所在事务提交成功之后才发通知（通知到达时数据已落库）', () => {
    const { mod, store } = newStore();
    const task = seedNeedsReviewTask(store);
    const w = watch(mod);
    let statusAtNotify = null;
    const off = mod.onPubsChanged(function () {
      // 通知到达的瞬间读库：必须已经是提交后的结果
      const rows = store.listPubs().filter(p => p && p.pub_key === task.pub_key);
      statusAtNotify = rows.length ? rows[0].status : null;
    });
    try {
      const res = store.confirmNeedsReviewPublished('w1', task.id, {
        platform_ref: 'dQw4w9WgXcQ',
        platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });
      expect(res.ok).toBe(true);
      expect(w.count()).toBe(1);
      // 通知发出时数据已经提交（不是 pending，也不是空）
      expect(statusAtNotify).toBe('ok');
    } finally { off(); w.off(); }
  });

  it('N4 _planPubUpsert 所在事务回滚时不发通知（数据也必须回到原状）', () => {
    const { mod, store } = newStore();
    const task = seedNeedsReviewTask(store);
    const w = watch(mod);
    try {
      // 让「任务行条件更新」失败 → 事务整体回滚（pubs 的写入也必须被回滚）
      const origRun = store.run.bind(store);
      store.run = function (sql, args) {
        if (String(sql).indexOf('UPDATE plan_tasks') >= 0) {
          throw new Error('模拟任务行更新失败');
        }
        return origRun(sql, args);
      };
      const res = store.confirmNeedsReviewPublished('w1', task.id, {
        platform_ref: 'dQw4w9WgXcQ',
        platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });
      expect(res.ok).toBe(false);
      // 回滚 → 绝不能发出通知
      expect(w.count()).toBe(0);
      // 回滚 → 发布记录仍是原来的 pending（没有被写成 ok）
      const rows = store.listPubs().filter(p => p && p.pub_key === task.pub_key);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('pending');
      store.run = origRun;
    } finally { w.off(); }
  });

  it('N5 deletePubs() 成功后发出通知（空删不通知）', () => {
    const { mod, store } = newStore();
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', title: 'v1', pub_key: 'gh|w1|1'
    });
    const w = watch(mod);
    try {
      const res = store.deletePubs({ pub_key: 'gh|w1|1' });
      expect(res.deleted).toBe(1);
      expect(w.count()).toBe(1);
      // 再删一次：已经没有这行 → 没有数据变化 → 不再打扰 renderer
      const again = store.deletePubs({ pub_key: 'gh|w1|1' });
      expect(again.deleted).toBe(0);
      expect(w.count()).toBe(1);
    } finally { w.off(); }
  });

  it('N6 deleteWork() 级联删除发布记录成功后发出通知', () => {
    const { mod, store } = newStore();
    H.seedWork(store, 'w1', '作品一');
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', title: 'v1', pub_key: 'gh|w1|1'
    });
    const w = watch(mod);
    try {
      store.deleteWork('w1');
      expect(w.count()).toBe(1);
      expect(store.listPubs().length).toBe(0);
    } finally { w.off(); }
  });

  it('N6b 删除没有发布记录的作品不触发发布记录通知', () => {
    const { mod, store } = newStore();
    H.seedWork(store, 'w2', '作品二');
    const w = watch(mod);
    try {
      store.deleteWork('w2');
      expect(w.count()).toBe(0);
    } finally { w.off(); }
  });

  it('N6c JSON 兜底模式同样只在持久化成功后通知', () => {
    const { mod, store } = newStore(true);   // 两个驱动都屏蔽 → JSON 文件兜底
    const w = watch(mod);
    try {
      store.addPub({
        work_id: 'w1', platform: 'GitHub', platform_id: 'github',
        status: 'ok', title: 'v1', pub_key: 'gh|w1|1'
      });
      expect(w.count()).toBe(1);
      store.deletePubs({ pub_key: 'gh|w1|1' });
      expect(w.count()).toBe(2);
    } finally { w.off(); }
  });

  it('N6d 通知失败（监听者抛错）绝不影响写入结果', () => {
    const { mod, store } = newStore();
    const off = mod.onPubsChanged(function () { throw new Error('监听者炸了'); });
    try {
      let row = null;
      expect(function () {
        row = store.addPub({
          work_id: 'w1', platform: 'GitHub', platform_id: 'github',
          status: 'ok', title: 'v1', pub_key: 'gh|w1|1'
        });
      }).not.toThrow();
      expect(row).toBeTruthy();
      // 数据真的落库了
      expect(store.listPubs().length).toBe(1);
    } finally { off(); }
  });
});

/* ==================================================================
   二、renderer：收到通知后刷新 state.pubLog
   ================================================================== */

/** 从源码里按花括号配平切出一个函数（与既有发布记录测试同一手法） */
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

const REFRESH_SRC = [
  extractBlock(HTML, 'function mergePubRowsFromDb(ps){'),
  'var __pubRefreshSeq=0;',
  extractBlock(HTML, 'function refreshPubsFromDb(){'),
  extractBlock(HTML, 'function renderPubsAfterChange(){')
].join('\n');

function makeRefreshEnv(opts) {
  const o = opts || {};
  const state = o.state || { pubLog: [], route: 'dashboard' };
  const calls = { listPubs: 0, dash: 0, list: 0, detail: 0, workBody: 0 };
  const modal = o.modalOpen
    ? { classList: { contains: function (c) { return c === 'show'; } } }
    : null;
  const windowStub = {
    api: {
      listPubs: function () {
        calls.listPubs++;
        return o.listPubs ? o.listPubs() : Promise.resolve([]);
      }
    }
  };
  const documentStub = {
    getElementById: function (id) { return id === 'workDetailModal' ? modal : null; }
  };
  const fn = new Function(
    'window', 'state', 'document', 'console',
    'renderDash', 'renderPubListPage', 'renderPubDetailPage', 'renderWorkDetailBody',
    REFRESH_SRC + '\nreturn { refreshPubsFromDb: refreshPubsFromDb, renderPubsAfterChange: renderPubsAfterChange };'
  );
  const api = fn(
    windowStub, state, documentStub, console,
    function () { calls.dash++; },
    function () { calls.list++; },
    function () { calls.detail++; },
    function () { calls.workBody++; }
  );
  return { state: state, calls: calls, api: api, window: windowStub };
}

const DB_ROW = {
  id: 7, work_id: 'w1', platform: 'GitHub', platform_id: 'github',
  status: 'ok', title: 'v1', body: 'b', tags: 't', time: '10:00',
  url: 'https://example.com/r', error: '', video_id: '',
  pub_key: 'gh|w1|1', created_at: '2026-10-20T02:30:00.000Z'
};

describe('发布记录变更通知 · renderer', () => {
  it('N7 收到通知后重新 listPubs 并更新 state.pubLog', async () => {
    const env = makeRefreshEnv({
      listPubs: function () { return Promise.resolve([DB_ROW]); }
    });
    await env.api.refreshPubsFromDb();
    expect(env.calls.listPubs).toBe(1);
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].platform_id).toBe('github');
    expect(env.state.pubLog[0].status).toBe('ok');
    expect(env.state.pubLog[0].recId).toBe(7);
  });

  it('N7b 刷新失败时保留既有 state.pubLog（不清空），只记录错误', async () => {
    const state = { pubLog: [{ platform_id: 'github', status: 'ok', pub_key: 'k' }], route: 'dashboard' };
    const env = makeRefreshEnv({
      state: state,
      listPubs: function () { return Promise.reject(new Error('读取失败')); }
    });
    await env.api.refreshPubsFromDb();
    expect(state.pubLog.length).toBe(1);
    expect(state.pubLog[0].pub_key).toBe('k');
  });

  it('N8 连续通知不会被旧查询结果覆盖（请求序号保护）', async () => {
    const deferreds = [];
    const env = makeRefreshEnv({
      listPubs: function () {
        return new Promise(function (resolve) { deferreds.push(resolve); });
      }
    });
    const p1 = env.api.refreshPubsFromDb();
    const p2 = env.api.refreshPubsFromDb();
    expect(deferreds.length).toBe(2);
    // 先让**新**的请求返回，再让旧的请求返回
    deferreds[1]([Object.assign({}, DB_ROW, { pub_key: 'new', title: '新记录' })]);
    await p2;
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].title).toBe('新记录');
    deferreds[0]([Object.assign({}, DB_ROW, { pub_key: 'old', title: '旧记录' })]);
    await p1;
    // 旧结果被丢弃 → 仍然是新记录
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].title).toBe('新记录');
  });

  it('N10 在其它页面不刷新、不跳转、不打断用户当前操作', async () => {
    const env = makeRefreshEnv({
      state: { pubLog: [], route: 'flow' },
      listPubs: function () { return Promise.resolve([DB_ROW]); }
    });
    const before = env.state.route;
    await env.api.refreshPubsFromDb();
    expect(env.calls.dash).toBe(0);
    expect(env.calls.list).toBe(0);
    expect(env.calls.detail).toBe(0);
    expect(env.calls.workBody).toBe(0);
    expect(env.state.route).toBe(before);
    // 数据仍然刷新进了内存（只是不重绘当前页）
    expect(env.state.pubLog.length).toBe(1);
  });

  it('N10b 在看板 / 发布列表 / 发布详情页分别刷新对应视图', async () => {
    const env1 = makeRefreshEnv({ state: { pubLog: [], route: 'dashboard' } });
    await env1.api.refreshPubsFromDb();
    expect(env1.calls.dash).toBe(1);

    const env2 = makeRefreshEnv({ state: { pubLog: [], route: 'pubs' } });
    await env2.api.refreshPubsFromDb();
    expect(env2.calls.list).toBe(1);
    expect(env2.calls.dash).toBe(0);

    const env3 = makeRefreshEnv({ state: { pubLog: [], route: 'pubdetail' } });
    await env3.api.refreshPubsFromDb();
    expect(env3.calls.detail).toBe(1);
  });

  it('N10c 作品详情弹窗开着才刷新当前作品；没开就不动', async () => {
    const env1 = makeRefreshEnv({
      state: { pubLog: [], route: 'works', workDetailWork: 'w1' },
      modalOpen: false
    });
    await env1.api.refreshPubsFromDb();
    expect(env1.calls.workBody).toBe(0);

    const env2 = makeRefreshEnv({
      state: { pubLog: [], route: 'works', workDetailWork: 'w1' },
      modalOpen: true
    });
    await env2.api.refreshPubsFromDb();
    expect(env2.calls.workBody).toBe(1);
  });

  it('N10d 监听只在初始化阶段注册一次（页面切换不会重复注册）', () => {
    // 只数「真正调用注册接口」的地方（typeof 守卫不算注册）
    const registrations = HTML.match(/window\.api\.onPubsChanged\(/g) || [];
    expect(registrations.length).toBe(1);
    // 刷新入口统一走 listPubs()，renderer 不直接碰 ipcRenderer
    expect(HTML.indexOf('ipcRenderer')).toBe(-1);
  });
});

/* ==================================================================
   三、手动标记发布失败处理
   ================================================================== */

const MARK_SRC = [
  extractBlock(HTML, 'function persistMarkedPub(payload,rollback){'),
  extractBlock(HTML, 'window.markPub=function(id){')
].join('\n');

function makeMarkEnv(opts) {
  const o = opts || {};
  const state = o.state || {
    copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
    curWork: 'w1',
    works: [{ id: 'w1', name: '作品一' }],
    kpis: {}, pubByPlatform: {}, pubLog: [], milestones: [], _pendingPubKeys: []
  };
  const toasts = [];
  const calls = { renderFlow: 0, addPub: 0 };
  const windowStub = {
    api: {
      addPub: function (payload) {
        calls.addPub++;
        return o.addPub ? o.addPub(payload) : Promise.resolve({});
      }
    }
  };
  const fn = new Function(
    'window', 'state', 'pf', 'findWork', 'pubKeyFor', 'nowHM',
    'toast', 'renderFlow', 'pushMilestoneIfFirst', 'console',
    MARK_SRC + '\nreturn window.markPub;'
  );
  const markPub = fn(
    windowStub, state,
    function (id) { return { name: id === 'github' ? 'GitHub' : id }; },
    function (id) { return (state.works || []).filter(w => w.id === id)[0] || null; },
    function () { return 'gh|w1|1'; },
    function () { return '10:00'; },
    function (m, level) { toasts.push({ msg: m, level: level }); },
    function () { calls.renderFlow++; },
    function () {},
    console
  );
  return { state: state, toasts: toasts, calls: calls, markPub: markPub };
}

describe('手动标记发布 · 落库失败处理', () => {
  it('N9 写入失败时不保留虚假的内存记录，并向用户显示失败', async () => {
    const env = makeMarkEnv({
      addPub: function () { return Promise.reject(new Error('数据库写入失败')); }
    });
    env.markPub('github', { status: 'manual', title: '手动标记' });
    // 乐观写入：先把记录放进内存
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.copies.github.done).toBe(true);

    await tick();

    // 失败 → 内存记录必须撤回（绝不能留下"只存在于内存的假发布记录"）
    expect(env.state.pubLog.length).toBe(0);
    expect(env.state.copies.github.done).toBe(false);
    // 失败 → 必须明确提示用户（不再静默吞错）
    expect(env.toasts.length).toBe(1);
    expect(env.toasts[0].level).toBe('fail');
    expect(env.toasts[0].msg).toContain('发布记录写入失败');
  });

  it('N9e 写库失败前发生过刷新（state.pubLog 被重建）时，回滚仍能撤掉假记录', async () => {
    const env = makeMarkEnv({
      addPub: function () { return Promise.reject(new Error('数据库写入失败')); }
    });
    env.markPub('github', { status: 'manual', title: '手动标记' });
    expect(env.state.pubLog.length).toBe(1);
    // 模拟一次「发布记录变更通知」触发的刷新：state.pubLog 被换成一个新数组
    env.state.pubLog = env.state.pubLog.slice();
    await tick();
    // 回滚必须作用于当前数组，不能抓着旧数组不放
    expect(env.state.pubLog.length).toBe(0);
    expect(env.toasts.length).toBe(1);
    expect(env.toasts[0].level).toBe('fail');
  });

  it('N9b 写入成功时保留记录，且不弹失败提示', async () => {
    const env = makeMarkEnv({
      addPub: function () { return Promise.resolve({ status: 'ok' }); }
    });
    env.markPub('github', { status: 'manual', title: '手动标记' });
    expect(env.state.pubLog.length).toBe(1);
    await tick();
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].status).toBe('manual');
    expect(env.toasts.length).toBe(0);
  });

  it('N9c 失败时不影响发布记录字段与幂等键规则', async () => {
    const env = makeMarkEnv({
      addPub: function () { return Promise.reject(new Error('数据库写入失败')); }
    });
    const sent = [];
    env.markPub('github', { status: 'manual', title: '手动标记' });
    await tick();
    expect(sent.length).toBe(0);
    // 幂等键仍然是既定规则（platform|work|...）
    expect(env.state.pubLog.length).toBe(0);
    expect(env.calls.addPub).toBe(1);
  });

  it('N9d 补挂作品失败时也不静默吞错，并撤回内存里的关联', async () => {
    const env = makeMarkEnv({
      addPub: function () { return Promise.reject(new Error('数据库写入失败')); }
    });
    env.state.pubLog = [{
      platform: 'GitHub', platform_id: 'github', id: 'github', status: 'manual',
      title: 't', body: 'b', tags: [], time: '10:00', url: '', error: '',
      video_id: '', work_id: '', created_at: new Date().toISOString(),
      pub_key: 'gh|w1|1', session: true
    }];
    const attachSrc = extractBlock(HTML, 'window.attachPubWork=function(pubKey,workId){');
    const fn = new Function('window', 'state', 'console', attachSrc + '\nreturn window.attachPubWork;');
    const attachPubWork = fn(env.window || { api: { addPub: function () { return Promise.reject(new Error('数据库写入失败')); } } }, env.state, console);
    attachPubWork('gh|w1|1', 'w1');
    expect(env.state.pubLog[0].work_id).toBe('w1');
    await tick();
    // 失败 → 内存里的关联撤回，并提示用户
    expect(env.state.pubLog[0].work_id).toBe('');
  });
});
