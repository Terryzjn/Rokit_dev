'use strict';

// Rokit · 第二阶段：计划管理页面定向测试
//
// 覆盖用户要求的全部页面验证点：
//   M1  全局入口和单作品入口均能正确打开
//   M2  多个作品的计划互不串数据
//   M3  搜索作品标题有效
//   M4  平台、状态筛选有效
//   M5  时间排序正确
//   M6  详情页按 DAY 分组
//   M7  同一阶段的多个平台具有独立状态
//   M8  查看文案不会触发文案重新生成或网络请求
//   M9  编辑未执行任务后，任务时间和配置正确持久化
//   M10 编辑已完成任务不会改写成功历史
//   M11 取消任务后重启仍然保持取消状态
//   M12 页面保存失败时有正确提示
//   M13 从详情返回列表时能保留合理的上下文
//   M14 空列表 / 读取失败有明确提示
//
// 跑的是生产代码：
//   - index.html 里切出来的页面函数（按花括号配平切出后注入依赖执行）
//   - electron/store.js（持久化断言用真实 SQLite / JSON 存储）

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
  openWorkPlan: extractBlock(HTML, 'window.openWorkPlan=function(workId,from,opts){'),
  detailBack: extractBlock(HTML, 'window.planDetailBack=function(){'),
  detailToggle: extractBlock(HTML, 'window.planDetailToggle=function(stageId){'),
  detailOpen: extractBlock(HTML, 'window.planDetailOpen=function(taskId){'),
  detailEdit: extractBlock(HTML, 'window.planDetailEdit=function(taskId){'),
  detailSave: extractBlock(HTML, 'window.planDetailSave=function(workId,taskId){'),
  detailCancel: extractBlock(HTML, 'window.planDetailCancel=function(workId,taskId){'),
  renderDetail: extractBlock(HTML, 'function renderWorkPlanDetail(){'),
  paintDetail: extractBlock(HTML, 'function paintPlanDetail(workId,stages,tasks){'),
  taskHtml: extractBlock(HTML, 'function planDetailTaskHtml(workId,st,t,openTask,editTask){'),
  taskDetailHtml: extractBlock(HTML, 'function planDetailTaskDetailHtml(workId,st,t,editing){'),
  copyText: extractBlock(HTML, 'function planTaskCopyText(stage,pid,workId){'),
  localInput: extractBlock(HTML, 'function planLocalInput(iso){'),
  isoFromLocal: extractBlock(HTML, 'function planIsoFromLocal(v){'),
  renderCenter: extractBlock(HTML, 'function renderPlanCenter(){'),
  schedBadge: extractBlock(HTML, 'function paintPlanSchedulerBadge(){'),
  storeInfo: extractBlock(HTML, 'function paintPlanStoreInfo(){'),
  statusArr: extractArray(HTML, 'PLAN_TASK_STATUS'),
  platsArr: extractArray(HTML, 'PLAN_PLATFORMS')
};

