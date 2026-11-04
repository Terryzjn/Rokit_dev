'use strict';

// Rokit · 修复「模拟任务重新排队后被再次模拟执行」的状态流转测试
//
// 覆盖本次修复的全部要求：
//   F1 模拟任务重排后调用 scanOnce()，任务仍保持「等待真实执行」，不会重新变成 simulated=1
//   F2 普通 pending 任务仍按原有 mock 流程执行
//   F3 真实执行器模式下，等待任务可被识别，但 skip / review / unclear 均被拒绝
//   F4 allow 仅代表通过发布前安全闸门（不实际调用真实发布）
//   F5 真实发布成功任务不能通过该接口被重置
//   F6 重排后的历史模拟结果不会被新执行结果或备注意外覆盖
//   F7 SQLite 与 JSON fallback 行为一致；迁移保留原数据
//
// 全部使用临时目录里的独立数据库与隔离数据，不触碰用户生产数据库。

const path = require('path');
const H = require('./helpers/plan-store');

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

function newStore(mode, file) {
  const { Store } = H.loadStoreFresh(mode === 'json');
  return new Store(file || dbPath);
}
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}

/**
 * 造一个"已经被模拟执行过"的任务：
 *   workId 作品 + 一个阶段 + 一个平台任务 → mock 跑一次 → status='done'、simulated=1
 */
function seedSimulatedDoneTask(store, workId, platformId) {
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, { platforms: [platformId || 'github'] })]);
  // GitHub 任务默认 real_only=1，模拟调度器不领取；降级为模拟候选（等价旧 auto_publish=0）
  H.demoteToSimulated(store, workId);
  const task = store.listPlanTasks(workId)[0];
  store.updatePlanTask(workId, task.id, { scheduled_at: H.PAST });
  const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
  createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
  return store.listPlanTasks(workId)[0];
}

/* ==================================================================
   F1 · 重排后下一次扫描不会重新模拟执行
   ================================================================== */
describe('F1 · 重排后的任务在后续扫描中保持「等待真实执行」', () => {
  it('scanOnce 之后仍是 pending + real_only=1 + simulated=0', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    expect(done.status).toBe('done');
    expect(done.simulated).toBe(1);

    const r = store.requeueSimulatedPlanTask('w1', done.id);
    expect(r.ok).toBe(true);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('pending');
    expect(after.simulated).toBe(0);
    expect(after.real_only).toBe(1);

    // 下一次调度扫描（mock 模式）
    let mockCalls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (t) { mockCalls++; return createMockPlanExecutor()(t, {}); }
    });
    const out = scheduler.scanOnce();

    expect(mockCalls).toBe(0);                       // 模拟执行器一次都没被调用
    expect(out.claimed).toHaveLength(0);
    expect(out.done).toHaveLength(0);
    const fin = store.listPlanTasks('w1')[0];
    expect(fin.status).toBe('pending');              // 没有被改回 done
    expect(fin.simulated).toBe(0);                   // 没有被重新写成模拟结果
    expect(fin.real_only).toBe(1);                   // 仍处于等待真实执行
  });

  it('连续多次扫描也不会被重新模拟执行', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();
    scheduler.scanOnce();
    scheduler.scanOnce();

    const fin = store.listPlanTasks('w1')[0];
    expect(fin.status).toBe('pending');
    expect(fin.simulated).toBe(0);
    expect(fin.real_only).toBe(1);
  });

  it('重开数据库（重启应用）后依然是等待状态，不会被复活成待执行的模拟任务', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);

    const reopened = newStore('sqlite');
    const t = reopened.listPlanTasks('w1')[0];
    expect(t.status).toBe('pending');
    expect(t.real_only).toBe(1);
    expect(t.simulated).toBe(0);
    // 到期列表里：模拟调度器看不到它
    expect(reopened.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
    // 真实执行器能看到它
    expect(reopened.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true })).toHaveLength(1);
  });

  it('到期扫描按执行器类型过滤（不依赖 note / platform_ref 等展示字段）', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    const t = store.listPlanTasks('w1')[0];
    // note / platform_ref 都不含"等待"字样，仍然按 real_only 列过滤
    expect(String(t.note).indexOf('等待')).toBeGreaterThan(-1);
    expect(t.platform_ref).toBe('');
    expect(store.listDuePlanTasks(new Date().toISOString()).map(x => x.id)).not.toContain(t.id);
    expect(store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true }).map(x => x.id)).toContain(t.id);
  });
});

