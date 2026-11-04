'use strict';

// Rokit · Phase 2 安全收尾：模拟标识 / 存储可见性 / 模拟与真实隔离 / 幂等基础
//
// 覆盖用户要求的全部验证点：
//   T1  模拟任务创建后，模拟标识在 SQLite 与 JSON fallback 中均能持久化
//   T2  模拟任务在列表、详情和状态展示中均能被明确识别
//   T3  模拟 done 任务不会被误判为真实发布成功
//   T4  模拟任务不会进入真实执行路径
//   T5  已确认成功的发布记录不会触发重复发布
//   T6  review / 匹配冲突 / 结果不确定的场景不会被自动重发
//   T7  数据库初始化失败时，不会悄悄切换到另一份数据库
//   T8  现有任务状态转换、作品隔离、阶段删除、手动发布流程没有非预期变化
//   T9  新增数据库迁移可保留原有工作、发布记录及计划数据
//
// 全部测试使用临时目录里的独立数据库 / 隔离数据，不触碰用户生产数据库。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 从 index.html 切出生产函数 ---------- */
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

const SRC = {
  statusMeta: extractBlock(HTML, 'function planTaskStatusMeta(id,simulated,realOnly){'),
  failNotice: extractBlock(HTML, 'function planTaskFailureNotice(task,platformName){'),
  paintDetail: extractBlock(HTML, 'function paintPlanDetail(workId,stages,tasks){'),
  taskHtml: extractBlock(HTML, 'function planDetailTaskHtml(workId,st,t,openTask,editTask){'),
  taskDetailHtml: extractBlock(HTML, 'function planDetailTaskDetailHtml(workId,st,t,editing){'),
  copyText: extractBlock(HTML, 'function planTaskCopyText(stage,pid,workId){'),
  renderCenter: extractBlock(HTML, 'function renderPlanCenter(){'),
  schedBadge: extractBlock(HTML, 'function paintPlanSchedulerBadge(){'),
  storeInfo: extractBlock(HTML, 'function paintPlanStoreInfo(){')
};
// 状态字典（页面里的真实常量）
const STATUS_ARR = (function () {
  const m = /var PLAN_TASK_STATUS=\[[\s\S]*?\];/.exec(HTML);
  return m ? m[0] : 'var PLAN_TASK_STATUS=[];';
})();

/* ---------- 极简 DOM 桩 ---------- */
function makeDom() {
  const els = {};
  function get(id) {
    if (!els[id]) {
      els[id] = {
        id: id, innerHTML: '', textContent: '', value: '', options: [], style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}
      };
    }
    return els[id];
  }
  return {
    els: els,
    get: get,
    document: {
      getElementById: get,
      querySelectorAll() { return []; },
      createElement() {
        return {
          style: {}, classList: { add() {}, remove() {} },
          appendChild() {}, addEventListener() {}, remove() {},
          set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; }
        };
      },
      body: { appendChild() {} }
    }
  };
}

/* ---------- 存储环境 ---------- */
let tmpDir;
let dbPath;
let restoreBlock = null;

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
function setupWork(store, workId, platforms) {
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, { platforms: platforms || ['github'] })]);
  // 本文件验证模拟执行：GitHub 任务默认 real_only=1，先降级为模拟候选（等价旧 auto_publish=0）
  return H.demoteToSimulated(store, workId);
}

/* ==================================================================
   T1 · 模拟标识持久化
   ================================================================== */
