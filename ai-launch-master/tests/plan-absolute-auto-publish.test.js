'use strict';

// Rokit · 计划绝对执行时间 + GitHub 自动发布真实路由 定向测试
//
// 覆盖：
//   P1 当前选中作品 w9 → 计划与任务均写 w9；归属不一致时阻止保存
//   P2 datetime-local 本地时间 → UTC ISO
//   P3 过去的执行时间被拒绝（renderer + store 双层）
//   P4 绝对时间不受作品创建日期影响
//   P5 GitHub 自动发布任务 real_only=1（其他平台仍为 0）
//   P6 总开关关闭：不调用真实执行器，任务保持等待真实执行
//   P7 总开关开启且闸门通过：只调用真实 GitHub 执行器
//   P8 旧模拟任务行为不变
//   P9 重复扫描不重复执行 / 不重复发布

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

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

function runSavePlan(state, opts) {
  opts = opts || {};
  const payloadSrc = extractBlock(HTML, 'function planStagePayload(it){');
  const saveSrc = extractBlock(HTML, 'window.savePlan=function(){');
  const fn = new Function('state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork',
    payloadSrc + '\n' + saveSrc + '\nreturn window.savePlan();');
  return fn(state, opts.window || { api: { planSave: function () { return Promise.resolve({ ok: true }); } } },
    opts.toast || function () {}, Promise, opts.findWork || function (id) { return { id: id }; }, opts.isSampleWork || function () { return false; });
}

/* ==================================================================
   P1 · 归属：当前选中 w9
   ================================================================== */
describe('P1 · 计划归属当前选中作品', () => {
  it('curWork=w9 且 planOwnerId=w9 时，计划与任务都写 w9', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', '旧作品', PAST);
    H.seedWork(store, 'w9', '当前作品', PAST);
    const calls = [];
    const state = {
      curWork: 'w9',
      planOwnerId: 'w9',
      plan: [absStage('ps_w9')],
      planDirty: true
    };
    const ok = await runSavePlan(state, {
      window: { api: { planSave: function (owner, stages) { calls.push({ owner: owner, stages: stages }); return Promise.resolve(store.savePlanStages(owner, stages)); } } }
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].owner).toBe('w9');
    const stages = store.listPlanStages('w9');
    const tasks = store.listPlanTasks('w9');
    expect(stages[0].work_id).toBe('w9');
    expect(tasks[0].work_id).toBe('w9');
    expect(tasks[0].real_only).toBe(1);
    expect(store.listPlanTasks('w1')).toHaveLength(0);
  });

  it('planOwnerId=w1 但当前选中 w9 时阻止保存，不写入 w1', async () => {
    const calls = [];
    const toasts = [];
    const state = { curWork: 'w9', planOwnerId: 'w1', plan: [absStage('ps_x')], planDirty: true };
    const ok = await runSavePlan(state, {
      window: { api: { planSave: function (owner) { calls.push(owner); return Promise.resolve({ ok: true }); } } },
      toast: function (m) { toasts.push(m); },
      findWork: function (id) { return { id: id }; }
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(toasts.some(function (m) { return String(m).indexOf('不一致') >= 0; })).toBe(true);
  });
});

/* ==================================================================
   P2 · 本地 datetime-local → UTC ISO
   ================================================================== */
describe('P2 · 绝对时间转换', () => {
  it('planIsoFromLocal 转换为正确的 UTC ISO', () => {
    const src = extractBlock(HTML, 'function planIsoFromLocal(v){');
    const fn = new Function(src + '\nreturn planIsoFromLocal("2026-10-30T18:30");');
    expect(fn()).toBe(new Date(2026, 9, 30, 18, 30, 0, 0).toISOString());
  });
});

/* ==================================================================
   P3 · 过去时间被拒绝
   ================================================================== */
describe('P3 · 过去时间不得静默保存', () => {
  it('store 拒绝过去的 scheduledAt', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    const r = store.savePlanStages('w1', [absStage('ps_p', { scheduledAt: PAST })]);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('future');
    expect(store.listPlanStages('w1')).toHaveLength(0);
  });

  it('renderer 在调用 planSave 前拒绝过去时间', async () => {
    const calls = [];
    const toasts = [];
    const state = { curWork: 'w1', planOwnerId: 'w1', plan: [absStage('ps_p', { scheduledAt: PAST })], planDirty: true };
    const ok = await runSavePlan(state, {
      window: { api: { planSave: function () { calls.push(1); return Promise.resolve({ ok: true }); } } },
      toast: function (m) { toasts.push(m); }
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(toasts.some(function (m) { return String(m).indexOf('晚于当前时间') >= 0; })).toBe(true);
  });
});

/* ==================================================================
   P4 · 不受作品创建日期影响
   ================================================================== */
describe('P4 · 绝对时间不依赖作品创建日期', () => {
  it('作品创建于 2020 年也不会改变 2099 年的执行时间', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_abs')]);
    const stages = store.listPlanStages('w1');
    const tasks = store.listPlanTasks('w1');
    expect(stages[0].scheduled_at).toBe(FUTURE);
    expect(tasks[0].scheduled_at).toBe(FUTURE);
  });
});

/* ==================================================================
   P5 · GitHub 真实执行资格（由平台选择决定，不再依赖 autoPublish）
   ================================================================== */
describe('P5 · GitHub 任务资格', () => {
  it('选中 GitHub / 公众号的任务 real_only=1（两个平台均已接入真实发布通道）', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_a', { platforms: ['github', 'wechat'] })]);
    const tasks = store.listPlanTasks('w1');
    const gh = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    const wx = tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0];
    expect(gh.real_only).toBe(1);
    expect(gh.simulated).toBe(0);
    // 微信公众号已接入真实草稿创建通道 → 同样是真实执行候选
    expect(wx.real_only).toBe(1);
    expect(wx.simulated).toBe(0);
  });

  it('旧数据 auto_publish=0 但选中 GitHub：再次保存后也具备真实执行资格', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [Object.assign(absStage('ps_a'), { autoPublish: false })]);
    // 首次保存沿用了显式 false；资格仍由平台决定
    expect(store.listPlanTasks('w1')[0].real_only).toBe(1);
    // 再次保存（新前端不再传 autoPublish）：资格保持为 1
    store.savePlanStages('w1', [absStage('ps_a')]);
    expect(store.listPlanTasks('w1')[0].real_only).toBe(1);
  });
});

