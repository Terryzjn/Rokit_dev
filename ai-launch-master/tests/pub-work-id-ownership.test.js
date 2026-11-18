//
// Rokit · 发布记录的作品归属（v1.30 修复）—— 定向测试
//
// 覆盖本次修复的核心不变量：
//   T1  改名派生期间（curWork='w1' 旧作品 + planOwnerId='draft_x' 草稿）
//       → 手动发布记录的 work_id 为**空**（绝不挂到旧作品 w1）
//   T2  同一场景下 manual scope 使用 draft_x，而不是 w1
//   T3  新作品 w4 落库后，记录正确回填到 w4
//   T4  回填前后 pub_key 保持不变
//   T5  自动发布在相同场景下也能正确登记和回填
//   T6  已有真实作品 w4 的发布仍直接关联 w4（不产生待回填状态）
//   T7  两个不同草稿分别回填到各自作品，不发生串联
//   T8  store._planPubState 能正确识别修复后的发布记录
//   T9  自动发布幂等键在改名派生期间不再携带旧作品 ID
//  T10  历史键兼容性：旧三段式 / plan 四段式 / 手动四段式键的识别与复用规则不变
//
// 跑的是 **index.html 里的生产代码**（按花括号配平切出来，在沙箱里注入依赖后执行）：
//   newPubKey / manualScopeId / pubKeyFor / findReusablePubKey / rememberPendingPub /
//   flushPendingPubWork / persistMarkedPub / markPub / attachPubWork /
//   planTransferAfterSave
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

const SRC = [
  extractBlock(HTML, 'function newPubKey(pid){'),
  extractBlock(HTML, 'function manualScopeId(workId){'),
  extractBlock(HTML, 'function newCopiesBatchId(){'),
  extractBlock(HTML, 'function newManualOpId(){'),
  extractBlock(HTML, 'function isManualMarkPubKey(key){'),
  extractBlock(HTML, 'function manualPubKey(pid,scope,opId){'),
  extractBlock(HTML, 'function pubKeyFor(pid,workId,status,opts,scope){'),
  extractBlock(HTML, 'function findReusablePubKey(pid,workId,scope){'),
  extractBlock(HTML, 'function rememberPendingPub(scope,pubKey){'),
  extractBlock(HTML, 'function flushPendingPubWork(workId,scopes){'),
  extractBlock(HTML, 'function persistMarkedPub(payload,rollback){'),
  extractBlock(HTML, 'window.markPub=function(id){'),
  extractBlock(HTML, 'window.attachPubWork=function(pubKey,workId){'),
  extractBlock(HTML, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){')
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
    works: [{ id: 'w1', name: '旧作品' }],
    planOwnerId: 'draft_x',
    copiesOwner: 'draft_x',
    planDirty: false,
    kpis: {},
    pubByPlatform: {},
    pubLog: [],
    milestones: []
  };
  const calls = { renderFlow: 0, addPub: [] };
  const windowStub = {
    api: {
      addPub: function (payload) {
        calls.addPub.push(payload);
        return Promise.resolve(store.addPub(payload));
      },
      saveWork: o.saveWork || function (w) { return Promise.resolve({ id: w.id, name: w.name }); },
      planReassign: function () { return Promise.resolve({ ok: true }); }
    },
    attachPubWork: null
  };
  const fn = new Function(
    'window', 'state', 'pf', 'findWork', 'nowHM', 'toast', 'renderFlow',
    'pushMilestoneIfFirst', 'console',
    SRC + '\nreturn { markPub: window.markPub, attachPubWork: window.attachPubWork,'
    + ' planTransferAfterSave: window.planTransferAfterSave,'
    + ' newPubKey: newPubKey, manualScopeId: manualScopeId, pubKeyFor: pubKeyFor,'
    + ' flushPendingPubWork: flushPendingPubWork };'
  );
  const api = fn(
    windowStub, state,
    function (id) { return { id: id, name: id === 'github' ? 'GitHub' : id }; },
    function (id) { if (!id) return null; return (state.works || []).filter(function (w) { return w.id === id; })[0] || null; },
    function () { return '10:00'; },
    function () {},
    function () { calls.renderFlow++; },
    function () {},
    console
  );
  windowStub.attachPubWork = api.attachPubWork;
  return { state: state, calls: calls, api: api, window: windowStub };
}

