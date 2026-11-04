'use strict';

// Rokit · 任务 C：删除整份发布计划（定向测试）
//
// 覆盖用户要求的全部删除语义：
//   D1  只删除用户明确选择的那一份计划（其它作品的计划不受影响）
//   D2  尚未执行的任务（pending）→ 取消，不再是待执行
//   D3  已执行历史（done / failed / draft_pending）与发布记录（pubs）一律保留
//   D4  不误删作品本身
//   D5  有「正在执行（running）」的任务 → 拒绝删除并说明原因
//   D6  有「结果未知的真实任务（needs_review 且非模拟）」→ 拒绝删除并说明原因
//   D7  模拟任务处于 needs_review 时可以删除（模拟结果没有任何外部副作用）
//   D8  删除后调度器不再选中该计划的任何任务
//   D9  进程重启（重新打开数据库）后仍是删除态，不会复活
//   D10 SQLite 与 JSON 两种存储模式行为一致
//   D11 renderer → preload → IPC → store 全链路真的打通（plan:delete / planDelete）
//   D12 删除过程不发生任何真实平台发布或网络请求
//
// 跑的是生产代码：
//   - electron/store.js（deletePlan）
//   - electron/plan-ipc.js（plan:delete 通道）
//   - electron/preload.js（planDelete 转发）
//   - electron/plan-scheduler.js（验证删除后不再被选中）
//
// 所有测试都用临时目录里的独立数据库，不触碰用户真实作品与发布记录。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const STORE_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const PLAN_IPC_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-ipc.js'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;
let restoreBlock = null;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  if (restoreBlock) { restoreBlock(); restoreBlock = null; }
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
});

// 载入 store（按模式屏蔽驱动）
function loadStore(mode) {
  if (restoreBlock) { restoreBlock(); restoreBlock = null; }
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
  restoreBlock = H.installDriverBlock(mode === 'json');
  return require(path.join(H.ROOT, 'electron', 'store'));
}
function newStore(mode) {
  const { Store } = loadStore(mode || 'sqlite');
  return new Store(dbPath);
}
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}

// 建一个作品 + 计划（返回任务数组）
//   本文件的到期列表断言按「模拟口径」检查：造好计划后降级为模拟候选（等价旧 auto_publish=0）
function setupPlan(store, workId, platforms) {
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, { platforms: platforms || ['github'] })]);
  return H.demoteToSimulated(store, workId);
}
function taskOf(store, workId, platformId) {
  return store.listPlanTasks(workId).filter(function (t) { return t.platform_id === platformId; })[0];
}

/* ==================================================================
   D1 · 只删除用户明确选择的那份计划
   ================================================================== */
describe('D1 · 只删除用户明确选择的那份计划', () => {
  it('删除 A 作品的计划后，B 作品的计划完全不受影响', () => {
    const store = newStore();
    setupPlan(store, 'w1', ['github']);
    setupPlan(store, 'w2', ['github', 'wechat']);

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.work_id).toBe('w1');

    expect(store.listPlanStages('w1')).toHaveLength(0);
    expect(store.listPlanStages('w2')).toHaveLength(1);
    expect(store.listPlanTasks('w2')).toHaveLength(2);
  });

  it('删除多个阶段的作品时，该作品的全部阶段都被删除', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [
      H.stage('ps_a', { platforms: ['github'] }),
      H.stage('ps_b', { platforms: ['wechat'] }),
      H.stage('ps_c', { platforms: ['youtube'] })
    ]);
    expect(store.listPlanStages('w1')).toHaveLength(3);

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.deleted_stages).toBe(3);
    expect(store.listPlanStages('w1')).toHaveLength(0);
  });

  it('作品没有已保存的计划时返回明确错误（不静默成功）', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一');
    const res = store.deletePlan('w1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('没有已保存的计划');
  });

  it('缺少作品 ID 时返回错误', () => {
    const store = newStore();
    const res = store.deletePlan('');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing work id');
  });
});

/* ==================================================================
   D2 · 尚未执行的任务 → 取消
   ================================================================== */
