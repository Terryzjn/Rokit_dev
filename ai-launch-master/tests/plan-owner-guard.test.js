'use strict';

// Rokit · 计划归属守卫 + 落库→转正链路（第二阶段补齐验收缺口的回归测试）
//
// 覆盖用户明确列出的 10 项验证点：
//   G1  合法真实 owner 保存成功（SQLite 与 JSON 一致）
//   G2  合法草稿 owner 保存成功（含渲染层生成的草稿 ID 一定能通过校验）
//   G3  空 owner / 非法草稿 owner / 指向不存在作品的普通 ID 一律被拒绝（写入前拒绝）
//   G4  保存计划失败时不触发作品转正
//   G5  作品持久化失败时不调用 planReassign（不靠 IPC 调用顺序推断写库已完成）
//   G6  转正失败时不把 state.planOwnerId 更新为目标 owner，且用户能看到错误
//   G7  转正成功后阶段、任务与 work_id 归属正确
//   G8  时间重算仍只影响 pending 任务
//   G9  重复转正不重复建任务、不重复发布（幂等键不被改写）
//   G10 同名复用旧作品与 addWork() 正常路径不受影响
//
// 跑的是生产代码：
//   - electron/store.js（真实 SQLite / JSON 存储层，临时数据库，不触碰生产库）
//   - index.html 里按花括号配平切出的 planTransferAfterSave / launch / addWork /
//     newDraftOwnerId / defaultPlan（注入依赖后在沙箱里真实执行）
// 全程不执行任何真实平台发布、不开启真实发送开关、不修改生产数据库。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

/* ---------- 切出的生产函数 ---------- */
const TRANSFER_SRC = extractBlock(HTML, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){');
const LAUNCH_SRC = extractBlock(HTML, 'window.launch=function(){');
const ADD_WORK_SRC = extractBlock(HTML, 'window.addWork=function(){');
const NEW_DRAFT_ID_SRC = extractBlock(HTML, 'function newDraftOwnerId(){');
const NEW_STAGE_ID_SRC = extractBlock(HTML, 'function newPlanStageId(){');
const DEFAULT_PLAN_SRC = extractBlock(HTML, 'function defaultPlan(){');
const DEDUPE_SRC = extractBlock(HTML, 'function dedupeLaunchDone(doneIds){');
// 本轮修复（活动草稿归属误判）新增的行为级验证对象
const SAVE_PLAN_SRC = extractBlock(HTML, 'window.savePlan=function(){');
const STAGE_PAYLOAD_SRC = extractBlock(HTML, 'function planStagePayload(it){');
const SUBMIT_NAME_SRC = extractBlock(HTML, 'window.submitName=function(e){');
const SEED_WORKS_SRC = extractBlock(HTML, 'function seedWorks(){');
const OPEN_WORK_SRC = extractBlock(HTML, 'window.openWork=function(id){');
const DEL_WORK_SRC = extractBlock(HTML, 'window.delWork=function(id){');
// 切出来的 planStagePayload 可直接调用（savePlan 依赖它把阶段转成保存载荷）
const PLAN_STAGE_PAYLOAD_FN = new Function(STAGE_PAYLOAD_SRC + '\nreturn planStagePayload;')();

/* ---------- 临时数据库 ---------- */
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

// 一个确定的作品创建时间（固定值，便于断言本地日历日换算）
const WORK_CREATED = '2026-03-10T02:00:00.000Z';

function expectedLocal(baseIso, offsetDays, timeOfDay) {
  const d = new Date(baseIso);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  const hh = m ? parseInt(m[1], 10) : 20;
  const mm = m ? parseInt(m[2], 10) : 0;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hh, mm, 0, 0);
  return t.toISOString();
}

/* ==================================================================
   G1 / G2 / G3 · savePlanStages 的 owner 校验（SQLite + JSON 双路径）
   ================================================================== */
describe('G1 · 合法真实 owner 保存成功', () => {
  ['sqlite', 'json'].forEach(mode => {
    it('[' + mode + '] 真实作品 ID（作品确实存在）→ 阶段与任务都写进去了', () => {
      const store = newStore(mode);
      H.seedWork(store, 'w1', '作品一', WORK_CREATED);

      const res = store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
      expect(res.ok).toBe(true);
      expect(res.stages).toHaveLength(1);
      expect(res.stages[0].id).toBe('ps_a');
      expect(res.stages[0].work_id).toBe('w1');
      expect(store.listPlanStages('w1')).toHaveLength(1);
      expect(store.listPlanTasks('w1')).toHaveLength(1);
      expect(store.listPlanTasks('w1')[0].work_id).toBe('w1');
    });

    it('[' + mode + '] 真实作品 ID 再次保存（更新）仍然成功', () => {
      const store = newStore(mode);
      H.seedWork(store, 'w1', '作品一', WORK_CREATED);
      store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
      const res = store.savePlanStages('w1', [H.stage('ps_a', { title: '改过的标题', platforms: ['github', 'wechat'] })]);
      expect(res.ok).toBe(true);
      expect(store.listPlanStages('w1')).toHaveLength(1);
      expect(store.listPlanStages('w1')[0].title).toBe('改过的标题');
      expect(store.listPlanTasks('w1')).toHaveLength(2);
    });
  });
});

