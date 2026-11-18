//
// Rokit · 视频快照更新不得创建 plan_tasks（v1.30 第四批）—— 定向测试
//
// 覆盖：
//   A  正常更新：已有阶段对应平台的 videoPath 更新成功；原 title/body/tags 不变；
//      其它平台快照不变；不新增阶段
//   B  任务隔离：更新前后 plan_tasks 总行数 / task ID / stage_id / platform_id /
//      status / scheduled_at 全部不变；且更新过程**未**调用 _planWriteTask 或 savePlanStages
//   C  不存在的阶段：返回失败；不创建新阶段；不创建任何任务
//   D  用户未保存的编辑：planDirty=false / true 两种情况下原值都保持不变；
//      不调用 savePlan()；不改变内存 state.plan；不清除未保存编辑
//   E  异步切换作品：更新目标仍是调用时捕获的原 owner 与阶段；
//      不得误写入切换后的作品；不得污染新作品的内存计划
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
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');
const PLAN_IPC_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'plan-ipc.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

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

// 剥离注释（避免注释里的文字被当成真实调用）
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PERSIST_SRC = extractBlock(HTML, 'function _persistFinalVideoForWork(videoPath){');
const OWNER_SRC = extractBlock(HTML, 'function _curVideoOwnerKey(){');
const DIAG_SRC = extractBlock(HTML, 'function _workVideoDiag(stage, data){');

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

const WORK_CREATED = '2026-03-10T02:00:00.000Z';

/* 造一个带 copy 快照的阶段 */
function stageWithCopy(id, platforms, copy) {
  return {
    id: id,
    title: '阶段 ' + id,
    desc: '',
    offsetDays: 0,
    timeOfDay: '20:00',
    scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    platforms: platforms,
    copy: copy
  };
}

function snapshotTasks(store, workId) {
  return store.listPlanTasks(workId).map(function (t) {
    return {
      id: t.id, stage_id: t.stage_id, work_id: t.work_id, platform_id: t.platform_id,
      status: t.status, scheduled_at: t.scheduled_at, pub_key: t.pub_key,
      real_only: t.real_only, simulated: t.simulated
    };
  });
}

/* ==================================================================
   A · 正常更新
   ================================================================== */
describe('A · 正常更新已有阶段的视频快照', () => {
  it('A1 · videoPath 更新成功；title/body/tags 与其它平台快照全部不变；不新增阶段', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('w1', [
      stageWithCopy('ps_a', ['github', 'youtube'], {
        github: { title: 'GH 标题', body: 'GH 正文', tags: ['#a'], videoPath: 'C:/old/final.mp4' },
        youtube: { title: 'YT 标题', body: 'YT 正文', tags: ['#b'], videoPath: 'C:/old/final.mp4' }
      })
    ]);
    const stagesBefore = store.listPlanStages('w1').length;

    const r = store.setPlanStageVideoReference('w1', 'ps_a', 'github', 'C:/new/final.mp4');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);

    const st = store.listPlanStages('w1')[0];
    expect(st.copy.github.videoPath).toBe('C:/new/final.mp4');
    // 该平台原有 title/body/tags 不变
    expect(st.copy.github.title).toBe('GH 标题');
    expect(st.copy.github.body).toBe('GH 正文');
    expect(st.copy.github.tags).toEqual(['#a']);
    // 其它平台快照完全不变
    expect(st.copy.youtube).toEqual({
      title: 'YT 标题', body: 'YT 正文', tags: ['#b'], videoPath: 'C:/old/final.mp4'
    });
    // 不新增阶段
    expect(store.listPlanStages('w1').length).toBe(stagesBefore);
  });

  it('A2 · 该平台原本没有快照时，只补 videoPath，其余字段为空', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('w1', [
      stageWithCopy('ps_a', ['github'], { github: { title: 'T', body: 'B', tags: [] } })
    ]);
    const r = store.setPlanStageVideoReference('w1', 'ps_a', 'github', 'C:/new/final.mp4');
    expect(r.ok).toBe(true);
    const st = store.listPlanStages('w1')[0];
    expect(st.copy.github.videoPath).toBe('C:/new/final.mp4');
    expect(st.copy.github.title).toBe('T');
    expect(st.copy.github.body).toBe('B');
  });

  it('A3 · 相同路径重复更新 → ok=true, changed=false（幂等）', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('w1', [
      stageWithCopy('ps_a', ['github'], { github: { title: 'T', body: 'B', tags: [], videoPath: 'C:/same.mp4' } })
    ]);
    const r = store.setPlanStageVideoReference('w1', 'ps_a', 'github', 'C:/same.mp4');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
  });

  it('A4 · 参数校验：缺 workId / stageId / platformId / videoPath 全部拒绝', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    expect(store.setPlanStageVideoReference('', 'ps_a', 'github', 'C:/x.mp4').ok).toBe(false);
    expect(store.setPlanStageVideoReference('w1', '', 'github', 'C:/x.mp4').ok).toBe(false);
    expect(store.setPlanStageVideoReference('w1', 'ps_a', '', 'C:/x.mp4').ok).toBe(false);
    expect(store.setPlanStageVideoReference('w1', 'ps_a', 'github', '').ok).toBe(false);
  });
});

