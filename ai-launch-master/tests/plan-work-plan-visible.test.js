'use strict';

// Rokit · 首秀计划在「我的作品」可见 / 归属正确 / 重启可读 定向测试
//
// 背景（根因回归）：
//   启动后 state.curWork 会指向第一件真实作品，但 state.planOwnerId 仍为空。
//   此时保存计划会按 curWork 写入数据库，却没有把归属回写到 state.planOwnerId；
//   随后 launch() 找不到「转正来源」，不会调用 planReassign，
//   计划就留在旧作品名下，新作品详情里自然看不到。
//
// 覆盖：
//   V1 savePlan 解析出的 owner 必须回写 state.planOwnerId
//   V2 保存后的计划能在对应作品的详情查询（plan:list 同源 store 查询）中读到
//   V3 应用重启（新 Store 实例读取同一数据库文件）后仍然能读到
//   V4 计划归属转正：阶段与任务改挂新作品，旧作品不再有残留
//   V5 不同作品的计划互不串数据
//   V6 旧 Release 历史任务（platform_ref = Release URL）不会导致列表加载失败
//   V7 改名（planOwnerId 为空但已有当前作品）必须切到新草稿归属，且保留执行时间
//
// 安全约束：全部使用临时目录数据库；不调用真实发布、不读写生产数据。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

const STEP_DONE = 12;
const FUTURE = H.FUTURE;
const PAST = H.PAST;

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
});

function newStore() {
  const { Store } = H.loadStoreFresh(false);
  return new Store(dbPath);
}

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

const PAYLOAD_SRC = extractBlock(HTML, 'function planStagePayload(it){');
const SAVE_SRC = extractBlock(HTML, 'window.savePlan=function(){');
const TRANSFER_SRC = extractBlock(HTML, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){');
const SUBMIT_NAME_SRC = extractBlock(HTML, 'window.submitName=function(e){');

function absStage(id, o) {
  o = o || {};
  return {
    id: id,
    title: o.title || ('阶段 ' + id),
    desc: '',
    scheduledAt: o.scheduledAt || FUTURE,
    platforms: o.platforms || ['github'],
    copy: o.copy || {}
  };
}

function runSavePlan(state, impl) {
  const fn = new Function('state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork',
    PAYLOAD_SRC + '\n' + SAVE_SRC + '\nreturn window.savePlan();');
  return fn(
    state,
    { api: { planSave: impl } },
    function () {},
    Promise,
    function (id) { return { id: id }; },
    function () { return false; }
  );
}

function runTransfer(state, win, toast) {
  const fn = new Function('state', 'window', 'toast', 'Promise',
    TRANSFER_SRC + '\nreturn window.planTransferAfterSave;');
  return fn(state, win, toast || function () {}, Promise);
}

/* ==================================================================
   V1 · savePlan 回写归属
   ================================================================== */
describe('V1 · 保存计划回写归属', () => {
  it('planOwnerId 为空、curWork=w1 → 写入 w1 并把归属回写为 w1', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    const calls = [];
    const state = { curWork: 'w1', planOwnerId: '', copiesOwner: '', plan: [absStage('ps_a')], planDirty: true };
    const ok = await runSavePlan(state, function (owner, stages) {
      calls.push(owner);
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['w1']);
    expect(state.planOwnerId).toBe('w1');
    expect(state.copiesOwner).toBe('w1');
    expect(store.listPlanStages('w1')).toHaveLength(1);
  });

  it('已属于别的作品的 copiesOwner 不会被错误改挂', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    const state = {
      curWork: 'w1', planOwnerId: '', copiesOwner: 'w_other',
      copies: {}, plan: [absStage('ps_a')], planDirty: true
    };
    const ok = await runSavePlan(state, function (owner, stages) {
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    expect(state.planOwnerId).toBe('w1');
    expect(state.copiesOwner).toBe('w_other');
  });
});

/* ==================================================================
   V2 / V3 · 作品详情可读 / 重启可读
   ================================================================== */
describe('V2 / V3 · 计划持久化与重启读取', () => {
  it('保存后该作品详情查询能读到阶段与任务（不再串到 w1 以外的作品）', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    H.seedWork(store, 'w2', '作品二', PAST);
    const state = { curWork: 'w2', planOwnerId: '', plan: [absStage('ps_b')], planDirty: true };
    const ok = await runSavePlan(state, function (owner, stages) {
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    expect(state.planOwnerId).toBe('w2');
    // 等价于 plan:list(w2)
    expect(store.listPlanStages('w2')).toHaveLength(1);
    expect(store.listPlanTasks('w2')).toHaveLength(1);
    expect(store.listPlanStages('w1')).toHaveLength(0);
  });

  it('重启（新 Store 实例）后仍能读到已保存计划与各状态任务', async () => {
    let store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    store.savePlanStages('w1', [
      absStage('ps_a', { platforms: ['github'] }),
      absStage('ps_b', { platforms: ['wechat'] })
    ]);
    const gh = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'github'; })[0];
    const wx = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'wechat'; })[0];
    store._planWriteTask(Object.assign({}, gh, { status: 'done', simulated: 0, platform_ref: 'posts/x.md' }));
    store._planWriteTask(Object.assign({}, wx, { status: 'needs_review', note: '待核实' }));

    // 重新打开同一个数据库文件（模拟应用重启）
    store = newStore();

    const stages = store.listPlanStages('w1');
    const tasks = store.listPlanTasks('w1');
    expect(stages).toHaveLength(2);
    expect(tasks).toHaveLength(2);
    const done = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    const review = tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0];
    expect(done.status).toBe('done');
    expect(done.platform_ref).toBe('posts/x.md');
    expect(review.status).toBe('needs_review');
    // 计划详情展示所需字段都还在
    expect(stages[0].scheduled_at).toBeTruthy();
    expect(stages[0].platforms.length).toBeGreaterThan(0);
  });
});