describe('G2 · 合法草稿 owner 保存成功', () => {
  ['sqlite', 'json'].forEach(mode => {
    it('[' + mode + '] 合法草稿 ID（draft_ + 小写字母数字分段）→ 保存成功', () => {
      const store = newStore(mode);
      const draft = 'draft_abc123';
      const res = store.savePlanStages(draft, [H.stage('ps_a', { platforms: ['github'] })]);
      expect(res.ok).toBe(true);
      expect(res.stages[0].work_id).toBe(draft);
      expect(store.listPlanTasks(draft)).toHaveLength(1);
    });

    it('[' + mode + '] 多段草稿 ID（draft_<段>_<段>）也是合法的', () => {
      const store = newStore(mode);
      const draft = 'draft_m8x1k2_9ab3cd';
      const res = store.savePlanStages(draft, [H.stage('ps_a', { platforms: ['github'] })]);
      expect(res.ok).toBe(true);
      expect(store.listPlanStages(draft)).toHaveLength(1);
    });
  });

  it('渲染层 newDraftOwnerId() 生成的 ID 一定能通过 store 的 owner 校验', () => {
    // 两端规则必须一致：渲染层生成的草稿归属，store 认。
    const fn = new Function(NEW_DRAFT_ID_SRC + '\nreturn newDraftOwnerId();');
    const store = newStore('sqlite');
    for (let i = 0; i < 20; i++) {
      const id = fn();
      expect(id).toMatch(/^draft_[0-9a-z]+(_[0-9a-z]+)*$/);
      const res = store.savePlanStages(id, [H.stage('ps_' + i, { platforms: ['github'] })]);
      expect(res.ok).toBe(true);
    }
  });
});

describe('G3 · 非法 owner 一律被拒绝（写入前拒绝）', () => {
  // [说明, owner, 期望的错误关键词]
  //   空 owner 走的是既有的「missing work id」早退分支；
  //   其余非法 owner 走新增的「invalid plan owner」分支。两者都必须在写入前拒绝。
  const badOwners = [
    ['空字符串', '', 'missing work id'],
    ['null', null, 'missing work id'],
    ['undefined', undefined, 'missing work id'],
    ['纯空白', '   ', 'invalid plan owner'],
    ['draft_ 但没有后缀', 'draft_', 'invalid plan owner'],
    ['draft_ 后缀含大写', 'draft_ABC', 'invalid plan owner'],
    ['draft_ 后缀含特殊字符', 'draft_a!', 'invalid plan owner'],
    ['draft_ 尾部多一个下划线', 'draft_a_', 'invalid plan owner'],
    ['大写 DRAFT_ 前缀', 'DRAFT_abc', 'invalid plan owner'],
    ['draft 少了下划线', 'draftabc', 'invalid plan owner'],
    ['指向不存在作品的普通 ID', 'w_not_exists', 'invalid plan owner'],
    ['任意不存在的字符串', 'no-such-owner', 'invalid plan owner']
  ];

  ['sqlite', 'json'].forEach(mode => {
    badOwners.forEach(pair => {
      it('[' + mode + '] 拒绝：' + pair[0] + '（' + JSON.stringify(pair[1]) + '）', () => {
        const store = newStore(mode);
        // 先造一条真实作品与一条合法计划，确保拒绝不是因为库里本来就空
        H.seedWork(store, 'w1', '作品一', WORK_CREATED);
        store.savePlanStages('w1', [H.stage('ps_keep', { platforms: ['github'] })]);
        const stagesBefore = store.listAllPlanStages().length;
        const tasksBefore = store.listPlanTasks('').length;

        const res = store.savePlanStages(pair[1], [H.stage('ps_bad', { platforms: ['github'] })]);
        expect(res.ok).toBe(false);
        expect(String(res.error || '')).toContain(pair[2]);

        // 拒绝发生在写入之前：库里没有多出任何阶段 / 任务
        expect(store.listAllPlanStages()).toHaveLength(stagesBefore);
        expect(store.listPlanTasks('')).toHaveLength(tasksBefore);
        expect(store.listAllPlanStages().filter(s => s.id === 'ps_bad')).toHaveLength(0);
        expect(store.listPlanTasks('').filter(t => t.stage_id === 'ps_bad')).toHaveLength(0);
        // 既有合法计划不受影响
        expect(store.listPlanStages('w1')).toHaveLength(1);
        expect(store.listPlanTasks('w1')).toHaveLength(1);
      });
    });
  });

  it('owner 合法但阶段属于别的作品 → 仍然被跨作品保护拒绝（既有保护保留）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    H.seedWork(store, 'w2', '作品二', WORK_CREATED);
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    const res = store.savePlanStages('w2', [H.stage('ps_a', { platforms: ['github'] })]);
    expect(res.ok).toBe(false);
    expect(String(res.error || '')).toContain('stage belongs to another work');
    // 原归属的阶段没有被改写
    expect(store.listPlanStages('w1')).toHaveLength(1);
    expect(store.listPlanStages('w2')).toHaveLength(0);
  });
});