function pubs() { return store.listPubs(); }

/** 改名派生场景：curWork 仍是旧作品 w1，本次归属是草稿 draft_x */
function renameState(extra) {
  return Object.assign({
    copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
    curWork: 'w1',
    works: [{ id: 'w1', name: '旧作品' }],
    planOwnerId: 'draft_x',
    copiesOwner: 'draft_x',
    planDirty: false,
    kpis: {},
    pubByPlatform: {},
    pubLog: [],
    milestones: []
  }, extra || {});
}

// =========================================================================
// T1 / T2 / T4 · 手动发布在改名派生期间的归属
// =========================================================================
describe('T1 / T2 · 改名派生期间：手动发布记录不得挂到旧作品', () => {
  it('T1 · work_id 为空（绝不挂到旧作品 w1），并登记待回填', () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    expect(rows.length).toBe(1);
    // ★ 核心断言：不是旧作品 w1
    expect(rows[0].work_id).toBe('');
    expect(rows[0].work_id).not.toBe('w1');
    // 内存态也一致
    expect(env.state.pubLog[0].work_id).toBe('');
    // 已登记待回填（作用域 = 草稿归属）
    expect(env.state._pendingPubKeys.length).toBe(1);
    expect(env.state._pendingPubScope[env.state._pendingPubKeys[0]]).toBe('draft_x');
  });

  it('T2 · manual scope 使用 draft_x，而不是 w1', () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    // pub_key = manual|<platform_id>|<scope>|<op_id>
    expect(rows[0].pub_key).toMatch(/^manual\|github\|draft_x\|mk_[0-9a-fA-F-]+$/);
    expect(rows[0].pub_key).not.toContain('|w1|');
    // scope 段的取值就是草稿归属
    expect(env.api.manualScopeId('')).toBe('draft_x');
    expect(env.api.manualScopeId('w1')).toBe('draft_x');   // 即使传入旧 workId 也必须用草稿
  });

  it('T2b · 真实作品归属下 scope 仍用作品 ID（既有行为不变）', () => {
    const env = makeEnv({
      state: renameState({ planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4', works: [{ id: 'w4', name: '作品四' }] })
    });
    expect(env.api.manualScopeId('w4')).toBe('w4');
  });
});

// =========================================================================
// T3 / T4 · 新作品落库后回填
// =========================================================================
describe('T3 / T4 · 新作品落库后正确回填', () => {
  it('T3 · 新作品 w4 落库后记录回填到 w4', async () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const keyBefore = pubs()[0].pub_key;
    expect(pubs()[0].work_id).toBe('');

    // 新作品落库（唯一会颁发正式作品 ID 的地方）+ 计划归属转正
    const res = await env.api.planTransferAfterSave({ id: 'w4', name: '新作品' }, 'draft_x', true);
    expect(res.ok).toBe(true);

    const rows = pubs();
    expect(rows.length).toBe(1);            // upsert，不新增行
    expect(rows[0].work_id).toBe('w4');
    // 旧作品 w1 从未出现
    expect(rows[0].work_id).not.toBe('w1');
  });

  it('T4 · 回填前后 pub_key 保持不变', async () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const keyBefore = pubs()[0].pub_key;

    await env.api.planTransferAfterSave({ id: 'w4', name: '新作品' }, 'draft_x', true);

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toBe(keyBefore);
    expect(rows[0].pub_key).toMatch(/^manual\|github\|draft_x\|mk_/);
  });

  it('T4b · 回填后待回填状态被清理（不重复回填）', async () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    expect(env.state._pendingPubKeys.length).toBe(1);

    await env.api.planTransferAfterSave({ id: 'w4', name: '新作品' }, 'draft_x', true);

    expect(env.state._pendingPubKeys.length).toBe(0);
    expect(env.state._pendingPubScope).toEqual({});
    // 再次回填 → 无事发生
    const again = env.api.flushPendingPubWork('w4', ['draft_x']);
    expect(again).toBe(0);
    expect(pubs().length).toBe(1);
  });
});