/* ==================================================================
   F2 · 普通 pending 任务照旧被 mock 执行
   ================================================================== */
describe('F2 · 普通待执行任务仍按原有 mock 流程执行', () => {
  it('pending 且非 real_only 的任务会被模拟执行器执行并写回 simulated=1', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    const out = scheduler.scanOnce();

    expect(out.done).toHaveLength(1);
    const fin = store.listPlanTasks('w1')[0];
    expect(fin.status).toBe('done');
    expect(fin.simulated).toBe(1);
    expect(fin.real_only).toBe(0);
  });

  it('同一批次里，等待任务被跳过、普通任务照常执行', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    // 两个作品：一个任务重排为等待，一个保持普通 pending
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);

    H.seedWork(store, 'w2', '作品二');
    store.savePlanStages('w2', [H.stage('ps_b', { platforms: ['github'] })]);
    H.demoteToSimulated(store, 'w2');
    const t2 = store.listPlanTasks('w2')[0];
    store.updatePlanTask('w2', t2.id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    const out = scheduler.scanOnce();

    expect(out.done).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].real_only).toBe(1);
    expect(store.listPlanTasks('w2')[0].simulated).toBe(1);
  });
});

/* ==================================================================
   F3 / F4 · 真实执行器：识别等待任务 + 幂等闸门
   ================================================================== */
describe('F3 · 真实执行器可识别等待任务，但闸门不通过一律不发布', () => {
  function makeWaitingTask(store) {
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    return store.listPlanTasks('w1')[0];
  }

  it('等待任务能被真实执行器扫描到', () => {
    const store = newStore('sqlite');
    makeWaitingTask(store);
    const due = store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true });
    expect(due).toHaveLength(1);
    expect(due[0].real_only).toBe(1);
  });

  it('skip：已存在确认成功的发布记录 → 拒绝执行', () => {
    const store = newStore('sqlite');
    const t = makeWaitingTask(store);
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: t.pub_key });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('skip');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    const out = scheduler.scanOnce();
    expect(calls).toBe(0);
    expect(out.skipped.length).toBeGreaterThan(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('review：只能模糊匹配 → 拒绝执行', () => {
    const store = newStore('sqlite');
    const t = makeWaitingTask(store);
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'other|github|w1' });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('review');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    }).scanOnce();
    expect(calls).toBe(0);
  });

  it('unclear：结果不确定 → 拒绝执行', () => {
    const store = newStore('sqlite');
    const t = makeWaitingTask(store);
    store.claimPlanTask(t.id);   // 变成 running：执行中残留，结果不确定
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('unclear');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    }).scanOnce();
    expect(calls).toBe(0);
  });

  it('allow：仅表示通过发布前安全闸门（本次不实际调用任何真实发布）', () => {
    const store = newStore('sqlite');
    const t = makeWaitingTask(store);
    const g = store.checkPlanPublishGuard('w1', t.id);
    expect(g.decision).toBe('allow');

    // 闸门放行 ≠ 真的会发布：本次不提供真实执行器，也不会调用任何平台接口
    const { checkRealExecutionGate } = loadScheduler();
    const gate = checkRealExecutionGate(store, t);
    expect(gate.allow).toBe(true);
    expect(gate.decision).toBe('allow');
  });
});

/* ==================================================================
   F4.5 · 人工「标记已发布」记录的阻断边界
   ================================================================== */