const SANDBOX_BODY = [
  SRC.statusArr, SRC.platsArr,
  SRC.platformMeta, SRC.statusMeta, SRC.failNotice, SRC.timeText, SRC.workName, SRC.pubArg,
  SRC.localInput, SRC.isoFromLocal, SRC.copyText,
  SRC.taskDetailHtml, SRC.taskHtml, SRC.paintDetail, SRC.renderDetail,
  SRC.openWorkPlan, SRC.detailBack, SRC.detailToggle, SRC.detailOpen, SRC.detailEdit,
  SRC.detailSave, SRC.detailCancel,
  SRC.schedBadge, SRC.storeInfo, SRC.renderCenter
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
  const state = opts.state || {
    works: [],
    planView: { status: 'all', q: '', platform: 'all', sort: 'time_asc' },
    planCenterData: { stages: [], tasks: [] },
    planDetailWork: '', planDetailFrom: 'works',
    planDetailExpanded: { ps_a: true, ps_b: true }, planDetailOpenTask: '', planDetailEditTask: '',
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
  const confirmModal = function () { return Promise.resolve(opts.confirm !== false); };

  const fn = new Function(
    'state', 'window', 'document', 'esc', 'toast', 'findWork', 'go', 'confirmModal',
    SANDBOX_BODY +
    '\nreturn {openWorkPlan:window.openWorkPlan,planDetailBack:window.planDetailBack,' +
    'planDetailToggle:window.planDetailToggle,planDetailOpen:window.planDetailOpen,' +
    'planDetailEdit:window.planDetailEdit,planDetailSave:window.planDetailSave,' +
    'planDetailCancel:window.planDetailCancel,renderWorkPlanDetail:renderWorkPlanDetail,' +
    'paintPlanDetail:paintPlanDetail,renderPlanCenter:renderPlanCenter,' +
    'planLocalInput:planLocalInput,planIsoFromLocal:planIsoFromLocal,' +
    'planTaskCopyText:planTaskCopyText};'
  );
  const api = fn(state, win, dom.document, esc, toast, findWork, go, confirmModal);
  return { api: api, state: state, win: win, dom: dom, toasts: toasts, routes: routes, esc: esc };
}

/* ---------- 数据构造 ---------- */
function task(o) {
  return Object.assign({
    id: 'pt_ps_a_' + (o.platform_id || 'github'),
    stage_id: 'ps_a',
    work_id: 'w1',
    platform_id: 'github',
    stage_seq: 0,
    stage_title: '阶段 A',
    scheduled_at: '2026-01-01T12:00:00.000Z',
    status: 'pending',
    started_at: '', finished_at: '',
    platform_ref: '', platform_url: '', error: '', note: '',
    pub_key: '', pub_state: 'none', created_at: '', updated_at: ''
  }, o);
}
function stageRow(o) {
  return Object.assign({
    id: 'ps_a', work_id: 'w1', seq: 0, title: '阶段 A', desc: '',
    offset_days: 0, time_of_day: '20:00', platforms: ['github'], copy: {},
    created_at: '', updated_at: ''
  }, o);
}

/* ==================================================================
   M1 · 入口
   ================================================================== */
describe('M1 · 全局入口和单作品入口均能正确打开', () => {
  it('「我的作品」里有全局「发布计划」入口（不新增一级导航）', () => {
    expect(HTML).toContain('id="openPlanCenterBtn"');
    expect(HTML).toContain('onclick="openPlanCenter()"');
    const navStart = HTML.indexOf('<div class="navtab">');
    const nav = HTML.slice(navStart, HTML.indexOf('</div>', navStart));
    expect((nav.match(/<button/g) || []).length).toBe(4);
  });

  it('每个作品卡片都有「查看计划」入口，且显式携带 work_id', () => {
    expect(HTML).toContain('openWorkPlan(');
    expect(HTML).toContain('📋 查看计划');
    expect(HTML).toContain("openWorkPlan('+pubArg(w.id)+',\\'works\\')");
  });

  it('点击作品计划入口会带上正确的 work_id（不依赖页面残留状态）', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }];
    sb.state.curWork = 'w1';                       // 页面残留状态是 w1
    sb.api.openWorkPlan('w2', 'works');

    expect(sb.state.planDetailWork).toBe('w2');   // 用的是显式传入的 ID
    expect(sb.routes[sb.routes.length - 1]).toBe('plandetail');
  });

  it('作品不存在时提示错误，不会跳转到空页面', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.openWorkPlan('nope', 'works');
    expect(sb.routes).toHaveLength(0);
    expect(sb.toasts.some(t => t.m.indexOf('作品不存在') >= 0)).toBe(true);
  });

  it('缺少作品 ID 时提示错误', () => {
    const sb = buildSandbox();
    sb.api.openWorkPlan('', 'works');
    expect(sb.routes).toHaveLength(0);
    expect(sb.toasts.length).toBeGreaterThan(0);
  });
});

/* ==================================================================
   M2 · 作品隔离
   ================================================================== */
