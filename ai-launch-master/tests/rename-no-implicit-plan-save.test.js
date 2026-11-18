//
// Rokit · 改名派生不得隐式创建首秀计划任务（v1.30 第一批）—— 定向测试
//
// 覆盖需求的三项验证：
//   A  普通新作品流程（未编辑首秀计划）
//        · submitName() 后 planDirty 仍为 false
//        · 阶段 ID 不因改名而无故改变
//        · launch() 后不调用 savePlan()
//        · 不因普通发布新建 plan_tasks
//   B  用户确实编辑过首秀计划，再改名并完成发布
//        · planDirty 保持 true
//        · 阶段 ID 重新生成的原有保护逻辑仍有效
//        · 计划仍能正常保存并完成归属转正
//   C  已存在的计划
//        · planReassign() 仍能正常迁移计划归属
//        · 阶段 ID、计划内容和任务状态保持一致
//
// 跑的是 **index.html 里的生产代码**（按花括号配平切出来，在沙箱里注入依赖后执行）：
//   submitName / planTransferAfterSave / launch / savePlan
// 以及 **electron/store.js** 里的 savePlanStages / reassignPlanOwner（真实临时库）。
//
// 全部使用**临时独立数据库**（node:sqlite，临时目录）与注入的 mock：
//   **绝不写入活动数据库 .userdata/ai-launch-master.db，不调用任何真实平台 API**。
//

'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/plan-store');

const ROOT = H.ROOT;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 从 index.html 切出被测函数 ---------- */
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

const SUBMIT_NAME_SRC = extractBlock(HTML, 'window.submitName=function(e){');
const TRANSFER_SRC = extractBlock(HTML, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){');
const SAVE_PLAN_SRC = extractBlock(HTML, 'window.savePlan=function(){');
const STAGE_PAYLOAD_SRC = extractBlock(HTML, 'function planStagePayload(it){');
const PLAN_STAGE_PAYLOAD_FN = new Function(STAGE_PAYLOAD_SRC + '\nreturn planStagePayload;')();

/* ---------- 临时数据库 ---------- */
let tmpDir;
let mod;
let store;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  mod = H.loadStoreFresh(false);
  store = new mod.Store(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
});

/* ==================================================================
   A · 普通改名（未编辑计划）不得标脏、不得隐式保存、不得建任务
   ================================================================== */
