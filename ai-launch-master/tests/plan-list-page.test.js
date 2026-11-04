'use strict';

// Rokit · 任务 C：计划列表 / 详情 / 删除 页面定向测试
//
// 覆盖用户在「第二部分：完善计划管理页面」里提出的全部验证点：
//   P1  计划列表：作品标题、正文预览、目标平台、计划发布时间（含明确时区）、
//       当前状态、阶段数 / 任务数、创建 / 更新时间、操作入口
//   P2  计划详情：作品标题与正文、目标平台、每个平台各自的任务状态、
//       每项任务的计划执行时间、失败平台 / 错误原因 / 处理提示
//   P3  删除计划：明确的删除入口、必须确认、只删选中的那一份、
//       失败有明确提示、成功后刷新
//   P4  空状态与加载失败：只有真的没有计划才显示空状态（并给出创建入口与步骤），
//       读取失败必须显示错误与重试入口，绝不能显示成「没有计划」
//   P5  刷新与状态一致性：创建 / 编辑 / 删除后刷新；页面刷新或重启后
//       仍能从持久化数据恢复列表（不依赖前端内存里的临时数组）
//
// 跑的是生产代码：
//   - index.html 里切出来的页面函数（按花括号配平切出后注入依赖执行）
//   - electron/store.js（持久化 / 恢复用真实 SQLite 与 JSON 存储）
//
// 安全约束：全程不调用任何真实平台接口，也不读写用户的真实数据库。

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
function extractArray(src, name) {
  const re = new RegExp('var ' + name + '=\\[[\\s\\S]*?\\];');
  const m = re.exec(src);
  if (!m) throw new Error('找不到数组：' + name);
  return m[0];
}

const SRC = {
  platformMeta: extractBlock(HTML, 'function planPlatformMeta(pid){'),
  statusMeta: extractBlock(HTML, 'function planTaskStatusMeta(id,simulated,realOnly){'),
  failNotice: extractBlock(HTML, 'function planTaskFailureNotice(task,platformName){'),
  timeText: extractBlock(HTML, 'function planTaskTimeText(task){'),
  workName: extractBlock(HTML, 'function planTaskWorkName(task){'),
  pubArg: extractBlock(HTML, 'function pubArg(s){'),
  copyText: extractBlock(HTML, 'function planTaskCopyText(stage,pid,workId){'),
  localInput: extractBlock(HTML, 'function planLocalInput(iso){'),
  isoFromLocal: extractBlock(HTML, 'function planIsoFromLocal(v){'),
  taskDetailHtml: extractBlock(HTML, 'function planDetailTaskDetailHtml(workId,st,t,editing){'),
  taskHtml: extractBlock(HTML, 'function planDetailTaskHtml(workId,st,t,openTask,editTask){'),
  paintDetail: extractBlock(HTML, 'function paintPlanDetail(workId,stages,tasks){'),
  renderDetail: extractBlock(HTML, 'function renderWorkPlanDetail(){'),
  detailBack: extractBlock(HTML, 'window.planDetailBack=function(){'),
  detailToggle: extractBlock(HTML, 'window.planDetailToggle=function(stageId){'),
  detailOpen: extractBlock(HTML, 'window.planDetailOpen=function(taskId){'),
  detailEdit: extractBlock(HTML, 'window.planDetailEdit=function(taskId){'),
  detailSave: extractBlock(HTML, 'window.planDetailSave=function(workId,taskId){'),
  detailCancel: extractBlock(HTML, 'window.planDetailCancel=function(workId,taskId){'),
  schedBadge: extractBlock(HTML, 'function paintPlanSchedulerBadge(){'),
  storeInfo: extractBlock(HTML, 'function paintPlanStoreInfo(){'),
  renderCenter: extractBlock(HTML, 'function renderPlanCenter(){'),
  deleteConfirm: extractBlock(HTML, 'function planDeletePlanWithConfirm(workId,afterOk){'),
  centerDelete: extractBlock(HTML, 'window.planCenterDeletePlan=function(workId){'),
  detailDelete: extractBlock(HTML, 'window.planDetailDeletePlan=function(workId){'),
  detailCreate: extractBlock(HTML, 'window.planDetailCreatePlan=function(workId){'),
  statusArr: extractArray(HTML, 'PLAN_TASK_STATUS'),
  platsArr: extractArray(HTML, 'PLAN_PLATFORMS')
};