describe('T1 · 模拟标识在 SQLite 与 JSON fallback 中持久化', () => {
  function runScenario(mode) {
    const store = newStore(mode);
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github', 'wechat']);
    expect(tasks[0].simulated).toBe(0);          // 刚创建的真实计划任务

    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[1].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    const after = store.listPlanTasks('w1');
    // 模拟执行过的任务必须带 simulated=1
    expect(after.every(t => t.simulated === 1)).toBe(true);

    // 重新打开（等价于重启应用）：标识仍在
    const reopened = newStore(mode);
    const persisted = reopened.listPlanTasks('w1');
    expect(persisted.every(t => t.simulated === 1)).toBe(true);
    expect(persisted.map(t => t.id).sort()).toEqual(after.map(t => t.id).sort());
    // 模拟任务的 platform_ref 带 mock: 前缀，platform_url 为空
    persisted.forEach(t => {
      expect(t.platform_ref.indexOf('mock:')).toBe(0);
      expect(t.platform_url).toBe('');
    });
    return persisted;
  }

  it('SQLite 模式下标识持久化', () => {
    const r = runScenario('sqlite');
    expect(r).toHaveLength(2);
  });

  it('JSON fallback 模式下标识同样持久化', () => {
    const r = runScenario('json');
    expect(r).toHaveLength(2);
  });

  it('新建的（尚未执行）任务默认不是模拟任务', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    expect(tasks[0].simulated).toBe(0);
    expect(store.listPlanTasks('w1')[0].simulated).toBe(0);
  });

  it('模拟失败的任务同样带模拟标识', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'], title: 'MOCK_FAIL 阶段' })]);
    H.demoteToSimulated(store, 'w1');
    const t = store.listPlanTasks('w1')[0];
    store.updatePlanTask('w1', t.id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('failed');
    expect(after.simulated).toBe(1);
  });
});

/* ==================================================================
   T2 · 模拟任务在界面上的明确识别
   ================================================================== */