describe('A · 普通新作品流程（未编辑首秀计划）', () => {
  function runSubmitName(cfg) {
    const state = {
      curWork: 'w1',
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      planDraftOwner: '',
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planDirty: !!cfg.planDirty,
      project: { name: '旧名字' },
      works: [{ id: 'w1', name: '旧名字', isSample: false }],
      step: 0
    };
    let draftSeq = 0;
    const fn = new Function(
      'state', 'window', 'document', 'stopDemo', 'findWork', 'newDraftOwnerId', 'newPlanStageId',
      'pushUser', 'pushAI', 'esc', 'renderRail', 'renderFlow',
      SUBMIT_NAME_SRC + '\nreturn window.submitName;'
    );
    const submitName = fn(
      state, {},
      { getElementById: function () { return { value: cfg.name }; } },
      function () {},
      function (id) { return state.works.filter(function (w) { return w.id === id; })[0] || null; },
      function () { draftSeq++; return 'draft_rename_' + draftSeq; },
      function () { return 'ps_new_' + (draftSeq + 1); },
      function () {}, function () {}, function (s) { return String(s); },
      function () {}, function () {}
    );
    submitName({ preventDefault: function () {} });
    return state;
  }

  it('A1 · submitName() 后 planDirty 仍为 false', () => {
    const state = runSubmitName({ name: '新名字' });
    expect(state.planDirty).toBe(false);
  });

  it('A2 · 阶段 ID 不因改名而无故改变（与数据库保持一致）', () => {
    const state = runSubmitName({ name: '新名字' });
    expect(state.plan[0].id).toBe('ps_a');
  });

  it('A3 · 归属仍切到新草稿（计划跟随新作品的核心行为不变）', () => {
    const state = runSubmitName({ name: '新名字' });
    expect(state.planOwnerId).toBe('draft_rename_1');
    expect(state.copiesOwner).toBe('draft_rename_1');
    expect(state.planDraftOwner).toBe('draft_rename_1');
    expect(state.curWork).toBe('w1');
  });

  it('A4 · launch() 后不调用 savePlan()，也不新建 plan_tasks', async () => {
    // 场景：改名派生（planDirty=false）→ 作品落库 → 归属转正
    const state = {
      curWork: 'w1',
      planOwnerId: 'draft_rename_1',
      copiesOwner: 'draft_rename_1',
      planDraftOwner: 'draft_rename_1',
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planDirty: false,                       // ← 改名后必须仍是 false
      project: { name: '新名字' },
      works: [{ id: 'w1', name: '旧名字', isSample: false }],
      step: 0
    };
    const calls = { savePlan: 0, planSave: [], planReassign: [] };
    const win = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id, name: w.name }); },
        planReassign: function (from, to) { calls.planReassign.push([from, to]); return Promise.resolve({ ok: true }); },
        planSave: function (owner, stages) { calls.planSave.push(owner); return Promise.resolve({ ok: true }); },
        addPub: function () { return Promise.resolve({}); }
      },
      // ★ 提供真实存在的 savePlan 桩（模拟生产环境 window.savePlan 一直可用）
      //   → 若代码仍会隐式保存，这里就会被计数到。
      savePlan: function () { calls.savePlan++; return Promise.resolve(true); }
    };
    const fn = new Function(
      'window', 'state', 'Promise', 'flushPendingPubWork',
      TRANSFER_SRC + '\nreturn window.planTransferAfterSave;'
    );
    const transfer = fn(win, state, Promise, function () { return 0; });

    const res = await transfer({ id: 'w4', name: '新名字' }, 'draft_rename_1', true);
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('reassign');
    // ★ 归属转正照常发生
    expect(calls.planReassign.length).toBe(1);
    expect(calls.planReassign[0][0]).toBe('draft_rename_1');
    expect(calls.planReassign[0][1]).toBe('w4');
    // ★ 但绝不调用 savePlan → 绝不写 plan:save → 绝不新建 plan_tasks
    expect(calls.savePlan).toBe(0);
    expect(calls.planSave.length).toBe(0);
  });

  it('A5 · 普通改名后不新建 plan_tasks（store 层：未调用 savePlanStages 就没有任务）', () => {
    H.seedWork(store, 'w1', '旧作品', '2026-03-10T02:00:00.000Z');
    // 只做归属迁移（等价于 launch() 在 planDirty=false 时的实际动作）
    const res = store.reassignPlanOwner('draft_rename_1', 'w4');
    expect(res.ok).toBe(true);
    expect(store.listPlanTasks('w4')).toHaveLength(0);
    expect(store.listPlanStages('w4')).toHaveLength(0);
  });
});

/* ==================================================================
   B · 用户确实编辑过计划 → 保留原有的标脏 + 换阶段 ID + 保存 + 转正
   ================================================================== */
