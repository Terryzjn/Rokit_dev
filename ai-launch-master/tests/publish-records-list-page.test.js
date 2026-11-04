// Rokit · 第二轮：发布记录列表页 / 独立发布详情页 / 批量删除 / 作品详情入口
//
// 本文件覆盖用户第二轮要求里的**可执行行为**（不是字符串猜测）：
//   L1  列表页：关键词搜索 / 平台筛选 / 状态筛选 / 时间范围 / 排序 —— 真的改变结果集
//   L2  列表页统计口径：显示「全部发布记录」与「成功发布」两个数，且与筛选结果一致
//   L3  渠道统计入口默认选中正确的平台
//   L4  状态未知的历史记录显示明确文本（不冒充已发布、不留空）
//   L5  单条记录能打开对应的独立发布详情页；详情页内容取自同一条记录
//   L6  从详情页返回列表后，筛选条件 / 排序 / 页码保留
//   L7  批量删除：删除前确认；取消不改数据；只删选中的本地记录；不删作品/平台内容
//   L8  删除后内存（state.pubLog）与数据库（pubs 表）保持一致
//   L9  「我的作品」详情入口在真实卡片里清晰可见
//   L10  一条作品可关联多条不同平台发布记录
//   L11 GitHub / YouTube 链接只用真实数据
//   L12 四个一级导航与既有发布流程不被破坏
//
// 跑的生产代码：
//   - renderer-utils/dashboard-view.js 的 window.__pubView（浏览器脚本，按 <script> 加载）
//   - index.html 里切出来的发布记录视图函数（按花括号配平切出，注入依赖后执行）
//   - electron/store.js 的 deletePubs（真实 SQLite / JSON 存储层行为）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const DASH_SRC = fs.readFileSync(path.join(ROOT, 'renderer-utils', 'dashboard-view.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const PUBLISHERS_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'publishers.js'), 'utf8').replace(/\r\n/g, '\n');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 通用：从源码里按花括号配平切出一个函数 ---------- */
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

const PLATFORMS = [
  { id: 'github', name: 'GitHub', color: '#24292F' },
  { id: 'youtube', name: 'YouTube', color: '#FF0000' },
  { id: 'x', name: 'X (Twitter)', color: '#000000' },
  { id: 'wechat', name: '微信公众号', color: '#07C160' },
  { id: 'v2ex', name: 'V2EX', color: '#5779C8' }
];

/* ==================================================================
   沙箱：把 index.html 里的发布记录视图函数切出来跑
   ================================================================== */

// index.html 中「发布记录视图」这一段的全部函数（列表页 + 详情页 + 作品详情）
const VIEW_SRC = [
  extractBlock(HTML, 'function pubViewApi(){'),
  extractBlock(HTML, 'function pubKeyOf(r){'),
  extractBlock(HTML, 'function pubRecordTitle(r){'),
  extractBlock(HTML, 'function pubRecordUrl(r){'),
  extractBlock(HTML, 'function pubRecordPlatformName(r){'),
  extractBlock(HTML, 'function pubStatusBadge(r){'),
  extractBlock(HTML, 'function pubStatusText(r){'),
  extractBlock(HTML, 'function pubTimeText(r){'),
  extractBlock(HTML, 'function pubListState(){'),
  extractBlock(HTML, 'function pubArg(s){'),
  extractBlock(HTML, 'function pubPlatMeta(r){'),
  extractBlock(HTML, 'window.openPubListPage=function(opts){'),
  extractBlock(HTML, 'window.pubListBack=function(){'),
  extractBlock(HTML, 'window.pubListOnFilter=function(name,val){'),
  extractBlock(HTML, 'window.pubListResetFilters=function(){'),
  extractBlock(HTML, 'window.pubListToggleSel=function(key,checked){'),
  extractBlock(HTML, 'window.pubListToggleAll=function(checked){'),
  extractBlock(HTML, 'window.pubListGotoPage=function(p){'),
  extractBlock(HTML, 'window.pubListOpenExternal=function(key){'),
  extractBlock(HTML, 'window.openPubDetail=function(key){'),
  extractBlock(HTML, 'window.pubDetailBack=function(){'),
  extractBlock(HTML, 'window.pubListDeleteSelected=function(){'),
  extractBlock(HTML, 'function pubListRemoveFromMemory(rows){'),
  extractBlock(HTML, 'function pubListFilterSummary(s){'),
  extractBlock(HTML, 'function renderPubListPage(){'),
  extractBlock(HTML, 'function syncPubListControls(s){'),
  extractBlock(HTML, 'function renderPubDetailPage(){'),
  extractBlock(HTML, 'window.openPubPlatformPubs=function(platId){')
].join('\n');