const SANDBOX_BODY = [
  SRC.statusArr, SRC.platsArr,
  SRC.platformMeta, SRC.statusMeta, SRC.failNotice, SRC.timeText, SRC.workName, SRC.pubArg,
  SRC.localInput, SRC.isoFromLocal, SRC.copyText,
  SRC.taskDetailHtml, SRC.taskHtml, SRC.paintDetail, SRC.renderDetail,
  SRC.detailBack, SRC.detailToggle, SRC.detailOpen, SRC.detailEdit, SRC.detailSave, SRC.detailCancel,
  SRC.schedBadge, SRC.storeInfo, SRC.renderCenter,
  SRC.deleteConfirm, SRC.centerDelete, SRC.detailDelete, SRC.detailCreate,
  // 沙箱里 window 是普通对象（不是真全局对象），
  // 生产代码里 window.planDetailBack 与裸标识 planDetailBack 等价，这里补一个同作用域别名。
  'var planDetailBack=window.planDetailBack;'
].join('\n');

/* ---------- 极简 DOM / 依赖桩 ---------- */
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

function buildSandbox(opts) {
  opts = opts || {};
  const dom = makeDom();
  const toasts = [];
  const routes = [];
  const confirms = [];
  const state = opts.state || {
    works: [],
    planView: { status: 'all', q: '', platform: 'all', sort: 'time_asc' },
    planCenterData: { stages: [], tasks: [] },
    planDetailWork: '', planDetailFrom: 'works',
    planDetailExpanded: {}, planDetailOpenTask: '', planDetailEditTask: '',
    copies: null, copiesOwner: '', planOwnerId: '', curWork: ''
  };
  const win = opts.window || { api: {} };
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  const toast = function (m, level) { toasts.push({ m: String(m), level: level || '' }); };
  const findWork = function (id) {
    return (state.works || []).filter(function (w) { return w && w.id === id; })[0] || null;
  };
  const go = function (r) { routes.push(r); };
  // confirmModal 可控：opts.confirm === false → 用户取消
  const confirmModal = function (cfg) {
    confirms.push(cfg || {});
    return Promise.resolve(opts.confirm !== false);
  };

  const fn = new Function(
    'state', 'window', 'document', 'esc', 'toast', 'findWork', 'go', 'confirmModal',
    SANDBOX_BODY +
    '\nreturn {renderPlanCenter:renderPlanCenter,paintPlanDetail:paintPlanDetail,' +
    'renderWorkPlanDetail:renderWorkPlanDetail,planDetailBack:window.planDetailBack,' +
    'planCenterDeletePlan:window.planCenterDeletePlan,' +
    'planDetailDeletePlan:window.planDetailDeletePlan,' +
    'planDetailCreatePlan:window.planDetailCreatePlan};'
  );
  const api = fn(state, win, dom.document, esc, toast, findWork, go, confirmModal);
  return {
    api: api, state: state, win: win, dom: dom,
    toasts: toasts, routes: routes, confirms: confirms, esc: esc
  };
}