/* ==================================================================
   B · 任务隔离
   ================================================================== */
describe('B · 任务隔离：更新快照绝不触碰 plan_tasks', () => {
  it('B1 · 更新前后 plan_tasks 全字段不变，总行数不变', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('w1', [
      stageWithCopy('ps_a', ['github', 'youtube'], {
        github: { title: 'GH', body: 'B', tags: [], videoPath: 'C:/old.mp4' },
        youtube: { title: 'YT', body: 'B', tags: [], videoPath: 'C:/old.mp4' }
      })
    ]);
    const before = snapshotTasks(store, 'w1');
    expect(before.length).toBe(2);

    store.setPlanStageVideoReference('w1', 'ps_a', 'github', 'C:/new.mp4');
    store.setPlanStageVideoReference('w1', 'ps_a', 'youtube', 'C:/new.mp4');

    const after = snapshotTasks(store, 'w1');
    expect(after.length).toBe(before.length);
    expect(after).toEqual(before);
    // 逐项明确核对
    after.forEach(function (t, i) {
      expect(t.id).toBe(before[i].id);
      expect(t.stage_id).toBe(before[i].stage_id);
      expect(t.platform_id).toBe(before[i].platform_id);
      expect(t.status).toBe(before[i].status);
      expect(t.scheduled_at).toBe(before[i].scheduled_at);
    });
  });

  it('B2 · setPlanStageVideoReference 不调用 _planWriteTask / savePlanStages', () => {
    // 源码级断言：新增方法体内只出现 plan_stages 的 UPDATE，绝不出现任务写入方法
    const fn = extractBlock(STORE_SRC, 'setPlanStageVideoReference(workId, stageId, platformId, videoPath) {');
    expect(fn).not.toMatch(/_planWriteTask/);
    expect(fn).not.toMatch(/savePlanStages/);
    expect(fn).not.toMatch(/INSERT INTO plan_tasks/);
    expect(fn).not.toMatch(/INSERT INTO plan_stages/);
    expect(fn).not.toMatch(/DELETE FROM/);
    expect(fn).toMatch(/UPDATE plan_stages SET copy=/);
  });

  it('B3 · 运行时验证：调用期间未触发任何任务写入方法', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    store.savePlanStages('w1', [stageWithCopy('ps_a', ['github'], { github: { title: 'T', body: 'B', tags: [] } })]);
    const calls = [];
    const origWrite = store._planWriteTask.bind(store);
    store._planWriteTask = function (t) { calls.push(t); return origWrite(t); };
    const origSave = store.savePlanStages.bind(store);
    store.savePlanStages = function () { calls.push('savePlanStages'); return origSave.apply(store, arguments); };

    store.setPlanStageVideoReference('w1', 'ps_a', 'github', 'C:/new.mp4');

    expect(calls).toEqual([]);
  });

  it('B4 · 阶段所属作品不匹配时不会写到别的作品名下', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    H.seedWork(store, 'w2', '作品二', WORK_CREATED);
    store.savePlanStages('w1', [stageWithCopy('ps_a', ['github'], { github: { title: 'T', body: 'B', tags: [] } })]);
    const r = store.setPlanStageVideoReference('w2', 'ps_a', 'github', 'C:/x.mp4');
    expect(r.ok).toBe(false);
    // w1 的阶段未被改动
    expect(store.listPlanStages('w1')[0].copy.github.videoPath).toBeUndefined();
    expect(store.listPlanStages('w2').length).toBe(0);
  });
});

