'use strict';

// Rokit · 首秀计划默认创建 / 默认自动发布 / 跳过 / 示例 定向测试
//
// 覆盖本次「首秀计划调整」的核心关系：
//   D1 进入首秀计划即默认创建（三阶段，默认启用当前支持的全部平台）
//   D2 默认计划里选中 GitHub 的阶段 → 任务 real_only=1；其它平台仍为 0（不再有独立勾选）
//   D3 移除 GitHub 平台 → 对应任务取消；重新选择后恢复为真实执行候选
//   D4 跳过首秀计划 → 不保存计划、不创建任何自动执行任务
//   D5 计划示例是真实可选模板：真实平台 + 未来时间；套用只改内存，不创建任务 / 不触发发布
//   D6 移除全局总开关后：符合条件（real_only=1）的任务进入真实执行资格判断；
//      不符合条件的任务仍只走模拟执行器；发布前幂等保护（review）仍然生效
//   D7 全局总开关调用链已彻底移除（main.js / plan-ipc.js / preload.js / index.html）
//
// 安全约束：全程使用临时目录的独立数据库；真实执行器一律用**假执行器**（只记录调用，
// 不发任何网络请求）；不读写用户的真实数据库与 settings_kv。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const IPC_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-ipc.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

// renderer 函数里引用的是字符串常量 12（STEP_DONE）
const STEP_DONE = 12;
const FUTURE = H.FUTURE;
const PAST = H.PAST;

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

let seq = 0;
function idGen() {
  seq++;
  return 'ps_t' + seq;
}

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

function runDefaultPlan() {
  const src = extractBlock(HTML, 'function defaultPlan(){');
  const fn = new Function('newPlanStageId', src + '\nreturn defaultPlan();');
  return fn(idGen);
}

function runPlanExamplePlan(key) {
  const src = extractBlock(HTML, 'function planExamplePlan(key){');
  const fn = new Function('newPlanStageId', src + '\nreturn planExamplePlan(' + JSON.stringify(key) + ');');
  return fn(idGen);
}

function runSavePlan(state, planSaveImpl) {
  const payloadSrc = extractBlock(HTML, 'function planStagePayload(it){');
  const saveSrc = extractBlock(HTML, 'window.savePlan=function(){');
  const fn = new Function('state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork',
    payloadSrc + '\n' + saveSrc + '\nreturn window.savePlan();');
  return fn(
    state,
    { api: { planSave: planSaveImpl } },
    function () {},
    Promise,
    function (id) { return { id: id }; },
    function () { return false; }
  );
}

function saveDefaultPlanToStore(store) {
  const plan = runDefaultPlan();
  const state = { curWork: 'w1', planOwnerId: 'w1', plan: plan, planDirty: true };
  const calls = [];
  return runSavePlan(state, function (owner, stages) {
    calls.push(owner);
    return Promise.resolve(store.savePlanStages(owner, stages));
  }).then(function (ok) {
    return { ok: ok, plan: plan, calls: calls };
  });
}

/* ==================================================================
   D1 · 进入首秀计划即默认创建
   ================================================================== */