/* ==================================================================
   V4 · 转正到新作品
   ================================================================== */
describe('V4 · 计划归属转正', () => {
  it('保存后 launch 用回写的来源归属完成转正：新作品可见，旧作品无残留', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', '旧作品', PAST);
    H.seedWork(store, 'w2', '新作品', PAST);
    const state = { curWork: 'w1', planOwnerId: '', copiesOwner: '', plan: [absStage('ps_a')], planDirty: true };
    const ok = await runSavePlan(state, function (owner, stages) {
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    expect(state.planOwnerId).toBe('w1');

    const win = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id }); },
        planReassign: function (from, to) { return Promise.resolve(store.reassignPlanOwner(from, to)); }
      }
    };
    const res = await runTransfer(state, win)({ id: 'w2' }, state.planOwnerId, true);
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('reassign');
    expect(state.planOwnerId).toBe('w2');
    expect(store.listPlanStages('w2')).toHaveLength(1);
    expect(store.listPlanTasks('w2')).toHaveLength(1);
    expect(store.listPlanStages('w1')).toHaveLength(0);
    expect(store.listPlanTasks('w1')).toHaveLength(0);
  });
});

/* ==================================================================
   V5 · 跨作品隔离
   ================================================================== */
describe('V5 · 不同作品的计划互不串数据', () => {
  it('w1 / w2 各自保存：查询结果按 work_id 严格隔离', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    H.seedWork(store, 'w2', '作品二', PAST);
    store.savePlanStages('w1', [absStage('ps_a')]);
    store.savePlanStages('w2', [absStage('ps_b')]);
    expect(store.listPlanStages('w1').map(function (s) { return s.id; })).toEqual(['ps_a']);
    expect(store.listPlanStages('w2').map(function (s) { return s.id; })).toEqual(['ps_b']);
    expect(store.listPlanTasks('w1')).toHaveLength(1);
    expect(store.listPlanTasks('w2')).toHaveLength(1);
    // 全局视图按 work_id 分组时不会把一个作品的阶段算到另一个作品
    const all = store.listAllPlanStages();
    expect(all.filter(function (s) { return s.work_id === 'w1'; })).toHaveLength(1);
    expect(all.filter(function (s) { return s.work_id === 'w2'; })).toHaveLength(1);
  });
});

/* ==================================================================
   V6 · 旧 Release 历史任务兼容
   ================================================================== */
describe('V6 · 旧 Release 历史任务不导致列表加载失败', () => {
  it('任务里留有 Release URL 等历史字段时，计划与任务列表仍能正常读取', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一', PAST);
    store.savePlanStages('w1', [absStage('ps_a')]);
    const task = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, task, {
      status: 'done',
      platform_ref: 'https://github.com/o/r/releases/tag/v0.1.0',
      platform_url: 'https://github.com/o/r/releases/tag/v0.1.0'
    }));
    expect(function () {
      const stages = store.listPlanStages('w1');
      const tasks = store.listPlanTasks('w1');
      const all = store.listAllPlanStages();
      expect(stages).toHaveLength(1);
      expect(tasks).toHaveLength(1);
      expect(all).toHaveLength(1);
      expect(tasks[0].status).toBe('done');
    }).not.toThrow();
  });
});

/* ==================================================================
   V7 · 改名切换草稿归属
   ================================================================== */
describe('V7 · 改名时计划跟随新作品', () => {
  function runSubmitName(state) {
    const fn = new Function(
      'state', 'window', 'document', 'findWork', 'newDraftOwnerId', 'newPlanStageId',
      'pushUser', 'pushAI', 'esc', 'renderRail', 'renderFlow', 'stopDemo',
      SUBMIT_NAME_SRC + '\nreturn window.submitName;'
    );
    return fn(
      state,
      {},
      { getElementById: function () { return { value: '新名字' }; } },
      function (id) { return state._works.filter(function (w) { return w.id === id; })[0] || null; },
      function () { return 'draft_rename_1'; },
      function () { return 'ps_new'; },
      function () {}, function () {}, function (s) { return String(s); },
      function () {}, function () {}, function () {}
    );
  }

  it('planOwnerId 为空但已有当前作品：改名切到新草稿，保留执行时间与平台', () => {
    const state = {
      curWork: 'w1',
      planOwnerId: '',
      copiesOwner: 'w1',
      plan: [absStage('ps_old', { scheduledAt: FUTURE, platforms: ['github', 'wechat'] })],
      planDirty: false,
      project: { name: '旧名字' },
      step: 1,
      messages: [],
      _works: [{ id: 'w1', name: '旧名字', isSample: false }]
    };
    runSubmitName(state)({ preventDefault: function () {} });
    expect(state.planOwnerId).toBe('draft_rename_1');
    expect(state.copiesOwner).toBe('draft_rename_1');
    expect(state.planDirty).toBe(true);
    expect(state.plan[0].id).toBe('ps_new');
    expect(state.plan[0].scheduledAt).toBe(FUTURE);
    expect(state.plan[0].platforms).toEqual(['github', 'wechat']);
  });
});

// 本文件不涉及 launch 的 UI 分支，保留常量避免误删提示
void STEP_DONE;