describe('T2 · 模拟任务在列表 / 详情 / 状态展示中被明确识别', () => {
  function metaOf(status, simulated) {
    const fn = new Function(STATUS_ARR + '\n' + SRC.statusMeta + '\nreturn planTaskStatusMeta;');
    return fn()(status, simulated);
  }
  const ESC = function (s) { return String(s == null ? '' : s); };
  const TIMETEXT = function (t) { return t.scheduled_at || ''; };

  it('状态文案：模拟完成显示为「已完成（模拟）」，真实完成仍是「已完成」', () => {
    expect(metaOf('done', 1).label).toBe('已完成（模拟）');
    expect(metaOf('done', 0).label).toBe('已完成');
    expect(metaOf('done', undefined).label).toBe('已完成');
  });

  it('状态文案：模拟公众号草稿显示为「草稿待发布（模拟）」', () => {
    expect(metaOf('draft_pending', 1).label).toBe('草稿待发布（模拟）');
    expect(metaOf('draft_pending', 0).label).toBe('草稿待发布');
  });

  it('任务详情：显示结果来源，模拟任务不会显示成真实发布', () => {
    const fn = new Function('state', 'document', 'esc', 'planTaskStatusMeta', 'planTaskTimeText',
      STATUS_ARR + '\n' + SRC.statusMeta + '\n' + SRC.failNotice + '\n' + SRC.copyText + '\n' + SRC.taskDetailHtml + '\nreturn planDetailTaskDetailHtml;');
    const call = fn({}, makeDom().document, ESC, metaOf, TIMETEXT);

    const html = call('w1', {}, {
      id: 't1', status: 'done', simulated: 1, platform_ref: 'mock:github:t1',
      scheduled_at: '2026-01-01T12:00:00.000Z'
    }, false);

    expect(html).toContain('结果来源');
    expect(html).toContain('模拟执行');
    expect(html).toContain('模拟平台标识（未真实发布）');
    expect(html).not.toContain('>平台返回 ID<');
    expect(html).toContain('已完成（模拟）');
  });

  it('真实任务的 platform_ref 仍然叫「平台返回 ID」，且只有可核实的发布记录才算真实发布', () => {
    const fn = new Function('state', 'document', 'esc', 'planTaskStatusMeta', 'planTaskTimeText',
      STATUS_ARR + '\n' + SRC.statusMeta + '\n' + SRC.failNotice + '\n' + SRC.copyText + '\n' + SRC.taskDetailHtml + '\nreturn planDetailTaskDetailHtml;');
    const call = fn({}, makeDom().document, ESC, metaOf, TIMETEXT);

    // 有可核实的发布记录 → 真实平台发布
    const real = call('w1', {}, {
      id: 't1', status: 'done', simulated: 0, platform_ref: 'real-id-123', scheduled_at: '', pub_state: 'done'
    }, false);
    expect(real).toContain('平台返回 ID');
    expect(real).toContain('真实平台发布');

    // 没有可核实的发布记录 → 标注"未核实"（历史任务不凭 status='done' 就认定成功）
    const unknown = call('w1', {}, {
      id: 't2', status: 'done', simulated: 0, platform_ref: '', scheduled_at: '', pub_state: 'none'
    }, false);
    expect(unknown).toContain('未核实');
    expect(unknown).not.toContain('真实平台发布');
  });

  it('计划详情页：模拟任务带「模拟任务」标记并提供重新排队入口', () => {
    const fn = new Function('state', 'document', 'esc', 'planTaskStatusMeta', 'planTaskTimeText', 'planPlatformMeta',
      STATUS_ARR + '\n' + SRC.statusMeta + '\n' + SRC.failNotice + '\n' + SRC.taskHtml + '\nreturn planDetailTaskHtml;');
    const html = fn({}, makeDom().document, ESC, metaOf, TIMETEXT,
      function (id) { return { id: id, name: id }; })(
      'w1', {}, { id: 't1', status: 'done', simulated: 1, platform_id: 'github' }, '', '');

    expect(html).toContain('模拟任务');
    expect(html).toContain('planDetailRequeue(');
    expect(html).toContain('已完成（模拟）');
  });

  it('全局计划列表：模拟任务带「模拟」标记', async () => {
    const dom = makeDom();
    const state = {
      planView: { status: 'all', q: '', platform: 'all', sort: 'time_asc' },
      planCenterData: { stages: [], tasks: [] },
      works: [{ id: 'w1', name: '作品一' }]
    };
    const win = {
      api: {
        planAll: function () {
          return Promise.resolve({
            stages: [{ id: 'ps_a', seq: 0, title: '阶段', platforms: ['github'] }],
            tasks: [{
              id: 't1', stage_id: 'ps_a', work_id: 'w1', platform_id: 'github',
              stage_seq: 0, stage_title: '阶段', scheduled_at: '2026-01-01T12:00:00.000Z',
              status: 'done', simulated: 1, pub_state: 'none'
            }]
          });
        }
      }
    };
    const fn = new Function('state', 'window', 'document', 'esc', 'planTaskStatusMeta', 'planTaskWorkName',
      'planTaskTimeText', 'planPlatformMeta', 'pubArg', 'PLAN_PLATFORMS',
      STATUS_ARR + '\n' + SRC.statusMeta + '\n' + SRC.failNotice + '\n' + SRC.schedBadge + '\n' + SRC.storeInfo + '\n'
      + SRC.renderCenter + '\nreturn renderPlanCenter;');
    fn(state, win, dom.document, ESC, metaOf,
      function () { return '作品一'; },
      TIMETEXT,
      function (id) { return { id: id, name: id, color: '#000' }; },
      function (s) { return '"' + String(s).replace(/"/g, '\\"') + '"'; },
      [{ id: 'github', name: 'GitHub' }])();

    await new Promise(function (r) { setTimeout(r, 0); });
    const html = dom.get('planCenterTable').innerHTML;
    expect(html).toContain('已完成（模拟）');
    expect(html).toContain('模拟');
  });
});

/* ==================================================================
   T3 · 模拟 done 不被误判为真实发布成功
   ================================================================== */
describe('T3 · 模拟 done 任务不会被误判为真实发布成功', () => {
  it('模拟任务即便与 pubs 记录同幂等键，pub_state 也不是 done', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    const task = store.listPlanTasks('w1')[0];
    expect(task.status).toBe('done');
    expect(task.simulated).toBe(1);

    // 即便 pubs 里出现了同幂等键的成功记录，模拟任务也不能被说成"已发布"
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: task.pub_key });
    const after = store.listPlanTasks('w1')[0];
    expect(after.pub_state).toBe('none');
  });

  it('发布前检查对模拟任务一律给出 unclear（不得当成可执行）', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    const g = store.checkPlanPublishGuard('w1', tasks[0].id);
    expect(g.decision).toBe('unclear');
    expect(g.reason).toContain('模拟');
  });

  it('模拟任务没有 platform_url，界面不会显示发布链接', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();
    expect(store.listPlanTasks('w1')[0].platform_url).toBe('');
  });
});

/* ==================================================================
   T4 · 模拟任务不会进入真实执行路径
   ================================================================== */