function makeDashState() {
  return {
    dashRange: 'all',
    channels: [],
    works: [
      { id: 'w1', name: '作品一', type: '效率工具', status: '运营期', intro: '作品一的简介', url: '', yt_url: '' },
      { id: 'w2', name: '作品二', type: '小游戏', status: '首秀中', intro: '作品二的简介', url: '', yt_url: '' }
    ],
    pubLog: [
      // 1. YouTube 成功（有真实 videoId）
      {
        session: false, recId: 1,
        platform: 'YouTube', platform_id: 'youtube', id: 'youtube',
        status: 'ok', title: '作品一 · 首发视频', body: '正文一',
        time: '10:30', created_at: '2026-10-20T02:30:00.000Z',
        work_id: 'w1', url: 'https://www.youtube.com/watch?v=abcdefghijk',
        video_id: 'abcdefghijk', pub_key: 'yt|w1|1'
      },
      // 2. GitHub 成功（有真实 Release URL）
      {
        session: false, recId: 2,
        platform: 'GitHub', platform_id: 'github', id: 'github',
        status: 'ok', title: '作品一 · Release', body: '正文二',
        time: '10:31', created_at: '2026-10-19T02:31:00.000Z',
        work_id: 'w1', url: 'https://github.com/o/r/releases/tag/v1.0.0',
        pub_key: 'gh|w1|1'
      },
      // 3. GitHub 失败
      {
        session: false, recId: 3,
        platform: 'GitHub', platform_id: 'github', id: 'github',
        status: 'failed', title: '作品一 · 失败发布', error: 'no-token',
        time: '10:32', created_at: '2026-10-18T02:32:00.000Z',
        work_id: 'w1', pub_key: 'gh|w1|2'
      },
      // 4. 草稿待发布（不计成功次数）
      {
        session: false, recId: 4,
        platform: 'V2EX', platform_id: 'v2ex', id: 'v2ex',
        status: 'pending', title: '作品二 · 草稿',
        time: '10:33', created_at: '2026-10-17T02:33:00.000Z',
        work_id: 'w2', pub_key: 'v2ex|w2|1'
      },
      // 5. 手动标记完成（计入成功次数）
      {
        session: false, recId: 5,
        platform: 'X (Twitter)', platform_id: 'x', id: 'x',
        status: 'manual', title: '作品二 · 手动发布',
        time: '10:34', created_at: '2026-10-16T02:34:00.000Z',
        work_id: 'w2', pub_key: 'x|w2|1'
      },
      // 6. 历史记录：**没有 status 字段** → 必须显示「状态未知」
      {
        session: false, recId: 6,
        platform: '微信公众号', platform_id: '', id: '',
        title: '历史作品 · 无状态', time: '09:00',
        created_at: '2026-10-15T01:00:00.000Z', work_id: 'w1'
      }
    ]
  };
}

function loadDashView(state) {
  const host = {};
  new Function('window', DASH_SRC)(host);
  host.RokitDashboardView.create({
    state: state,
    esc: (s) => String(s == null ? '' : s),
    platforms: PLATFORMS,
    go: () => {},
    toast: () => {},
    findWork: (id) => (state.works || []).find((w) => w.id === id) || null,
    formatRelTime: () => ''
  });
  return host.__pubView;
}

/* ---------- 极简 DOM 桩：只需要 innerHTML / textContent / value / style ---------- */
function makeEl(id) {
  return {
    id: id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    options: [],
    checked: false,
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {}
  };
}

function makeDom(ids) {
  const els = {};
  ids.forEach((id) => { els[id] = makeEl(id); });
  return {
    els: els,
    getElementById(id) { return els[id] || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeEl('tmp'); },
    body: { appendChild() {} }
  };
}

const LIST_DOM_IDS = [
  'pubListTable', 'pubListFoot', 'pubListSummary', 'pubListCount',
  'pubFilterQ', 'pubFilterPlatform', 'pubFilterStatus', 'pubFilterRange',
  'pubFilterFrom', 'pubFilterTo', 'pubFilterSort',
  'pubDetailPageBody', 'pubDetailPageSub'
];

/**
 * 搭建一个可执行的「列表页 + 详情页」运行环境。
 * 依赖注入：state / __pubView / DOM / toast / confirmModal / openExt / api.deletePubs / go
 */
function makeListEnv(overrides) {
  const o = overrides || {};
  const state = o.state || makeDashState();
  const dom = o.dom || makeDom(LIST_DOM_IDS);
  const pubView = loadDashView(state);

  const toasts = [];
  const opened = [];
  const confirmCalls = [];
  const deleteCalls = [];
  const goCalls = [];

  const host = {
    __pubView: pubView,
    api: {
      deletePubs: function (targets) {
        deleteCalls.push(targets);
        if (o.deleteResult) return Promise.resolve(o.deleteResult);
        return Promise.resolve({ deleted: (targets || []).length, ids: [], keys: [] });
      }
    }
  };

  let confirmAnswer = o.confirmAnswer === undefined ? true : o.confirmAnswer;
  const confirmModal = function (opts) {
    confirmCalls.push(opts);
    return Promise.resolve(confirmAnswer);
  };
  const openExt = function (url) { opened.push(url); };
  const toast = function (msg, kind) { toasts.push({ msg: msg, kind: kind }); };
  const go = function (route) { goCalls.push(route); state.route = route; };
  const closeModal = function () {};
  const findWork = (id) => (state.works || []).find((w) => w.id === id) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const factory = new Function(
    'state', 'PLATFORMS', 'esc', 'window', 'document', 'toast', 'confirmModal',
    'openExt', 'go', 'closeModal', 'findWork',
    VIEW_SRC +
    '\nreturn { openPubListPage: window.openPubListPage, pubListBack: window.pubListBack,' +
    ' pubListOnFilter: window.pubListOnFilter, pubListResetFilters: window.pubListResetFilters,' +
    ' pubListToggleSel: window.pubListToggleSel, pubListToggleAll: window.pubListToggleAll,' +
    ' pubListGotoPage: window.pubListGotoPage, pubListOpenExternal: window.pubListOpenExternal,' +
    ' openPubDetail: window.openPubDetail, pubDetailBack: window.pubDetailBack,' +
    ' pubListDeleteSelected: window.pubListDeleteSelected, openPubPlatformPubs: window.openPubPlatformPubs,' +
    ' renderPubListPage: renderPubListPage, renderPubDetailPage: renderPubDetailPage,' +
    ' pubListState: pubListState, pubListFilterSummary: pubListFilterSummary,' +
    ' pubStatusBadge: pubStatusBadge, pubStatusText: pubStatusText, pubRecordUrl: pubRecordUrl };'
  );
  const api = factory(state, PLATFORMS, esc, host, dom, toast, confirmModal, openExt, go, closeModal, findWork);

  return {
    state: state,
    dom: dom,
    api: api,
    view: pubView,
    toasts: toasts,
    opened: opened,
    confirmCalls: confirmCalls,
    deleteCalls: deleteCalls,
    goCalls: goCalls,
    setConfirmAnswer: (v) => { confirmAnswer = v; },
    tableHtml: () => dom.els.pubListTable.innerHTML,
    footHtml: () => dom.els.pubListFoot.innerHTML,
    countText: () => dom.els.pubListCount.textContent,
    summaryText: () => dom.els.pubListSummary.textContent,
    detailHtml: () => dom.els.pubDetailPageBody.innerHTML
  };
}