/* ---------- 数据构造 ---------- */
function task(o) {
  return Object.assign({
    id: 'pt_ps_a_github',
    stage_id: 'ps_a',
    work_id: 'w1',
    platform_id: 'github',
    stage_seq: 0,
    stage_title: '阶段 A',
    scheduled_at: '2026-03-02T10:00:00.000Z',
    status: 'pending',
    started_at: '', finished_at: '',
    platform_ref: '', platform_url: '', error: '', note: '',
    pub_key: 'plan|w1|ps_a|github',
    simulated: 0, real_only: 0, history_note: '',
    pub_state: 'none', created_at: '', updated_at: ''
  }, o);
}
function stageRow(o) {
  return Object.assign({
    id: 'ps_a', work_id: 'w1', seq: 0, title: '阶段 A', desc: '',
    offset_days: 0, time_of_day: '20:00', platforms: ['github'], copy: {},
    created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z'
  }, o);
}

// 计划列表沙箱：一份计划（w1，含正文快照，两个平台）
function listSandbox(opts) {
  opts = opts || {};
  const sb = buildSandbox(opts);
  sb.state.works = [
    { id: 'w1', name: '作品甲', intro: '作品甲的简介' },
    { id: 'w2', name: '作品乙', intro: '作品乙的简介' }
  ];
  sb.win.api = {
    planAll: function () {
      return Promise.resolve({
        stages: [
          stageRow({
            id: 'ps_a', work_id: 'w1', seq: 0, title: 'DAY 0',
            platforms: ['github', 'wechat'],
            copy: { github: { title: '阶段标题', body: '这是真实保存的阶段正文' } },
            created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-03T00:00:00.000Z'
          })
        ],
        tasks: [
          task({ id: 't_gh', work_id: 'w1', platform_id: 'github', status: 'pending', scheduled_at: '2026-03-02T10:00:00.000Z' }),
          task({ id: 't_wx', work_id: 'w1', platform_id: 'wechat', status: 'done', scheduled_at: '2026-03-03T10:00:00.000Z', simulated: 1 })
        ]
      });
    },
    planDelete: function (workId) {
      (opts.deleteCalls || (opts.deleteCalls = [])).push(workId);
      return Promise.resolve(opts.deleteResult || { ok: true });
    }
  };
  return sb;
}
function listHtml(sb) {
  sb.api.renderPlanCenter();
  return new Promise(function (r) {
    setTimeout(function () { r(sb.dom.get('planCenterList').innerHTML); }, 0);
  });
}

/* ==================================================================
   P1 · 计划列表：每条计划都要有清晰、可辨认的信息
   ================================================================== */