describe('M2 · 多个作品的计划互不串数据', () => {
  it('详情页只展示当前作品的阶段与任务', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }];
    sb.win.api = {
      planList: function (workId) {
        if (workId === 'w1') {
          return Promise.resolve({
            stages: [stageRow({ id: 'ps_a', title: '作品一阶段' })],
            tasks: [task({ id: 'pt_ps_a_github', work_id: 'w1' })]
          });
        }
        return Promise.resolve({
          stages: [stageRow({ id: 'ps_b', title: '作品二阶段', seq: 0 })],
          tasks: [task({ id: 'pt_ps_b_github', stage_id: 'ps_b', work_id: 'w2' })]
        });
      }
    };
    sb.state.planDetailWork = 'w1';
    sb.api.renderWorkPlanDetail();

    return Promise.resolve().then(function () {
      return new Promise(function (r) { setTimeout(r, 0); });
    }).then(function () {
      const html = sb.dom.get('planDetailBody').innerHTML;
      expect(html).toContain('作品一阶段');
      expect(html).not.toContain('作品二阶段');
    });
  });

  it('打开不同作品时不会串用上一个作品的展开状态', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }];
    sb.api.openWorkPlan('w1', 'works', { stageId: 'ps_a' });
    expect(sb.state.planDetailExpanded.ps_a).toBe(true);
    sb.api.openWorkPlan('w2', 'works');
    expect(Object.keys(sb.state.planDetailExpanded)).toHaveLength(0);
    expect(sb.state.planDetailOpenTask).toBe('');
  });
});

/* ==================================================================
   M3 / M4 / M5 · 全局列表：搜索、筛选、排序
   ================================================================== */
function centerSandbox() {
  const sb = buildSandbox();
  sb.state.works = [{ id: 'w1', name: '作品甲' }, { id: 'w2', name: '作品乙' }];
  sb.win.api = {
    planAll: function () {
      return Promise.resolve({
        stages: [stageRow({ id: 'ps_a' }), stageRow({ id: 'ps_b', seq: 1 })],
        tasks: [
          task({ id: 't1', work_id: 'w1', stage_id: 'ps_a', platform_id: 'github', scheduled_at: '2026-03-02T10:00:00.000Z', stage_title: '甲阶段' }),
          task({ id: 't2', work_id: 'w2', stage_id: 'ps_b', platform_id: 'wechat', scheduled_at: '2026-03-01T10:00:00.000Z', stage_title: '乙阶段', status: 'done' }),
          task({ id: 't3', work_id: 'w2', stage_id: 'ps_b', platform_id: 'youtube', scheduled_at: '2026-03-03T10:00:00.000Z', stage_title: '乙阶段', status: 'failed' })
        ]
      });
    }
  };
  return sb;
}
function centerHtml(sb) {
  sb.api.renderPlanCenter();
  return new Promise(function (r) { setTimeout(function () { r(sb.dom.get('planCenterTable').innerHTML); }, 0); });
}

describe('M3 · 搜索作品标题有效', () => {
  it('按作品标题搜索只留下命中的任务', async () => {
    const sb = centerSandbox();
    sb.state.planView.q = '作品乙';
    const html = await centerHtml(sb);
    expect(html).toContain('作品乙');
    expect(html).not.toContain('作品甲');
  });

  it('清空搜索条件后恢复全部', async () => {
    const sb = centerSandbox();
    sb.state.planView.q = '作品乙';
    await centerHtml(sb);
    sb.state.planView.q = '';
    const html = await centerHtml(sb);
    expect(html).toContain('作品甲');
    expect(html).toContain('作品乙');
  });
});

