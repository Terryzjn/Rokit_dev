//
// Rokit · 「标记已发布」按钮状态切换 —— 定向测试
//
// 覆盖 8 个场景（严格对应需求）：
//   B1 初次进入页面，没有本次确认操作时，显示「标记已发布」
//   B2 数据库存在历史 manual 记录，但没有本次确认操作时，不得直接显示「撤回」
//   B3 点击「标记已发布」打开确认弹窗，按钮不提前变化
//   B4 取消弹窗，按钮保持「标记已发布」，不新增记录
//   B5 确认成功且链接为空，按钮才变成「撤回」
//   B6 确认成功且链接非空，按钮才变成灰色禁用的「已发布」
//   B7 撤回后恢复「标记已发布」，且只删除本次记录
//   B8 刷新页面 / 重新进入页面，不得把历史记录错误识别成本次新操作
//   B9 确认弹窗入口保留（confirmModal 仍被调用）
//  B10 写入失败 → 按钮不切换、状态回滚、明确提示
//
// 跑的是 **index.html 里的生产代码**（按花括号配平切出来，在沙箱里注入依赖后执行）：
//   pubMarkActionHtml / markPubManual / revokeManualMark / persistMarkedPub / markPub
//
// 全部使用**临时隔离数据库**：
//   **绝不写入活动数据库 .userdata/ai-launch-master.db，不调用任何真实平台 API**。
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

const SRC = [
  extractBlock(HTML, 'function manualScopeId(workId){'),
  extractBlock(HTML, 'function newCopiesBatchId(){'),
  extractBlock(HTML, 'function newManualOpId(){'),
  extractBlock(HTML, 'function isManualMarkPubKey(key){'),
  extractBlock(HTML, 'function manualPubKey(pid,scope,opId){'),
  extractBlock(HTML, 'function pubKeyFor(pid,workId,status,opts,scope){'),
  extractBlock(HTML, 'function findReusablePubKey(pid,workId,scope){'),
  extractBlock(HTML, 'function rememberPendingPub(scope,pubKey){'),
  extractBlock(HTML, 'function persistMarkedPub(payload,rollback){'),
  extractBlock(HTML, 'window.markPub=function(id){'),
  extractBlock(HTML, 'function pubMarkActionHtml(id,c){'),
  extractBlock(HTML, 'window.markPubManual=function(id){'),
  extractBlock(HTML, 'window.revokeManualMark=function(id){')
].join('\n');

/* ---------- 临时库 ---------- */
let tmpDir;
let mod;
let store;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  mod = H.loadStoreFresh(false);          // 屏蔽 better-sqlite3 → 用 node:sqlite（临时库）
  store = new mod.Store(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
});