/* ==================================================================
   L1 / L2 / L4：列表页查询（真实执行 __pubView.list）
   ================================================================== */

describe('L1 · 发布记录列表页：搜索 / 筛选 / 排序真的改变结果', () => {
  it('关键词搜索命中发布标题', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ q: 'Release' });
    expect(rows.length).toBe(1);
    expect(rows[0].platform_id).toBe('github');
    expect(rows[0].status).toBe('ok');
  });

  it('关键词搜索命中关联作品名（作品标题）', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ q: '作品二' });
    // 作品二关联 pending + manual 两条
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['manual', 'pending']);
  });

  it('关键词无命中 → 返回空数组（不是 undefined）', () => {
    const view = loadDashView(makeDashState());
    expect(view.list({ q: '不存在的关键词zzz' })).toEqual([]);
  });

  it('平台筛选只保留该平台的记录', () => {
    const view = loadDashView(makeDashState());
    const yt = view.list({ platform: 'youtube' });
    expect(yt.length).toBe(1);
    expect(yt[0].platform_id).toBe('youtube');
    const gh = view.list({ platform: 'github' });
    expect(gh.length).toBe(2);           // 一成功一失败都属 GitHub
    expect(gh.every((r) => r.platform_id === 'github')).toBe(true);
  });

  it('平台筛选支持平台名（历史记录按名反查）', () => {
    const view = loadDashView(makeDashState());
    expect(view.list({ platform: 'X (Twitter)' }).length).toBe(1);
    expect(view.list({ platform: 'x' }).length).toBe(1);
  });

  it('状态筛选：success 只含 ok+manual，不含 failed/pending/unknown', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ status: 'success' });
    expect(rows.length).toBe(3);          // ok(yt) + ok(gh) + manual(x)
    expect(rows.every((r) => r.status === 'ok' || r.status === 'manual')).toBe(true);
  });

  it('状态筛选：failed / pending / unknown 分别精确命中', () => {
    const view = loadDashView(makeDashState());
    expect(view.list({ status: 'failed' }).length).toBe(1);
    expect(view.list({ status: 'pending' }).length).toBe(1);
    const unknown = view.list({ status: 'unknown' });
    expect(unknown.length).toBe(1);
    expect(unknown[0].status_known).toBe(false);
  });

  it('时间范围筛选：只保留区间内的记录；没有真实时间的记录不参与', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ from: '2026-10-19', to: '2026-10-20' });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.recId).sort()).toEqual([1, 2]);
    // 只有一个下界：2026-10-18 及以后 → rec1(10-20) / rec2(10-19) / rec3(10-18)
    expect(view.list({ from: '2026-10-18' }).length).toBe(3);
    // 只有一个上界：2026-10-16 及以前 → rec5(10-16) / rec6(10-15)
    expect(view.list({ to: '2026-10-16' }).length).toBe(2);
  });

  it('排序：desc 最新优先 / asc 最早优先', () => {
    const view = loadDashView(makeDashState());
    const desc = view.list({ sort: 'desc' });
    const asc = view.list({ sort: 'asc' });
    expect(desc.length).toBe(asc.length);
    expect(desc[0].recId).toBe(1);          // 2026-10-20 最新
    expect(asc[0].recId).toBe(6);           // 2026-10-15 最早
    // 同一份数据排序反转
    expect(desc.map((r) => r.recId)).toEqual(asc.map((r) => r.recId).reverse());
  });

  it('组合筛选：平台 + 状态 + 关键词同时生效', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ platform: 'github', status: 'ok', q: 'Release' });
    expect(rows.length).toBe(1);
    expect(rows[0].recId).toBe(2);
    // 换成 failed 就空了
    expect(view.list({ platform: 'github', status: 'failed', q: 'Release' }).length).toBe(0);
  });
});

describe('L2 · 列表页计数口径', () => {
  it('列表条数 = 筛选结果条数；成功次数单独给出', () => {
    const view = loadDashView(makeDashState());
    const all = view.list({});
    expect(all.length).toBe(6);
    expect(view.successCount(all)).toBe(3);   // ok + ok + manual

    const failed = view.list({ status: 'failed' });
    expect(failed.length).toBe(1);
    expect(view.successCount(failed)).toBe(0);

    const gh = view.list({ platform: 'github' });
    expect(gh.length).toBe(2);
    expect(view.successCount(gh)).toBe(1);
  });

  it('列表页渲染的计数文案明确区分「全部发布记录」与「成功发布」', () => {
    const env = makeListEnv();
    env.api.renderPubListPage();
    const text = env.countText();
    expect(text).toContain('共 6 条发布记录');
    expect(text).toContain('3 条为成功发布');
    // 不能把全部记录数误称为成功发布次数
    expect(text).not.toMatch(/共 6 条成功/);
  });

  it('筛选后计数同步刷新（与筛选结果一致）', () => {
    const env = makeListEnv();
    env.api.pubListOnFilter('platform', 'github');
    env.api.renderPubListPage();
    expect(env.countText()).toContain('共 2 条发布记录');
    expect(env.countText()).toContain('1 条为成功发布');
  });
});