describe('D1 · 默认创建计划与默认平台', () => {
  it('defaultPlan 默认三阶段，覆盖当前支持的全部平台，时间为未来绝对时间', () => {
    const plan = runDefaultPlan();
    expect(plan).toHaveLength(3);
    const allPlats = {};
    plan.forEach(function (s) { (s.platforms || []).forEach(function (pid) { allPlats[pid] = true; }); });
    expect(Object.keys(allPlats).sort()).toEqual(['github', 'wechat', 'youtube']);
    plan.forEach(function (s) {
      expect(new Date(s.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('新增阶段默认启用全部支持平台', () => {
    const addSrc = extractBlock(HTML, 'window.addPlan=function(){');
    const platsSrc = 'var PLAN_PLATFORMS=[{id:\'wechat\'},{id:\'github\'},{id:\'youtube\'}];';
    const fn = new Function('state', 'window', 'renderFlow', 'newPlanStageId', 'planDefaultScheduledAt', platsSrc +
      '\n' + addSrc + '\nreturn window.addPlan();');
    const state = { plan: [], planDirty: false };
    fn(state, {}, function () {}, idGen, function () { return FUTURE; });
    expect(state.plan).toHaveLength(1);
    const st = state.plan[0];
    expect(st.platforms.slice().sort()).toEqual(['github', 'wechat', 'youtube']);
    expect(new Date(st.scheduledAt).getTime()).toBeGreaterThan(Date.now());
  });
});

/* ==================================================================
   D2 · 平台选择决定任务资格
   ================================================================== */
describe('D2 · 默认计划与任务资格', () => {
  it('默认计划不再携带独立的自动发布字段', () => {
    const plan = runDefaultPlan();
    plan.forEach(function (s) { expect(s.autoPublish).toBeUndefined(); });
  });

  it('保存默认计划：GitHub / YouTube 任务 real_only=1（已接入真实发布通道），公众号任务仍为 0', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    const r = await saveDefaultPlanToStore(store);
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(['w1']);
    const tasks = store.listPlanTasks('w1');
    const gh = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    const wx = tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0];
    const yt = tasks.filter(function (t) { return t.platform_id === 'youtube'; })[0];
    expect(gh.real_only).toBe(1);
    expect(gh.simulated).toBe(0);
    // 微信公众号已接入真实草稿创建通道 → 真实执行候选
    expect(wx.real_only).toBe(1);
    expect(wx.simulated).toBe(0);
    // YouTube 已接入真实发布通道 → 真实执行候选
    expect(yt.real_only).toBe(1);
    expect(yt.simulated).toBe(0);
    // 用户设置的绝对时间被正确保存并用于任务调度
    const stageGh = store.listPlanStages('w1').filter(function (s) { return s.platforms.indexOf('github') >= 0; })[0];
    expect(stageGh.scheduled_at).toBe(r.plan.filter(function (s) { return s.platforms.indexOf('github') >= 0; })[0].scheduledAt);
    expect(gh.scheduled_at).toBe(stageGh.scheduled_at);
  });

  it('planStagePayload 不再输出 autoPublish（资格完全由平台选择决定）', () => {
    const src = extractBlock(HTML, 'function planStagePayload(it){');
    const fn = new Function(src + '\nreturn [planStagePayload({id:"a",platforms:["wechat"]}),' +
      'planStagePayload({id:"b",platforms:["github"]})];');
    const out = fn();
    expect(out[0].autoPublish).toBeUndefined();
    expect(out[1].autoPublish).toBeUndefined();
    expect(out[0].platforms).toEqual(['wechat']);
    expect(out[1].platforms).toEqual(['github']);
  });
});

/* ==================================================================
   D3 · 移除 / 重新选择平台
   ================================================================== */
describe('D3 · 平台选择与任务同步', () => {
  it('阶段只选公众号：不会创建 GitHub 任务，公众号任务是真实执行候选', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    const state = {
      curWork: 'w1', planOwnerId: 'w1', planDirty: true,
      plan: [absStage('ps_a', { platforms: ['wechat'] })]
    };
    const ok = await runSavePlan(state, function (owner, stages) {
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    const tasks = store.listPlanTasks('w1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].platform_id).toBe('wechat');
    // 公众号已接入真实草稿创建通道 → 真实执行候选
    expect(tasks[0].real_only).toBe(1);
  });

  it('移除 GitHub 平台会取消任务；重新选择后恢复为真实执行候选', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_a')]);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    // 移除 github → 任务取消
    store.savePlanStages('w1', [absStage('ps_a', { platforms: ['wechat'] })]);
    const cancelled = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'github'; })[0];
    expect(cancelled.status).toBe('cancelled');
    // 重新选择 github → 任务恢复 pending，并具备真实执行资格
    store.savePlanStages('w1', [absStage('ps_a', { platforms: ['github', 'wechat'] })]);
    const restored = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'github'; })[0];
    expect(restored.status).toBe('pending');
    expect(restored.real_only).toBe(1);
  });
});

/* ==================================================================
   D4 · 跳过首秀计划
   ================================================================== */
describe('D4 · 跳过首秀计划不生成任务', () => {
  it('确认跳过后不调用 planSave、不创建任务，并进入完成态', async () => {
    const src = extractBlock(HTML, 'window.skipPlanAndGo=function(){');
    const saveCalls = [];
    const launched = [];
    const state = { step: 10, planDirty: true, plan: runDefaultPlan(), curWork: 'w1', planOwnerId: 'w1' };
    const win = {
      api: { planSave: function () { saveCalls.push(1); return Promise.resolve({ ok: true }); } },
      launch: function () { launched.push(1); }
    };
    const fn = new Function('state', 'window', 'confirmModal', 'toast', 'renderRail', 'renderFlow', 'STEP_DONE',
      src + '\nreturn window.skipPlanAndGo();');
    await fn(state, win, function () { return Promise.resolve(true); }, function () {}, function () {}, function () {}, STEP_DONE);
    expect(saveCalls).toHaveLength(0);     // 没有保存 → 不会创建任务
    expect(launched).toHaveLength(1);
    expect(state.planDirty).toBe(false);   // 防止后续 launch 自动保存
    expect(state.step).toBe(STEP_DONE);
  });

  it('用户取消跳过时不保存、也不进入完成态', async () => {
    const src = extractBlock(HTML, 'window.skipPlanAndGo=function(){');
    const launched = [];
    const state = { step: 10, planDirty: true, plan: runDefaultPlan() };
    const fn = new Function('state', 'window', 'confirmModal', 'toast', 'renderRail', 'renderFlow', 'STEP_DONE',
      src + '\nreturn window.skipPlanAndGo();');
    await fn(state, { launch: function () { launched.push(1); } },
      function () { return Promise.resolve(false); }, function () {}, function () {}, function () {}, STEP_DONE);
    expect(launched).toHaveLength(0);
    expect(state.step).toBe(10);
  });
});

/* ==================================================================
   D5 · 计划示例
   ================================================================== */
describe('D5 · 计划示例为真实可用模板', () => {
  const KEYS = ['github-auto', 'three-days', 'two-stage'];

  it('每个示例都使用真实支持的平台与未来时间', () => {
    KEYS.forEach(function (key) {
      const plan = runPlanExamplePlan(key);
      expect(plan.length).toBeGreaterThan(0);
      plan.forEach(function (s) {
        expect(['github', 'wechat', 'youtube'].indexOf(s.platforms[0]) >= 0).toBe(true);
        expect(s.platforms.length).toBe(1);
        expect(new Date(s.scheduledAt).getTime()).toBeGreaterThan(Date.now());
        expect(s.autoPublish).toBeUndefined();
      });
    });
  });

  it('套用示例只改内存，不保存、不创建任务', async () => {
    const applySrc = extractBlock(HTML, 'window.applyPlanExample=function(key){');
    const exampleSrc = extractBlock(HTML, 'function planExamplePlan(key){');
    const saveCalls = [];
    const state = { plan: runDefaultPlan(), planDirty: false };
    const win = { api: { planSave: function () { saveCalls.push(1); return Promise.resolve({ ok: true }); } } };
    const fn = new Function('state', 'window', 'confirmModal', 'toast', 'renderFlow', 'newPlanStageId',
      exampleSrc + '\n' + applySrc + '\nreturn window.applyPlanExample("github-auto");');
    await fn(state, win, function () { return Promise.resolve(true); }, function () {}, function () {}, idGen);
    expect(saveCalls).toHaveLength(0);
    expect(state.plan).toHaveLength(1);
    expect(state.plan[0].platforms).toEqual(['github']);
    expect(state.plan[0].autoPublish).toBeUndefined();
  });

  it('套用示例后可以正常保存为真实计划配置', async () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    const plan = runPlanExamplePlan('three-days');
    const state = { curWork: 'w1', planOwnerId: 'w1', plan: plan, planDirty: true };
    const ok = await runSavePlan(state, function (owner, stages) {
      return Promise.resolve(store.savePlanStages(owner, stages));
    });
    expect(ok).toBe(true);
    const stages = store.listPlanStages('w1');
    expect(stages).toHaveLength(3);
    const tasks = store.listPlanTasks('w1');
    expect(tasks).toHaveLength(3);
    const gh = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    expect(gh.real_only).toBe(1);
  });
});