describe('T4 · 模拟任务不会进入真实执行路径', () => {
  it('真实执行器（executorKind=real）拒绝执行模拟任务', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    // 先用模拟执行器跑一次 → 任务变成 simulated=1 且 done
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();

    let realCalls = 0;
    const realScheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      executor: function () { realCalls++; return { ok: true, status: 'done' }; }
    });
    const out = realScheduler.scanOnce();

    expect(realCalls).toBe(0);
    expect(out.claimed).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');   // 状态未被改写
  });

  it('闸门函数对模拟任务直接拒绝', () => {
    const { checkRealExecutionGate } = loadScheduler();
    const gate = checkRealExecutionGate({}, { simulated: 1, id: 't1' });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toContain('模拟');
  });

  it('缺少检查能力时保守拒绝（绝不默认放行）', () => {
    const { checkRealExecutionGate } = loadScheduler();
    const gate = checkRealExecutionGate({}, { simulated: 0, id: 't1' });
    expect(gate.allow).toBe(false);
  });

  it('默认调度器始终是 mock（不会误用真实执行路径）', () => {
    const { createPlanScheduler } = loadScheduler();
    const s = createPlanScheduler({ getStore: () => newStore('sqlite') });
    expect(s.status().executor_kind).toBe('mock');
    expect(s.status().mode).toBe('mock');
  });
});

/* ==================================================================
   T5 / T6 · 幂等保护：skip / review / unclear
   ================================================================== */
describe('T5 · 已确认成功的发布记录不会触发重复发布', () => {
  it('幂等键精确命中 → skip，真实执行器不会调用', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    // 让任务进入「等待真实执行」（real_only=1）：这才是可能走真实发布的任务
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
    store.requeueSimulatedPlanTask('w1', task.id);
    expect(store.listPlanTasks('w1')[0].real_only).toBe(1);

    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: task.pub_key });

    const g = store.checkPlanPublishGuard('w1', task.id);
    expect(g.decision).toBe('skip');

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    const out = scheduler.scanOnce();

    expect(calls).toBe(0);
    expect(out.skipped.some(s => String(s.reason).indexOf('不得再次发布') >= 0)).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');   // 没有被执行掉
  });

  it('人工标记（manual）的成功记录同样算"已确认成功"', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual', pub_key: task.pub_key });
    expect(store.checkPlanPublishGuard('w1', task.id).decision).toBe('skip');
  });
});

describe('T6 · review / 冲突 / 不确定的场景不会被自动重发', () => {
  it('同作品同平台有成功记录但幂等键不同 → review', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'other|github|w1' });

    const g = store.checkPlanPublishGuard('w1', task.id);
    expect(g.decision).toBe('review');

    let calls = 0;
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    scheduler.scanOnce();
    expect(calls).toBe(0);
  });

  it('任务已标记完成但没有可核实的发布记录 → unclear（不盲目重试）', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, task, { status: 'done', simulated: 0 }));

    const g = store.checkPlanPublishGuard('w1', task.id);
    expect(g.decision).toBe('unclear');
  });

  it('执行中的任务 → unclear', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    store.claimPlanTask(task.id);
    expect(store.checkPlanPublishGuard('w1', task.id).decision).toBe('unclear');
  });

  it('明确失败过（无成功记录）→ allow（允许重新执行）', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const task = store.listPlanTasks('w1')[0];
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'failed', pub_key: 'x|1' });

    const g = store.checkPlanPublishGuard('w1', task.id);
    expect(g.decision).toBe('allow');
  });

  it('没有任何发布记录 → allow', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    expect(store.checkPlanPublishGuard('w1', tasks[0].id).decision).toBe('allow');
  });

  it('检查是只读的：不会改动任务或发布记录', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const before = store.listPlanTasks('w1')[0];
    store.checkPlanPublishGuard('w1', tasks[0].id);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe(before.status);
    expect(after.updated_at).toBe(before.updated_at);
    expect(store.listPubs()).toHaveLength(0);
  });
});

/* ==================================================================
   T7 · 数据库初始化失败不切换数据库
   ================================================================== */