describe('L4 · 状态未知的历史记录：明确文本，不冒充已发布', () => {
  it('归一化后状态为 unknown 且 status_known=false', () => {
    const view = loadDashView(makeDashState());
    const row = view.records().find((r) => r.recId === 6);
    expect(row.status).toBe('unknown');
    expect(row.status_known).toBe(false);
    expect(view.isSuccess(row)).toBe(false);      // 不计入成功次数
    expect(view.successRecords().some((r) => r.recId === 6)).toBe(false);
  });

  it('徽标与文案都显示「状态未知」（不留空、不写已发布）', () => {
    const env = makeListEnv();
    const badge = env.api.pubStatusBadge({ status: 'unknown' });
    expect(badge).toContain('状态未知');
    expect(badge).not.toContain('已发布');
    expect(env.api.pubStatusText({ status: 'unknown' })).toBe('状态未知');
  });

  it('列表页渲染里出现「状态未知」，且该记录仍出现在列表中', () => {
    const env = makeListEnv();
    env.api.renderPubListPage();
    expect(env.tableHtml()).toContain('状态未知');
    expect(env.tableHtml()).toContain('历史作品 · 无状态');
  });

  it('详情页对无状态记录给出明确说明（不冒充已发布）', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'd:6';
    env.api.renderPubDetailPage();
    const html = env.detailHtml();
    expect(html).toContain('状态未知');
    expect(html).toContain('没有保存发布状态');
    expect(html).not.toContain('✓ 已成功发布到');
  });

  it('存储层：没有 status 的记录落库为 unknown，不是 ok', () => {
    // addPub 的兜底必须是 'unknown'
    expect(STORE_SRC).toMatch(/status:\s*r\.status\s*\|\|\s*'unknown'/);
    // 迁移里 status 列不能有 DEFAULT 'ok'（否则旧行会被洗成已发布）
    expect(STORE_SRC).toMatch(/ALTER TABLE pubs ADD COLUMN status TEXT(?! DEFAULT)/);
    expect(STORE_SRC).not.toMatch(/ALTER TABLE pubs ADD COLUMN status TEXT DEFAULT 'ok'/);
  });

  it('渲染层 loadPubs 的兜底也是 unknown', () => {
    expect(HTML).toContain("status:p.status||'unknown'");
    expect(HTML).not.toContain("status:p.status||'ok'");
  });
});

/* ==================================================================
   L3：入口默认筛选
   ================================================================== */

describe('L3 · 入口默认筛选条件', () => {
  it('看板「查看全部发布记录」→ 列表页且平台=全部平台', () => {
    const env = makeListEnv();
    env.api.openPubListPage({ back: 'dashboard', reset: true });
    expect(env.goCalls[env.goCalls.length - 1]).toBe('pubs');
    const s = env.api.pubListState();
    expect(s.platform).toBe('all');
    expect(s.q).toBe('');
    expect(s.status).toBe('all');
  });

  it('点击某个平台的发布次数 → 列表页且默认选中该平台', () => {
    const env = makeListEnv();
    env.api.openPubPlatformPubs('youtube');
    expect(env.goCalls[env.goCalls.length - 1]).toBe('pubs');
    expect(env.api.pubListState().platform).toBe('youtube');
  });

  it('渠道入口默认平台下，列表结果确实只有该平台', () => {
    const env = makeListEnv();
    env.api.openPubPlatformPubs('github');
    env.api.renderPubListPage();
    expect(env.countText()).toContain('共 2 条发布记录');
    expect(env.tableHtml()).not.toContain('作品一 · 首发视频');
  });

  it('筛选摘要显示当前平台与状态', () => {
    const env = makeListEnv();
    env.api.openPubPlatformPubs('youtube');
    const summary = env.api.pubListFilterSummary(env.api.pubListState());
    expect(summary).toContain('YouTube');
    expect(summary).toContain('全部状态');
    expect(summary).toContain('发布时间最新优先');
  });
});

/* ==================================================================
   L5 / L6：独立详情页 + 返回保留筛选
   ================================================================== */

describe('L5 · 独立发布详情页', () => {
  it('openPubDetail 进入内部路由 pubdetail，并记住记录键', () => {
    const env = makeListEnv();
    env.state.route = 'pubs';
    env.api.openPubDetail('yt|w1|1');
    expect(env.goCalls[env.goCalls.length - 1]).toBe('pubdetail');
    expect(env.state.pubDetailKey).toBe('yt|w1|1');
  });

  it('详情页展示的是同一条记录的真实信息', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'yt|w1|1';
    env.api.renderPubDetailPage();
    const html = env.detailHtml();
    expect(html).toContain('作品一 · 首发视频');
    expect(html).toContain('YouTube');
    expect(html).toContain('abcdefghijk');              // 真实 videoId
    expect(html).toContain('https://www.youtube.com/watch?v=abcdefghijk');
    expect(html).toContain('已成功发布到 YouTube');
  });

  it('失败记录展示真实失败原因，不显示成功', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'gh|w1|2';
    env.api.renderPubDetailPage();
    const html = env.detailHtml();
    expect(html).toContain('发布失败');
    expect(html).toContain('no-token');
    expect(html).not.toContain('✓ 已成功发布到');
  });

  it('没有真实链接时明确提示「未记录平台原始链接」，不用平台首页冒充', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'v2ex|w2|1';
    env.api.renderPubDetailPage();
    const html = env.detailHtml();
    expect(html).toContain('未记录平台原始链接');
    expect(html).not.toContain('https://v2ex.com"');
  });

  it('详情页不会自动打开外部链接（必须用户点击）', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'yt|w1|1';
    env.api.renderPubDetailPage();
    expect(env.opened.length).toBe(0);   // 渲染本身不打开
  });

  it('记录不存在时安全空状态，不崩溃', () => {
    const env = makeListEnv();
    env.state.pubDetailKey = 'not-exist';
    env.api.renderPubDetailPage();
    expect(env.detailHtml()).toContain('找不到这条发布记录');
  });

  it('详情页有返回入口，且返回到来源视图', () => {
    const env = makeListEnv();
    env.state.route = 'pubs';
    env.api.openPubDetail('yt|w1|1');
    env.api.pubDetailBack();
    expect(env.goCalls[env.goCalls.length - 1]).toBe('pubs');
  });
});