describe('P1 · 计划列表展示每份计划的关键信息', () => {
  it('列表容器存在（有计划时不会出现"只有说明文字"的空页面）', () => {
    expect(HTML).toContain('id="planCenterList"');
    expect(HTML).toContain('id="planCenterListSub"');
  });

  it('列表按作品聚合出计划卡片，每份计划一个卡片', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect((html.match(/class="plancard"/g) || []).length).toBe(1);
    expect(html).toContain('data-plan-work="w1"');
    expect(sb.dom.get('planCenterListSub').textContent).toContain('共 1 份计划');
  });

  it('展示真实作品标题（不是编造的文案）', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('作品甲');
    // 卡片标题就是作品名
    const m = /class="plancard-title"[^>]*>([^<]*)</.exec(html);
    expect(m).toBeTruthy();
    expect(m[1]).toBe('作品甲');
  });

  it('正文预览来自实际保存的阶段文案快照，并标注来源', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('这是真实保存的阶段正文');
    expect(html).toContain('正文来源：GitHub');
  });

  it('正文预览不是标题（正文不会被当成标题显示）', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    const titleM = /class="plancard-title"[^>]*>([^<]*)</.exec(html);
    expect(titleM[1]).not.toContain('这是真实保存的阶段正文');
    // 正文出现在 plancard-body 区块里
    expect(/class="plancard-body[^"]*"[^>]*>[^<]*这是真实保存的阶段正文/.test(html)).toBe(true);
  });

  it('没有阶段文案快照时退回作品简介，并标注来源是「作品简介」', async () => {
    const sb = listSandbox();
    sb.win.api.planAll = function () {
      return Promise.resolve({
        stages: [stageRow({ id: 'ps_a', work_id: 'w1', copy: {} })],
        tasks: [task({ work_id: 'w1' })]
      });
    };
    const html = await listHtml(sb);
    expect(html).toContain('作品甲的简介');
    expect(html).toContain('正文来源：作品简介');
  });

  it('展示目标平台（各阶段选择的平台并集）', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('目标平台：');
    expect(html).toContain('GitHub');
    expect(html).toContain('微信公众号');
  });

  it('展示计划发布时间，并带明确时区标注', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('计划发布时间：');
    // 时间文本带 UTC 偏移（形如 (UTC+08:00)）
    expect(/计划发布时间：[^<]*\(UTC[+-]\d{2}:\d{2}\)/.test(html)).toBe(true);
  });

  it('展示当前状态（含状态明细）', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('class="ps-badge"');
    // 状态明细串把各状态条数列出来
    expect(html).toContain('待执行 1');
    expect(html).toContain('已完成（模拟） 1');
  });

  it('不同任务状态汇总成正确的计划状态', async () => {
    const cases = [
      { tasks: [{ status: 'running' }, { status: 'pending' }], label: '执行中' },
      { tasks: [{ status: 'needs_review' }], label: '待人工核实' },
      { tasks: [{ status: 'failed' }, { status: 'done' }], label: '部分失败' },
      { tasks: [{ status: 'pending' }], label: '待发送' },
      { tasks: [{ status: 'done' }, { status: 'done' }], label: '成功' }
    ];
    for (const c of cases) {
      const sb = listSandbox();
      sb.win.api.planAll = function () {
        return Promise.resolve({
          stages: [stageRow({ id: 'ps_a', work_id: 'w1', platforms: c.tasks.map((_, i) => (i ? 'wechat' : 'github')) })],
          tasks: c.tasks.map((t, i) => task({ id: 't' + i, work_id: 'w1', platform_id: i ? 'wechat' : 'github', status: t.status }))
        });
      };
      const html = await listHtml(sb);
      expect(html).toContain('>' + c.label + '<');
    }
  });

  it('展示阶段数、任务数、创建时间与更新时间', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('1 个阶段');
    expect(html).toContain('2 条任务');
    expect(html).toContain('更新于 ');
    expect(html).toContain('创建于 ');
    // 创建 / 更新时间同样带时区
    expect(/更新于 [^<]*\(UTC[+-]\d{2}:\d{2}\)/.test(html)).toBe(true);
  });

  it('提供操作入口：查看详情 + 删除计划', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).toContain('查看详情');
    expect(html).toContain('删除计划');
    // pubArg 走 JSON.stringify + 转义：work_id 用双引号包裹并转义为 &quot;
    expect(html).toContain('openWorkPlan(&quot;w1&quot;');
    expect(html).toContain('planCenterDeletePlan(&quot;w1&quot;');
  });

  it('作品已被删除时明确说明，不会编造作品标题', async () => {
    const sb = listSandbox();
    sb.state.works = [{ id: 'w2', name: '作品乙', intro: '' }];
    const html = await listHtml(sb);
    expect(html).toContain('（作品已删除：w1）');
  });
});

/* ==================================================================
   P2 · 计划详情
   ================================================================== */