/* ==================================================================
   G4 / G5 / G6 · 渲染层：严格串行 + 失败可观察
   ================================================================== */
describe('G4 / G5 / G6 · planTransferAfterSave 严格串行', () => {
  // 把生产函数切出来注入沙箱依赖（state / window / toast），真实执行一次
  function runTransfer(sandbox) {
    const fn = new Function('state', 'window', 'toast', 'Promise',
      TRANSFER_SRC + '\nreturn window.planTransferAfterSave;');
    return fn(sandbox.state, sandbox.window, sandbox.toast, Promise);
  }

  function baseSandbox(overrides) {
    const calls = { saveWork: [], planReassign: [], savePlan: [] };
    const toasts = [];
    const sandbox = {
      state: {
        planOwnerId: 'draft_src',
        copiesOwner: 'draft_src',
        planDraftOwner: 'draft_src',
        planDirty: false,
        plan: [H.stage('ps_a')]
      },
      window: {
        api: {
          saveWork: function (w) { calls.saveWork.push(w); return Promise.resolve({ id: w.id }); },
          planReassign: function (from, to) {
            calls.planReassign.push({ from: from, to: to });
            return Promise.resolve({ ok: true, stages: [], tasks: [], rescheduled: [], reschedule_kept: [] });
          }
        }
      },
      toast: function (m, level) { toasts.push({ m: String(m), level: level }); }
    };
    if (overrides) overrides(sandbox, calls);
    return { sandbox: sandbox, calls: calls, toasts: toasts };
  }

  it('G6 · 转正成功后才把 state.planOwnerId 更新为目标 owner，planReassign 实参是 (来源, 目标)', async () => {
    const h = baseSandbox();
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1', name: '作品一' }, 'draft_src', true);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe('reassign');
    expect(h.calls.saveWork).toHaveLength(1);
    expect(h.calls.planReassign).toHaveLength(1);
    expect(h.calls.planReassign[0].from).toBe('draft_src');
    expect(h.calls.planReassign[0].to).toBe('w1');
    expect(h.sandbox.state.planOwnerId).toBe('w1');
    expect(h.sandbox.state.copiesOwner).toBe('w1');
    // 本次转正的活动草稿标记必须被清掉
    expect(h.sandbox.state.planDraftOwner).toBe('');
  });

  it('G5 · 作品持久化失败（抛错）→ 不调用 planReassign，归属保持来源，用户能看到原因', async () => {
    const h = baseSandbox(function (s) {
      s.window.api.saveWork = function () { return Promise.reject(new Error('磁盘写不进去')); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('save');
    expect(res.reason).toContain('磁盘写不进去');
    expect(res.from).toBe('draft_src');
    expect(res.to).toBe('w1');
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
  });

  it('G5 · 作品持久化返回的不是这件作品 → 不调用 planReassign（不靠调用顺序推断写库已完成）', async () => {
    const h = baseSandbox(function (s) {
      s.window.api.saveWork = function () { return Promise.resolve({ id: 'w_other' }); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('save');
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
  });

  it('G4 · 计划保存失败 → 不触发作品转正（planReassign 不被调用），归属保持来源', async () => {
    const h = baseSandbox(function (s) {
      s.state.planDirty = true;
      s.window.savePlan = function () { return Promise.resolve(false); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('plan');
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
  });

  it('G4 · 计划保存成功后才继续转正', async () => {
    const h = baseSandbox(function (s) {
      s.state.planDirty = true;
      s.window.savePlan = function () { return Promise.resolve(true); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(true);
    expect(h.calls.planReassign).toHaveLength(1);
    expect(h.sandbox.state.planOwnerId).toBe('w1');
  });

  it('G6 · 转正失败（返回 ok:false）→ 归属不更新，失败原因带回来', async () => {
    const h = baseSandbox(function (s) {
      s.window.api.planReassign = function () { return Promise.resolve({ ok: false, error: '来源归属没有计划' }); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('reassign');
    expect(res.reason).toContain('来源归属没有计划');
    expect(res.from).toBe('draft_src');
    expect(res.to).toBe('w1');
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
    expect(h.sandbox.state.copiesOwner).toBe('draft_src');
  });

  it('G6 · 转正抛异常 → 归属不更新，原因如实带回来（不被静默吞掉）', async () => {
    const h = baseSandbox(function (s) {
      s.window.api.planReassign = function () { return Promise.reject(new Error('IPC 断了')); };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('reassign');
    expect(res.reason).toContain('IPC 断了');
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
  });

  it('不需要改挂（来源就是目标）→ 不调用 planReassign', async () => {
    const h = baseSandbox();
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'w1', false);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe('none');
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.sandbox.state.planOwnerId).toBe('draft_src');
  });

  it('转正成功但有任务未能重算时间 → 明确告知用户（warn），不静默吞掉', async () => {
    const h = baseSandbox(function (s) {
      s.window.api.planReassign = function () {
        return Promise.resolve({ ok: true, rescheduled: [], reschedule_kept: [{ id: 't1', reason: '作品没有有效创建时间' }] });
      };
    });
    const transfer = runTransfer(h.sandbox);
    const res = await transfer({ id: 'w1' }, 'draft_src', true);

    expect(res.ok).toBe(true);
    expect(h.toasts.some(t => t.level === 'warn' && t.m.indexOf('未能按作品创建时间重算') >= 0)).toBe(true);
  });
});

/* ==================================================================
   G10 · launch() 的结果卡片：失败时绝不显示"发射成功"
   ================================================================== */
describe('G10 · launch() 的结果提示随转正结果变化', () => {
  function runLaunch(setup) {
    const calls = { saveWork: [], planReassign: [] };
    const cards = [];
    const toasts = [];
    const state = {
      step: 0,
      sel: { github: true },
      copies: { github: { done: true, title: '标题', body: '正文', tags: [] } },
      works: [],
      curWork: null,
      project: { name: '作品一', type: 'tool', intro: '介绍', url: '', ytUrl: '' },
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planOwnerId: 'draft_src',
      copiesOwner: 'draft_src',
      planDraftOwner: 'draft_src',
      planDirty: false,
      pubLog: [],
      kpis: {},
      messages: [],
      _pendingPubKeys: []
    };
    const win = {
      api: {
        saveWork: function (w) { calls.saveWork.push(w); return Promise.resolve({ id: w.id }); },
        planReassign: function (from, to) {
          calls.planReassign.push({ from: from, to: to });
          return Promise.resolve({ ok: true, rescheduled: [], reschedule_kept: [] });
        }
      },
      attachPubWork: function () {}
    };
    if (setup) setup({ state: state, win: win, calls: calls, cards: cards, toasts: toasts });

    const fn = new Function(
      'state', 'window', 'toast', 'Promise',
      'PLATFORMS', 'dedupeLaunchDone', 'findWork', 'SAMPLE_WORK_IDS', 'STATUS_COLOR',
      'fmtPlay', 'demoteMainsInMemory', 'renderWorks', 'pushMilestoneIfFirst',
      'esc', 'pf', 'STEP_DONE', 'renderRail', 'renderFlow', 'pushAIHtml',
      TRANSFER_SRC + '\n' + LAUNCH_SRC + '\nreturn window.launch;'
    );
    const launch = fn(
      state, win,
      function (m, level) { toasts.push({ m: String(m), level: level }); },
      Promise,
      [{ id: 'github', name: 'GitHub' }],
      function (ids) { return ids; },
      function (id) { return state.works.filter(w => w.id === id)[0] || null; },
      [],
      { '首秀中': '#F59E0B' },
      function (cur) { return String(cur || '0'); },
      function () {},
      function () {},
      function () {},
      function (s) { return String(s); },
      function (id) { return { id: id, name: id }; },
      99,
      function () {},
      function () {},
      function (html) { cards.push(String(html)); }
    );
    launch();
    // launch 里的结果卡片在 planChain 的 .then 里渲染 → 等微任务跑完
    return new Promise(resolve => setTimeout(() => resolve({
      state: state, win: win, calls: calls, cards: cards, toasts: toasts
    }), 0));
  }

  it('转正成功 → 显示发射成功卡片', async () => {
    const h = await runLaunch();
    expect(h.calls.saveWork).toHaveLength(1);
    expect(h.calls.planReassign).toHaveLength(1);
    expect(h.calls.planReassign[0].from).toBe('draft_src');
    expect(h.calls.planReassign[0].to).toBe('w1');
    expect(h.state.planOwnerId).toBe('w1');
    expect(h.state.planDraftOwner).toBe('');
    expect(h.cards.some(c => c.indexOf('发射成功') >= 0)).toBe(true);
    expect(h.cards.some(c => c.indexOf('未能转正') >= 0)).toBe(false);
  });

  it('转正失败 → 绝不显示"发射成功"，而是显示失败卡片（来源/目标/原因都在）', async () => {
    const h = await runLaunch(function (s) {
      s.win.api.planReassign = function () { return Promise.resolve({ ok: false, error: '归属迁移失败' }); };
    });
    expect(h.cards.some(c => c.indexOf('发射成功') >= 0)).toBe(false);
    const failCard = h.cards.filter(c => c.indexOf('未能转正') >= 0)[0] || '';
    expect(failCard).toContain('draft_src');
    expect(failCard).toContain('w1');
    expect(failCard).toContain('归属迁移失败');
    // 归属保持来源（失败不覆盖）
    expect(h.state.planOwnerId).toBe('draft_src');
    // 用户能看到错误（fail 级别 toast）
    expect(h.toasts.some(t => t.level === 'fail' && t.m.indexOf('归属迁移失败') >= 0)).toBe(true);
  });

  it('作品持久化失败 → 同样不显示"发射成功"，且没有调用 planReassign', async () => {
    const h = await runLaunch(function (s) {
      s.win.api.saveWork = function () { return Promise.reject(new Error('写库失败')); };
    });
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.cards.some(c => c.indexOf('发射成功') >= 0)).toBe(false);
    expect(h.cards.some(c => c.indexOf('未能转正') >= 0)).toBe(true);
    expect(h.state.planOwnerId).toBe('draft_src');
  });

  it('同名复用旧作品 → 不新建作品、不调用 planReassign（正常路径不受影响）', async () => {
    const h = await runLaunch(function (s) {
      s.state.works.push({
        id: 'w1', name: '作品一', type: 'tool', intro: '介绍', url: '',
        status: '首秀中', color: '#F59E0B', queue: '主推', star: 0, dl: 0, play: '0'
      });
      s.state.curWork = 'w1';
      s.state.planOwnerId = 'w1';
      s.state.copiesOwner = 'w1';
    });
    // 作品没有被顶替成新记录
    expect(h.state.works.filter(w => !w.isSample)).toHaveLength(1);
    expect(h.state.works[0].id).toBe('w1');
    // 归属已经是目标作品 → 无需转正
    expect(h.calls.planReassign).toHaveLength(0);
    expect(h.state.planOwnerId).toBe('w1');
    expect(h.cards.some(c => c.indexOf('发射成功') >= 0)).toBe(true);
  });
});

describe('G10 · addWork() 正常路径不受影响', () => {
  function runAddWork() {
    const state = {
      curWork: 'w1',
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      plan: [H.stage('ps_a')],
      planDirty: true,
      messages: [],
      platforms: { github: true },
      sel: { github: true },
      copies: { github: { done: true } },
      step: 9,
      project: { name: '旧作品' }
    };
    const fn = new Function(
      'state', 'window', 'stopDemo', 'go', 'renderWorks',
      NEW_STAGE_ID_SRC + '\n' + NEW_DRAFT_ID_SRC + '\n' + DEFAULT_PLAN_SRC + '\n' + ADD_WORK_SRC + '\nreturn window.addWork;'
    );
    const addWork = fn(state, {}, function () {}, function () {}, function () {});
    addWork();   // 真实执行一次 addWork()
    return state;
  }

  it('新建作品 → 换到独立的新草稿归属，计划重置，不碰旧归属', () => {
    const state = runAddWork();
    expect(state.curWork).toBe(null);
    expect(state.planOwnerId).toMatch(/^draft_[0-9a-z]+(_[0-9a-z]+)*$/);
    expect(state.planOwnerId).not.toBe('w1');
    expect(state.copiesOwner).toBe(state.planOwnerId);
    // 本轮新建流程的活动草稿标记必须与被登记的草稿归属一致
    expect(state.planDraftOwner).toBe(state.planOwnerId);
    expect(state.plan).toHaveLength(3);
    expect(state.planDirty).toBe(false);
    expect(state.messages).toHaveLength(1);
  });

  it('渲染层生成的草稿归属在 store 里可保存（新建→发射的链路不断）', () => {
    const state = runAddWork();
    const store = newStore('sqlite');
    const res = store.savePlanStages(state.planOwnerId, [H.stage('ps_a', { platforms: ['github'] })]);
    expect(res.ok).toBe(true);
  });
});

/* ==================================================================
   G7 / G8 / G9 · 转正后的归属、时间重算与幂等（store 层）
   ================================================================== */
describe('G7 · 转正成功后阶段 / 任务 / work_id 归属正确', () => {
  ['sqlite', 'json'].forEach(mode => {
    it('[' + mode + '] 阶段与任务的 work_id 都改挂到真实作品，来源归属下不再有残留', () => {
      const store = newStore(mode);
      H.seedWork(store, 'w1', '作品一', WORK_CREATED);
      store.savePlanStages('draft_src', [
        H.stage('ps_a', { platforms: ['github'] }),
        H.stage('ps_b', { platforms: ['wechat', 'youtube'] })
      ]);

      const res = store.reassignPlanOwner('draft_src', 'w1');
      expect(res.ok).toBe(true);
      expect(store.listPlanStages('draft_src')).toHaveLength(0);
      expect(store.listPlanTasks('draft_src')).toHaveLength(0);

      const stages = store.listPlanStages('w1');
      expect(stages).toHaveLength(2);
      expect(stages.map(s => s.work_id)).toEqual(['w1', 'w1']);
      const tasks = store.listPlanTasks('w1');
      expect(tasks).toHaveLength(3);
      expect(tasks.every(t => t.work_id === 'w1')).toBe(true);
    });
  });
});

describe('G8 · 时间重算仍只影响 pending 任务', () => {
  it('pending 按真实作品 created_at 重算；已完成 / 已取消的任务时间与状态一律不变', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('draft_src', [
      H.stage('ps_a', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github', 'wechat', 'youtube'] })
    ]);
    const before = store.listPlanTasks('draft_src');
    const gh = before.filter(t => t.platform_id === 'github')[0];
    const we = before.filter(t => t.platform_id === 'wechat')[0];
    const yt = before.filter(t => t.platform_id === 'youtube')[0];
    // 一个已完成、一个已取消
    store._planWriteTask(Object.assign({}, gh, { status: 'done', platform_ref: 'rel-1' }));
    store._planWriteTask(Object.assign({}, we, { status: 'cancelled', note: '用户取消' }));
    const doneBefore = store.listPlanTasks('draft_src').filter(t => t.platform_id === 'github')[0];
    const cancelledBefore = store.listPlanTasks('draft_src').filter(t => t.platform_id === 'wechat')[0];
    const pendingBefore = yt.scheduled_at;

    const res = store.reassignPlanOwner('draft_src', 'w1');
    expect(res.ok).toBe(true);
    expect(res.rescheduled).toHaveLength(1);

    const after = store.listPlanTasks('w1');
    const doneAfter = after.filter(t => t.platform_id === 'github')[0];
    const cancelledAfter = after.filter(t => t.platform_id === 'wechat')[0];
    const pendingAfter = after.filter(t => t.platform_id === 'youtube')[0];

    expect(doneAfter.status).toBe('done');
    expect(doneAfter.platform_ref).toBe('rel-1');
    expect(doneAfter.scheduled_at).toBe(doneBefore.scheduled_at);
    expect(cancelledAfter.status).toBe('cancelled');
    expect(cancelledAfter.note).toBe('用户取消');
    expect(cancelledAfter.scheduled_at).toBe(cancelledBefore.scheduled_at);
    expect(pendingAfter.scheduled_at).toBe(expectedLocal(WORK_CREATED, 2, '10:30'));
    expect(pendingAfter.scheduled_at).not.toBe(pendingBefore);
  });
});

describe('G9 · 重复转正不重复建任务、不重复发布', () => {
  it('连续转正两次：任务数量不变，时间不被二次改写，幂等键不被改写', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('draft_src', [H.stage('ps_a', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github'] })]);
    const keyBefore = store.listPlanTasks('draft_src')[0].pub_key;

    const first = store.reassignPlanOwner('draft_src', 'w1');
    expect(first.ok).toBe(true);
    const tasksAfterFirst = store.listPlanTasks('w1');
    expect(tasksAfterFirst).toHaveLength(1);
    const timeAfterFirst = tasksAfterFirst[0].scheduled_at;

    const second = store.reassignPlanOwner('draft_src', 'w1');
    expect(second.ok).toBe(true);
    expect(second.rescheduled).toHaveLength(0);
    expect(store.listPlanTasks('w1')).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].scheduled_at).toBe(timeAfterFirst);
    // 幂等键（发布去重凭据）保持不变 → 不会因为转正而变成"另一条任务"
    expect(store.listPlanTasks('w1')[0].pub_key).toBe(keyBefore);
  });

  it('转正不写任何发布记录（不触发发布）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('draft_src', [H.stage('ps_a', { platforms: ['github'] })]);
    const pubsBefore = store.listPubs ? store.listPubs() : [];
    store.reassignPlanOwner('draft_src', 'w1');
    const pubsAfter = store.listPubs ? store.listPubs() : [];
    expect(pubsAfter.length).toBe(pubsBefore.length);
  });

  it('转正后幂等闸门仍然生效：同 pub_key 的成功记录 → skip（不重复发布）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('draft_src', [H.stage('ps_a', { platforms: ['github'] })]);
    const task = store.listPlanTasks('draft_src')[0];
    store.reassignPlanOwner('draft_src', 'w1');
    const moved = store.listPlanTasks('w1')[0];
    expect(moved.pub_key).toBe(task.pub_key);

    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      title: '标题', body: '正文', tags: '', time: '2026-03-11 10:30',
      url: 'https://example.com/rel', error: '', video_id: '', pub_key: moved.pub_key
    });
    const guard = store.checkPlanPublishGuard('w1', moved.id);
    expect(guard.decision).toBe('skip');
  });
});

/* ==================================================================
   G11 · 本轮修复：活动草稿归属（state.planDraftOwner）
   ------------------------------------------------------------------
   背景：新建作品（含改名派生）时 planOwnerId 是草稿、curWork 仍停在旧作品（如 w1），
   savePlan 的草稿分支把它误判成跨作品操作。修复后只对「本轮活动草稿」放行。
   ================================================================== */
describe('G11 · savePlan 归属守卫：活动草稿放行，其余情况保持原保护', () => {
  function runSavePlan(cfg) {
    const calls = [];
    const toasts = [];
    const state = {
      planOwnerId: cfg.planOwnerId,
      curWork: cfg.curWork,
      planDraftOwner: cfg.planDraftOwner || '',
      copiesOwner: cfg.copiesOwner || '',
      plan: [Object.assign(H.stage('ps_a', { platforms: ['github'] }), { scheduledAt: H.FUTURE })],
      copies: {},
      planDirty: true,
      route: 'flow',
      works: [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }]
    };
    const win = {
      api: {
        planSave: function (owner, stages) {
          calls.push({ owner: owner, stages: stages });
          return Promise.resolve({ ok: true });
        }
      }
    };
    const fn = new Function(
      'state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork', 'planStagePayload',
      SAVE_PLAN_SRC + '\nreturn window.savePlan;'
    );
    const savePlan = fn(
      state, win,
      function (m, level) { toasts.push({ m: String(m), level: level }); },
      Promise,
      function (id) { return state.works.filter(w => w.id === id)[0] || null; },
      function () { return false; },
      PLAN_STAGE_PAYLOAD_FN
    );
    return savePlan().then(function (ok) {
      return { ok: ok, state: state, calls: calls, toasts: toasts };
    });
  }

  it('活动草稿 + curWork=w1 → 允许保存（不再误判跨作品）', async () => {
    const h = await runSavePlan({ planOwnerId: 'draft_live', planDraftOwner: 'draft_live', curWork: 'w1' });
    expect(h.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].owner).toBe('draft_live');
    expect(h.state.planOwnerId).toBe('draft_live');
    expect(h.state.planDirty).toBe(false);
    expect(h.toasts).toHaveLength(0);
  });

  it('活动草稿 + curWork=null（addWork 正常路径）→ 允许保存', async () => {
    const h = await runSavePlan({ planOwnerId: 'draft_live', planDraftOwner: 'draft_live', curWork: '' });
    expect(h.ok).toBe(true);
    expect(h.calls[0].owner).toBe('draft_live');
  });

  it('陈旧草稿（无活动标记）+ curWork=w1 → 仍触发原有归属保护（不写入）', async () => {
    const h = await runSavePlan({ planOwnerId: 'draft_stale', planDraftOwner: '', curWork: 'w1' });
    expect(h.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.toasts.some(t => t.level === 'fail' && t.m.indexOf('不一致') >= 0)).toBe(true);
  });

  it('草稿不是本轮活动草稿（标记指向别的草稿）+ curWork=w1 → 仍被拒绝', async () => {
    const h = await runSavePlan({ planOwnerId: 'draft_old', planDraftOwner: 'draft_live', curWork: 'w1' });
    expect(h.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('真实作品 w1 的计划 + curWork=w2 → 真实作品之间的跨作品保护不变', async () => {
    const h = await runSavePlan({ planOwnerId: 'w1', curWork: 'w2' });
    expect(h.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.toasts.some(t => t.m.indexOf('计划归属（w1）') >= 0)).toBe(true);
  });

  it('真实作品 w1 + curWork=w1 → 正常保存', async () => {
    const h = await runSavePlan({ planOwnerId: 'w1', curWork: 'w1' });
    expect(h.ok).toBe(true);
    expect(h.calls[0].owner).toBe('w1');
  });

  it('无归属 + curWork=w1 → 仍以当前作品为归属保存（原有行为不变）', async () => {
    const h = await runSavePlan({ planOwnerId: '', curWork: 'w1' });
    expect(h.ok).toBe(true);
    expect(h.calls[0].owner).toBe('w1');
  });
});

describe('G11 · submitName 改名派生：登记新的活动草稿', () => {
  function runSubmitName(cfg) {
    const state = {
      curWork: 'w1',
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      planDraftOwner: cfg.planDraftOwner || '',
      plan: [H.stage('ps_a', { platforms: ['github'] })],
      planDirty: false,
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
      function (id) { return state.works.filter(w => w.id === id)[0] || null; },
      function () { draftSeq++; return 'draft_rename_' + draftSeq; },
      function () { return 'ps_new_' + Math.random().toString(36).slice(2, 7); },
      function () {}, function () {}, function (s) { return String(s); },
      function () {}, function () {}
    );
    submitName({ preventDefault: function () {} });
    return state;
  }

  it('改名派生 → 切到新草稿并登记为活动草稿，curWork 仍停在 w1（合法组合）', () => {
    const state = runSubmitName({ name: '新名字' });
    expect(state.planOwnerId).toBe('draft_rename_1');
    expect(state.copiesOwner).toBe('draft_rename_1');
    expect(state.planDraftOwner).toBe('draft_rename_1');
    expect(state.curWork).toBe('w1');
    expect(state.planDirty).toBe(true);
    // 阶段 ID 全部换新（不复用旧作品的阶段 ID）
    expect(state.plan.every(it => it.id.indexOf('ps_new_') === 0)).toBe(true);
  });

  it('名称未改（不是改名派生）→ 不切换草稿，也不登记活动草稿', () => {
    const state = runSubmitName({ name: '旧名字' });
    expect(state.planOwnerId).toBe('w1');
    expect(state.planDraftOwner).toBe('');
    expect(state.planDirty).toBe(false);
  });

  it('改名派生后的草稿 → savePlan 允许保存（与上一条守卫联动）', async () => {
    const state = runSubmitName({ name: '新名字' });
    const calls = [];
    const toasts = [];
    const win = { api: { planSave: function (owner) { calls.push(owner); return Promise.resolve({ ok: true }); } } };
    const fn = new Function(
      'state', 'window', 'toast', 'Promise', 'findWork', 'isSampleWork', 'planStagePayload',
      SAVE_PLAN_SRC + '\nreturn window.savePlan;'
    );
    const savePlan = fn(
      state, win,
      function (m, level) { toasts.push({ level: level }); },
      Promise,
      function (id) { return state.works.filter(w => w.id === id)[0] || null; },
      function () { return false; },
      PLAN_STAGE_PAYLOAD_FN
    );
    // 给阶段补一个合法的未来时间，避免被时间校验拦截
    state.plan = state.plan.map(it => Object.assign({}, it, { scheduledAt: H.FUTURE }));
    const ok = await savePlan();
    expect(ok).toBe(true);
    expect(calls).toEqual(['draft_rename_1']);
    expect(toasts).toHaveLength(0);
  });
});

describe('G11 · seedWorks 启动竞态：不覆盖正在进行的新作品流程', () => {
  function runSeedWorks(cfg) {
    const state = {
      works: [{ id: 'sample_a', name: '示例', isSample: true }],
      curWork: cfg.curWork === undefined ? null : cfg.curWork,
      planDraftOwner: cfg.planDraftOwner || ''
    };
    const win = {
      api: {
        listWorks: function () { return Promise.resolve(cfg.rows); },
        deleteWork: function () { return Promise.resolve(); }
      }
    };
    const fn = new Function(
      'state', 'window', 'SAMPLE_WORK_IDS', 'normalizeWork', 'Promise',
      SEED_WORKS_SRC + '\nreturn seedWorks;'
    );
    const seedWorks = fn(
      state, win, [],
      function (w) { return { id: w.id, name: w.name, isSample: false }; },
      Promise
    );
    return seedWorks().then(function () { return state; });
  }

  it('正常启动（无活动草稿）→ 默认选中第一件真实作品', async () => {
    const state = await runSeedWorks({ rows: [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }] });
    expect(state.curWork).toBe('w1');
  });

  it('存在活动草稿且 curWork 为空 → 不覆盖新作品流程（保持未选中）', async () => {
    const state = await runSeedWorks({
      rows: [{ id: 'w1', name: '作品一' }],
      curWork: null,
      planDraftOwner: 'draft_live'
    });
    expect(state.curWork).toBe(null);
  });

  it('用户已选中作品 → 不被默认作品覆盖', async () => {
    const state = await runSeedWorks({
      rows: [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }],
      curWork: 'w2'
    });
    expect(state.curWork).toBe('w2');
  });
});

describe('G11 · 生命周期出口的标记清理（源码级一致性）', () => {
  it('openWork 打开已有作品时清空活动草稿标记', () => {
    expect(OPEN_WORK_SRC).toContain("state.planOwnerId=id;");
    expect(OPEN_WORK_SRC).toContain("state.planDraftOwner='';");
  });

  it('delWork 删除作品时按归属匹配清空活动草稿标记', () => {
    expect(DEL_WORK_SRC).toContain("state.planOwnerId='';state.copiesOwner='';state.planDirty=false;");
    expect(DEL_WORK_SRC).toContain("state.planDraftOwner='';");
  });

  it('planTransferAfterSave 只清「本次已转正」的活动草稿', () => {
    expect(TRANSFER_SRC).toContain("if(String(state.planDraftOwner||'')===_from)state.planDraftOwner='';");
  });
  it('转正活动草稿之外的草稿不会被误清', async () => {
    const state = {
      planOwnerId: 'draft_src', copiesOwner: 'draft_src', planDraftOwner: 'draft_other',
      planDirty: false, plan: [H.stage('ps_a')]
    };
    const calls = [];
    const win = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id }); },
        planReassign: function (from, to) {
          calls.push([from, to]);
          return Promise.resolve({ ok: true, rescheduled: [], reschedule_kept: [] });
        }
      }
    };
    const fn = new Function('state', 'window', 'toast', 'Promise', TRANSFER_SRC + '\nreturn window.planTransferAfterSave;');
    const transfer = fn(state, win, function () {}, Promise);
    const res = await transfer({ id: 'w1', name: '作品一' }, 'draft_src', true);
    expect(res.ok).toBe(true);
    expect(state.planDraftOwner).toBe('draft_other');
  });
});
