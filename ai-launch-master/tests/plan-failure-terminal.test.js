'use strict';

// Rokit · 计划发送「失败即终止」（不自动重试 / 不自动重新入队）—— 定向测试
//
// 覆盖本次修改的全部要求：
//   FT1 明确失败的任务不会被定时扫描重新执行
//   FT2 应用启动恢复后，明确失败的任务仍保持终止状态
//   FT3 状态对账不会把明确失败的任务改回待发送
//   FT4 结果未知的任务不会自动重发，并保留人工核实路径
//   FT5 成功任务不会被重复执行
//   FT6 失败平台和失败原因能正确保留并供 UI 展示
//   FT7 用户主动创建的新计划不受旧失败任务影响
//   FT8 现有模拟发送 / 幂等保护 / 成功恢复行为不被破坏
//
// 全部使用临时数据库 + 注入的 mock 执行器，**没有任何真实平台调用**。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

function newStore(mode) {
  const { Store } = H.loadStoreFresh(mode === 'json');
  return new Store(dbPath);
}
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}
function seedStage(store, workId, stageId, platformId) {
  store.savePlanStages(workId, [H.stage(stageId, { platforms: [platformId] })]);
  // GitHub 任务默认 real_only=1，模拟调度器不领取；降级为模拟候选（等价旧 auto_publish=0）
  H.demoteToSimulated(store, workId);
  return store.listPlanTasks(workId).filter(t => t.platform_id === platformId)[0];
}
/** 模拟 → 显式重新排队 → 得到一条「等待真实执行」的真实任务（real_only=1） */
function makeRealWaitingTask(store, workId, taskId) {
  const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
  store.updatePlanTask(workId, taskId, { scheduled_at: H.PAST });
  createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
  const r = store.requeueSimulatedPlanTask(workId, taskId);
  expect(r.ok).toBe(true);
  return store.listPlanTasks(workId).filter(t => t.id === taskId)[0];
}

/* ==================================================================
   FT1 · 明确失败的任务不会被定时扫描重新执行
   ================================================================== */
describe('FT1 · 明确失败的任务不会被定时扫描重新执行', () => {
  it('失败后连续扫描：执行器不再被调用，状态保持 failed', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: false, error: '平台明确拒绝：授权已失效' }; }
    });
    scheduler.scanOnce();

    expect(calls).toBe(1);
    const failed = store.listPlanTasks('w1')[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('授权已失效');

    // 后续定时扫描：不再领取、不再执行
    scheduler.scanOnce();
    scheduler.scanOnce();
    expect(calls).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
    expect(store.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
  });

  it('失败任务不进入待发送队列（模拟 / 真实两种扫描口径都不领取）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    store.claimPlanTask(task.id);
    store.finishPlanTask(task.id, store.listPlanTasks('w1')[0].started_at, { ok: false, error: '明确失败' });

    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
    expect(store.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
    expect(store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true })).toHaveLength(0);
  });
});

/* ==================================================================
   FT2 · 应用启动恢复后，明确失败的任务仍保持终止状态
   ================================================================== */
describe('FT2 · 应用启动恢复后，明确失败的任务仍保持终止状态', () => {
  it('重启（新的 store + 新的调度器）不会复活失败任务，也不会再次执行', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: '平台明确拒绝：授权已失效' }; }
    }).scanOnce();
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');

    // 重启：新的 store 实例（同样的持久化数据）+ 新的调度器
    const store2 = newStore('sqlite');
    let calls = 0;
    const scheduler2 = createPlanScheduler({
      getStore: () => store2,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    const rec = scheduler2.recover();
    expect(rec.ok).toBe(true);

    const after = store2.listPlanTasks('w1')[0];
    expect(after.status).toBe('failed');
    expect(after.error).toContain('授权已失效');

    await scheduler2.scanOnce().settled;
    expect(calls).toBe(0);
    expect(store2.listPlanTasks('w1')[0].status).toBe('failed');
  });

  it('模拟执行的遗留 running 任务仍然正常重新排队（调度器恢复能力不被削弱）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.claimPlanTask(task.id);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    const rec = store.recoverStuckPlanTasks();
    expect(rec.recovered).toBe(1);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('pending');
    expect(after.note).toContain('重启恢复');
  });
});