/* ==================================================================
   P6/P7 · 总开关与真实执行器
   ================================================================== */
describe('P6/P7 · 总开关关闭/开启时的执行路由', () => {
  function seedDueAutoTask(store) {
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_a')]);
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: PAST });
    return store.listPlanTasks('w1')[0];
  }

  it('总开关关闭（mock 模式）：不调用真实 GitHub executor，任务保持等待真实执行', async () => {
    const store = newStore();
    const task = seedDueAutoTask(store);
    const { createPlanScheduler } = loadScheduler();
    const mockCalls = [];
    const realCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'mock',
      mockExecutor: function (t) { mockCalls.push(t.id); return { ok: true, simulated: true, status: 'done' }; },
      realExecutors: { github: function (t) { realCalls.push(t.id); return { ok: true, simulated: false }; } }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    expect(mockCalls).toHaveLength(0);
    expect(realCalls).toHaveLength(0);
    const after = store.listPlanTasks('w1')[0];
    expect(after.id).toBe(task.id);
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);
    expect(after.simulated).toBe(0);
  });

  it('总开关开启且闸门通过：仅调用真实 GitHub executor 一次', async () => {
    const store = newStore();
    seedDueAutoTask(store);
    const { createPlanScheduler } = loadScheduler();
    const mockCalls = [];
    const realCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      mockExecutor: function (t) { mockCalls.push(t.id); return { ok: true, simulated: true, status: 'done' }; },
      realExecutors: {
        github: function (t) {
          realCalls.push(t.id);
          return Promise.resolve({
            ok: true, simulated: false, status: 'done',
            platform_ref: 'github:test:' + t.id, platform_url: 'https://example.com/release'
          });
        }
      }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    expect(mockCalls).toHaveLength(0);
    expect(realCalls).toHaveLength(1);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.simulated).toBe(0);
    expect(after.platform_url).toBe('https://example.com/release');

    // P9：重复扫描不重复执行
    const out2 = scheduler.scanOnce();
    await out2.settled;
    expect(realCalls).toHaveLength(1);
  });

  it('真实执行器闸门拒绝时不会调用 executor', async () => {
    const store = newStore();
    const task = seedDueAutoTask(store);
    // 同一条任务的幂等键已有成功发布记录 → guard 必须拒绝重复发布
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', url: 'https://example.com/old', pub_key: task.pub_key,
      title: 'already published', time: FUTURE
    });
    const { createPlanScheduler } = loadScheduler();
    const realCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: { github: function (t) { realCalls.push(t.id); return { ok: true, simulated: false }; } }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    expect(realCalls).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