describe('M4 · 平台、状态筛选有效', () => {
  it('按平台筛选只留下该平台的任务', async () => {
    const sb = centerSandbox();
    sb.state.planView.platform = 'youtube';
    const html = await centerHtml(sb);
    expect(html).toContain('YouTube');
    expect(html).not.toContain('GitHub');
  });

  it('按状态筛选只留下该状态的任务', async () => {
    const sb = centerSandbox();
    sb.state.planView.status = 'done';
    const html = await centerHtml(sb);
    expect(html).toContain('已完成');
    expect(html).not.toContain('执行失败');
  });

  it('筛选不会改变数据库里的任务状态（纯前端过滤）', async () => {
    const sb = centerSandbox();
    sb.state.planView.status = 'done';
    await centerHtml(sb);
    expect(sb.state.planCenterData.tasks.length).toBe(3);
    expect(sb.state.planCenterData.tasks.filter(t => t.status === 'done')).toHaveLength(1);
  });

  it('重置筛选恢复默认条件', () => {
    const sb = centerSandbox();
    sb.state.planView = { status: 'done', q: '作品乙', platform: 'youtube', sort: 'time_desc' };
    // 直接调用页面上的筛选函数（生产代码）
    const filterSrc = extractBlock(HTML, 'window.planCenterFilter=function(name,val){');
    const fn = new Function('state', 'window', 'renderPlanCenter', filterSrc + '\nreturn window.planCenterFilter;');
    const f = fn(sb.state, {}, function () {});
    f('reset', '');
    expect(sb.state.planView).toEqual({ status: 'all', q: '', platform: 'all', sort: 'time_asc' });
  });
});

describe('M5 · 时间排序正确', () => {
  function sortSandbox() {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.win.api = {
      planAll: function () {
        return Promise.resolve({
          stages: [stageRow({ id: 'ps_a' })],
          tasks: [
            task({ id: 's1', stage_title: '早行', scheduled_at: '2026-03-01T10:00:00.000Z' }),
            task({ id: 's2', stage_title: '中行', scheduled_at: '2026-03-02T10:00:00.000Z' }),
            task({ id: 's3', stage_title: '晚行', scheduled_at: '2026-03-03T10:00:00.000Z' })
          ]
        });
      }
    };
    return sb;
  }
  it('升序按计划执行时间从早到晚', async () => {
    const sb = sortSandbox();
    sb.state.planView.sort = 'time_asc';
    const html = await centerHtml(sb);
    expect(html.indexOf('早行')).toBeLessThan(html.indexOf('中行'));
    expect(html.indexOf('中行')).toBeLessThan(html.indexOf('晚行'));
  });

  it('降序按计划执行时间从晚到早', async () => {
    const sb = sortSandbox();
    sb.state.planView.sort = 'time_desc';
    const html = await centerHtml(sb);
    expect(html.indexOf('晚行')).toBeLessThan(html.indexOf('中行'));
    expect(html.indexOf('中行')).toBeLessThan(html.indexOf('早行'));
  });

  it('排序只影响展示顺序，不改任务状态', async () => {
    const sb = centerSandbox();
    sb.state.planView.sort = 'time_desc';
    await centerHtml(sb);
    expect(sb.state.planCenterData.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('已完成 / 已取消的任务仍然出现在全局列表里（历史不隐藏）', async () => {
    const sb = centerSandbox();
    sb.state.planView.sort = 'time_asc';
    const html = await centerHtml(sb);
    expect(html).toContain('已完成');
    expect(html).toContain('执行失败');
    // 只有那条「待执行」的任务才有取消入口（已完成 / 执行失败都没有）
    expect((html.match(/planCenterCancelTask/g) || []).length).toBe(1);
  });
});

/* ==================================================================
   M6 / M7 · 作品计划详情
   ================================================================== */
describe('M6 · 详情页按 DAY 分组', () => {
  it('按阶段序号展示 DAY 0 / DAY 1，并显示偏移天数与时刻', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0, title: '第一阶段', offset_days: 1, time_of_day: '09:30' }),
       stageRow({ id: 'ps_b', seq: 1, title: '第二阶段', offset_days: 3, time_of_day: '21:00' })],
      [task({ id: 't1', stage_id: 'ps_a' }), task({ id: 't2', stage_id: 'ps_b' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html.indexOf('DAY 0')).toBeGreaterThan(-1);
    expect(html.indexOf('DAY 1')).toBeGreaterThan(-1);
    expect(html.indexOf('DAY 0')).toBeLessThan(html.indexOf('DAY 1'));
    expect(html).toContain('第一阶段');
    expect(html).toContain('+1 天');
    expect(html).toContain('09:30');
    expect(html).toContain('+3 天');
    expect(html).toContain('21:00');
  });

  it('展示该阶段是否仍有未执行任务', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0 })],
      [task({ id: 't1', status: 'pending' }), task({ id: 't2', platform_id: 'wechat', status: 'done' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('还有 1 个未执行任务');
  });

  it('没有阶段时给出明确提示', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1', [], []);
    expect(sb.dom.get('planDetailBody').innerHTML).toContain('还没有保存过发布计划');
  });
});