describe('D2 · 尚未执行的任务被取消（不再是待执行）', () => {
  it('pending 任务变成 cancelled，并写明原因', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github', 'wechat']);
    expect(tasks.map(t => t.status)).toEqual(['pending', 'pending']);

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.cancelled_tasks).toBe(2);
    expect(res.kept_tasks).toBe(0);

    const after = store.listPlanTasks('w1');
    after.forEach(function (t) {
      expect(t.status).toBe('cancelled');
      expect(t.finished_at).toBeTruthy();
      expect(t.note).toContain('计划已删除');
    });
  });

  it('取消后的任务不再出现在到期任务列表里', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    expect(store.listDuePlanTasks(new Date().toISOString()).length).toBe(1);

    store.deletePlan('w1');
    expect(store.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
  });
});

/* ==================================================================
   D3 · 已执行历史与发布记录一律保留
   ================================================================== */
describe('D3 · 已执行历史与发布记录保留，不被删除', () => {
  it('done / failed 任务原样保留（不被伪造成未发布）', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github', 'wechat', 'youtube']);
    const gh = tasks.filter(t => t.platform_id === 'github')[0];
    const yt = tasks.filter(t => t.platform_id === 'youtube')[0];

    store._planWriteTask(Object.assign({}, gh, {
      status: 'done', platform_ref: 'mock:github:x', platform_url: 'https://github.com/x/y',
      started_at: new Date().toISOString(), finished_at: new Date().toISOString()
    }));
    store._planWriteTask(Object.assign({}, yt, {
      status: 'failed', error: '模拟失败', finished_at: new Date().toISOString()
    }));

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.cancelled_tasks).toBe(1);      // 只有 wechat 那条 pending 被取消
    expect(res.kept_tasks).toBe(2);          // done / failed 保留

    const after = store.listPlanTasks('w1');
    const done = after.filter(t => t.platform_id === 'github')[0];
    const failed = after.filter(t => t.platform_id === 'youtube')[0];
    const cancelled = after.filter(t => t.platform_id === 'wechat')[0];
    expect(done.status).toBe('done');
    expect(done.platform_ref).toBe('mock:github:x');
    expect(done.platform_url).toBe('https://github.com/x/y');
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('模拟失败');
    expect(cancelled.status).toBe('cancelled');
  });

  it('草稿待发布（draft_pending）历史也保留', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['wechat']);
    store._planWriteTask(Object.assign({}, tasks[0], { status: 'draft_pending' }));

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.kept_tasks).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('draft_pending');
  });

  it('删除计划不会删除历史发布记录（pubs）', () => {
    const store = newStore();
    setupPlan(store, 'w1', ['github']);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', pub_key: 'k1', url: 'https://github.com/x/y'
    });
    expect(store.listPubs()).toHaveLength(1);

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(store.listPubs()).toHaveLength(1);
    expect(store.listPubs()[0].url).toBe('https://github.com/x/y');
  });
});

/* ==================================================================
   D4 · 不误删作品本身
   ================================================================== */
describe('D4 · 删除计划不会误删作品', () => {
  it('删除计划后作品仍然存在', () => {
    const store = newStore();
    setupPlan(store, 'w1', ['github']);
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });

    store.deletePlan('w1');

    const works = store.listWorks().filter(function (w) { return w.id === 'w1'; });
    expect(works).toHaveLength(1);
    expect(works[0].name).toBe('作品 w1');
  });
});

/* ==================================================================
   D5 / D6 / D7 · 正在执行 / 结果未知的安全边界
   ================================================================== */
describe('D5 · 有正在执行的任务时拒绝删除', () => {
  it('running 任务存在时 deletePlan 拒绝删除，且不改动任何数据', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github', 'wechat']);
    store._planWriteTask(Object.assign({}, tasks[0], { status: 'running' }));

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe('running');
    expect(res.error).toContain('正在执行');
    expect(res.blocked_tasks.length).toBe(1);

    // 数据完全没动
    expect(store.listPlanStages('w1')).toHaveLength(1);
    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('running');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('pending');
  });
});