// =========================================================================
// T5 · 自动发布在相同场景下也能登记与回填
// =========================================================================
describe('T5 · 自动发布在改名派生期间同样正确', () => {
  it('T5 · 自动发布（status=ok）work_id 为空 + 登记待回填 + 落库后回填', async () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'ok', url: 'https://github.com/o/r' });

    let rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('');
    expect(rows[0].work_id).not.toBe('w1');
    expect(env.state._pendingPubKeys.length).toBe(1);
    expect(env.state._pendingPubScope[env.state._pendingPubKeys[0]]).toBe('draft_x');

    await env.api.planTransferAfterSave({ id: 'w4', name: '新作品' }, 'draft_x', true);

    rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('w4');
  });

  it('T9 · 自动发布幂等键在改名派生期间不再携带旧作品 ID', () => {
    const env = makeEnv({ state: renameState() });
    const key = env.api.newPubKey('github');
    const segs = key.split('|');
    expect(segs.length).toBe(3);                     // 键结构不变
    expect(segs[0]).toBe('github');
    expect(segs[1]).toBe('draft_x');                 // 归属段 = 草稿
    expect(segs[1]).not.toBe('w1');
    expect(key).toMatch(/^github\|draft_x\|[a-z0-9]+-[a-z0-9]+$/);
  });

  it('T9b · 真实作品归属下自动幂等键仍携带该作品 ID', () => {
    const env = makeEnv({
      state: renameState({ planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4', works: [{ id: 'w4', name: '作品四' }] })
    });
    const key = env.api.newPubKey('youtube');
    expect(key.split('|')[1]).toBe('w4');
  });
});