describe('B · 用户确实编辑过首秀计划，再改名并完成发布', () => {
  function runSubmitName(cfg) {
    const state = {
      curWork: 'w1',
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      planDraftOwner: '',
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planDirty: !!cfg.planDirty,
      project: { name: '旧名字' },
      works: [{ id: 'w1', name: '旧名字', isSample: false }],
      step: 0
    };
    let draftSeq = 0;
    const fn = new Function(
      'state', 'window', 'document', 'stopDemo', 'findWork', 'newDraftOwnerId', 'newPlanStageId',
      'pushUser', 'pushAI', 'esc', 'renderRail', 'renderFlow',
      SUBMIT_NAME_SRC + '\nreturn window.submitName;'
    );
    const submitName = fn(
      state, {},
      { getElementById: function () { return { value: cfg.name }; } },
      function () {},
      function (id) { return state.works.filter(function (w) { return w.id === id; })[0] || null; },
      function () { draftSeq++; return 'draft_rename_' + draftSeq; },
      function () { return 'ps_new_' + (draftSeq + 1); },
      function () {}, function () {}, function (s) { return String(s); },
      function () {}, function () {}
    );
    submitName({ preventDefault: function () {} });
    return state;
  }

  it('B1 · planDirty 保持 true（用户真实编辑的状态不被抹掉）', () => {
    const state = runSubmitName({ name: '新名字', planDirty: true });
    expect(state.planDirty).toBe(true);
  });

  it('B2 · 阶段 ID 重新生成的跨作品保护逻辑仍有效', () => {
    const state = runSubmitName({ name: '新名字', planDirty: true });
    expect(state.plan[0].id).not.toBe('ps_a');
    expect(state.plan[0].id.indexOf('ps_new_') === 0).toBe(true);
  });

  it('B3 · 计划仍能正常保存（plan:save 被调用，归属为新草稿）', async () => {
    const state = runSubmitName({ name: '新名字', planDirty: true });
    const calls = { planSave: [] };
    const win = { api: { planSave: function (owner, stages) { calls.planSave.push({ owner: owner, stages: stages }); return Promise.resolve({ ok: true }); } } };
    const fn = new Function(
      'state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork', 'planStagePayload',
      SAVE_PLAN_SRC + '\nreturn window.savePlan;'
    );
    const savePlan = fn(
      state, win,
      function () {},
      Promise,
      function (id) { return state.works.filter(function (w) { return w.id === id; })[0] || null; },
      function () { return false; },
      PLAN_STAGE_PAYLOAD_FN
    );
    // 给阶段补一个合法的未来时间，避免被时间校验拦截
    state.plan = state.plan.map(function (it) { return Object.assign({}, it, { scheduledAt: H.FUTURE }); });
    const ok = await savePlan();
    expect(ok).toBe(true);
    expect(calls.planSave.length).toBe(1);
    expect(calls.planSave[0].owner).toBe('draft_rename_1');
    // 保存成功后脏标记清掉
    expect(state.planDirty).toBe(false);
  });

  it('B4 · 作品落库时仍会隐式保存计划并完成归属转正', async () => {
    const state = {
      curWork: 'w1',
      planOwnerId: 'draft_rename_1',
      copiesOwner: 'draft_rename_1',
      planDraftOwner: 'draft_rename_1',
      plan: [H.stage('ps_new_1', { platforms: ['github'] })],
      planDirty: true,                        // ← 用户编辑过
      project: { name: '新名字' },
      works: [{ id: 'w1', name: '旧名字', isSample: false }],
      step: 0
    };
    const calls = { planSave: [], planReassign: [], savePlan: 0 };
    const win = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id, name: w.name }); },
        planReassign: function (from, to) { calls.planReassign.push([from, to]); return Promise.resolve({ ok: true }); },
        planSave: function (owner, stages) { calls.planSave.push(owner); return Promise.resolve({ ok: true }); }
      },
      savePlan: function () {
        calls.savePlan++;
        // 模拟真实 savePlan()：最终会写 plan:save（落库阶段与任务）
        return Promise.resolve(win.api.planSave(state.planOwnerId, []));
      }
    };
    const fn = new Function(
      'window', 'state', 'Promise', 'flushPendingPubWork',
      TRANSFER_SRC + '\nreturn window.planTransferAfterSave;'
    );
    const transfer = fn(win, state, Promise, function () { return 0; });
    const res = await transfer({ id: 'w4', name: '新名字' }, 'draft_rename_1', true);
    expect(res.ok).toBe(true);
    // ★ 计划先保存（到草稿归属），再转正
    expect(calls.savePlan).toBe(1);
    expect(calls.planSave.length).toBe(1);
    expect(calls.planSave[0]).toBe('draft_rename_1');
    expect(calls.planReassign.length).toBe(1);
    expect(calls.planReassign[0][0]).toBe('draft_rename_1');
    expect(calls.planReassign[0][1]).toBe('w4');
  });
});

/* ==================================================================
   C · 已存在的计划：归属迁移正常，内容与任务状态一致
   ================================================================== */