/* ==================================================================
   C · 不存在的阶段
   ================================================================== */
describe('C · 不存在的阶段', () => {
  it('C1 · 返回失败；不创建阶段；不创建任务', () => {
    H.seedWork(store, 'w1', '作品一', WORK_CREATED);
    const stagesBefore = store.listPlanStages('w1').length;
    const tasksBefore = store.listPlanTasks('w1').length;

    const r = store.setPlanStageVideoReference('w1', 'ps_not_exist', 'github', 'C:/x.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('stage not found for work');
    expect(store.listPlanStages('w1').length).toBe(stagesBefore);
    expect(store.listPlanTasks('w1').length).toBe(tasksBefore);
    expect(store.listPlanTasks('w1')).toEqual([]);
  });
});

/* ==================================================================
   D · 用户未保存的编辑
   ================================================================== */
describe('D · 用户未保存的计划编辑不被覆盖', () => {
  function runPersist(opts) {
    const o = opts || {};
    const state = {
      planOwnerId: o.planOwnerId || 'w1',
      copiesOwner: o.planOwnerId || 'w1',
      curWork: o.curWork || 'w1',
      plan: o.plan || [],
      planDirty: !!o.planDirty,
      __captionFinalVideo: null
    };
    const calls = { savePlan: 0, planSave: [], planSetStageVideoRef: [], planList: [] };
    const win = {
      api: {
        planSaveFinalVideo: function () { return Promise.resolve({ ok: true, path: 'C:/x.mp4' }); },
        planList: function (owner) {
          calls.planList.push(owner);
          return Promise.resolve(o.planListResult || { stages: [], tasks: [] });
        },
        planSetStageVideoRef: function (workId, stageId, platformId, videoPath) {
          calls.planSetStageVideoRef.push({ workId: workId, stageId: stageId, platformId: platformId, videoPath: videoPath });
          return Promise.resolve(o.setRefResult !== undefined ? o.setRefResult : { ok: true, changed: true });
        },
        planSave: function (owner, stages) { calls.planSave.push(owner); return Promise.resolve({ ok: true }); }
      },
      savePlan: function () { calls.savePlan++; return Promise.resolve(true); }
    };
    const fn = new Function(
      'window', 'state', 'Promise', 'toast', 'console',
      OWNER_SRC + '\n' + DIAG_SRC + '\n' + PERSIST_SRC + '\nreturn _persistFinalVideoForWork;'
    );
    const persist = fn(
      win, state, Promise,
      function () {},
      { log: function () {}, warn: function () {}, error: function () {} }
    );
    persist('C:/new/final.mp4');
    return { state: state, calls: calls, win: win };
  }

  [false, true].forEach(function (dirty) {
    it('D-' + (dirty ? 'true' : 'false') + ' · planDirty=' + dirty + ' → dirty 保持原值，不调 savePlan，内存 plan 不变', async function () {
      const memPlan = [{ id: 'ps_a', title: '用户改过的标题', platforms: ['github'], copy: {} }];
      const env = runPersist({
        planDirty: dirty,
        plan: memPlan,
        planListResult: {
          stages: [{ id: 'ps_a', copy: { github: { title: 'DB 标题', body: 'DB 正文', tags: [], videoPath: 'C:/old.mp4' } } }],
          tasks: [{ platform_id: 'github', status: 'pending' }]
        }
      });
      // 等异步链跑完
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // ★ dirty 状态原样保留（既不置真也不清零）
      expect(env.state.planDirty).toBe(dirty);
      // ★ 绝不调用 savePlan / plan:save
      expect(env.calls.savePlan).toBe(0);
      expect(env.calls.planSave.length).toBe(0);
      // ★ 内存 state.plan 完全不变（用户的未保存编辑仍在）
      expect(env.state.plan).toEqual(memPlan);
      expect(env.state.plan[0].title).toBe('用户改过的标题');
      // ★ 走的是独立更新入口
      expect(env.calls.planSetStageVideoRef.length).toBe(1);
      expect(env.calls.planSetStageVideoRef[0].stageId).toBe('ps_a');
      expect(env.calls.planSetStageVideoRef[0].platformId).toBe('github');
      expect(env.calls.planSetStageVideoRef[0].videoPath).toBe('C:/new/final.mp4');
    });
  });

  it('D3 · 数据库里没有该平台的快照 → 不调用更新入口（不补建）', async function () {
    const env = runPersist({
      planDirty: false,
      plan: [{ id: 'ps_a', title: 'T', platforms: ['github', 'youtube'], copy: {} }],
      planListResult: {
        stages: [{ id: 'ps_a', copy: { github: { title: 'DB', body: 'B', tags: [] } } }],
        tasks: [{ platform_id: 'github', status: 'pending' }]
      }
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // 只有 github 有快照 → 只更新 github，不补建 youtube
    expect(env.calls.planSetStageVideoRef.length).toBe(1);
    expect(env.calls.planSetStageVideoRef[0].platformId).toBe('github');
    expect(env.calls.savePlan).toBe(0);
  });

  it('D4 · 更新失败 → 明确记录失败，不伪装成功，且不影响任何视频文件', async function () {
    const env = runPersist({
      planDirty: false,
      plan: [{ id: 'ps_a', title: 'T', platforms: ['github'], copy: {} }],
      planListResult: {
        stages: [{ id: 'ps_a', copy: { github: { title: 'DB', body: 'B', tags: [] } } }],
        tasks: [{ platform_id: 'github', status: 'pending' }]
      },
      setRefResult: { ok: false, error: 'stage not found for work' }
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // 调用了更新入口（没有静默跳过），失败也没有抛异常中断流程
    expect(env.calls.planSetStageVideoRef.length).toBe(1);
    expect(env.calls.savePlan).toBe(0);
    expect(env.state.planDirty).toBe(false);
  });
});

/* ==================================================================
   E · 异步切换作品
   ================================================================== */
describe('E · 异步过程中切换作品', () => {
  it('E1 · 更新目标仍是调用时捕获的原 owner 与阶段，不写入切换后的作品', async function () {
    const state = {
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      curWork: 'w1',
      plan: [{ id: 'ps_a', title: 'T', platforms: ['github'], copy: {} }],
      planDirty: false,
      __captionFinalVideo: null
    };
    const calls = { planSetStageVideoRef: [], planList: [] };
    const win = {
      api: {
        planSaveFinalVideo: function () { return Promise.resolve({ ok: true }); },
        planList: function (owner) {
          calls.planList.push(owner);
          // 模拟 IPC 延迟：期间用户切换了作品
          return new Promise(function (resolve) {
            setTimeout(function () {
              // 用户已切换到 w2
              state.planOwnerId = 'w2';
              state.copiesOwner = 'w2';
              state.curWork = 'w2';
              state.plan = [{ id: 'ps_w2', title: '另一个作品', platforms: ['github'], copy: {} }];
              resolve({
                stages: [{ id: 'ps_a', copy: { github: { title: 'DB', body: 'B', tags: [] } } }],
                tasks: [{ platform_id: 'github', status: 'pending' }]
              });
            }, 5);
          });
        },
        planSetStageVideoRef: function (workId, stageId, platformId, videoPath) {
          calls.planSetStageVideoRef.push({ workId: workId, stageId: stageId, platformId: platformId, videoPath: videoPath });
          return Promise.resolve({ ok: true, changed: true });
        }
      }
    };
    const fn = new Function(
      'window', 'state', 'Promise', 'toast', 'console',
      OWNER_SRC + '\n' + DIAG_SRC + '\n' + PERSIST_SRC + '\nreturn _persistFinalVideoForWork;'
    );
    const persist = fn(
      win, state, Promise,
      function () {},
      { log: function () {}, warn: function () {}, error: function () {} }
    );
    persist('C:/new/final.mp4');
    await new Promise(function (r) { setTimeout(r, 30); });

    // ★ 查询与更新都用调用时捕获的 owner（w1）
    expect(calls.planList.length).toBe(1);
    expect(calls.planList[0]).toBe('w1');
    expect(calls.planSetStageVideoRef.length).toBe(1);
    expect(calls.planSetStageVideoRef[0].workId).toBe('w1');
    expect(calls.planSetStageVideoRef[0].stageId).toBe('ps_a');
    // ★ 绝没有写到切换后的 w2
    expect(calls.planSetStageVideoRef.some(function (c) { return c.workId === 'w2'; })).toBe(false);
    expect(calls.planSetStageVideoRef.some(function (c) { return c.stageId === 'ps_w2'; })).toBe(false);
    // ★ 新作品的内存计划未被污染（仍只有它自己的阶段）
    expect(state.plan.length).toBe(1);
    expect(state.plan[0].id).toBe('ps_w2');
  });
});

/* ==================================================================
   接线检查：IPC / preload / store 三者一致
   ================================================================== */
describe('接线 · IPC / preload / store 一致', () => {
  it('W1 · store 方法存在且已导出（Store 实例方法）', () => {
    expect(STORE_SRC).toMatch(/setPlanStageVideoReference\(workId, stageId, platformId, videoPath\) \{/);
  });

  it('W2 · plan-ipc 注册了 plan:set-stage-video-ref 并直接调 store 方法', () => {
    expect(PLAN_IPC_SRC).toMatch(/ipcMain\.handle\('plan:set-stage-video-ref'/);
    expect(PLAN_IPC_SRC).toMatch(/store\.setPlanStageVideoReference\(workId, stageId, platformId, videoPath\)/);
    // 不得经过 plan:save
    const handler = extractBlock(PLAN_IPC_SRC, "ipcMain.handle('plan:set-stage-video-ref'");
    expect(handler).not.toMatch(/savePlanStages/);
  });

  it('W3 · preload 暴露 planSetStageVideoRef', () => {
    expect(PRELOAD_SRC).toMatch(/planSetStageVideoRef:\s*\(workId, stageId, platformId, videoPath\)/);
    expect(PRELOAD_SRC).toMatch(/ipcRenderer\.invoke\('plan:set-stage-video-ref'/);
  });

  it('W4 · _persistFinalVideoForWork 不再调用 savePlan / 修改 planDirty', () => {
    const code = stripComments(PERSIST_SRC);
    expect(code).not.toMatch(/window\.savePlan\(/);
    expect(code).not.toMatch(/state\.planDirty\s*=/);
    expect(code).not.toMatch(/state\.plan\s*=/);
    expect(code).not.toMatch(/state\.planOwnerId\s*=/);
    expect(code).toMatch(/planSetStageVideoRef/);
  });
});
