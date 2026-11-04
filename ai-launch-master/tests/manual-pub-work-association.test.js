// Rokit · 手动标记发布的「唯一身份」与「作品关联」—— 定向测试
//
// 覆盖本批的 6 个场景：
//   S1 作品已落库：手动标记后，记录关联正确（work_id + 幂等键都带作品身份）
//   S2 作品尚未落库：手动标记后，**保存作品**（不点「开始发射」）记录也能自动关联
//   S3 两个尚未落库的不同作品，同一平台分别手动标记 → 两条记录都保留，互不覆盖
//   S4 同一作品、同一平台**两次独立**手动标记 → 两条独立记录（各自操作 ID），互不覆盖
//   S5 作品保存失败 → 待关联记录不会被错误关联
//   S6 重新加载 / 重复回填 → 不出现错误关联，也不产生重复行
//
// 幂等键格式（手动标记）：manual|<platform_id>|<scope>|<op_id>
//   op_id = 'mk_' + crypto.randomUUID() → 每次**独立**标记都不同；
//   同一操作重试（复用同一个 op_id）→ 同一个键 → 只对应一条记录。
//
// 全部使用**临时独立数据库**（node:sqlite，临时目录）与注入的 mock：
//   **绝不写入活动数据库 .userdata/ai-launch-master.db，不调用任何真实平台 API**。
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/plan-store');

const ROOT = H.ROOT;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;
let mod;
let store;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
  mod = H.loadStoreFresh(false);          // 屏蔽 better-sqlite3 → 用 node:sqlite（临时库）
  store = new mod.Store(dbPath);
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
});

/* ---------- 从 index.html 源码切出被测函数（与既有发布记录测试同一手法） ---------- */
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
  extractBlock(HTML, 'function flushPendingPubWork(workId,scopes){'),
  extractBlock(HTML, 'function persistMarkedPub(payload,rollback){'),
  extractBlock(HTML, 'window.attachPubWork=function(pubKey,workId){'),
  extractBlock(HTML, 'window.markPub=function(id){'),
  extractBlock(HTML, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){')
].join('\n');

/**
 * 构造 renderer 侧的运行环境：
 *   - window.api.addPub → 真实 store.addPub（落到临时库）
 *   - window.api.saveWork → 由用例指定（resolve / reject）
 *   - window.api.planReassign → 桩
 */
function makeEnv(opts) {
  const o = opts || {};
  const state = o.state || {
    copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
    curWork: null,
    works: [],
    planOwnerId: '',
    copiesOwner: '',
    planDirty: false,
    kpis: {},
    pubByPlatform: {},
    pubLog: [],
    milestones: []
  };
  const toasts = [];
  const calls = { renderFlow: 0, addPub: [] };
  const windowStub = {
    api: {
      addPub: function (payload) {
        calls.addPub.push(payload);
        return Promise.resolve(store.addPub(payload));
      },
      saveWork: o.saveWork || function () { return Promise.resolve(o.savedWork || null); },
      planReassign: function () { return Promise.resolve({ ok: true }); }
    },
    attachPubWork: null
  };
  const fn = new Function(
    'window', 'state', 'pf', 'findWork', 'nowHM', 'toast', 'renderFlow',
    'pushMilestoneIfFirst', 'console',
    SRC + '\nreturn { markPub: window.markPub, attachPubWork: window.attachPubWork,'
    + ' flushPendingPubWork: flushPendingPubWork, rememberPendingPub: rememberPendingPub,'
    + ' manualScopeId: manualScopeId, manualPubKey: manualPubKey,'
    + ' planTransferAfterSave: window.planTransferAfterSave };'
  );
  const api = fn(
    windowStub, state,
    function (id) { return { id: id, name: id === 'github' ? 'GitHub' : id }; },
    function (id) { return (state.works || []).filter(w => w.id === id)[0] || null; },
    function () { return '10:00'; },
    function (m, level) { toasts.push({ msg: m, level: level }); },
    function () { calls.renderFlow++; },
    function () {},
    console
  );
  windowStub.attachPubWork = api.attachPubWork;
  return { state: state, toasts: toasts, calls: calls, api: api, window: windowStub };
}

function pubs() { return store.listPubs(); }