/* ---------- 运行环境 ---------- */
function makeEnv(opts) {
  const o = opts || {};
  const state = o.state || {
    copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
    curWork: 'w1',
    works: [{ id: 'w1', name: '作品一' }],
    planOwnerId: 'w1',
    copiesOwner: 'w1',
    planDirty: false,
    kpis: {},
    pubByPlatform: {},
    pubLog: [],
    milestones: []
  };
  const calls = { renderFlow: 0, addPub: [], revoke: [], confirm: [] };
  const toasts = [];
  // 确认弹窗：可控制"用户点了确认 / 取消"，并可选择填写的链接
  let confirmResolve = null;
  const confirmModal = function (c) {
    calls.confirm.push(c);
    return new Promise(function (resolve) { confirmResolve = resolve; });
  };
  const windowStub = {
    api: {
      addPub: function (payload) {
        calls.addPub.push(payload);
        if (o.addPubFails) return Promise.reject(new Error('模拟写入失败'));
        return Promise.resolve(store.addPub(payload));
      },
      revokePub: function (pubKey) {
        calls.revoke.push(pubKey);
        if (o.revokeResult) return Promise.resolve(o.revokeResult);
        const res = store.deleteManualPub(pubKey);
        return Promise.resolve(res && res.deleted
          ? { ok: true, deleted: res.deleted, id: res.id, key: pubKey }
          : { ok: false, deleted: 0, error: '未找到对应的手动标记发布记录' });
      },
      oauthStatus: function () { return Promise.resolve({ connected: false }); }
    },
    attachPubWork: null
  };
  const fn = new Function(
    'window', 'state', 'pf', 'findWork', 'nowHM', 'toast', 'renderFlow',
    'pushMilestoneIfFirst', 'confirmModal', 'pubAccountOf', 'console',
    'markPub', 'revokeManualMark',
    SRC + '\nreturn { markPub: window.markPub, markPubManual: window.markPubManual,'
    + ' revokeManualMark: window.revokeManualMark, pubMarkActionHtml: pubMarkActionHtml };'
  );
  // 浏览器里 window === globalThis，所以 `markPub(...)` 这种裸调用能拿到 window.markPub。
  // 沙箱里 window 只是个普通对象 → 用 holder 做一层惰性转发，等价于浏览器的全局查找。
  const holder = {};
  const api = fn(
    windowStub, state,
    function (id) { return { id: id, name: id === 'github' ? 'GitHub' : id }; },
    function (id) { if (!id) return null; return (state.works || []).filter(function (w) { return w.id === id; })[0] || null; },
    function () { return '10:00'; },
    function (m, level) { toasts.push({ msg: m, level: level }); },
    function () { calls.renderFlow++; },
    function () {},
    confirmModal,
    function () { return Promise.resolve(''); },
    console,
    function () { return holder.markPub.apply(this, arguments); },
    function () { return holder.revokeManualMark.apply(this, arguments); }
  );
  holder.markPub = api.markPub;
  holder.revokeManualMark = api.revokeManualMark;
  return {
    state: state, calls: calls, toasts: toasts, api: api, window: windowStub,
    // 模拟用户在确认弹窗里点「确认已发布」（value = 填写的链接）
    confirm: function (value) { confirmResolve({ value: value === undefined ? '' : value }); },
    // 模拟用户点「取消」
    cancel: function () { confirmResolve(false); },
    button: function (pid) { return api.pubMarkActionHtml(pid || 'github', state.copies[pid || 'github']); }
  };
}

// 按钮文本标记：用 >…< 精确区分「标记已发布」与「已发布」（后者是禁用按钮）
const BTN_MARK = '>标记已发布<';
const BTN_REVOKE = '>撤回<';
const BTN_PUBLISHED = '>已发布<';

function flush() {
  // 等待若干轮微任务 + 一次宏任务，确保「确认 → 写入 → 登记操作状态」整条链路走完
  return new Promise(function (r) { setTimeout(r, 0); })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
}

/* ================================================================== */

describe('「标记已发布」按钮状态 · 初始状态与历史记录', () => {
  it('B1 初次进入页面（没有本次确认操作）→ 显示「标记已发布」', () => {
    const env = makeEnv();
    const html = env.button('github');
    expect(html).toContain(BTN_MARK);
    expect(html).not.toContain(BTN_REVOKE);
    expect(html).not.toContain(BTN_PUBLISHED);
    expect(html).toContain("markPubManual('github')");
  });

  it('B2 数据库存在历史 manual 记录，但没有本次确认操作 → 不得显示「撤回」', () => {
    // 库里有一条历史手动标记记录
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', body: '', tags: '', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|w1|mk_history_op_1'
    });
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: 'w1', works: [{ id: 'w1', name: '作品一' }],
        planOwnerId: 'w1', copiesOwner: 'w1', planDirty: false,
        kpis: {}, pubByPlatform: {},
        // 模拟页面初始化时从 DB 回填了历史记录（含那条 manual）
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'manual',
          title: '历史手动记录', work_id: 'w1', pub_key: 'manual|github|w1|mk_history_op_1'
        }],
        milestones: []
      }
    });
    const html = env.button('github');
    expect(html).toContain(BTN_MARK);   // ← 关键：历史记录不能把按钮变成「撤回」
    expect(html).not.toContain(BTN_REVOKE);
    expect(html).not.toContain('revokeManualMark');
  });

  it('B8 刷新页面 / 重新进入页面 → 历史记录不会被识别成本次新操作', () => {
    // 模拟刷新：copies 被重置（新的会话），但 pubLog 仍有历史记录
    const env = makeEnv();
    env.state.copies = { github: { title: '标题', body: '正文', tags: [], done: false, time: '' } };
    env.state.pubLog = [{
      recId: 1, platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', work_id: 'w1', pub_key: 'manual|github|w1|mk_history_op_1'
    }];
    const html = env.button('github');
    expect(html).toContain(BTN_MARK);
    expect(html).not.toContain(BTN_REVOKE);
    // 也没有登记任何本次操作状态
    expect(env.state.copies.github.manualMarkOp).toBeUndefined();
  });
});