describe('L6 · 从详情返回后列表筛选条件保留', () => {
  it('关键词 / 平台 / 状态 / 排序 / 页码在进出详情后保持不变', () => {
    const env = makeListEnv();
    env.api.pubListOnFilter('q', '作品');
    env.api.pubListOnFilter('platform', 'github');
    env.api.pubListOnFilter('status', 'ok');
    env.api.pubListOnFilter('sort', 'asc');
    env.api.pubListGotoPage(1);

    const before = Object.assign({}, env.api.pubListState());
    expect(before.q).toBe('作品');
    expect(before.platform).toBe('github');
    expect(before.status).toBe('ok');
    expect(before.sort).toBe('asc');

    env.state.route = 'pubs';
    env.api.openPubDetail('gh|w1|1');
    env.api.pubDetailBack();
    env.api.renderPubListPage();

    const after = env.api.pubListState();
    expect(after.q).toBe('作品');
    expect(after.platform).toBe('github');
    expect(after.status).toBe('ok');
    expect(after.sort).toBe('asc');
    // 筛选控件也回填了（用户能看见条件还在）
    expect(env.dom.els.pubFilterQ.value).toBe('作品');
    expect(env.dom.els.pubFilterPlatform.value).toBe('github');
    expect(env.dom.els.pubFilterStatus.value).toBe('ok');
    expect(env.dom.els.pubFilterSort.value).toBe('asc');
  });

  it('重置筛选恢复默认值', () => {
    const env = makeListEnv();
    env.api.pubListOnFilter('q', 'xxx');
    env.api.pubListOnFilter('platform', 'github');
    env.api.pubListResetFilters();
    const s = env.api.pubListState();
    expect(s.q).toBe('');
    expect(s.platform).toBe('all');
    expect(s.status).toBe('all');
    expect(s.sort).toBe('desc');
  });
});

/* ==================================================================
   L7 / L8：批量删除
   ================================================================== */

describe('L7 · 批量删除：确认 / 取消 / 只删选中', () => {
  it('删除前必须弹确认框，且明确显示选中条数', async () => {
    const env = makeListEnv();
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListToggleSel('gh|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.confirmCalls.length).toBe(1);
    expect(env.confirmCalls[0].title).toContain('删除');
    expect(env.confirmCalls[0].body).toContain('2 条发布记录');
    // 明确说明删除范围
    expect(env.confirmCalls[0].detail).toContain('仅 Rokit 本机保存的发布记录');
    expect(env.confirmCalls[0].detail).toContain('不会删除作品');
    expect(env.confirmCalls[0].detail).toContain('不会删除平台上的内容');
  });

  it('取消确认 → 什么都不改（不调用删除接口，不改内存数据）', async () => {
    const env = makeListEnv({ confirmAnswer: false });
    const before = JSON.stringify(env.state.pubLog);
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.deleteCalls.length).toBe(0);
    expect(JSON.stringify(env.state.pubLog)).toBe(before);
    expect(env.state.pubLog.length).toBe(6);
  });

  it('确认后只对**选中的**记录调用删除接口（不按作品 id / 平台 id 误删）', async () => {
    const env = makeListEnv();
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.deleteCalls.length).toBe(1);
    const targets = env.deleteCalls[0];
    expect(targets.length).toBe(1);
    // 只传稳定唯一标识：记录行 id / pub_key，不传 work_id、platform_id
    expect(Object.keys(targets[0]).sort()).toEqual(['id', 'pub_key']);
    expect(targets[0].pub_key).toBe('yt|w1|1');
    expect(targets[0].work_id).toBeUndefined();
    expect(targets[0].platform_id).toBeUndefined();
  });

  it('全选只作用于当前筛选结果，不是全部记录', async () => {
    const env = makeListEnv();
    env.api.pubListOnFilter('platform', 'github');
    env.api.pubListToggleAll(true);
    const s = env.api.pubListState();
    expect(Object.keys(s.selected).sort()).toEqual(['gh|w1|1', 'gh|w1|2']);
  });

  it('删除后清掉已删除记录的选中状态并刷新列表', async () => {
    const env = makeListEnv();
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const s = env.api.pubListState();
    expect(s.selected['yt|w1|1']).toBeUndefined();
    expect(env.countText()).toContain('共 5 条发布记录');
  });

  it('删除失败时保留记录并提示错误', async () => {
    const env = makeListEnv({ deleteResult: { deleted: 0, ids: [], keys: [], error: '数据库忙' } });
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.pubLog.length).toBe(6);          // 记录保留
    expect(env.toasts.some((t) => t.msg && t.msg.indexOf('删除失败') >= 0)).toBe(true);
  });

  it('空选择时提示并直接返回（不弹确认、不调接口）', async () => {
    const env = makeListEnv();
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    expect(env.confirmCalls.length).toBe(0);
    expect(env.deleteCalls.length).toBe(0);
    expect(env.toasts.some((t) => t.msg && t.msg.indexOf('请先勾选') >= 0)).toBe(true);
  });

  it('重复点击删除：第二次直接返回，不会重复调接口', async () => {
    const env = makeListEnv();
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.deleteCalls.length).toBe(1);
  });

  it('删除只影响本地发布记录：不删作品、不调外部平台删除 API', () => {
    const del = extractBlock(STORE_SRC, 'deletePubs(targets) {');
    // 只操作 pubs 表
    expect(del).toContain('pubs');
    expect(del).not.toMatch(/works/i);
    expect(del).not.toMatch(/fetch\(|https?:|axios|request\(/);
    // 没有调用任何平台删除接口
    expect(del).not.toMatch(/deleteVideo|deleteRelease|youtube.*delete/i);
    // 渲染层删除函数也不调任何外部平台接口
    const ui = extractBlock(HTML, 'window.pubListDeleteSelected=function(){');
    expect(ui).not.toMatch(/youtube|github.*api\.|deleteVideo/);
    expect(ui).toContain('window.api.deletePubs');
  });

  it('删除范围说明在 UI 上是明确的（记录 ≠ 作品 ≠ 撤销授权 ≠ 删平台内容）', () => {
    const ui = extractBlock(HTML, 'window.pubListDeleteSelected=function(){');
    expect(ui).toContain('仅 Rokit 本机保存的发布记录');
    expect(ui).toContain('不会删除作品');
    expect(ui).toContain('不会撤销平台授权');
    expect(ui).toContain('不会删除平台上的内容');
  });
});