describe('C · 已存在的计划', () => {
  it('C1 · planReassign() 仍能正常迁移计划归属', () => {
    H.seedWork(store, 'w1', '旧作品', '2026-03-10T02:00:00.000Z');
    const saveRes = store.savePlanStages('w1', [
      H.stage('ps_a', { platforms: ['github'] }),
      H.stage('ps_b', { platforms: ['wechat'] })
    ]);
    expect(saveRes.ok).toBe(true);
    expect(store.listPlanTasks('w1').length).toBe(2);

    const res = store.reassignPlanOwner('w1', 'w4');
    expect(res.ok).toBe(true);
    // 阶段与任务都改挂到新作品
    expect(store.listPlanStages('w4').length).toBe(2);
    expect(store.listPlanStages('w1').length).toBe(0);
    expect(store.listPlanTasks('w4').length).toBe(2);
    expect(store.listPlanTasks('w1').length).toBe(0);
  });

  it('C2 · 阶段 ID、计划内容与任务状态保持一致', () => {
    H.seedWork(store, 'w1', '旧作品', '2026-03-10T02:00:00.000Z');
    store.savePlanStages('w1', [
      H.stage('ps_a', { platforms: ['github'] }),
      H.stage('ps_b', { platforms: ['wechat', 'youtube'] })
    ]);
    const before = {
      stages: store.listPlanStages('w1').map(function (s) { return { id: s.id, title: s.title, platforms: s.platforms }; }),
      tasks: store.listPlanTasks('w1').map(function (t) { return { id: t.id, platform_id: t.platform_id, status: t.status, pub_key: t.pub_key }; })
    };

    store.reassignPlanOwner('w1', 'w4');

    const after = {
      stages: store.listPlanStages('w4').map(function (s) { return { id: s.id, title: s.title, platforms: s.platforms }; }),
      tasks: store.listPlanTasks('w4').map(function (t) { return { id: t.id, platform_id: t.platform_id, status: t.status, pub_key: t.pub_key }; })
    };
    expect(after.stages).toEqual(before.stages);
    expect(after.tasks).toEqual(before.tasks);
    // 幂等键仍指向**原归属**（历史事实不被改写）
    after.tasks.forEach(function (t) {
      expect(t.pub_key.indexOf('plan|w1|') === 0).toBe(true);
    });
  });

  it('C3 · 改名（未编辑计划）后阶段 ID 与数据库一致，归属迁移不会丢阶段', () => {
    H.seedWork(store, 'w1', '旧作品', '2026-03-10T02:00:00.000Z');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    expect(store.listPlanStages('w1')[0].id).toBe('ps_a');

    // 改名派生：阶段 ID 原样保留（ps_a），只换归属
    const state = {
      curWork: 'w1',
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      planDraftOwner: '',
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planDirty: false,
      project: { name: '旧名字' },
      works: [{ id: 'w1', name: '旧名字', isSample: false }],
      step: 0
    };
    const fn = new Function(
      'state', 'window', 'document', 'stopDemo', 'findWork', 'newDraftOwnerId', 'newPlanStageId',
      'pushUser', 'pushAI', 'esc', 'renderRail', 'renderFlow',
      SUBMIT_NAME_SRC + '\nreturn window.submitName;'
    );
    fn(
      state, {},
      { getElementById: function () { return { value: '新名字' }; } },
      function () {},
      function (id) { return state.works.filter(function (w) { return w.id === id; })[0] || null; },
      function () { return 'draft_rename_1'; },
      function () { return 'ps_new_1'; },
      function () {}, function () {}, function (s) { return String(s); },
      function () {}, function () {}
    )({ preventDefault: function () {} });

    expect(state.plan[0].id).toBe('ps_a');   // 阶段 ID 没变
    expect(state.planDirty).toBe(false);
    // 阶段 ID 仍属于 w1 → planReassign 会把它改挂到新作品
    const res = store.reassignPlanOwner('w1', 'w4');
    expect(res.ok).toBe(true);
    expect(store.listPlanStages('w4').length).toBe(1);
    expect(store.listPlanStages('w4')[0].id).toBe('ps_a');
  });
});

/* ==================================================================
   保护：本次修复不得影响其它已验收逻辑
   ================================================================== */
describe('保护 · 本次修复未影响其它逻辑', () => {
  it('P1 · submitName 未改动归属切换与活动草稿登记', () => {
    expect(SUBMIT_NAME_SRC).toMatch(/state\.planOwnerId=_draft/);
    expect(SUBMIT_NAME_SRC).toMatch(/state\.copiesOwner=_draft/);
    expect(SUBMIT_NAME_SRC).toMatch(/state\.planDraftOwner=_draft/);
  });

  it('P2 · planTransferAfterSave 仍保留「用户编辑过计划 → 隐式保存」的行为', () => {
    expect(TRANSFER_SRC).toMatch(/if\(state\.planDirty&&window\.savePlan\)/);
    expect(TRANSFER_SRC).toMatch(/window\.api\.planReassign/);
  });

  it('P3 · 未改动 _persistFinalVideoForWork / savePlan / 计划执行器', () => {
    expect(HTML).toMatch(/function _persistFinalVideoForWork\(videoPath\)\{/);
    // savePlan 的核心不变：仍然调 window.api.planSave
    expect(SAVE_PLAN_SRC).toMatch(/window\.api\.planSave\(owner,stages\)/);
    // 计划执行器文件未被本批触碰（本批只改 index.html）
    const executor = fs.readFileSync(path.join(ROOT, 'electron', 'plan-github-executor.js'), 'utf8');
    expect(executor).toMatch(/publishFile/);
  });
});