describe('D6 · 有结果未知的真实任务时拒绝删除', () => {
  it('needs_review 且非模拟的任务存在时拒绝删除', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github', 'wechat']);
    store._planWriteTask(Object.assign({}, tasks[0], {
      status: 'needs_review', simulated: 0, real_only: 0,
      note: '真实发布过程中断，无法确认平台是否已收到内容'
    }));

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe('needs_review');
    expect(res.error).toContain('人工核实');
    expect(res.error).toContain('不会自动重发');
    expect(res.blocked_tasks.length).toBe(1);

    // 状态没有被抹掉（否则重新创建计划就可能重复发送）
    expect(store.listPlanStages('w1')).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });
});

describe('D7 · 模拟任务的 needs_review 可以删除', () => {
  it('simulated=1 的 needs_review 任务被取消（模拟没有外部副作用）', () => {
    const store = newStore();
    const tasks = setupPlan(store, 'w1', ['github']);
    store._planWriteTask(Object.assign({}, tasks[0], {
      status: 'needs_review', simulated: 1, real_only: 0
    }));

    const res = store.deletePlan('w1');
    expect(res.ok).toBe(true);
    expect(res.cancelled_tasks).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

/* ==================================================================
   D8 / D9 · 删除后不再被调度、重启后仍是删除态
   ================================================================== */
describe('D8 · 删除后调度器不再选中该计划的任务', () => {
  it('调度器扫描一次不会执行已删除计划里的到期任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupPlan(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });

    store.deletePlan('w1');
    const out = scheduler.scanOnce();

    expect(calls).toBe(0);
    expect(out.claimed).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

describe('D9 · 进程重启后仍是删除态', () => {
  it('重新打开数据库后阶段依然为空、任务依然是 cancelled', () => {
    const store = newStore();
    setupPlan(store, 'w1', ['github', 'wechat']);
    store.deletePlan('w1');

    const reopened = newStore();
    expect(reopened.listPlanStages('w1')).toHaveLength(0);
    const tasks = reopened.listPlanTasks('w1');
    expect(tasks).toHaveLength(2);
    tasks.forEach(function (t) { expect(t.status).toBe('cancelled'); });
  });

  it('重启后调度器依然不会执行这个计划', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupPlan(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.deletePlan('w1');

    const reopened = newStore();
    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();

    expect(calls).toBe(0);
    expect(reopened.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

/* ==================================================================
   D10 · SQLite 与 JSON 行为一致
   ================================================================== */
describe('D10 · SQLite 与 JSON 两种存储模式行为一致', () => {
  it('两种模式的删除结果完全一致', () => {
    function scenario(mode) {
      const store = newStore(mode);
      const tasks = setupPlan(store, 'w1', ['github', 'wechat']);
      store._planWriteTask(Object.assign({}, tasks[0], { status: 'done', platform_ref: 'mock:github:x' }));
      const res = store.deletePlan('w1');
      return {
        ok: res.ok,
        stages: store.listPlanStages('w1').length,
        tasks: store.listPlanTasks('w1').map(function (t) {
          return { plat: t.platform_id, status: t.status, ref: t.platform_ref };
        }).sort(function (a, b) { return a.plat < b.plat ? -1 : 1; })
      };
    }
    const sq = scenario('sqlite');
    const js = scenario('json');
    expect(js).toEqual(sq);
    expect(sq.ok).toBe(true);
    expect(sq.stages).toBe(0);
  });

  it('两种模式下运行中 / 结果未知的拦截行为一致', () => {
    function scenario(mode) {
      const store = newStore(mode);
      const tasks = setupPlan(store, 'w1', ['github']);
      store._planWriteTask(Object.assign({}, tasks[0], { status: 'needs_review', simulated: 0 }));
      const res = store.deletePlan('w1');
      return { ok: res.ok, blocked: res.blocked, stages: store.listPlanStages('w1').length };
    }
    expect(scenario('json')).toEqual(scenario('sqlite'));
  });
});

/* ==================================================================
   D11 · renderer → preload → IPC → store 全链路
   ================================================================== */
describe('D11 · 删除计划的 IPC 全链路', () => {
  function createIpcHarness() {
    const handlers = new Map();
    const ipcMain = {
      handle: vi.fn(function (channel, fn) { handlers.set(channel, fn); })
    };
    const storeRef = { current: null };
    const { registerPlanIpc } = require(path.join(H.ROOT, 'electron', 'plan-ipc'));
    registerPlanIpc(ipcMain, { getStore: function () { return storeRef.current; } });
    return { handlers: handlers, ipcMain: ipcMain, storeRef: storeRef };
  }

  it('plan-ipc 注册了 plan:delete 通道', () => {
    const h = createIpcHarness();
    expect(h.handlers.has('plan:delete')).toBe(true);
  });

  it('preload 暴露了 planDelete', () => {
    expect(PRELOAD_SRC).toContain('planDelete:');
    expect(PRELOAD_SRC).toContain("ipcRenderer.invoke('plan:delete'");
  });

  it('完整链路：renderer 调用 → preload 转发 → IPC handler → store 落库 → 读回', async () => {
    const h = createIpcHarness();
    const store = newStore();
    setupPlan(store, 'w1', ['github']);
    h.storeRef.current = store;

    const invoked = [];
    const ipcRenderer = {
      invoke: vi.fn(function (channel, ...args) {
        invoked.push({ channel: channel, args: args });
        const fn = h.handlers.get(channel);
        if (!fn) return Promise.reject(new Error('no handler ' + channel));
        return Promise.resolve(fn(null, ...args));
      })
    };
    const electronStub = {
      contextBridge: {
        exposeInMainWorld: function (key, value) { if (key === 'api') api = value; }
      },
      ipcRenderer: ipcRenderer
    };
    let api = null;
    const preloadFn = new Function('require', 'module', 'exports', PRELOAD_SRC);
    preloadFn(function (name) {
      if (name === 'electron') return electronStub;
      return require(name);
    }, { exports: {} }, {});

    const res = await api.planDelete('w1');
    expect(res.ok).toBe(true);
    expect(invoked[0].channel).toBe('plan:delete');
    expect(invoked[0].args[0]).toBe('w1');

    // 真的落库了
    expect(store.listPlanStages('w1')).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

/* ==================================================================
   D12 · 删除过程不发生真实平台发布
   ================================================================== */
describe('D12 · 删除计划不触发任何真实平台发布', () => {
  it('deletePlan 不发起网络请求', () => {
    const i = STORE_SRC.indexOf('  deletePlan(workId) {');
    expect(i).toBeGreaterThan(-1);
    const block = STORE_SRC.slice(i, i + 2600);
    expect(block).not.toMatch(/https?\.(get|post|request)|fetch\(|net\.request|axios/i);
    expect(block).not.toMatch(/publishers|youtube-publisher|github-publisher|createDraft|publishVideo|publishRepo/i);
  });

  it('plan:delete 通道只调用 store.deletePlan，不含任何平台发布调用', () => {
    const i = PLAN_IPC_SRC.indexOf("ipcMain.handle('plan:delete'");
    expect(i).toBeGreaterThan(-1);
    const block = PLAN_IPC_SRC.slice(i, i + 200);
    expect(block).toContain('deletePlan');
    expect(block).not.toMatch(/publishToGithub|githubPublish|youtubePublish|wechatCreateDraft|publishVideo|createDraft/i);
  });

  it('preload 的 planDelete 只转发到 plan:delete 通道', () => {
    const i = PRELOAD_SRC.indexOf('planDelete:');
    const line = PRELOAD_SRC.slice(i, PRELOAD_SRC.indexOf('\n', i));
    expect(line).toContain("ipcRenderer.invoke('plan:delete'");
    expect(line).not.toMatch(/publish|createDraft|fetch/i);
  });

  it('删除计划不会新增任何发布记录', () => {
    const store = newStore();
    setupPlan(store, 'w1', ['github']);
    const before = store.listPubs().length;
    store.deletePlan('w1');
    expect(store.listPubs().length).toBe(before);
  });
});