describe('M7 · 同一阶段的多个平台具有独立状态', () => {
  it('每个平台单独显示自己的状态，不合并成一个阶段状态', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0, platforms: ['github', 'wechat'] })],
      [task({ id: 't1', platform_id: 'github', status: 'done', finished_at: '2026-01-01T12:00:00.000Z' }),
       task({ id: 't2', platform_id: 'wechat', status: 'pending' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('GitHub');
    expect(html).toContain('微信公众号');
    expect(html).toContain('已完成');
    expect(html).toContain('待执行');
    // 状态是分平台展示的（两行任务）
    expect((html.match(/pd-task-plat/g) || []).length).toBe(2);
  });

  it('展开任务详情后显示计划时间与真实存在的时间 / 平台字段', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.planDetailOpenTask = 't1';
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0 })],
      [task({ id: 't1', status: 'done', started_at: '2026-01-01T11:00:00.000Z', finished_at: '2026-01-01T12:00:00.000Z', platform_ref: 'mock:github:t1' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('实际开始');
    expect(html).toContain('实际结束');
    expect(html).toContain('mock:github:t1');
    // 没有真实链接时不显示"发布链接"
    expect(html).not.toContain('发布链接');
  });

  it('尚未执行的任务显示「待执行」与计划时间，不显示开始 / 结束时间', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.planDetailOpenTask = 't1';
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0 })],
      [task({ id: 't1', status: 'pending' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('待执行');
    expect(html).toContain('计划执行时间');
    expect(html).not.toContain('实际开始');
    expect(html).not.toContain('实际结束');
    expect(html).not.toContain('平台返回 ID');
  });
});

/* ==================================================================
   M8 · 查看文案不触发生成
   ================================================================== */
describe('M8 · 查看文案不会触发文案重新生成或网络请求', () => {
  it('文案读取代码里没有任何生成 / 网络调用', () => {
    expect(SRC.copyText).not.toMatch(/genAll|genCopy|fetch|axios|XMLHttpRequest/i);
    expect(SRC.taskDetailHtml).not.toMatch(/genAll|genCopy|fetch|axios/i);
  });

  it('展示的是该阶段保存的文案快照（只读）', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.planDetailOpenTask = 't1';
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0, copy: { github: { title: '阶段标题', body: '阶段正文' } } })],
      [task({ id: 't1' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('阶段标题');
    expect(html).toContain('阶段正文');
  });

  it('属于其它作品的 state.copies 不会被展示', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.copies = { github: { title: '别的作品的标题', body: '别的作品正文' } };
    sb.state.copiesOwner = 'w2';
    sb.state.planDetailOpenTask = 't1';
    sb.api.paintPlanDetail('w1', [stageRow({ id: 'ps_a', seq: 0 })], [task({ id: 't1' })]);
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).not.toContain('别的作品的标题');
    expect(html).toContain('没有保存这个平台的发布文案');
  });

  it('属于当前作品的 state.copies 可以展示', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.copies = { github: { title: '我的标题', body: '我的正文' } };
    sb.state.copiesOwner = 'w1';
    sb.state.planDetailOpenTask = 't1';
    sb.api.paintPlanDetail('w1', [stageRow({ id: 'ps_a', seq: 0 })], [task({ id: 't1' })]);
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('我的标题');
  });
});