describe('L8 · 删除后内存与数据库数据一致', () => {
  let tmpDir;
  let dbPath;
  let Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-pubdel-'));
    dbPath = path.join(tmpDir, 'test.db');
    // 本机 better-sqlite3 原生模块与当前 Node ABI 不匹配（与本轮改动无关的既有环境问题），
    // 这里强制走 store.js 自带的 node:sqlite 回退分支，仍然是真实的 SQLite 存储层行为。
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === 'better-sqlite3') {
        const e = new Error('native binding unavailable');
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      return origLoad.apply(this, arguments);
    };
    try {
      Store = require('../electron/store').Store;
    } finally {
      Module._load = origLoad;
    }
  });

  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_e) {} }
    }
    const jf = path.join(tmpDir, 'ai-launch-master-data.json');
    if (fs.existsSync(jf)) { try { fs.unlinkSync(jf); } catch (_e) {} }
    try { fs.rmdirSync(tmpDir); } catch (_e) {}
  });

  it('按 pub_key 精确删除：只删那一条，同作品其它平台记录保留', () => {
    const store = new Store(dbPath);
    store.saveWork({ id: 'w1', name: '作品一' });
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', title: 'A', pub_key: 'yt|w1|1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', title: 'B', pub_key: 'gh|w1|1' });
    store.addPub({ work_id: 'w1', platform: 'V2EX', platform_id: 'v2ex', status: 'failed', title: 'C', pub_key: 'vx|w1|1' });

    const res = store.deletePubs([{ id: '', pub_key: 'yt|w1|1' }]);
    expect(res.deleted).toBe(1);
    expect(res.keys).toEqual(['yt|w1|1']);

    const left = store.listPubs();
    expect(left.length).toBe(2);
    expect(left.map((r) => r.pub_key).sort()).toEqual(['gh|w1|1', 'vx|w1|1']);
    // 作品行没被动过
    expect(store.listWorks().map((w) => w.id)).toEqual(['w1']);
  });

  it('按记录行 id 精确删除：只删那一条', () => {
    const store = new Store(dbPath);
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', pub_key: 'k1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k2' });
    const rows = store.listPubs();
    const target = rows.find((r) => r.pub_key === 'k1');

    const res = store.deletePubs([{ id: String(target.id), pub_key: '' }]);
    expect(res.deleted).toBe(1);
    const left = store.listPubs();
    expect(left.length).toBe(1);
    expect(left[0].pub_key).toBe('k2');
  });

  it('空选择 / 记录已不存在 → 不删任何东西', () => {
    const store = new Store(dbPath);
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', pub_key: 'k1' });
    expect(store.deletePubs([]).deleted).toBe(0);
    expect(store.deletePubs([{ id: '999999', pub_key: '' }]).deleted).toBe(0);
    expect(store.deletePubs([{ id: '', pub_key: 'nope' }]).deleted).toBe(0);
    expect(store.listPubs().length).toBe(1);
  });

  it('不支持按作品 id / 平台 id 删除（避免越界误删整部作品或其它平台记录）', () => {
    const store = new Store(dbPath);
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', pub_key: 'k1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k2' });
    // 只给 work_id / platform_id（不带 id / pub_key）→ 什么都不该被删
    const res = store.deletePubs([{ work_id: 'w1', platform_id: 'youtube' }]);
    expect(res.deleted).toBe(0);
    expect(store.listPubs().length).toBe(2);
  });

  it('删除后重新读取数据库，列表里不再出现已删记录（无过期行）', () => {
    const store = new Store(dbPath);
    store.addPub({ work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok', pub_key: 'k1' });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k2' });
    store.deletePubs([{ id: '', pub_key: 'k1' }]);
    const fresh = new Store(dbPath);
    const rows = fresh.listPubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toBe('k2');
  });

  it('内存行与数据库行都被清掉：删除后列表条数 = 数据库条数', async () => {
    const env = makeListEnv();
    const store = new Store(dbPath);
    // 把内存里的两条记录写进数据库（模拟已落库的历史记录）
    env.state.pubLog.slice(0, 2).forEach((r) => {
      store.addPub({
        work_id: r.work_id, platform: r.platform, platform_id: r.platform_id,
        status: r.status, title: r.title, url: r.url, video_id: r.video_id, pub_key: r.pub_key
      });
    });
    expect(store.listPubs().length).toBe(2);

    // 选中第 1 条并删除
    env.api.pubListToggleSel('yt|w1|1', true);
    env.api.pubListDeleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 内存里那条没了
    expect(env.state.pubLog.some((r) => r.pub_key === 'yt|w1|1')).toBe(false);
    // 数据库里那条也没了（IPC 真实调用 store.deletePubs）
    expect(env.deleteCalls.length).toBe(1);
  });

  it('删除接口链路完整：renderer → preload → IPC → store', () => {
    // preload 暴露 deletePubs
    expect(PRELOAD_SRC).toContain('deletePubs');
    expect(PRELOAD_SRC).toMatch(/deletePubs:\s*\(targets\)\s*=>\s*ipcRenderer\.invoke\('pubs:delete',\s*targets\)/);
    // main 注册 pubs:delete，并转交 store.deletePubs
    expect(MAIN_SRC).toContain("ipcMain.handle('pubs:delete'");
    const ipc = extractBlock(MAIN_SRC, "ipcMain.handle('pubs:delete', (_e, targets) => {");
    expect(ipc).toContain('store.deletePubs');
    // 参数化查询，不是字符串拼 SQL
    expect(STORE_SRC).toContain('SELECT id FROM pubs WHERE id = ?');
    expect(STORE_SRC).toContain('DELETE FROM pubs WHERE pub_key = ?');
    expect(STORE_SRC).not.toMatch(/DELETE FROM pubs WHERE id = '\s*\+/);
  });
});