describe('T7 · 数据库初始化失败时不会悄悄切换到另一份数据库', () => {
  it('损坏的数据库文件 → mode=error，不退回 JSON、不新建文件', () => {
    const badPath = path.join(tmpDir, 'bad.db');
    fs.writeFileSync(badPath, 'this-is-not-a-sqlite-file-at-all');

    const store = newStore('sqlite', badPath);
    const info = store.storeInfo();

    expect(info.mode).toBe('error');
    expect(info.driver).not.toBe('unknown');       // 驱动是确定的，只是打开失败
    expect(info.init_error).toBeTruthy();
    // 没有偷偷切到 JSON
    expect(info.mode).not.toBe('json');
    expect(info.json_file).toBe('');
    // 没有生成 JSON 兜底文件
    expect(fs.existsSync(path.join(tmpDir, 'ai-launch-master-data.json'))).toBe(false);
    // 原文件内容没有被覆盖 / 重建
    expect(fs.readFileSync(badPath, 'utf8')).toBe('this-is-not-a-sqlite-file-at-all');
  });

  it('storeInfo 明确给出文件与目录，不隐藏', () => {
    const store = newStore('sqlite');
    const info = store.storeInfo();
    expect(info.file).toContain('test.db');
    expect(info.dir).toContain(tmpDir);
    expect(info.mode).toBe('sqlite');
    expect(['better-sqlite3', 'node-sqlite']).toContain(info.driver);
  });

  it('main.js 启动时记录存储信息，并在失败时不启动调度器', () => {
    const MAIN = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(MAIN).toContain("logger.info('[store] ready'");
    expect(MAIN).toContain('file: _storeInfo.file');
    expect(MAIN).toContain('driver: _storeInfo.driver');
    expect(MAIN).toContain('_storeBroken');
    expect(MAIN).toContain('数据库初始化失败');
    // 存储坏掉时不启动调度器
    expect(MAIN).toContain('plan-scheduler] 未启动：存储初始化失败');
  });

  it('main.js 不做任何自动迁移 / 合并两个数据目录的动作', () => {
    const MAIN = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(MAIN).not.toMatch(/copyFileSync\([^)]*Rokit[^)]*\.userdata/);
    expect(MAIN).not.toMatch(/mergeStore|copyDatabase|migrateDatabase/i);
  });
});

/* ==================================================================
   T8 · 既有行为无非预期变化
   ================================================================== */
describe('T8 · 既有状态转换 / 隔离 / 阶段删除 / 手动发布无回归', () => {
  it('状态转换：pending → cancelled 保留历史，重开数据库不复活', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github', 'wechat']);
    const gh = tasks.filter(t => t.platform_id === 'github')[0];

    expect(store.cancelPlanTask('w1', gh.id).ok).toBe(true);
    const reopened = newStore('sqlite');
    const after = reopened.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('cancelled');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('pending');
  });

  it('已完成任务不能被编辑计划重置', () => {
    const store = newStore('sqlite');
    const tasks = setupWork(store, 'w1', ['github']);
    const t = tasks[0];
    store._planWriteTask(Object.assign({}, t, { status: 'done', platform_ref: 'x' }));
    store.savePlanStages('w1', [H.stage('ps_w1', { platforms: ['github'], offsetDays: 9 })]);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
    expect(store.listPlanTasks('w1')[0].platform_ref).toBe('x');
  });

  it('作品隔离：跨作品保存 / 取消仍然被拒绝', () => {
    const store = newStore('sqlite');
    setupWork(store, 'w1', ['github']);
    H.seedWork(store, 'w2', '作品二');
    expect(store.savePlanStages('w2', [H.stage('ps_w1')]).ok).toBe(false);
    expect(store.cancelPlanTask('w2', store.listPlanTasks('w1')[0].id).ok).toBe(false);
  });

  it('阶段删除：只取消未执行任务，已完成历史保留', () => {
    const store = newStore('sqlite');
    setupWork(store, 'w1', ['github', 'wechat']);
    const gh = store.listPlanTasks('w1').filter(t => t.platform_id === 'github')[0];
    store._planWriteTask(Object.assign({}, gh, { status: 'done' }));
    store.deletePlanStage('w1', 'ps_w1');
    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('done');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('cancelled');
  });

  it('手动发布流程不受影响：addPub 仍按 pub_key upsert', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    expect(store.listPubs()).toHaveLength(1);
  });

  it('模拟任务重新排队：只影响模拟任务，真实任务不受影响', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();

    const simulated = store.listPlanTasks('w1')[0];
    expect(simulated.simulated).toBe(1);

    // 真实任务不能被重新排队
    const realTask = { id: 'pt_ps_w1_youtube', stage_id: 'ps_w1', work_id: 'w1', platform_id: 'youtube', stage_seq: 0, stage_title: 'x', scheduled_at: '2026-01-01T00:00:00.000Z', status: 'done', started_at: '', finished_at: '', platform_ref: 'real', platform_url: '', error: '', note: '', pub_key: 'plan|w1|ps_w1|youtube', simulated: 0, created_at: '', updated_at: '' };
    store._planWriteTask(realTask);
    expect(store.requeueSimulatedPlanTask('w1', realTask.id).ok).toBe(false);
    expect(store.listPlanTasks('w1').filter(t => t.id === realTask.id)[0].status).toBe('done');

    // 模拟任务可以重新排队 → 进入「等待真实执行」：pending + real_only=1 + 模拟标识清零
    const r = store.requeueSimulatedPlanTask('w1', simulated.id);
    expect(r.ok).toBe(true);
    const after = store.listPlanTasks('w1').filter(t => t.id === simulated.id)[0];
    expect(after.status).toBe('pending');
    expect(after.simulated).toBe(0);
    expect(after.real_only).toBe(1);
    expect(after.platform_ref).toBe('');
    expect(after.note).toContain('由模拟任务重新排队');
    expect(after.history_note).toContain('原模拟结果');
  });

  it('重新排队校验归属：跨作品调用被拒绝', () => {
    const store = newStore('sqlite');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
    H.seedWork(store, 'w2', '作品二');

    const res = store.requeueSimulatedPlanTask('w2', tasks[0].id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });
});