/* ==================================================================
   M9 / M10 · 编辑
   ================================================================== */
describe('M9 · 编辑未执行任务后时间与配置正确持久化', () => {
  it('保存会把本地时间转换成持久化的 UTC 时间并真正调用后端', async () => {
    const calls = [];
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.win.api = {
      planUpdateTask: function (workId, taskId, patch) {
        calls.push({ workId: workId, taskId: taskId, patch: patch });
        return Promise.resolve({ ok: true });
      },
      planList: function () { return Promise.resolve({ stages: [], tasks: [] }); }
    };
    sb.dom.get('planDetailTime_t1').value = '2030-05-06T08:15';

    const ok = await sb.api.planDetailSave('w1', 't1');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].workId).toBe('w1');
    expect(calls[0].taskId).toBe('t1');
    // 本地时间 → UTC ISO（本地时区解释规则）
    const d = new Date(calls[0].patch.scheduled_at);
    expect(d.getFullYear()).toBe(2030);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(6);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(15);
  });

  it('时间格式非法时提示错误，不调用后端', async () => {
    const calls = [];
    const sb = buildSandbox();
    sb.win.api = { planUpdateTask: function () { calls.push(1); return Promise.resolve({ ok: true }); } };
    sb.dom.get('planDetailTime_t1').value = '不是时间';
    const ok = await sb.api.planDetailSave('w1', 't1');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(sb.toasts.some(t => t.m.indexOf('时间格式不正确') >= 0)).toBe(true);
  });
});

describe('M10 · 编辑已完成任务不会改写成功历史', () => {
  it('已完成 / 已失败 / 草稿待发布 / 已取消 / 执行中的任务不提供编辑入口', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0 })],
      [task({ id: 't_done', platform_id: 'github', status: 'done' }),
       task({ id: 't_failed', platform_id: 'wechat', status: 'failed' }),
       task({ id: 't_draft', platform_id: 'youtube', status: 'draft_pending' }),
       task({ id: 't_cancel', platform_id: 'github', status: 'cancelled' }),
       task({ id: 't_run', platform_id: 'wechat', status: 'running' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).not.toContain('planDetailEdit(');
    // 执行中的任务明确说明不能中断
    expect(html).toContain('执行中不可取消');
  });

  it('待执行的任务提供编辑与取消入口', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.paintPlanDetail('w1',
      [stageRow({ id: 'ps_a', seq: 0 })],
      [task({ id: 't_pending', status: 'pending' })]
    );
    const html = sb.dom.get('planDetailBody').innerHTML;
    expect(html).toContain('planDetailEdit(');
    expect(html).toContain('planDetailCancel(');
  });

  it('存储层拒绝改写已完成任务的结果（详见 M11 的存储断言）', () => {
    expect(HTML).toContain("t.status==='pending'||t.status==='needs_review'");
  });
});

/* ==================================================================
   M11 / M12 / M13 / M14
   ================================================================== */
describe('M11 · 取消任务后重启仍然保持取消状态', () => {
  let tmpDir, dbPath, restoreBlock = null;
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
  function newStore() {
    const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
    delete require.cache[id];
    restoreBlock = H.installDriverBlock(false);
    const { Store } = require(path.join(H.ROOT, 'electron', 'store'));
    return new Store(dbPath);
  }

  it('取消后重新打开数据库仍是 cancelled，不会复活为待执行', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github', 'wechat'] })]);
    const tasks = store.listPlanTasks('w1');
    const gh = tasks.filter(t => t.platform_id === 'github')[0];

    expect(store.cancelPlanTask('w1', gh.id).ok).toBe(true);

    const reopened = newStore();
    const after = reopened.listPlanTasks('w1').filter(t => t.id === gh.id)[0];
    expect(after.status).toBe('cancelled');
    // 同阶段另一个平台不受影响
    expect(reopened.listPlanTasks('w1').filter(t => t.platform_id === 'wechat')[0].status).toBe('pending');
  });

  it('存储层拒绝改写已完成任务的结果，也拒绝跨作品 / 跨阶段改写', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品一');
    H.seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [H.stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'done' }));

    expect(store.updatePlanTask('w1', t.id, { scheduled_at: '2030-01-01T00:00:00.000Z' }).ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
    // 跨作品
    expect(store.updatePlanTask('w2', t.id, { scheduled_at: '2030-01-01T00:00:00.000Z' }).ok).toBe(false);
    // 跨阶段
    expect(store.updatePlanTask('w1', t.id, { stage_id: 'ps_other' }).ok).toBe(false);
  });
});