/* ==================================================================
   P8 · 旧模拟任务 / 其他平台不受影响
   ================================================================== */
describe('P8 · 旧模拟任务行为不变', () => {
  it('未设置 scheduledAt 的历史阶段继续按 offset/time 运行模拟任务', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [H.stage('ps_old', { platforms: ['wechat'], offsetDays: 0, timeOfDay: '20:00' })]);
    // 公众号已接入真实通道 → 新建任务默认是真实执行候选；
    // 这里显式降级为「旧版 auto_publish=0 的历史模拟任务」，验证旧模拟任务行为不变
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: PAST });
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({ getStore: function () { return store; } });
    const out = scheduler.scanOnce();
    await out.settled;
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('draft_pending');
    expect(after.simulated).toBe(1);
    expect(after.real_only).toBe(0);
  });

  it('真实候选任务在 real 模式只走已注册的真实执行器，绝不回落到 mock', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_mix', { platforms: ['github', 'wechat'] })]);
    store.listPlanTasks('w1').forEach(function (t) {
      store.updatePlanTask('w1', t.id, { scheduled_at: PAST });
    });
    const { createPlanScheduler } = loadScheduler();
    const mockCalls = [];
    const realCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      mockExecutor: function (t) { mockCalls.push(t.platform_id); return { ok: true, simulated: true, status: 'done' }; },
      realExecutors: { github: function (t) { realCalls.push(t.platform_id); return Promise.resolve({ ok: true, simulated: false, status: 'done', platform_ref: 'github:test', platform_url: 'https://example.com/x' }); } }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    // GitHub 走真实执行器
    expect(realCalls).toEqual(['github']);
    // 公众号同样是真实执行候选：未注册真实执行器时**跳过**，绝不降级成 mock 执行
    expect(mockCalls).toEqual([]);
    const tasks = store.listPlanTasks('w1');
    expect(tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0].status).toBe('pending');
    expect(tasks.filter(function (t) { return t.platform_id === 'github'; })[0].status).toBe('done');
  });

  it('旧模拟任务（real_only=0）在 real 模式仍走 mock 执行器', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_mix', { platforms: ['github', 'wechat'] })]);
    // 只把公众号任务降级为历史模拟任务，GitHub 仍是真实执行候选
    const wx = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'wechat'; })[0];
    store._planWriteTask(Object.assign({}, wx, { real_only: 0 }));
    store.listPlanTasks('w1').forEach(function (t) {
      store.updatePlanTask('w1', t.id, { scheduled_at: PAST });
    });
    const { createPlanScheduler } = loadScheduler();
    const mockCalls = [];
    const realCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      mockExecutor: function (t) { mockCalls.push(t.platform_id); return { ok: true, simulated: true, status: 'done' }; },
      realExecutors: { github: function (t) { realCalls.push(t.platform_id); return Promise.resolve({ ok: true, simulated: false, status: 'done', platform_ref: 'github:test', platform_url: 'https://example.com/x' }); } }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    expect(realCalls).toEqual(['github']);
    expect(mockCalls).toEqual(['wechat']);
    const tasks = store.listPlanTasks('w1');
    expect(tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0].status).toBe('done');
    expect(tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0].simulated).toBe(1);
    expect(tasks.filter(function (t) { return t.platform_id === 'github'; })[0].status).toBe('done');
  });
});