describe('手动标记发布 · 唯一身份与作品关联', () => {
  it('S1 作品已落库：手动标记后记录关联正确，且不产生待关联记录', () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: 'w5', works: [{ id: 'w5', name: '作品五' }],
        planOwnerId: 'w5', copiesOwner: 'w5', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('w5');
    expect(rows[0].status).toBe('manual');
    // 幂等键带作品身份 + 独立操作 ID（不再是平台级占位）
    expect(rows[0].pub_key).toMatch(/^manual\|github\|w5\|mk_[0-9a-fA-F-]+$/);
    expect(rows[0].pub_key).not.toContain('manual|github|-');
    // 作品已落库 → 不需要待关联
    expect(env.state._pendingPubKeys || []).toEqual([]);
  });

  it('S2 作品尚未落库：保存作品后（不点「开始发射」）记录自动关联', async () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      },
      savedWork: { id: 'w9', name: '新作品' }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    // 作品还没落库：记录已写入，但 work_id 为空
    let rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('');
    expect(rows[0].pub_key).toMatch(/^manual\|github\|draft_a\|mk_[0-9a-fA-F-]+$/);
    const keyBefore = rows[0].pub_key;
    expect(env.state._pendingPubKeys.length).toBe(1);

    // 作品保存并确认落库（唯一会颁发正式作品 ID 的地方）
    const res = await env.api.planTransferAfterSave({ id: 'w9', name: '新作品' }, 'draft_a', false);
    expect(res.ok).toBe(true);

    // 不点「开始发射」，记录也已经关联到作品
    rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('w9');
    expect(rows[0].pub_key).toBe(keyBefore);   // 键不变（回填不改变 pub_key / op_id）
    // 待处理状态已清理
    expect(env.state._pendingPubKeys.length).toBe(0);
  });

  it('S3 两个尚未落库的不同作品，同一平台手动标记 → 两条记录都保留，互不覆盖', () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '作品A', body: 'A', tags: [], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '作品A' });

    // 切到另一个尚未落库的作品（新的草稿归属）
    env.state.planOwnerId = 'draft_b';
    env.state.copiesOwner = 'draft_b';
    env.state.copies = { github: { title: '作品B', body: 'B', tags: [], done: false, time: '' } };
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '作品B' });

    const rows = pubs();
    expect(rows.length).toBe(2);                       // 两条都在
    const keys = rows.map(r => r.pub_key);
    // （listPubs 按 created_at DESC 返回，顺序不固定 → 按作用域归类断言）
    expect(keys.filter(k => /^manual\|github\|draft_a\|mk_/.test(k)).length).toBe(1);
    expect(keys.filter(k => /^manual\|github\|draft_b\|mk_/.test(k)).length).toBe(1);
    expect(keys[0]).not.toBe(keys[1]);                 // 操作 ID 不同 → 键不同
    const titles = rows.map(r => r.title).sort();
    expect(titles).toEqual(['作品A', '作品B']);          // 没有互相覆盖
  });

  it('S4 同一作品、同一平台两次**独立**手动标记 → 两条独立记录，互不覆盖', () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: 'w5', works: [{ id: 'w5', name: '作品五' }],
        planOwnerId: 'w5', copiesOwner: 'w5', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第一次' });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第二次' });

    const rows = pubs();
    expect(rows.length).toBe(2);                       // 两次独立标记 → 两条记录
    const titles = rows.map(r => r.title).sort();
    expect(titles).toEqual(['第一次', '第二次']);       // 第一次的记录没有被覆盖
    // 两条记录的幂等键不同（各自独立操作 ID）
    expect(rows[0].pub_key).not.toBe(rows[1].pub_key);
    rows.forEach(function (r) {
      expect(r.pub_key).toMatch(/^manual\|github\|w5\|mk_[0-9a-fA-F-]+$/);
    });
  });

  it('S4b 同一次操作重试（复用同一个 op_id）→ 只对应一条记录', () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: 'w5', works: [{ id: 'w5', name: '作品五' }],
        planOwnerId: 'w5', copiesOwner: 'w5', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    // 同一次操作的两次提交：带**同一个** opId → 必须复用同一个 pub_key → 只写一条
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第一次', opId: 'mk_fixed_op_1' });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第一次', opId: 'mk_fixed_op_1' });

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toBe('manual|github|w5|mk_fixed_op_1');
    expect(rows[0].title).toBe('第一次');
  });

  it('S4c 作品尚未落库时，同一草稿两次**独立**手动标记 → 两条记录（作用域相同、键不同）', () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第一次' });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '第二次' });

    const rows = pubs();
    expect(rows.length).toBe(2);
    const titles = rows.map(r => r.title).sort();
    expect(titles).toEqual(['第一次', '第二次']);
    expect(rows[0].pub_key).not.toBe(rows[1].pub_key);
    rows.forEach(function (r) {
      expect(r.pub_key).toMatch(/^manual\|github\|draft_a\|mk_[0-9a-fA-F-]+$/);
    });
  });

  it('S5 作品保存失败 → 待关联记录不会被错误关联', async () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      },
      saveWork: function () { return Promise.reject(new Error('模拟保存失败')); }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    expect(env.state._pendingPubKeys.length).toBe(1);

    const res = await env.api.planTransferAfterSave({ id: 'w9', name: '新作品' }, 'draft_a', false);
    expect(res.ok).toBe(false);

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].work_id).toBe('');                   // 没有被错挂到不存在的作品
    // 记录仍然保留，待关联状态也保留（等作品真正保存成功后再回填）
    expect(env.state._pendingPubKeys.length).toBe(1);
  });

  it('S5b 保存返回的作品 ID 与目标不一致 → 同样不关联', async () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      },
      savedWork: { id: 'w_other', name: '别的作品' }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    const res = await env.api.planTransferAfterSave({ id: 'w9', name: '新作品' }, 'draft_a', false);
    expect(res.ok).toBe(false);
    expect(pubs()[0].work_id).toBe('');
  });

  it('S6 回填成功后重复回填 / 重新加载 → 不产生重复行、不产生错误关联', async () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      },
      savedWork: { id: 'w9', name: '新作品' }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    await env.api.planTransferAfterSave({ id: 'w9', name: '新作品' }, 'draft_a', false);
    expect(pubs().length).toBe(1);
    expect(pubs()[0].work_id).toBe('w9');

    // 再次回填同一作用域 → 无事发生（待处理状态已清空）
    const again = env.api.flushPendingPubWork('w9', ['draft_a']);
    expect(again).toBe(0);
    expect(pubs().length).toBe(1);
    expect(pubs()[0].work_id).toBe('w9');

    // 模拟重启：重新从库里加载发布记录（内存态换成 DB 行）
    env.state.pubLog = store.listPubs().map(function (p) {
      return {
        recId: p.id, platform: p.platform, platform_id: p.platform_id, status: p.status,
        title: p.title, body: p.body, tags: p.tags, time: p.time, url: p.url,
        error: p.error, video_id: p.video_id, pub_key: p.pub_key,
        work_id: p.work_id, created_at: p.created_at
      };
    });
    // 重启后再次回填：attachPubWork 只处理"还没有 work_id"的行 → 这里已经是 w9 → 不会重复写
    env.api.flushPendingPubWork('w9', ['draft_a']);
    expect(pubs().length).toBe(1);
    expect(pubs()[0].work_id).toBe('w9');
  });

  it('S6b 别的作用域的待关联记录不会被本次保存波及', async () => {
    const env = makeEnv({
      state: {
        copies: { github: { title: '标题', body: '正文', tags: ['t'], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      },
      savedWork: { id: 'w9', name: '新作品' }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });
    // 另一个草稿的待关联记录
    env.api.rememberPendingPub('draft_other', 'manual|github|draft_other');

    await env.api.planTransferAfterSave({ id: 'w9', name: '新作品' }, 'draft_a', false);

    const rows = pubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toMatch(/^manual\|github\|draft_a\|mk_[0-9a-fA-F-]+$/);
    expect(rows[0].work_id).toBe('w9');
    // 另一个作用域的仍留在待处理状态（等它自己的作品保存成功再回填）
    expect(env.state._pendingPubKeys).toContain('manual|github|draft_other');
  });

  it('S7 历史记录兼容：旧的 manual|<pid>|- 记录不受影响，也不会被新逻辑复用', () => {
    // 模拟历史遗留行（平台级占位键）
    store.addPub({
      work_id: '', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史记录', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|-'
    });
    const env = makeEnv({
      state: {
        copies: { github: { title: '新记录', body: 'B', tags: [], done: false, time: '' } },
        curWork: null, works: [],
        planOwnerId: 'draft_a', copiesOwner: 'draft_a', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '新记录' });

    const rows = pubs();
    expect(rows.length).toBe(2);                        // 历史行 + 新行，各一条
    const legacy = rows.filter(r => r.pub_key === 'manual|github|-');
    expect(legacy.length).toBe(1);
    expect(legacy[0].title).toBe('历史记录');            // 历史行没有被覆盖
    const fresh = rows.filter(r => /^manual\|github\|draft_a\|mk_/.test(r.pub_key));
    expect(fresh.length).toBe(1);
    expect(fresh[0].title).toBe('新记录');
  });

  it('S8 旧三段式手动键（manual|<pid>|<scope>）不会被新的一次标记复用', () => {
    // 历史三段式手动记录（同作品同平台）——新的一次独立标记必须自己成为一条新记录
    store.addPub({
      work_id: 'w5', platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', time: '09:00', url: '', error: '', video_id: '',
      pub_key: 'manual|github|w5'
    });
    const env = makeEnv({
      state: {
        copies: { github: { title: '新记录', body: 'B', tags: [], done: false, time: '' } },
        curWork: 'w5', works: [{ id: 'w5', name: '作品五' }],
        planOwnerId: 'w5', copiesOwner: 'w5', planDirty: false,
        kpis: {}, pubByPlatform: {}, pubLog: [], milestones: []
      }
    });
    // 把历史行放进会话日志（模拟重启后从库里回填）
    env.state.pubLog = store.listPubs().map(function (p) {
      return {
        recId: p.id, platform: p.platform, platform_id: p.platform_id, status: p.status,
        title: p.title, body: p.body, tags: p.tags, time: p.time, url: p.url,
        error: p.error, video_id: p.video_id, pub_key: p.pub_key,
        work_id: p.work_id, created_at: p.created_at
      };
    });
    env.api.markPub('github', { status: 'manual', source: 'manual-mark', title: '新记录' });

    const rows = pubs();
    expect(rows.length).toBe(2);
    const legacy = rows.filter(r => r.pub_key === 'manual|github|w5');
    expect(legacy.length).toBe(1);
    expect(legacy[0].title).toBe('历史手动记录');        // 历史记录没有被覆盖
    const fresh = rows.filter(r => /^manual\|github\|w5\|mk_/.test(r.pub_key));
    expect(fresh.length).toBe(1);
    expect(fresh[0].title).toBe('新记录');
  });
});