describe('M12 · 页面保存 / 读取失败时有正确提示', () => {
  it('保存失败时提示失败并返回 false（不显示成功）', async () => {
    const sb = buildSandbox();
    sb.win.api = { planUpdateTask: function () { return Promise.resolve({ ok: false, error: '磁盘满了' }); } };
    sb.dom.get('planDetailTime_t1').value = '2030-05-06T08:15';

    const ok = await sb.api.planDetailSave('w1', 't1');
    expect(ok).toBe(false);
    expect(sb.toasts.some(t => t.m.indexOf('保存失败') >= 0)).toBe(true);
    expect(sb.toasts.some(t => t.m.indexOf('已保存') >= 0)).toBe(false);
  });

  it('后端抛错时同样提示失败', async () => {
    const sb = buildSandbox();
    sb.win.api = { planUpdateTask: function () { return Promise.reject(new Error('IPC 断了')); } };
    sb.dom.get('planDetailTime_t1').value = '2030-05-06T08:15';

    const ok = await sb.api.planDetailSave('w1', 't1');
    expect(ok).toBe(false);
    expect(sb.toasts.some(t => t.m.indexOf('保存失败') >= 0)).toBe(true);
  });

  it('读取计划失败时给出明确提示', async () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.planDetailWork = 'w1';
    sb.win.api = { planList: function () { return Promise.reject(new Error('读库失败')); } };

    sb.api.renderWorkPlanDetail();
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.dom.get('planDetailBody').innerHTML).toContain('读取发布计划失败');
  });

  it('全局列表读取失败时给出明确提示', async () => {
    const sb = buildSandbox();
    sb.win.api = { planAll: function () { return Promise.reject(new Error('读库失败')); } };
    sb.api.renderPlanCenter();
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(sb.dom.get('planCenterTable').innerHTML).toContain('读取发布计划失败');
  });

  it('筛选结果为空时给出明确提示', async () => {
    const sb = centerSandbox();
    sb.state.planView.q = '不存在的作品';
    const html = await centerHtml(sb);
    expect(html).toContain('当前筛选条件下没有发布任务');
  });
});

describe('M13 · 从详情返回列表时保留上下文', () => {
  it('打开详情不会清掉全局列表的搜索 / 筛选 / 排序条件', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.state.planView = { status: 'failed', q: '作品一', platform: 'github', sort: 'time_desc' };
    sb.api.openWorkPlan('w1', 'plans');
    expect(sb.state.planView).toEqual({ status: 'failed', q: '作品一', platform: 'github', sort: 'time_desc' });
  });

  it('从全局列表进入的详情返回到列表，从作品进入的返回到作品列表', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }];
    sb.api.openWorkPlan('w1', 'plans');
    sb.api.planDetailBack();
    expect(sb.routes[sb.routes.length - 1]).toBe('plans');

    sb.api.openWorkPlan('w1', 'works');
    sb.api.planDetailBack();
    expect(sb.routes[sb.routes.length - 1]).toBe('works');
  });

  it('作品归属不会因为打开详情而丢失', () => {
    const sb = buildSandbox();
    sb.state.works = [{ id: 'w1', name: '作品一' }, { id: 'w2', name: '作品二' }];
    sb.api.openWorkPlan('w2', 'works');
    expect(sb.state.planDetailWork).toBe('w2');
    expect(sb.state.curWork).toBe('');   // 打开详情不改当前作品
  });
});