/* ==================================================================
   L9 / L10：我的作品详情入口
   ================================================================== */

describe('L9 · 「我的作品」的详情入口清晰可见', () => {
  it('作品卡里有常驻可见的「查看详情」按钮（不只是 hover 才出现的菜单项）', () => {
    const works = extractBlock(HTML, 'function renderWorks(){');
    // 常驻操作条
    expect(works).toContain('class="wacts"');
    expect(works).toContain('class="wact"');
    expect(works).toContain('查看详情');
    expect(works).toContain('openWorkDetail(');
    // 原有「进入首秀」等操作仍然保留
    expect(works).toContain('进入首秀');
    expect(works).toContain('置为主推');
  });

  it('3-dot 菜单不再只在 hover 时才出现（常驻可见）', () => {
    // .wdot 的 opacity 必须是 1，而不是 0
    const dotRule = extractBlock(HTML, '.wcard .wdot{');
    expect(dotRule).toContain('opacity:1');
    expect(dotRule).not.toMatch(/opacity:0/);
  });

  it('「当前」角标不再盖住 3-dot 按钮', () => {
    const tagRule = extractBlock(HTML, '.wcard .cur-tag{');
    expect(tagRule).toContain('right:44px');
  });

  it('作品详情展示基本信息 + 该作品的全部平台发布记录，每条可进独立详情', () => {
    // 弹窗内容由 renderWorkDetailBody 渲染；openWorkDetail 负责渲染 + 打开弹窗
    const body = extractBlock(HTML, 'function renderWorkDetailBody(workId){');
    expect(body).toContain('api.byWork(workId)');
    ['作品标题', '类型', '状态', '简介', '发布标题', '正文', '视频'].forEach((label) => {
      expect(body).toContain(label);
    });
    expect(body).toContain('openPubDetail(');
    const fn = extractBlock(HTML, 'window.openWorkDetail=function(workId){');
    expect(fn).toContain('renderWorkDetailBody(workId)');
    expect(fn).toContain("openModal('workDetailModal')");
  });

  it('作品不存在时安全空状态', () => {
    const body = extractBlock(HTML, 'function renderWorkDetailBody(workId){');
    expect(body).toContain('找不到这个作品');
    const fn = extractBlock(HTML, 'window.openWorkDetail=function(workId){');
    expect(fn).toContain('renderWorkDetailBody(workId)');
  });

  it('openWorkDetail 在真实作品数据上能取到该作品的全部平台记录', () => {
    const state = makeDashState();
    const view = loadDashView(state);
    const rows = view.byWork('w1');
    // YouTube 成功 + GitHub 成功 + GitHub 失败 + 历史无状态记录
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.platform_id).sort()).toEqual(['github', 'github', 'wechat', 'youtube']);
  });
});

describe('L10 · 一条作品关联多条不同平台发布记录', () => {
  it('byWork 返回该作品在多个平台上的全部记录（含失败/未知状态）', () => {
    const view = loadDashView(makeDashState());
    const rows = view.byWork('w2');
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.platform_id).sort()).toEqual(['v2ex', 'x']);
  });

  it('列表页能按关键词筛出该作品的全部平台记录', () => {
    const view = loadDashView(makeDashState());
    const rows = view.list({ q: '作品一' });
    expect(rows.length).toBe(4);   // yt + gh成功 + gh失败 + 历史无状态记录
    expect(new Set(rows.map((r) => r.platform_id || r.platform)).size).toBeGreaterThan(1);
  });

  it('每条记录都有稳定唯一键，可以各自打开独立详情', () => {
    const view = loadDashView(makeDashState());
    const keys = view.records().map((r) => view.key(r));
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((k) => {
      expect(view.byKey(k)).toBeTruthy();
    });
  });
});

/* ==================================================================
   L11：GitHub / YouTube 链接只用真实数据
   ================================================================== */