describe('「标记已发布」按钮状态 · 弹窗与确认时序', () => {
  it('B3 点「标记已发布」打开确认弹窗 → 按钮不提前变化，也不写记录', () => {
    const env = makeEnv();
    env.api.markPubManual('github');

    // 确认弹窗确实被调用（入口保留）
    expect(env.calls.confirm.length).toBe(1);
    expect(env.calls.confirm[0].title).toBe('标记已发布');
    expect(env.calls.confirm[0].okLabel).toBe('确认已发布');

    // 弹窗打开期间：按钮仍是「标记已发布」，且**没有**写入任何记录
    expect(env.button('github')).toContain(BTN_MARK);
    expect(env.button('github')).not.toContain(BTN_REVOKE);
    expect(env.calls.addPub.length).toBe(0);
    expect(store.listPubs().length).toBe(0);
  });

  it('B9 确认弹窗入口保留：markPubManual 仍然调用 confirmModal', () => {
    expect(HTML).toContain('window.markPubManual=function(id){');
    expect(HTML).toMatch(/window\.markPubManual=function\(id\)\{[\s\S]*confirmModal\(/);
  });

  it('B4 取消弹窗 → 不写记录、按钮保持「标记已发布」、发布次数不变', async () => {
    const env = makeEnv();
    env.api.markPubManual('github');
    env.cancel();
    await flush();

    expect(env.calls.addPub.length).toBe(0);
    expect(store.listPubs().length).toBe(0);
    expect(env.state.pubByPlatform.github).toBeUndefined();
    expect(env.state.pubLog.length).toBe(0);
    const html = env.button('github');
    expect(html).toContain(BTN_MARK);
    expect(html).not.toContain(BTN_REVOKE);
    expect(env.state.copies.github.manualMarkOp).toBeUndefined();
  });

  it('B5 确认成功且链接为空 → 按钮才变成「撤回」', async () => {
    const env = makeEnv();
    env.api.markPubManual('github');
    env.confirm('');            // 确认，链接留空
    await flush(); await flush();

    expect(env.calls.addPub.length).toBe(1);
    expect(store.listPubs().length).toBe(1);
    const html = env.button('github');
    expect(html).toContain(BTN_REVOKE);
    expect(html).toContain("revokeManualMark('github')");
    expect(html).not.toContain(BTN_MARK);
    // 本次操作状态已登记，且带完整 pub_key
    const op = env.state.copies.github.manualMarkOp;
    expect(op).toBeTruthy();
    expect(op.pub_key).toMatch(/^manual\|github\|w1\|mk_/);
    expect(op.url).toBe('');
  });

  it('B6 确认成功且链接非空 → 按钮变成灰色禁用的「已发布」', async () => {
    const env = makeEnv();
    env.api.markPubManual('github');
    env.confirm('https://github.com/o/r/releases/tag/v1');   // 确认，带链接
    await flush(); await flush();

    expect(store.listPubs().length).toBe(1);
    const html = env.button('github');
    expect(html).toContain(BTN_PUBLISHED);
    expect(html).toContain('disabled');            // 灰色禁用
    expect(html).not.toContain(BTN_REVOKE);
    expect(html).not.toContain('revokeManualMark');
    // 链接被记录进本次操作状态
    expect(env.state.copies.github.manualMarkOp.url).toBe('https://github.com/o/r/releases/tag/v1');
  });

  it('B10 写入失败 → 按钮不切换、内存状态回滚、明确提示', async () => {
    const env = makeEnv({ addPubFails: true });
    env.api.markPubManual('github');
    env.confirm('');
    await flush(); await flush();

    // 按钮仍是「标记已发布」
    expect(env.button('github')).toContain(BTN_MARK);
    expect(env.button('github')).not.toContain(BTN_REVOKE);
    // 内存里没有留下假记录 / 假操作状态
    expect(env.state.pubLog.length).toBe(0);
    expect(env.state.copies.github.manualMarkOp).toBeUndefined();
    // 发布次数没有增长（回滚到 0 = 未计数）
    expect(env.state.pubByPlatform.github || 0).toBe(0);
    // 有明确的失败提示
    expect(env.toasts.some(function (t) { return String(t.msg).indexOf('发布记录写入失败') >= 0; })).toBe(true);
  });
});

describe('「标记已发布」按钮状态 · 撤回', () => {
  it('B7 撤回后恢复「标记已发布」，且只删除本次记录', async () => {
    const env = makeEnv();
    // 先塞一条历史手动记录（撤回**绝不能**碰它）
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', body: '', tags: '', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|w1|mk_history_op_1'
    });
    env.state.pubLog = [{
      recId: 1, platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', work_id: 'w1', pub_key: 'manual|github|w1|mk_history_op_1'
    }];

    // 本次确认（链接为空 → 按钮是「撤回」）
    env.api.markPubManual('github');
    env.confirm('');
    await flush(); await flush();
    expect(env.button('github')).toContain(BTN_REVOKE);
    expect(store.listPubs().length).toBe(2);

    // 撤回
    env.api.revokeManualMark('github');
    await flush(); await flush();

    // 只删了本次那条；历史记录原封不动
    const rows = store.listPubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toBe('manual|github|w1|mk_history_op_1');
    expect(rows[0].title).toBe('历史手动记录');
    // 走的是 revokePub 通道，且传的是本次记录的完整 pub_key
    expect(env.calls.revoke.length).toBe(1);
    expect(env.calls.revoke[0]).toMatch(/^manual\|github\|w1\|mk_/);
    // 按钮恢复「标记已发布」
    const html = env.button('github');
    expect(html).toContain(BTN_MARK);
    expect(html).not.toContain(BTN_REVOKE);
    expect(env.state.copies.github.manualMarkOp).toBeUndefined();
  });

  it('撤回失败 → 保留当前状态（仍是「撤回」）并提示错误', async () => {
    const env = makeEnv();
    env.api.markPubManual('github');
    env.confirm('');
    await flush(); await flush();
    expect(env.button('github')).toContain(BTN_REVOKE);

    // 模拟主进程返回失败
    env.window.api.revokePub = function () { return Promise.resolve({ ok: false, deleted: 0, error: '未找到对应的手动标记发布记录' }); };
    env.api.revokeManualMark('github');
    await flush(); await flush();

    // 状态保留 + 有提示
    expect(env.button('github')).toContain(BTN_REVOKE);
    expect(env.toasts.some(function (t) { return String(t.msg).indexOf('撤回失败') >= 0; })).toBe(true);
  });

  it('没有本次确认操作时点撤回 → 什么都不做（绝不删历史记录）', async () => {
    const env = makeEnv();
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', body: '', tags: '', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|w1|mk_history_op_1'
    });
    env.api.revokeManualMark('github');
    await flush();
    expect(env.calls.revoke.length).toBe(0);
    expect(store.listPubs().length).toBe(1);
  });
});