describe('F4.5 · manual 记录只在可归因时才阻断自动发布', () => {
  function waitingTask(store) {
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    return store.listPlanTasks('w1')[0];
  }

  it('无 URL、无平台发布 ID 的无关 manual 记录 → allow，并真的进入（stub）执行器', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'manual', pub_key: 'manual|github|-'
    });

    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('allow');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    }).scanOnce();

    expect(calls).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('manual 记录带平台 URL → review，不调用执行器', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      pub_key: 'manual|github|-', url: 'https://github.com/o/r/releases/tag/v0.1.0'
    });

    const g = store.checkPlanPublishGuard('w1', t.id);
    expect(g.decision).toBe('review');
    expect(g.reason).toContain('需人工确认');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    }).scanOnce();
    expect(calls).toBe(0);
  });

  it('manual 记录带平台发布 ID（video_id）→ review', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      pub_key: 'manual|github|-', video_id: 'release-12345'
    });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('review');
  });

  it('幂等键精确匹配的 manual 记录 → skip（不重复发布）', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'manual', pub_key: t.pub_key
    });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('skip');
  });

  it('真实计划任务成功记录（ok + 同 pub_key）仍然阻止重复发布', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      pub_key: t.pub_key, url: 'https://github.com/o/r/releases/tag/v0.1.0'
    });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('skip');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    createPlanScheduler({
      getStore: () => store, executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    }).scanOnce();
    expect(calls).toBe(0);
  });

  it('其他平台的无关联 manual 记录不影响本平台任务', () => {
    const store = newStore('sqlite');
    const t = waitingTask(store);
    store.addPub({
      work_id: 'w1', platform: 'YouTube', platform_id: 'youtube',
      status: 'manual', pub_key: 'manual|youtube|-'
    });
    expect(store.checkPlanPublishGuard('w1', t.id).decision).toBe('allow');
  });

  it('存在无关联 manual 记录时，旧模拟任务仍照常被模拟执行', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: H.PAST });
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'manual', pub_key: 'manual|github|-'
    });

    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const out = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();

    expect(out.done).toHaveLength(1);
    const fin = store.listPlanTasks('w1')[0];
    expect(fin.status).toBe('done');
    expect(fin.simulated).toBe(1);
  });
});

/* ==================================================================
   F5 · 真实发布成功任务不能被重排接口重置
   ================================================================== */
describe('F5 · 非模拟任务不能被重新排队接口重置', () => {
  it('真实成功任务（simulated=0）重排被拒绝', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'done', simulated: 0, platform_ref: 'real-123' }));

    const res = store.requeueSimulatedPlanTask('w1', t.id);
    expect(res.ok).toBe(false);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_ref).toBe('real-123');
    expect(after.real_only).toBe(0);
  });

  it('普通 pending 任务也不能被重排接口重置', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    const res = store.requeueSimulatedPlanTask('w1', t.id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    expect(store.listPlanTasks('w1')[0].real_only).toBe(0);
  });

  it('跨作品调用被拒绝', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    H.seedWork(store, 'w2', '作品二');
    const res = store.requeueSimulatedPlanTask('w2', done.id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('阶段 / 平台归属不匹配时被拒绝', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    expect(store.requeueSimulatedPlanTask('w1', done.id, { stage_id: 'ps_other' }).ok).toBe(false);
    expect(store.requeueSimulatedPlanTask('w1', done.id, { platform_id: 'youtube' }).ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
    // 归属一致时放行
    expect(store.requeueSimulatedPlanTask('w1', done.id, {
      stage_id: done.stage_id, platform_id: done.platform_id
    }).ok).toBe(true);
  });
});

/* ==================================================================
   F6 · 历史保留
   ================================================================== */