/* ==================================================================
   D6 · 移除总开关后的执行资格
   ================================================================== */
describe('D6 · 移除总开关后的执行路由', () => {
  function seedDue(store) {
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_a')]);
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: PAST });
    return store.listPlanTasks('w1')[0];
  }

  function scan(store) {
    const { createPlanScheduler } = loadScheduler();
    const realCalls = [];
    const mockCalls = [];
    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',                    // 总开关已移除 → 常驻真实模式
      mockExecutor: function (t) {
        mockCalls.push(t.id);
        return { ok: true, simulated: true, status: 'done', platform_ref: 'mock:' + t.platform_id, platform_url: '' };
      },
      realExecutors: {
        github: function (t) {
          realCalls.push(t.id);
          return { ok: true, simulated: false, status: 'done', platform_ref: 'real:gh', platform_url: 'https://github.example/r' };
        },
        // 公众号：已接入真实草稿创建通道（只创建草稿，不正式发表）
        wechat: function (t) {
          realCalls.push(t.id);
          return { ok: true, simulated: false, status: 'done', platform_ref: 'real:wx-draft', platform_url: '' };
        }
      }
    });
    const out = scheduler.scanOnce();
    return { out: out, realCalls: realCalls, mockCalls: mockCalls };
  }

  it('选中 GitHub 的到期任务：不再被总开关拦截，进入真实执行器一次', () => {
    const store = newStore();
    const task = seedDue(store);
    const r = scan(store);
    expect(r.realCalls).toEqual([task.id]);
    expect(r.mockCalls).toHaveLength(0);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.simulated).toBe(0);
  });

  it('公众号任务已接入真实执行通道：走真实执行器，不走模拟执行器', () => {
    const store = newStore();
    H.seedWork(store, 'w1', 'w1', PAST);
    store.savePlanStages('w1', [absStage('ps_wx', { platforms: ['wechat'] })]);
    const task = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', task.id, { scheduled_at: PAST });
    // 公众号已接入真实草稿创建通道 → 真实执行候选（不再走模拟执行器）
    expect(task.real_only).toBe(1);
    const r = scan(store);
    expect(r.realCalls).toEqual([task.id]);
    expect(r.mockCalls).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].simulated).toBe(0);
  });

  it('原有发布前幂等保护保留：可归因的手动记录 → review，不调用真实执行器', () => {
    const store = newStore();
    const task = seedDue(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      pub_key: 'other-key', url: 'https://github.com/o/r/releases/tag/v0.1.0'
    });
    const r = scan(store);
    expect(r.realCalls).toHaveLength(0);
    expect(r.mockCalls).toHaveLength(0);
    expect(r.out.skipped.length).toBe(1);
    expect(r.out.skipped[0].reason).toContain('需人工确认');
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    expect(task.id).toBeTruthy();
  });

  it('无法精确关联且无 URL 的手动记录不阻止自动发布（manual 修复保留）', () => {
    const store = newStore();
    seedDue(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      pub_key: 'manual|github|-', url: ''
    });
    const r = scan(store);
    expect(r.realCalls).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });
});