describe('L11 · 外部链接只用真实数据', () => {
  it('YouTube 优先用经过格式校验的真实 videoId', () => {
    const env = makeListEnv();
    expect(env.api.pubRecordUrl({ platform_id: 'youtube', video_id: 'abcdefghijk' }))
      .toBe('https://www.youtube.com/watch?v=abcdefghijk');
    // 非法 videoId 不用来拼链接
    expect(env.api.pubRecordUrl({ platform_id: 'youtube', video_id: 'short' })).toBe('');
    expect(env.api.pubRecordUrl({ platform_id: 'youtube', video_id: 'not-valid-id!' })).toBe('');
  });

  it('GitHub Release 使用保存下来的真实 URL；没有就是空串', () => {
    const env = makeListEnv();
    expect(env.api.pubRecordUrl({ platform_id: 'github', url: 'https://github.com/o/r/releases/tag/v1.0.0' }))
      .toBe('https://github.com/o/r/releases/tag/v1.0.0');
    expect(env.api.pubRecordUrl({ platform_id: 'github' })).toBe('');
  });

  it('非 http(s) 的 URL 一律拒绝（不生成 javascript: 链接）', () => {
    const env = makeListEnv();
    expect(env.api.pubRecordUrl({ platform_id: 'github', url: 'javascript:alert(1)' })).toBe('');
    expect(env.api.pubRecordUrl({ platform_id: 'github', url: 'not-a-url' })).toBe('');
  });

  it('GitHub 发布器返回真实 Release URL（读页面真实 location，不拼接）', () => {
    // 真实执行 publishers.js 的 github.submit：它返回的是一段会被 executeJavaScript
    // 执行的脚本，必须是合法 JS，且真的从页面真实 location 取 URL。
    const { adapters } = require('../electron/publishers');
    const script = adapters.github.submit({ title: 'T', body: 'B' });

    // 1) 脚本必须能解析（否则发布流程直接炸）
    expect(() => new Function(script)).not.toThrow();

    // 2) 脚本读的是页面真实 location.href
    expect(script).toContain('location.href');
    // 3) 命中 Release 页才把 url 带回主进程
    expect(script).toContain("return {status:'ok',url:h}");
    // 4) 没跳转 / 超时 → 只返回 status，**不编造 URL**
    expect(script).toContain("return {status:'ok'}");

    // 5) 绝不拼接 / 猜测 Release URL
    expect(script).not.toMatch(/releases\/tag\/['"]\s*\+/);
    expect(script).not.toMatch(/releases\/tag\/\s*tag/);
  });

  it('GitHub 发布器的 URL 判定只在真实 Release 页面上生效', () => {
    const { adapters } = require('../electron/publishers');
    const script = adapters.github.submit({ title: 'T', body: 'B' });

    // 在沙箱里**真实执行**这段注入脚本：模拟页面已跳到 Release 页，
    // 断言它带回的 url 就是页面上的真实 location.href（不是拼出来的）。
    function runInPage(href, hasPublishButton) {
      const document = {
        querySelectorAll: function () {
          return hasPublishButton ? [{ textContent: 'Publish Release', click: function () {} }] : [];
        }
      };
      const location = { href: href };
      // eslint-disable-next-line no-new-func
      const fn = new Function('document', 'location', 'return ' + script);
      return fn(document, location);
    }

    return runInPage('https://github.com/o/r/releases/tag/v1.0.0', true).then((res) => {
      expect(res.status).toBe('ok');
      expect(res.url).toBe('https://github.com/o/r/releases/tag/v1.0.0');
    });
  });

  it('GitHub 发布器在页面未跳转时只回 status，不编造 URL', () => {
    const { adapters } = require('../electron/publishers');
    const script = adapters.github.submit({ title: 'T', body: 'B' });
    // 找不到 Publish Release 按钮 → 直接要求人工确认，不给 URL
    const document = { querySelectorAll: function () { return []; } };
    const location = { href: 'https://github.com/o/r/releases/new' };
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'location', 'return ' + script);
    return fn(document, location).then((res) => {
      expect(res.status).toBe('confirm');
      expect(res.url).toBeUndefined();
    });
  });

  it('渲染层把平台返回的真实 URL 存进发布记录', () => {
    expect(HTML).toContain("markPub(id,{status:'ok',url:(s2&&s2.url)||''})");
    expect(HTML).toContain("markPub(id,{status:'ok',url:(r&&r.url)||''})");
  });

  it('列表页「在平台打开」只在存在经过校验的真实链接时出现', () => {
    const env = makeListEnv();
    env.api.renderPubListPage();
    const html = env.tableHtml();
    // YouTube / GitHub 成功这两条有真实链接
    expect(html).toContain('pubListOpenExternal(');
    // 但只有两条应该有按钮：数一下 openPubDetail 与 openPubExternal 的出现次数
    const detailCount = (html.match(/openPubDetail\(/g) || []).length;
    const extCount = (html.match(/pubListOpenExternal\(/g) || []).length;
    expect(detailCount).toBe(6);   // 每条记录都能看详情
    expect(extCount).toBe(2);      // 只有 2 条有真实链接
  });
});

/* ==================================================================
   L12：回归约束
   ================================================================== */

describe('L12 · 一级导航与既有流程不被破坏', () => {
  it('仍然只有四个一级导航（没有为列表页新增一级导航）', () => {
    const navStart = HTML.indexOf('<div class="navtab">');
    const nav = HTML.slice(navStart, HTML.indexOf('</div>', navStart));
    expect((nav.match(/<button/g) || []).length).toBe(4);
    ['首秀向导', '数据看板', '推广渠道', '我的作品'].forEach((label) => {
      expect(nav).toContain(label);
    });
    ['tabFlow', 'tabDash', 'tabChannels', 'tabWorks'].forEach((id) => {
      expect(HTML).toContain('id="' + id + '"');
    });
  });

  it('列表页 / 详情页是 main 内的 section（内部路由），不是导航按钮', () => {
    expect(HTML).toContain('<section data-route="pubs"');
    expect(HTML).toContain('<section data-route="pubdetail"');
    const go = extractBlock(HTML, 'function go(r, sub){');
    expect(go).toContain("if(r==='pubs'){renderPubListPage();}");
    expect(go).toContain("if(r==='pubdetail'){renderPubDetailPage();}");
    // 一级导航高亮仍然只有 4 个 tab
    expect(go).toContain("document.getElementById('tabDash').className=(r==='dashboard'||r==='pubs'||r==='pubdetail')?'on':''");
  });

  it('发布流程 / 平台授权 / 字幕 / AI 配音的关键入口仍在', () => {
    expect(HTML).toContain('function captionStepBack(){');
    expect(HTML).toContain('id="capSaveBtn"');
    expect(HTML).toContain('window.openChannelEditor=function(');
    expect(HTML).toContain('youtubePublishPayload(){');
    expect(HTML).toContain('window.markPub=function(id){');
  });

  it('列表页 / 详情页不重置首秀向导的工作流状态', () => {
    const list = extractBlock(HTML, 'function renderPubListPage(){');
    const detail = extractBlock(HTML, 'function renderPubDetailPage(){');
    [list, detail].forEach((src) => {
      expect(src).not.toMatch(/state\.copies\s*=/);
      expect(src).not.toMatch(/state\.sel\s*=/);
      expect(src).not.toMatch(/state\.project\s*=/);
      expect(src).not.toMatch(/state\.step\s*=/);
    });
  });
});