describe('F6 · 重排后的历史模拟结果不会被覆盖', () => {
  it('原模拟结果归档到 history_note，且不受后续 note 写入影响', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    const originalRef = done.platform_ref;
    const originalTime = done.finished_at;
    expect(originalRef.indexOf('mock:')).toBe(0);

    store.requeueSimulatedPlanTask('w1', done.id);
    const after = store.listPlanTasks('w1')[0];
    expect(after.history_note).toContain('原模拟结果');
    expect(after.history_note).toContain(originalRef);
    expect(after.history_note).toContain(originalTime);
    expect(after.note).toContain('等待真实执行');
    // mock 的平台标识已被清掉（不会被误当成真实平台 ID）
    expect(after.platform_ref).toBe('');
    expect(after.platform_url).toBe('');
  });

  it('后续执行写入新的 note / 结果时，history_note 不受影响', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    const hist = store.listPlanTasks('w1')[0].history_note;

    // 模拟一次"别的执行结果写入"（不代表本次会真实发生）
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, {
      status: 'done', note: '完全不同的新备注', platform_ref: 'new-ref', platform_url: '', finished_at: new Date().toISOString()
    }));
    const after = store.listPlanTasks('w1')[0];
    expect(after.note).toBe('完全不同的新备注');
    expect(after.history_note).toBe(hist);
  });

  it('重开数据库后历史仍在', () => {
    const store = newStore('sqlite');
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    const hist = store.listPlanTasks('w1')[0].history_note;

    const reopened = newStore('sqlite');
    expect(reopened.listPlanTasks('w1')[0].history_note).toBe(hist);
  });
});

/* ==================================================================
   F7 · 双模式一致 + 迁移保留数据
   ================================================================== */
describe('F7 · SQLite / JSON fallback 一致，迁移保留原数据', () => {
  function runFlow(mode) {
    const store = newStore(mode);
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const done = seedSimulatedDoneTask(store, 'w1', 'github');
    store.requeueSimulatedPlanTask('w1', done.id);
    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();
    const t = store.listPlanTasks('w1')[0];
    return {
      status: t.status, simulated: t.simulated, real_only: t.real_only,
      history: t.history_note, dueMock: store.listDuePlanTasks(new Date().toISOString()).length,
      dueReal: store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true }).length
    };
  }

  it('SQLite 模式下的流转结果', () => {
    const r = runFlow('sqlite');
    expect(r.status).toBe('pending');
    expect(r.simulated).toBe(0);
    expect(r.real_only).toBe(1);
    expect(r.history).toContain('原模拟结果');
    expect(r.dueMock).toBe(0);
    expect(r.dueReal).toBe(1);
  });

  it('JSON fallback 模式下的流转结果一致', () => {
    const r = runFlow('json');
    expect(r.status).toBe('pending');
    expect(r.simulated).toBe(0);
    expect(r.real_only).toBe(1);
    expect(r.history).toContain('原模拟结果');
    expect(r.dueMock).toBe(0);
    expect(r.dueReal).toBe(1);
  });

  it('迁移到 v10：既有工作 / 发布记录 / 计划数据全部保留', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);

    // 退回 v8（删掉新列 + 改版本号），模拟"旧库升级"
    store.exec('ALTER TABLE plan_tasks DROP COLUMN real_only');
    store.exec('ALTER TABLE plan_tasks DROP COLUMN history_note');
    store.run('PRAGMA user_version = 8');

    const upgraded = newStore('sqlite');
    expect(upgraded.version).toBe(10);
    expect(upgraded.listWorks()).toHaveLength(1);
    expect(upgraded.listPubs()).toHaveLength(1);
    expect(upgraded.listPlanStages('w1')).toHaveLength(1);
    expect(upgraded.listPlanTasks('w1')).toHaveLength(1);
    // 既有任务默认既不是模拟、也不等待真实执行（行为不变）
    const t = upgraded.listPlanTasks('w1')[0];
    expect(t.simulated).toBe(0);
    expect(t.real_only).toBe(0);
    expect(t.history_note).toBe('');
  });

  it('重复迁移安全（不会重复加列、不丢数据）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a')]);
    const again = newStore('sqlite');
    again.migrate();
    again.migrate();
    expect(again.listWorks()).toHaveLength(1);
    expect(again.listPlanStages('w1')).toHaveLength(1);
    const cols = again.all('PRAGMA table_info(plan_tasks)').map(c => c.name);
    expect(cols.filter(n => n === 'real_only')).toHaveLength(1);
    expect(cols.filter(n => n === 'history_note')).toHaveLength(1);
  });
});