describe('P2 · 计划详情展示正文、逐平台状态与失败提示', () => {
  function detailSandbox() {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品甲', intro: '作品甲的简介' }];
    sb.state.planDetailWork = 'w1';
    sb.state.planDetailExpanded = { ps_a: true };
    sb.win.api = {
      planList: function () {
        return Promise.resolve({
          stages: [stageRow({
            id: 'ps_a', work_id: 'w1', platforms: ['github', 'wechat'],
            copy: { github: { title: '阶段标题', body: '这是真实保存的阶段正文' } }
          })],
          tasks: [
            task({ id: 't_gh', platform_id: 'github', status: 'pending' }),
            task({ id: 't_wx', platform_id: 'wechat', status: 'failed', error: '授权失效', simulated: 1 })
          ]
        });
      },
      planDelete: function () { return Promise.resolve({ ok: true }); }
    };
    return sb;
  }

  it('详情展示作品标题、正文与目标平台', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('作品甲 的发布计划');
    expect(html).toContain('这是真实保存的阶段正文');
    expect(html).toContain('正文来源：GitHub');
    expect(html).toContain('目标平台：');
    expect(html).toContain('GitHub');
    expect(html).toContain('微信公众号');
  });

  it('详情展示阶段数 / 任务数 / 未执行数', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.dom.get('planDetailCount').textContent).toContain('1 个阶段');
    expect(sb.dom.get('planDetailCount').textContent).toContain('2 条任务');
    expect(sb.dom.get('planDetailCount').textContent).toContain('1 条未执行');
  });

  it('多平台分别展示各自的任务状态', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect((html.match(/pd-task-plat/g) || []).length).toBe(2);
    expect(html).toContain('GitHub');
    expect(html).toContain('微信公众号');
    expect(html).toContain('待执行');
    expect(html).toContain('执行失败');
  });

  it('每项任务都显示自己的计划执行时间（带时区）', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect((html.match(/计划执行：/g) || []).length).toBe(2);
    expect(/计划执行：[^<]*\(UTC[+-]\d{2}:\d{2}\)/.test(html)).toBe(true);
  });

  it('失败平台显示失败原因与处理提示', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('微信公众号：发送失败');
    expect(html).toContain('授权失效');
    expect(html).toContain('系统不会自动重试');
  });

  it('needs_review 明确提示先核实平台是否已收到内容，且系统不会自动重发', async () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品甲', intro: '' }];
    sb.state.planDetailExpanded = { ps_a: true };
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', work_id: 'w1', platforms: ['github'] })],
      [task({ id: 't_rev', platform_id: 'github', status: 'needs_review', error: '连接中断' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('结果未知，需人工核实');
    expect(html).toContain('核实内容是否已经收到');
    expect(html).toContain('系统不会自动重发');
  });

  it('详情里也有删除入口', async () => {
    const sb = detailSandbox();
    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('删除这份计划');
    expect(html).toContain("planDetailDeletePlan('w1'");
  });
});

/* ==================================================================
   P3 · 删除计划
   ================================================================== */
describe('P3 · 删除计划：入口、确认、只删选中的那份、失败有提示', () => {
  it('删除前必须经过用户确认', async () => {
    const sb = listSandbox();
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.confirms.length).toBe(1);
    expect(sb.confirms[0].title).toContain('删除发布计划');
    expect(String(sb.confirms[0].body)).toContain('作品甲');
    expect(sb.confirms[0].danger).toBe(true);
  });

  it('用户取消时不调用删除接口', async () => {
    const opts = { confirm: false };
    const sb = listSandbox(opts);
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(opts.deleteCalls).toBeUndefined();
    expect(sb.toasts.some(t => t.m.indexOf('计划已删除') >= 0)).toBe(false);
  });

  it('确认后只删除用户选中的那一份计划', async () => {
    const opts = {};
    const sb = listSandbox(opts);
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(opts.deleteCalls).toEqual(['w1']);
  });

  it('删除成功后提示并刷新列表', async () => {
    const opts = {};
    const sb = listSandbox(opts);
    let allCalls = 0;
    const orig = sb.win.api.planAll;
    sb.win.api.planAll = function () { allCalls++; return orig(); };
    await listHtml(sb);                            // 先渲染一次（基线）
    const base = allCalls;
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.toasts.some(t => t.m.indexOf('计划已删除') >= 0)).toBe(true);
    expect(allCalls).toBeGreaterThan(base);        // 删完重新读了一次列表
  });

  it('后端拒绝删除时提示原因，不会显示成功', async () => {
    const opts = { deleteResult: { ok: false, error: '这个计划还有正在执行的任务' } };
    const sb = listSandbox(opts);
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.toasts.some(t => t.m.indexOf('删除失败') >= 0)).toBe(true);
    expect(sb.toasts.some(t => t.m.indexOf('正在执行') >= 0)).toBe(true);
    expect(sb.toasts.some(t => t.m.indexOf('计划已删除') >= 0)).toBe(false);
  });

  it('删除调用异常时同样提示失败', async () => {
    const sb = listSandbox();
    sb.win.api.planDelete = function () { return Promise.reject(new Error('IPC 断了')); };
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.toasts.some(t => t.m.indexOf('删除失败') >= 0)).toBe(true);
  });

  it('详情页删除成功后回到来源页并刷新列表', async () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品甲', intro: '' }];
    sb.state.planDetailWork = 'w1';
    sb.state.planDetailFrom = 'plans';
    let allCalls = 0;
    sb.win.api = {
      planAll: function () { allCalls++; return Promise.resolve({ stages: [], tasks: [] }); },
      planDelete: function () { return Promise.resolve({ ok: true }); }
    };
    sb.api.planDetailDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.toasts.some(t => t.m.indexOf('计划已删除') >= 0)).toBe(true);
    expect(sb.routes[sb.routes.length - 1]).toBe('plans');
    expect(allCalls).toBeGreaterThan(0);
  });

  it('没有 planDelete 能力时明确提示，而不是静默失败', async () => {
    const sb = listSandbox();
    sb.win.api.planDelete = undefined;
    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.toasts.some(t => t.m.indexOf('不支持删除计划') >= 0)).toBe(true);
  });
});