/* ==================================================================
   T9 · 迁移保留既有数据
   ================================================================== */
describe('T9 · 新增迁移保留原有工作 / 发布记录 / 计划数据', () => {
  it('从 v7 升级到 v9：既有 works / pubs / plan 行全部保留', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);

    // 手动把库退回 v7（删掉 v8/v9 新增的列 + 改版本号），模拟"旧库升级"
    store.exec('ALTER TABLE plan_tasks DROP COLUMN simulated');
    store.exec('ALTER TABLE plan_tasks DROP COLUMN real_only');
    store.exec('ALTER TABLE plan_tasks DROP COLUMN history_note');
    store.run('PRAGMA user_version = 7');
    const beforeWorks = store.listWorks().length;
    const beforePubs = store.listPubs().length;
    const beforeStages = store.listPlanStages('w1').length;
    const beforeTasks = store.listPlanTasks('w1').length;

    const upgraded = newStore('sqlite');
    expect(upgraded.version).toBe(10);
    expect(upgraded.listWorks()).toHaveLength(beforeWorks);
    expect(upgraded.listPubs()).toHaveLength(beforePubs);
    expect(upgraded.listPlanStages('w1')).toHaveLength(beforeStages);
    expect(upgraded.listPlanTasks('w1')).toHaveLength(beforeTasks);
    // 历史任务默认不是模拟任务、也不处于等待真实执行（行为不变）
    expect(upgraded.listPlanTasks('w1')[0].simulated).toBe(0);
    expect(upgraded.listPlanTasks('w1')[0].real_only).toBe(0);
    expect(upgraded.listPlanTasks('w1')[0].history_note).toBe('');
  });

  it('重复迁移安全（多次实例化不会丢数据、不会重复加列）', () => {
    const store = newStore('sqlite');
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a')]);

    const again = newStore('sqlite');
    again.migrate();
    again.migrate();
    expect(again.listWorks()).toHaveLength(1);
    expect(again.listPlanStages('w1')).toHaveLength(1);
    const cols = again.all('PRAGMA table_info(plan_tasks)').map(c => c.name);
    expect(cols.filter(n => n === 'simulated')).toHaveLength(1);
    expect(cols.filter(n => n === 'real_only')).toHaveLength(1);
    expect(cols.filter(n => n === 'history_note')).toHaveLength(1);
  });

  it('JSON fallback 下同样保留既有数据', () => {
    const store = newStore('json');
    H.seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    store.savePlanStages('w1', [H.stage('ps_a')]);

    const reopened = newStore('json');
    expect(reopened.listWorks()).toHaveLength(1);
    expect(reopened.listPubs()).toHaveLength(1);
    expect(reopened.listPlanStages('w1')).toHaveLength(1);
    expect(reopened.listPlanTasks('w1')).toHaveLength(1);
    expect(reopened.listPlanTasks('w1')[0].simulated).toBe(0);
  });
});