/* ==================================================================
   FT3 · 状态对账不会把明确失败的任务改回待发送
   ================================================================== */
describe('FT3 · 状态对账不会把明确失败的任务改回待发送', () => {
  it('即使有同幂等键的确认成功记录，failed 任务也不会被对账改回 pending / done', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: '平台明确拒绝' }; }
    }).scanOnce();
    const failed = store.listPlanTasks('w1')[0];
    expect(failed.status).toBe('failed');

    // 造一条同幂等键的"确认成功"记录（最容易被误判成成功的场景）
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: failed.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('failed');
    expect(store.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
  });

  it('失败任务的发布前闸门不再放行（不会因为闸门 allow 而被再次自动发送）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: '平台明确拒绝' }; }
    }).scanOnce();

    const g = store.checkPlanPublishGuard('w1', task.id);
    expect(g.decision).not.toBe('allow');
    expect(g.reason).toContain('终止');
  });
});

/* ==================================================================
   FT4 · 结果未知的任务不会自动重发，并保留人工核实路径
   ================================================================== */
describe('FT4 · 结果未知的任务不会自动重发，并保留人工核实路径', () => {
  it('真实发布执行器抛异常（超时）→ needs_review，不会被自动重发', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    makeRealWaitingTask(store, 'w1', task.id);

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      realExecutors: {
        github: function () { calls++; throw new Error('请求超时：ETIMEDOUT'); }
      }
    });
    const out = scheduler.scanOnce();
    await out.settled;

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('needs_review');
    expect(after.error).toContain('结果未知');
    expect(after.note).toContain('无法确认平台是否已收到内容');
    expect(out.review).toHaveLength(1);
    expect(calls).toBe(1);

    // 再次扫描：不会自动重发
    scheduler.scanOnce();
    expect(calls).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });

  it('真实发布执行器 Promise reject（连接中断）→ needs_review，不会被自动重发', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    makeRealWaitingTask(store, 'w1', task.id);

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      realExecutors: {
        github: function () { calls++; return Promise.reject(new Error('连接中断：ECONNRESET')); }
      }
    });
    await scheduler.scanOnce().settled;

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('needs_review');
    expect(after.error).toContain('结果未知');
    expect(calls).toBe(1);

    scheduler.scanOnce();
    expect(calls).toBe(1);
  });

  it('真实发布途中进程退出（结果未知）→ 启动恢复转 needs_review，不自动重发', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeRealWaitingTask(store, 'w1', task.id);
    // 模拟：真实执行途中进程退出（任务停在 running，real_only=1）
    const claim = store.claimPlanTask(t.id);
    expect(claim.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    const store2 = newStore('sqlite');
    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store2,
      executorKind: 'real',
      realExecutors: { github: function () { calls++; return { ok: true, status: 'done' }; } }
    });
    const rec = scheduler.recover();
    expect(rec.needs_review).toBe(1);

    const after = store2.listPlanTasks('w1')[0];
    expect(after.status).toBe('needs_review');
    expect(after.note).toContain('无法确认平台是否已收到内容');
    expect(store2.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true })).toHaveLength(0);

    await scheduler.scanOnce().settled;
    expect(calls).toBe(0);     // 没有自动重发
    expect(store2.listPlanTasks('w1')[0].status).toBe('needs_review');
  });

  it('模拟执行的异常仍然是明确失败（模拟没有任何外部副作用）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });

    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { throw new Error('模拟执行器炸了'); }
    }).scanOnce();

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('failed');
    expect(after.error).toContain('模拟执行器炸了');
  });
});

/* ==================================================================
   FT5 · 成功任务不会被重复执行
   ================================================================== */