/* ==================================================================
   P4 · 空状态与加载失败
   ================================================================== */
describe('P4 · 空状态与读取失败的表现', () => {
  it('确实没有已保存计划时才显示空状态，并给出创建入口与步骤', async () => {
    const sb = listSandbox();
    sb.win.api.planAll = function () { return Promise.resolve({ stages: [], tasks: [] }); };
    const html = await listHtml(sb);
    expect(html).toContain('还没有任何已保存的发布计划');
    expect(html).toContain('创建步骤');
    expect(html).toContain("go('works')");
    expect(html).toContain('去「我的作品」创建计划');
  });

  it('有已保存计划时不显示空状态', async () => {
    const sb = listSandbox();
    const html = await listHtml(sb);
    expect(html).not.toContain('还没有任何已保存的发布计划');
  });

  it('只有历史任务、没有阶段配置的作品不算一份计划（不算「有计划」）', async () => {
    const sb = listSandbox();
    sb.win.api.planAll = function () {
      return Promise.resolve({
        stages: [],
        tasks: [task({ work_id: 'w1', status: 'done' })]
      });
    };
    const html = await listHtml(sb);
    expect(html).toContain('还没有任何已保存的发布计划');
  });

  it('列表读取失败时显示错误与重试入口，绝不显示成「没有计划」', async () => {
    const sb = listSandbox();
    sb.win.api.planAll = function () { return Promise.reject(new Error('读库失败')); };
    const html = await listHtml(sb);
    expect(html).toContain('读取发布计划失败');
    expect(html).toContain('读库失败');
    expect(html).toContain('重试');
    expect(html).not.toContain('还没有任何已保存的发布计划');
    // 明确说明这是读取错误，不代表没有计划
    expect(html).toContain('不代表没有计划');
  });

  it('当前环境不支持读取计划时给出明确说明', async () => {
    const sb = listSandbox();
    sb.win.api = {};
    sb.api.renderPlanCenter();
    const html = sb.dom.get('planCenterList').innerHTML;
    expect(html).toContain('当前环境不支持读取发布计划');
  });
});

/* ==================================================================
   P5 · 刷新与状态一致性
   ================================================================== */