/* ==================================================================
   D7 · 总开关调用链彻底移除
   ================================================================== */
describe('D7 · 全局自动发布总开关已移除', () => {
  it('main.js 不再读取 plan_real_publish，调度器常驻 real 模式', () => {
    expect(MAIN_SRC).not.toContain('plan_real_publish');
    expect(MAIN_SRC).not.toContain('isPlanRealPublishEnabled');
    expect(MAIN_SRC).toContain("executorKind: 'real'");
  });

  it('plan-ipc / preload 不再暴露真实发布开关通道', () => {
    expect(IPC_SRC).not.toContain("'plan:real-publish'");
    expect(IPC_SRC).not.toContain("'plan:set-real-publish'");
    expect(PRELOAD_SRC).not.toContain('planRealPublish');
    expect(PRELOAD_SRC).not.toContain('planSetRealPublish');
  });

  it('index.html 不再有开关 UI / 函数，调度器徽标说明按平台选择展示', () => {
    expect(HTML).not.toContain('planCenterRealPublish');
    expect(HTML).not.toContain('paintPlanRealPublish');
    expect(HTML).not.toContain('togglePlanRealPublish');
    const badge = extractBlock(HTML, 'function paintPlanSchedulerBadge(){');
    expect(badge).toContain('真实发布模式');
    expect(badge).toContain('posts/');
    expect(badge).not.toContain('勾选「自动发布」');
    expect(badge).not.toContain('已重新排队');
  });

  it('首秀计划页提供示例入口与跳过入口', () => {
    expect(HTML).toContain('planExampleChips()');
    expect(HTML).toContain('applyPlanExample');
    expect(HTML).toContain('skipPlanAndGo');
    expect(HTML).toContain('跳过首秀计划');
  });
});