describe('FT5 · 成功任务不会被重复执行', () => {
  it('成功任务在重复扫描 / 重启后都不会再次执行', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();
    expect(calls).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');

    scheduler.scanOnce();
    expect(calls).toBe(1);

    const store2 = newStore('sqlite');
    const scheduler2 = createPlanScheduler({
      getStore: () => store2,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler2.recover();
    await scheduler2.scanOnce().settled;
    expect(calls).toBe(1);
    expect(store2.listPlanTasks('w1')[0].status).toBe('done');
  });
});

/* ==================================================================
   FT6 · 失败平台和失败原因能正确保留并供 UI 展示
   ================================================================== */
describe('FT6 · 失败平台和失败原因能正确保留并供 UI 展示', () => {
  function extractBlock(src, header) {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('block not found: ' + header);
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
  }
  const SRC = {
    statusMeta: extractBlock(HTML, 'function planTaskStatusMeta(id,simulated,realOnly){'),
    failNotice: extractBlock(HTML, 'function planTaskFailureNotice(task,platformName){'),
    timeText: extractBlock(HTML, 'function planTaskTimeText(task){'),
    copyText: extractBlock(HTML, 'function planTaskCopyText(stage,pid,workId){'),
    taskDetailHtml: extractBlock(HTML, 'function planDetailTaskDetailHtml(workId,st,t,editing){'),
    renderCenter: extractBlock(HTML, 'function renderPlanCenter(){')
  };
  const ESC = function (s) { return String(s == null ? '' : s); };
  const STATUS_ARR = (function () {
    const m = /var PLAN_TASK_STATUS=\[[\s\S]*?\];/.exec(HTML);
    return m ? m[0] : 'var PLAN_TASK_STATUS=[];';
  })();
  const PLATFORM_META = function (id) {
    return { github: { id: 'github', name: 'GitHub' }, youtube: { id: 'youtube', name: 'YouTube' } }[id] || { id: id, name: id };
  };

  it('失败原因与失败平台被完整保留在任务行里', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: 'missing-token（尚未完成 GitHub 授权）' }; }
    }).scanOnce();

    const after = store.listPlanTasks('w1')[0];
    expect(after.platform_id).toBe('github');       // 失败平台
    expect(after.status).toBe('failed');
    expect(after.error).toContain('missing-token');  // 失败原因
    expect(after.finished_at).toBeTruthy();
  });

  it('界面提示包含：失败平台、失败原因、检查登录 / 授权 / 平台配置的建议', () => {
    const fn = new Function('esc', 'planPlatformMeta', SRC.failNotice + '\nreturn planTaskFailureNotice;');
    const notice = fn(ESC, PLATFORM_META)({
      id: 't1', status: 'failed', platform_id: 'github', error: 'missing-token（尚未完成 GitHub 授权）'
    }, 'GitHub');

    expect(notice).toContain('GitHub');                 // 失败平台
    expect(notice).toContain('missing-token');          // 失败原因
    expect(notice).toContain('登录状态');                // 排查建议
    expect(notice).toContain('授权');
    expect(notice).toContain('平台配置');
    expect(notice).toContain('手动发送');                // 后续动作
    expect(notice).toContain('重新创建计划');
    expect(notice).toContain('不会自动重试');
  });

  it('没有可靠原因时给通用提示，不编造原因', () => {
    const fn = new Function('esc', 'planPlatformMeta', SRC.failNotice + '\nreturn planTaskFailureNotice;');
    const notice = fn(ESC, PLATFORM_META)({ id: 't1', status: 'failed', platform_id: 'github', error: '' }, 'GitHub');
    expect(notice).toContain('GitHub');
    expect(notice).toContain('没有返回具体失败原因');
    expect(notice).not.toContain('undefined');
  });

  it('结果未知（needs_review）提示的是先核实平台是否已收到内容', () => {
    const fn = new Function('esc', 'planPlatformMeta', SRC.failNotice + '\nreturn planTaskFailureNotice;');
    const notice = fn(ESC, PLATFORM_META)({
      id: 't1', status: 'needs_review', platform_id: 'github', error: 'network（连接超时）'
    }, 'GitHub');
    expect(notice).toContain('结果未知');
    expect(notice).toContain('核实');
    expect(notice).toContain('不会自动重发');
  });

  it('非失败状态不显示任何失败提示', () => {
    const fn = new Function('esc', 'planPlatformMeta', SRC.failNotice + '\nreturn planTaskFailureNotice;');
    expect(fn(ESC, PLATFORM_META)({ id: 't1', status: 'pending', platform_id: 'github' }, 'GitHub')).toBe('');
    expect(fn(ESC, PLATFORM_META)({ id: 't1', status: 'done', platform_id: 'github' }, 'GitHub')).toBe('');
  });

  it('任务详情面板展示失败提示', () => {
    const fn = new Function('state', 'esc', 'planTaskStatusMeta', 'planTaskTimeText', 'planPlatformMeta',
      STATUS_ARR + '\n' + SRC.statusMeta + '\n' + SRC.timeText + '\n' + SRC.copyText + '\n' + SRC.failNotice + '\n' + SRC.taskDetailHtml
      + '\nreturn planDetailTaskDetailHtml;');
    const html = fn({}, ESC,
      function (id) { return { id: id, label: id }; },
      function (t) { return t.scheduled_at || ''; },
      PLATFORM_META)(
        'w1', {}, { id: 't1', status: 'failed', platform_id: 'github', error: '平台明确拒绝：授权已失效' }, false);

    expect(html).toContain('GitHub');
    expect(html).toContain('平台明确拒绝：授权已失效');
    expect(html).toContain('登录状态');
  });

  it('全局计划列表渲染失败提示（失败平台 + 原因）', () => {
    expect(SRC.renderCenter).toContain('planTaskFailureNotice');
  });
});