// =========================================================================
// T6 · 正常场景保护
// =========================================================================
describe('T6 · 已落库作品的发布仍直接关联', () => {
  it('T6 · 真实作品 w4 → work_id 直接是 w4，不产生待回填状态', () => {
    const env = makeEnv({
      state: renameState({
        planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4',
        works: [{ id: 'w1', name: '旧作品' }, { id: 'w4', name: '作品四' }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('w4');
    expect(rows[0].pub_key).toMatch(/^manual\|github\|w4\|mk_/);
    // 不产生任何待回填状态
    expect(env.state._pendingPubKeys || []).toEqual([]);
  });

  it('T6b · 已落库作品的自动发布同样直接关联', () => {
    const env = makeEnv({
      state: renameState({
        planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4',
        works: [{ id: 'w4', name: '作品四' }]
      })
    });
    env.api.markPub('youtube', { status: 'ok', url: 'https://yt/x' });
    expect(pubs()[0].work_id).toBe('w4');
    expect(env.state._pendingPubKeys || []).toEqual([]);
  });

  it('T6c · 没有任何归属 → work_id 留空，绝不猜测旧作品', () => {
    const env = makeEnv({
      state: renameState({ planOwnerId: '', copiesOwner: '', curWork: '' })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const rows = pubs();
    expect(rows[0].work_id).toBe('');
    expect(rows[0].work_id).not.toBe('w1');
  });
});

// =========================================================================
// T7 · 两个不同草稿不串联
// =========================================================================
describe('T7 · 不同草稿各自回填，不串联', () => {
  it('T7 · draft_a 与 draft_b 各自回填到各自作品', async () => {
    const env = makeEnv({ state: renameState() });

    // 第一个草稿：draft_a
    env.state.planOwnerId = 'draft_a';
    env.state.copiesOwner = 'draft_a';
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '作品A' });

    // 第二个草稿：draft_b
    env.state.planOwnerId = 'draft_b';
    env.state.copiesOwner = 'draft_b';
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '作品B' });

    expect(env.state._pendingPubKeys.length).toBe(2);

    // 作品 A 落库 → 只回填 draft_a 作用域
    await env.api.planTransferAfterSave({ id: 'wA', name: '作品A' }, 'draft_a', true);

    let rows = pubs();
    expect(rows.length).toBe(2);
    const byTitle = {};
    rows.forEach(function (r) { byTitle[r.title] = r; });
    expect(byTitle['作品A'].work_id).toBe('wA');
    expect(byTitle['作品B'].work_id).toBe('');        // 还没有落库 → 保持待回填
    expect(env.state._pendingPubKeys.length).toBe(1);

    // 作品 B 落库 → 只回填 draft_b 作用域
    await env.api.planTransferAfterSave({ id: 'wB', name: '作品B' }, 'draft_b', true);

    rows = pubs();
    expect(rows.length).toBe(2);
    const byTitle2 = {};
    rows.forEach(function (r) { byTitle2[r.title] = r; });
    expect(byTitle2['作品A'].work_id).toBe('wA');
    expect(byTitle2['作品B'].work_id).toBe('wB');
    expect(env.state._pendingPubKeys.length).toBe(0);
  });
});

// =========================================================================
// T8 · store._planPubState 能识别修复后的记录
// =========================================================================
describe('T8 · store._planPubState 识别修复后的发布记录', () => {
  it('T8 · 回填到 w4 后，计划任务能用 work_id 认到这条 manual 记录', async () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const key = pubs()[0].pub_key;

    await env.api.planTransferAfterSave({ id: 'w4', name: '新作品' }, 'draft_x', true);

    // 模拟一条 w4 的 GitHub 计划任务（pub_key 与发布记录一致）
    const task = { work_id: 'w4', platform_id: 'github', pub_key: key, simulated: false };
    const st = store._planPubState(task);
    expect(st.pub_state).toBe('done');
    // 且 _planFindConfirmedPub 能找到这条记录
    const found = store._planFindConfirmedPub(task);
    expect(found).toBeTruthy();
    expect(String(found.work_id)).toBe('w4');
  });

  it('T8b · 回填前的记录（work_id 为空）不会被误认成 w4 的成功记录', () => {
    const env = makeEnv({ state: renameState() });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const key = pubs()[0].pub_key;

    const task = { work_id: 'w4', platform_id: 'github', pub_key: key, simulated: false };
    expect(store._planPubState(task).pub_state).toBe('none');
    expect(store._planFindConfirmedPub(task)).toBeFalsy();
  });
});

// =========================================================================
// T10 · 历史键兼容性
// =========================================================================
describe('T10 · 历史键兼容性与复用规则不变', () => {
  it('T10a · 历史手动四段式键不被复用（新的独立标记自己成为一条新记录）', () => {
    // 历史记录**落库**（模拟真实历史数据）
    store.addPub({
      work_id: 'w4', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', body: '', tags: '', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|w4|mk_history_op_1'
    });
    const env = makeEnv({
      state: renameState({
        planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4',
        works: [{ id: 'w4', name: '作品四' }],
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'manual',
          title: '历史手动记录', work_id: 'w4', pub_key: 'manual|github|w4|mk_history_op_1'
        }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    expect(rows.length).toBe(2);                       // 新增一条，不覆盖历史
    const keys = rows.map(function (r) { return r.pub_key; });
    expect(keys.filter(function (k) { return /^manual\|github\|w4\|mk_/.test(k); }).length).toBe(2);
    // 历史那条原封不动
    const hist = rows.filter(function (r) { return r.pub_key === 'manual|github|w4|mk_history_op_1'; })[0];
    expect(hist.title).toBe('历史手动记录');
    expect(hist.status).toBe('manual');
  });

  it('T10b · 历史成功记录（status=ok）不被复用', () => {
    store.addPub({
      work_id: 'w4', platform: 'GitHub', platform_id: 'github', status: 'ok',
      title: '历史成功记录', body: '', tags: '', time: '09:00', url: 'https://gh/x', error: '', video_id: '',
      pub_key: 'github|w4|mwhistorical'
    });
    const env = makeEnv({
      state: renameState({
        planOwnerId: 'w4', copiesOwner: 'w4', curWork: 'w4',
        works: [{ id: 'w4', name: '作品四' }],
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'ok',
          title: '历史成功记录', work_id: 'w4', pub_key: 'github|w4|mwhistorical'
        }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    expect(rows.length).toBe(2);
    const manualRows = rows.filter(function (r) { return r.status === 'manual'; });
    expect(manualRows.length).toBe(1);
    expect(manualRows[0].pub_key).toMatch(/^manual\|github\|w4\|mk_/);
    // 历史成功记录不被改写
    const hist = rows.filter(function (r) { return r.pub_key === 'github|w4|mwhistorical'; })[0];
    expect(hist.status).toBe('ok');
    expect(hist.title).toBe('历史成功记录');
  });

  it('T10c · 草稿归属下：同归属的 pending 自动记录被复用（只保留一条）', () => {
    const env = makeEnv({
      state: renameState({
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'pending',
          title: '草稿待发布', work_id: '', pub_key: 'github|draft_x|mwpending'
        }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    // 复用那条 pending → 升级为 manual，不新增第二条
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].status).toBe('manual');
    expect(env.state.pubLog[0].pub_key).toBe('github|draft_x|mwpending');
  });

  it('T10d · 草稿归属下：别的归属的 pending 记录绝不被复用', () => {
    const env = makeEnv({
      state: renameState({
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'pending',
          title: '别的归属待发布', work_id: '', pub_key: 'github|draft_other|mwpending'
        }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    // 不复用 → 新增一条独立的四段式手动键记录
    expect(env.state.pubLog.length).toBe(2);
    const manualRows = env.state.pubLog.filter(function (r) { return r.status === 'manual'; });
    expect(manualRows.length).toBe(1);
    expect(manualRows[0].pub_key).toMatch(/^manual\|github\|draft_x\|mk_/);
  });

  it('T10e · plan 四段式键不参与自动记录的复用匹配', () => {
    const env = makeEnv({
      state: renameState({
        pubLog: [{
          recId: 1, platform: 'GitHub', platform_id: 'github', status: 'pending',
          title: '计划待发布', work_id: '', pub_key: 'plan|draft_x|ps_abc|github'
        }]
      })
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    expect(env.state.pubLog.length).toBe(2);            // 未复用 → 新增一条
    const manualRows = env.state.pubLog.filter(function (r) { return r.status === 'manual'; });
    expect(manualRows.length).toBe(1);
    expect(manualRows[0].pub_key).toMatch(/^manual\|github\|draft_x\|mk_/);
  });

  it('T10f · 撤回通道仍只接受四段式手动键（历史三段式键不受影响）', () => {
    // store 层的手动键判定（生产源码）
    const storeSrc = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    const fn = extractBlock(storeSrc, 'function isManualOpPubKey(key) {');
    const isManual = new Function('return (' + fn + ')')();
    expect(isManual('manual|github|w4|mk_1234')).toBe(true);
    expect(isManual('manual|github|w4')).toBe(false);          // 旧三段式 → 不认
    expect(isManual('github|w4|ts')).toBe(false);              // 自动键 → 不认
    expect(isManual('plan|draft_x|ps_abc|github')).toBe(false); // 计划键 → 不认
  });
});