describe('P5 · 刷新与状态一致性（不依赖前端内存数组）', () => {
  let tmpDir, restoreBlock = null;
  beforeEach(() => {
    tmpDir = H.makeTmpDir();
  });
  afterEach(() => {
    if (restoreBlock) { restoreBlock(); restoreBlock = null; }
    H.rmTmpDir(tmpDir);
    const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
    delete require.cache[id];
  });
  function newStore(file) {
    const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
    delete require.cache[id];
    restoreBlock = H.installDriverBlock(false);
    const { Store } = require(path.join(H.ROOT, 'electron', 'store'));
    return new Store(file || path.join(tmpDir, 'test.db'));
  }

  it('每次进入列表都重新从后端读取（不使用前端缓存的旧数据）', async () => {
    const sb = listSandbox();
    let allCalls = 0;
    const orig = sb.win.api.planAll;
    sb.win.api.planAll = function () { allCalls++; return orig(); };
    await listHtml(sb);
    await listHtml(sb);
    expect(allCalls).toBe(2);
  });

  it('任务状态变化后重新渲染能显示最新状态', async () => {
    const sb = listSandbox();
    await listHtml(sb);
    expect(sb.dom.get('planCenterList').innerHTML).toContain('待发送');

    // 模拟调度器把任务推进到"待人工核实"
    sb.win.api.planAll = function () {
      return Promise.resolve({
        stages: [stageRow({ id: 'ps_a', work_id: 'w1', platforms: ['github'] })],
        tasks: [task({ work_id: 'w1', status: 'needs_review' })]
      });
    };
    const html = await listHtml(sb);
    expect(html).toContain('待人工核实');
    expect(html).not.toContain('>待发送<');
  });

  it('删除后重新读取，列表里不再有这份计划（持久化生效）', async () => {
    const dbFile = path.join(tmpDir, 'persist.db');
    const store = newStore(dbFile);
    H.seedWork(store, 'w1', '作品甲');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    expect(store.listPlanStages('w1')).toHaveLength(1);

    const sb = listSandbox();
    sb.win.api.planAll = function () {
      return Promise.resolve({ stages: store.listAllPlanStages(), tasks: store.listPlanTasks('') });
    };
    sb.win.api.planDelete = function () { return Promise.resolve(store.deletePlan('w1')); };
    sb.state.works = [{ id: 'w1', name: '作品甲', intro: '作品甲的简介' }];

    const before = await listHtml(sb);
    expect(before).toContain('作品甲');

    sb.api.planCenterDeletePlan('w1');
    await new Promise(function (r) { setTimeout(r, 0); });
    await new Promise(function (r) { setTimeout(r, 0); });

    const after = await listHtml(sb);
    expect(after).toContain('还没有任何已保存的发布计划');
    // 重新打开数据库仍然是删除状态
    const reopened = newStore(dbFile);
    expect(reopened.listPlanStages('w1')).toHaveLength(0);
  });

  it('页面刷新（重新加载）后仍能从持久化数据恢复列表', async () => {
    const dbFile = path.join(tmpDir, 'reload.db');
    const store = newStore(dbFile);
    H.seedWork(store, 'w1', '作品甲');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);

    const reopened = newStore(dbFile);
    // 模拟"刷新页面"：全新沙箱 + 只从后端读取数据
    const sb = listSandbox();
    sb.state.works = [{ id: 'w1', name: '作品甲', intro: '作品甲的简介' }];
    sb.win.api.planAll = function () {
      return Promise.resolve({ stages: reopened.listAllPlanStages(), tasks: reopened.listPlanTasks('') });
    };
    const html = await listHtml(sb);
    expect(html).toContain('作品甲');
    expect(html).toContain('1 个阶段');
    expect(html).toContain('1 条任务');
    expect(html).not.toContain('还没有任何已保存的发布计划');
  });

  it('进入「发布计划」页会启动自动刷新（状态变化能自动跟上）', () => {
    expect(HTML).toContain("if(r==='plans'){renderPlanCenter();planStartAutoRefresh();}");
    expect(HTML).toContain('function planStartAutoRefresh(){');
  });
});