/* ==================================================================
   FT7 · 用户主动创建的新计划不受旧失败任务影响
   ================================================================== */
describe('FT7 · 用户主动创建的新计划不受旧失败任务影响', () => {
  it('旧失败任务保持终止，新阶段的新任务正常待发送并可被执行', async () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const old = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', old.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: '平台明确拒绝：授权已失效' }; }
    }).scanOnce();
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');

    // 用户重新创建计划：新增一个阶段
    store.savePlanStages('w1', [
      H.stage('ps_a', { platforms: ['github'] }),
      H.stage('ps_b', { platforms: ['github'] })
    ]);
    // 新任务按模拟口径验证（GitHub 默认 real_only=1，降级为模拟候选；旧失败任务状态不变）
    H.demoteToSimulated(store, 'w1');
    const tasks = store.listPlanTasks('w1');
    const oldTask = tasks.filter(t => t.stage_id === 'ps_a')[0];
    const newTask = tasks.filter(t => t.stage_id === 'ps_b')[0];
    expect(oldTask.status).toBe('failed');        // 旧任务不被复活
    expect(newTask.status).toBe('pending');       // 新任务正常待发送
    expect(newTask.pub_key).not.toBe(oldTask.pub_key);
    store.updatePlanTask('w1', newTask.id, { scheduled_at: H.PAST });   // 让新任务到期

    // 新任务可以被正常调度（旧失败任务不受影响）
    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();
    expect(calls).toBe(1);
    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.stage_id === 'ps_a')[0].status).toBe('failed');
    expect(after.filter(t => t.stage_id === 'ps_b')[0].status).toBe('done');
  });

  it('真实失败任务没有"重新入队"入口（重排接口只接受模拟任务）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: false, error: '平台明确拒绝' }; }
    }).scanOnce();

    const failed = store.listPlanTasks('w1')[0];
    const res = store.requeueSimulatedPlanTask('w1', failed.id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
  });
});

/* ==================================================================
   FT8 · 现有模拟发送 / 幂等保护 / 成功恢复行为不被破坏
   ================================================================== */
describe('FT8 · 现有模拟发送 / 幂等保护 / 成功恢复行为不被破坏', () => {
  it('模拟执行照旧成功（done + 模拟标识）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.simulated).toBe(1);
    expect(after.platform_ref).toContain('mock:');
  });

  it('幂等保护仍然拦住重复发布（已有确认成功记录 → skip）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeRealWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('skip');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      realExecutors: { github: function () { calls++; return { ok: true, status: 'done' }; } }
    });
    scheduler.scanOnce();
    expect(calls).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('真实发布成功后的崩溃恢复仍然能把任务对账为 done（成功恢复不被破坏）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeRealWaitingTask(store, 'w1', task.id);
    // 模拟"发布成功、记录已落库、任务结算前崩溃"的现场
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    store.claimPlanTask(t.id);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({ getStore: () => store, executorKind: 'real' });
    const rec = scheduler.recover();
    expect(rec.reconciled).toBe(1);

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_url).toBe('https://github.com/owner/repo/releases/tag/v0.1.0');
  });
});
