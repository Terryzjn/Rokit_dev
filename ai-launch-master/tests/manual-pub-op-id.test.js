// Rokit · 手动发布「操作 ID + 幂等 + 精确删除」—— 批次一（Store 与键机制）定向测试
//
// 覆盖：
//   K1 手动标记键格式：manual|<platform_id>|<scope>|<op_id>，op_id 以 mk_ 开头
//   K2 两次**独立**手动标记 → 两个不同 op_id / 两个不同 pub_key
//   K3 同一次操作重试（同一 op_id）→ 复用同一 pub_key → 只产生一条记录
//   K4 Store.addPub：同一 pub_key 重复提交 → 仍然只有一条记录（不重复计数）
//   K5 Store：不同 pub_key → 各自独立成行（互不覆盖）
//   K6 手动标记**不再**复用历史手动标记记录（同作品同平台的旧手动记录不被覆盖）
//   K7 手动标记仍复用**自动来源的 pending 记录**（草稿待发布 → 人工标记升级那一条）
//   K8 手动标记**不再**复用历史成功记录（status='ok'）→ 本次标记自己成为一条新记录
//   K9 GitHub 存在历史 ok 记录时手动标记不复用它（同作品同平台也不复用）
//   K10 同时存在历史 ok 记录与 pending 记录时 → 复用 pending 那一条
//   D1 Store.deleteManualPub：只删完整 pub_key 匹配的那一条
//   D2 Store.deleteManualPub：不影响同作品/同平台的其他记录
//   D3 Store.deleteManualPub：记录不存在 → 安全返回未删除（deleted=0）
//   D4 Store.deleteManualPub：拒绝删除自动发布键 / 首秀计划键 / 旧三段式手动键
//   D5 Store.deleteManualPub：删除后 pubs:changed 才通知（空删不通知）
//   U1 部分唯一索引：排除空字符串键；非空重复键被数据库拒绝
//   U2 历史数据里的重复空键行**不受影响**（不被索引约束、不被改写）
//   P1 自动发布与首秀计划的原有 upsert 语义不变（同一 pub_key → 同一条记录）
//   J1 SQLite 与 JSON Store 行为一致
//
// 全部使用**临时隔离数据库 / 临时 JSON 目录**：
//   **绝不写入活动数据库 .userdata/ai-launch-master.db，不调用任何真实平台 API**。
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/plan-store');

const ROOT = H.ROOT;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 从 index.html 源码切出被测的键机制函数（与既有测试同一手法） ---------- */
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

const KEY_SRC = [
  extractBlock(HTML, 'function manualScopeId(workId){'),
  extractBlock(HTML, 'function newCopiesBatchId(){'),
  extractBlock(HTML, 'function newManualOpId(){'),
  extractBlock(HTML, 'function isManualMarkPubKey(key){'),
  extractBlock(HTML, 'function manualPubKey(pid,scope,opId){'),
  extractBlock(HTML, 'function pubKeyFor(pid,workId,status,opts,scope){'),
  extractBlock(HTML, 'function findReusablePubKey(pid,workId,scope){')
].join('\n');

// 键机制函数在沙箱里跑（只需要 state）
function makeKeyEnv(state) {
  const st = state || { copies: {}, pubLog: [], works: [], curWork: null, copiesOwner: '', planOwnerId: '' };
  const factory = new Function(
    'state', 'findWork',
    KEY_SRC +
    '\nreturn { newManualOpId: newManualOpId, manualPubKey: manualPubKey,' +
    ' pubKeyFor: pubKeyFor, findReusablePubKey: findReusablePubKey,' +
    ' manualScopeId: manualScopeId, isManualMarkPubKey: isManualMarkPubKey };'
  );
  return factory(st, function (id) {
    return (st.works || []).filter(function (w) { return w.id === id; })[0] || null;
  });
}

/* ---------- Store 侧：临时库装配 ---------- */
let tmpDir;
let mod;
let store;
let pubsChanged;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  mod = H.loadStoreFresh(false);          // 屏蔽 better-sqlite3 → 用 node:sqlite（临时库）
  store = new mod.Store(path.join(tmpDir, 'test.db'));
  pubsChanged = 0;
  mod.onPubsChanged(function () { pubsChanged++; });
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
});

function addManual(store, o) {
  const opt = o || {};
  return store.addPub({
    work_id: opt.work_id || 'w1',
    platform: opt.platform || 'GitHub',
    platform_id: opt.platform_id || 'github',
    status: opt.status || 'manual',
    title: opt.title || '',
    body: opt.body || '',
    tags: opt.tags || '',
    time: opt.time || '10:00',
    url: opt.url || '',
    error: opt.error || '',
    video_id: opt.video_id || '',
    pub_key: opt.pub_key || ''
  });
}

describe('批次一 · 手动发布操作 ID 与幂等键', () => {
  it('K1 手动标记键格式为 manual|<platform_id>|<scope>|<op_id>，op_id 以 mk_ 开头', () => {
    const env = makeKeyEnv();
    const opId = env.newManualOpId();
    expect(opId).toMatch(/^mk_[0-9a-fA-F-]+$/);
    const key = env.manualPubKey('github', 'w1', opId);
    expect(key).toBe('manual|github|w1|' + opId);
    // 键里带作品作用域（不同作品绝不共用一个键）
    expect(env.manualPubKey('github', 'w2', opId)).not.toBe(key);
    // 手动标记分支走的是这个键
    const k2 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k2).toMatch(/^manual\|github\|w1\|mk_[0-9a-fA-F-]+$/);
  });

  it('K2 两次独立手动标记 → 两个不同 op_id / 两个不同 pub_key', () => {
    const env = makeKeyEnv();
    const opA = env.newManualOpId();
    const opB = env.newManualOpId();
    expect(opA).not.toBe(opB);                       // 操作 ID 随机且互不相同
    expect(env.manualPubKey('github', 'w1', opA)).not.toBe(env.manualPubKey('github', 'w1', opB));
    // 两次独立调用 pubKeyFor（不传 opId）→ 各自产生新键
    const k1 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    const k2 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k1).not.toBe(k2);
  });

  it('K3 同一次操作重试（同一 op_id）→ 复用同一 pub_key', () => {
    const env = makeKeyEnv();
    const opId = 'mk_same_operation_1';
    const k1 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark', opId: opId }, 'w1');
    const k2 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark', opId: opId }, 'w1');
    expect(k1).toBe(k2);
    expect(k1).toBe('manual|github|w1|' + opId);
  });

  it('K6 手动标记不再复用历史手动标记记录（同作品同平台的旧手动记录不被覆盖）', () => {
    const state = {
      copies: {}, works: [{ id: 'w1', name: '作品一' }], curWork: 'w1',
      copiesOwner: '', planOwnerId: '', pubLog: []
    };
    state.pubLog = [{
      recId: 57, platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '历史手动记录', work_id: 'w1', pub_key: 'manual|github|w1'
    }];
    const env = makeKeyEnv(state);
    // 旧三段式手动键 → 不复用
    expect(env.findReusablePubKey('github', 'w1', 'w1')).toBe('');
    // 新格式手动键 → 同样不复用
    state.pubLog = [{
      recId: 58, platform: 'GitHub', platform_id: 'github', status: 'manual',
      title: '新的手动记录', work_id: 'w1', pub_key: 'manual|github|w1|mk_abc'
    }];
    expect(env.findReusablePubKey('github', 'w1', 'w1')).toBe('');
    // 新的一次标记 → 全新键
    const k = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k).toMatch(/^manual\|github\|w1\|mk_/);
    expect(k).not.toBe('manual|github|w1');
  });

  it('K7 手动标记仍复用自动来源的 pending 记录（同一次真实发布不记两条）', () => {
    const state = {
      copies: {}, works: [{ id: 'w1', name: '作品一' }], curWork: 'w1',
      copiesOwner: '', planOwnerId: '', pubLog: []
    };
    // pending 记录（仅草稿待发布，平台侧尚未确认）→ 复用，人工标记升级那一条
    state.pubLog = [{
      recId: 11, platform: '微信公众号', platform_id: 'wechat', status: 'pending',
      title: '草稿待发布', work_id: 'w1', pub_key: 'wechat|w1|1699999999-def'
    }];
    const env = makeKeyEnv(state);
    expect(env.findReusablePubKey('wechat', 'w1', 'w1')).toBe('wechat|w1|1699999999-def');
    expect(env.pubKeyFor('wechat', 'w1', 'manual', { source: 'manual-mark' }, 'w1'))
      .toBe('wechat|w1|1699999999-def');
  });

  it('K8 历史成功记录（status=\'ok\'）不被手动标记复用 → 手动标记自己成为一条新记录', () => {
    const state = {
      copies: {}, works: [{ id: 'w1', name: '作品一' }], curWork: 'w1',
      copiesOwner: '', planOwnerId: '', pubLog: []
    };
    state.pubLog = [{
      recId: 10, platform: 'YouTube', platform_id: 'youtube', status: 'ok',
      title: '自动发布成功', work_id: 'w1', pub_key: 'youtube|w1|1699999999-abc'
    }];
    const env = makeKeyEnv(state);
    // 历史 ok 记录 → 绝不复用（否则本次手动标记只会把那条旧记录就地改写）
    expect(env.findReusablePubKey('youtube', 'w1', 'w1')).toBe('');
    // 本次手动标记 → 生成新的四段式手动键（不是旧自动键）
    const k = env.pubKeyFor('youtube', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k).toMatch(/^manual\|youtube\|w1\|mk_[0-9a-fA-F-]+$/);
    expect(k).not.toBe('youtube|w1|1699999999-abc');
  });

  it('K9 GitHub 存在历史 ok 记录时手动标记不复用它（同作品同平台也不复用）', () => {
    const state = {
      copies: {}, works: [{ id: 'w1', name: '作品一' }], curWork: 'w1',
      copiesOwner: '', planOwnerId: '', pubLog: []
    };
    // 复现线上数据：GitHub / w1 有一条自动发布留下的成功记录（自动键）
    state.pubLog = [{
      recId: 60, platform: 'GitHub', platform_id: 'github', status: 'ok',
      title: 'Release v0.1.0 — 你的作品', work_id: 'w1', pub_key: 'github|w1|mvurgycb-xk22eq'
    }];
    const env = makeKeyEnv(state);
    expect(env.findReusablePubKey('github', 'w1', 'w1')).toBe('');
    const k = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k).toMatch(/^manual\|github\|w1\|mk_[0-9a-fA-F-]+$/);
    expect(k).not.toBe('github|w1|mvurgycb-xk22eq');
    // 同一次操作重试（同一 opId）→ 仍复用同一个键
    const k2 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark', opId: 'mk_same_op' }, 'w1');
    expect(k2).toBe('manual|github|w1|mk_same_op');
    // 独立手动操作 → 新的 opId / 新的键
    const k3 = env.pubKeyFor('github', 'w1', 'manual', { source: 'manual-mark' }, 'w1');
    expect(k3).not.toBe(k);
  });

  it('K10 同时存在历史 ok 记录与 pending 记录时 → 复用 pending 那一条', () => {
    const state = {
      copies: {}, works: [{ id: 'w1', name: '作品一' }], curWork: 'w1',
      copiesOwner: '', planOwnerId: '', pubLog: []
    };
    state.pubLog = [
      {
        recId: 10, platform: 'GitHub', platform_id: 'github', status: 'ok',
        title: '历史成功', work_id: 'w1', pub_key: 'github|w1|mvurgycb-xk22eq'
      },
      {
        recId: 11, platform: 'GitHub', platform_id: 'github', status: 'pending',
        title: '草稿待发布', work_id: 'w1', pub_key: 'github|w1|mw0028ou-vmshzh'
      }
    ];
    const env = makeKeyEnv(state);
    expect(env.findReusablePubKey('github', 'w1', 'w1')).toBe('github|w1|mw0028ou-vmshzh');
  });
});

describe('批次一 · Store 层幂等与精确删除', () => {
  it('K4 Store.addPub：同一 pub_key 重复提交 → 仍然只有一条记录（不重复计数）', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '第一次' });
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '第二次' });
    const rows = store.listPubs();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('第二次');
  });

  it('K5 Store：不同 pub_key → 各自独立成行（互不覆盖）', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '第一次' });
    addManual(store, { pub_key: 'manual|github|w1|mk_op2', title: '第二次' });
    const rows = store.listPubs();
    expect(rows.length).toBe(2);
    const titles = rows.map(function (r) { return r.title; }).sort();
    expect(titles).toEqual(['第一次', '第二次']);
  });

  it('D1 Store.deleteManualPub：只删完整 pub_key 匹配的那一条', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '第一次' });
    addManual(store, { pub_key: 'manual|github|w1|mk_op2', title: '第二次' });
    const res = store.deleteManualPub('manual|github|w1|mk_op1');
    expect(res.deleted).toBe(1);
    const rows = store.listPubs();
    expect(rows.length).toBe(1);
    expect(rows[0].pub_key).toBe('manual|github|w1|mk_op2');
    expect(rows[0].title).toBe('第二次');
  });

  it('D2 Store.deleteManualPub：不影响同作品 / 同平台的其他记录', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', work_id: 'w1', title: '目标' });
    addManual(store, { pub_key: 'manual|github|w2|mk_op2', work_id: 'w2', title: '别的作品' });
    addManual(store, { pub_key: 'manual|youtube|w1|mk_op3', platform_id: 'youtube', title: '别的平台' });
    addManual(store, { pub_key: 'youtube|w1|1699999999-auto', platform_id: 'youtube', status: 'ok', title: '自动发布' });
    const res = store.deleteManualPub('manual|github|w1|mk_op1');
    expect(res.deleted).toBe(1);
    const keys = store.listPubs().map(function (r) { return r.pub_key; }).sort();
    expect(keys).toEqual([
      'manual|github|w2|mk_op2',
      'manual|youtube|w1|mk_op3',
      'youtube|w1|1699999999-auto'
    ]);
  });

  it('D3 Store.deleteManualPub：记录不存在 → 安全返回未删除（不误删其他记录）', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '保留' });
    const res = store.deleteManualPub('manual|github|w1|mk_不存在');
    expect(res.deleted).toBe(0);
    expect(store.listPubs().length).toBe(1);
    expect(store.listPubs()[0].title).toBe('保留');
  });

  it('D4 Store.deleteManualPub：拒绝删除自动发布键 / 首秀计划键 / 旧三段式手动键', () => {
    addManual(store, { pub_key: 'youtube|w1|1699999999-auto', platform_id: 'youtube', status: 'ok', title: '自动发布' });
    addManual(store, { pub_key: 'plan|w1|stage1|wechat', platform_id: 'wechat', status: 'pending', title: '首秀计划' });
    addManual(store, { pub_key: 'manual|github|w1', title: '旧三段式手动记录' });

    expect(store.deleteManualPub('youtube|w1|1699999999-auto').deleted).toBe(0);
    expect(store.deleteManualPub('plan|w1|stage1|wechat').deleted).toBe(0);
    expect(store.deleteManualPub('manual|github|w1').deleted).toBe(0);
    expect(store.deleteManualPub('').deleted).toBe(0);
    expect(store.deleteManualPub(null).deleted).toBe(0);

    // 三条都还在
    expect(store.listPubs().length).toBe(3);
  });

  it('D5 Store.deleteManualPub：真的删掉行才通知 pubs:changed（空删不通知）', () => {
    addManual(store, { pub_key: 'manual|github|w1|mk_op1', title: '目标' });
    const before = pubsChanged;
    // 空删（记录不存在）→ 不通知
    store.deleteManualPub('manual|github|w1|mk_不存在');
    expect(pubsChanged).toBe(before);
    // 真删 → 通知一次
    store.deleteManualPub('manual|github|w1|mk_op1');
    expect(pubsChanged).toBe(before + 1);
    expect(store.listPubs().length).toBe(0);
  });

  it('P1 自动发布与首秀计划的原有 upsert 语义不变（同一 pub_key → 同一条记录）', () => {
    // 自动发布键
    store.addPub({
      work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'failed',
      title: '标题', body: '', tags: '', time: '', url: '', error: '网络错误', video_id: '',
      pub_key: 'youtube|w1|1699999999-auto'
    });
    store.addPub({
      work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok',
      title: '标题', body: '', tags: '', time: '', url: 'https://y/watch?v=x', error: '', video_id: 'x',
      pub_key: 'youtube|w1|1699999999-auto'
    });
    const auto = store.listPubs().filter(function (r) { return r.pub_key === 'youtube|w1|1699999999-auto'; });
    expect(auto.length).toBe(1);              // 同一 pub_key → 仍然只有一条
    expect(auto[0].status).toBe('ok');        // 成功结果覆盖失败状态
    expect(auto[0].url).toBe('https://y/watch?v=x');
    // ★ 既有语义未被本批改动：addPub 用 `r.error || exist.error`，
    //   所以"成功但没带 error"不会抹掉历史失败原因（清空 error 是 _planPubUpsert 的语义）。
    expect(auto[0].error).toBe('网络错误');

    // 首秀计划键
    store.addPub({
      work_id: 'w1', platform: '微信公众号', platform_id: 'wechat', status: 'pending',
      title: '标题', body: '', tags: '', time: '', url: '', error: '', video_id: '',
      pub_key: 'plan|w1|stage1|wechat'
    });
    store.addPub({
      work_id: 'w1', platform: '微信公众号', platform_id: 'wechat', status: 'ok',
      title: '标题', body: '', tags: '', time: '', url: '', error: '', video_id: 'mid',
      pub_key: 'plan|w1|stage1|wechat'
    });
    const plan = store.listPubs().filter(function (r) { return r.pub_key === 'plan|w1|stage1|wechat'; });
    expect(plan.length).toBe(1);
    expect(plan[0].status).toBe('ok');
    expect(plan[0].video_id).toBe('mid');
  });

  it('U1 部分唯一索引：排除空字符串键；非空重复键被数据库拒绝', () => {
    // 索引已由 Store 初始化（ensurePubsPubKeyIndex）建好
    const idx = store.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pubs_pub_key'");
    expect(idx.length).toBe(1);
    const sql = store.get("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_pubs_pub_key'");
    expect(String(sql.sql)).toMatch(/pub_key/);
    expect(String(sql.sql)).toMatch(/WHERE/i);   // 部分索引（排除空键）
    // 索引条件保持不变：只约束非空键
    expect(String(sql.sql)).toMatch(/pub_key IS NOT NULL/i);
    expect(String(sql.sql)).toMatch(/pub_key <> ''/);

    // 空字符串键：允许多行（历史数据不受约束）
    addManual(store, { pub_key: '', title: '空键一' });
    addManual(store, { pub_key: '', title: '空键二' });
    expect(store.listPubs().length).toBe(2);

    // 非空重复键：被数据库唯一索引拒绝
    const dupKey = 'manual|github|w1|mk_dup';
    const ins = 'INSERT INTO pubs (work_id, platform, title, body, tags, time, platform_id, status, url, error, video_id, pub_key, created_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
    store.run(ins, ['w1', 'GitHub', 'first', '', '', '', 'github', 'manual', '', '', '', dupKey, new Date().toISOString()]);
    let rejected = false;
    let errMsg = '';
    try {
      store.run(ins, ['w1', 'GitHub', 'dup', '', '', '', 'github', 'manual', '', '', '', dupKey, new Date().toISOString()]);
    } catch (e) {
      rejected = true;
      errMsg = String((e && e.message) || e);
    }
    expect(rejected).toBe(true);
    expect(errMsg).toMatch(/UNIQUE constraint failed/i);
    // 第一条仍在（被拒绝的只是重复的那次插入）
    expect(store.listPubs().filter(function (r) { return r.pub_key === dupKey; }).length).toBe(1);
  });

  it('U2 历史数据里的重复空键行不受影响（不被改写、不被清理）', () => {
    // 模拟历史遗留：多条空键行
    for (let i = 0; i < 5; i++) {
      store.run(
        'INSERT INTO pubs (work_id, platform, title, body, tags, time, platform_id, status, url, error, video_id, pub_key, created_at)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ['w1', 'GitHub', '历史' + i, '', '', '', 'github', 'manual', '', '', '', '', new Date().toISOString()]
      );
    }
    const rows = store.listPubs();
    expect(rows.length).toBe(5);
    expect(rows.every(function (r) { return r.pub_key === ''; })).toBe(true);
    // 内容未被改写
    expect(rows.map(function (r) { return r.title; }).sort()).toEqual(['历史0', '历史1', '历史2', '历史3', '历史4']);
    // 旧三段式手动键同样可以并存（不与新格式冲突）
    addManual(store, { pub_key: 'manual|github|w1', title: '旧手动记录' });
    addManual(store, { pub_key: 'manual|github|w1|mk_new', title: '新手动记录' });
    expect(store.listPubs().length).toBe(7);
  });

  it('U3 索引创建失败不阻断启动，且下次启动自动重试成功', () => {
    // 造一个"非空键重复"的库（唯一索引必然建不出来），并停在 v9（模拟旧库升级）
    const dir = H.makeTmpDir();
    const f = path.join(dir, 'dup.db');
    const db = new (require('node:sqlite').DatabaseSync)(f);
    db.exec(
      'CREATE TABLE pubs (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, platform TEXT,'
      + ' title TEXT, body TEXT, tags TEXT, time TEXT, platform_id TEXT, status TEXT, url TEXT,'
      + ' error TEXT, video_id TEXT, pub_key TEXT, created_at TEXT)'
    );
    const ins = db.prepare(
      'INSERT INTO pubs (work_id, platform, title, platform_id, status, pub_key, created_at)'
      + ' VALUES (?,?,?,?,?,?,?)'
    );
    ins.run('w1', 'GitHub', 'A', 'github', 'manual', 'manual|github|w1|mk_dup', '2026-01-01T00:00:00.000Z');
    ins.run('w1', 'GitHub', 'B', 'github', 'manual', 'manual|github|w1|mk_dup', '2026-02-01T00:00:00.000Z');
    db.exec('PRAGMA user_version = 9');
    db.close();

    // 首次启动：建索引失败 → 只记日志、**不抛错**、不阻断启动；历史数据保持原样
    const errs = [];
    const origErr = console.error;
    console.error = function () { errs.push(Array.prototype.slice.call(arguments).join(' ')); };
    let first = null;
    try {
      first = new mod.Store(f);
    } finally {
      console.error = origErr;
    }
    expect(first).toBeTruthy();                       // 没有抛错 → 应用能继续启动
    expect(first.mode).toBe('sqlite');
    expect(first.listPubs().length).toBe(2);           // 历史行未被改写/删除
    expect(first.listPubs().map(function (r) { return r.title; }).sort()).toEqual(['A', 'B']);
    expect(errs.join('\n')).toMatch(/唯一索引失败/);     // 有明确日志
    // 索引确实没建成
    expect(first.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pubs_pub_key'").length).toBe(0);

    // 用户修掉重复数据后再次启动 → 自动重试 → 索引建成
    const db2 = new (require('node:sqlite').DatabaseSync)(f);
    db2.exec("DELETE FROM pubs WHERE pub_key='manual|github|w1|mk_dup' AND id=1");
    db2.close();

    const errs2 = [];
    const origErr2 = console.error;
    console.error = function () { errs2.push(Array.prototype.slice.call(arguments).join(' ')); };
    let second = null;
    try {
      second = new mod.Store(f);
    } finally {
      console.error = origErr2;
    }
    expect(second.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pubs_pub_key'").length).toBe(1);
    expect(errs2.join('\n')).toBe('');                 // 这次没有报错

    H.rmTmpDir(dir);
  });

  it('U4 重复启动不会重复创建索引（幂等、无报错）', () => {
    const dir = H.makeTmpDir();
    const f = path.join(dir, 't.db');
    const errs = [];
    const origErr = console.error;
    console.error = function () { errs.push(Array.prototype.slice.call(arguments).join(' ')); };
    try {
      new mod.Store(f);
      new mod.Store(f);
      new mod.Store(f);
    } finally {
      console.error = origErr;
    }
    const idx = store.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pubs_pub_key'");
    expect(idx.length).toBe(1);                       // 只有一个索引
    expect(errs.join('\n')).toBe('');                 // 全程无报错
    H.rmTmpDir(dir);
  });

  it('D6 同一新格式 pub_key 对应多行时，删除的是 id 最大（最新）的那一条', () => {
    // 造三行同键（唯一索引建不出来时才可能出现的极端情形）
    const dir = H.makeTmpDir();
    const f = path.join(dir, 'dup.db');
    const db = new (require('node:sqlite').DatabaseSync)(f);
    db.exec(
      'CREATE TABLE pubs (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, platform TEXT,'
      + ' title TEXT, body TEXT, tags TEXT, time TEXT, platform_id TEXT, status TEXT, url TEXT,'
      + ' error TEXT, video_id TEXT, pub_key TEXT, created_at TEXT)'
    );
    const ins = db.prepare(
      'INSERT INTO pubs (work_id, platform, title, platform_id, status, pub_key, created_at)'
      + ' VALUES (?,?,?,?,?,?,?)'
    );
    const KEY = 'manual|github|w1|mk_op1';
    ins.run('w1', 'GitHub', '第一条', 'github', 'manual', KEY, '2026-01-01T00:00:00.000Z');
    ins.run('w1', 'GitHub', '第二条', 'github', 'manual', KEY, '2026-06-01T00:00:00.000Z');
    ins.run('w1', 'GitHub', '第三条', 'github', 'manual', KEY, '2026-07-01T00:00:00.000Z');
    ins.run('w1', 'GitHub', '别的记录', 'github', 'manual', 'manual|github|w1|mk_op2', '2026-06-02T00:00:00.000Z');
    db.close();

    const dupStore = new mod.Store(f);
    const res = dupStore.deleteManualPub(KEY);
    expect(res.deleted).toBe(1);                       // 只删一条
    expect(Number(res.id)).toBe(3);                    // 删的是最大 id（最新那条）
    const left = dupStore.all('SELECT id,title FROM pubs ORDER BY id');
    expect(left.length).toBe(3);
    expect(left.map(function (r) { return r.id; })).toEqual([1, 2, 4]);
    expect(left.map(function (r) { return r.title; })).toEqual(['第一条', '第二条', '别的记录']);

    H.rmTmpDir(dir);
  });
});

describe('批次一 · SQLite 与 JSON Store 行为一致', () => {
  let jsonDir;
  let jsonStore;
  let jsonChanged;

  beforeEach(() => {
    jsonDir = H.makeTmpDir();
    // 两个驱动都屏蔽 → 走 JSON 文件兜底（生产代码的另一个真实分支）
    const jsonMod = H.loadStoreFresh(true);
    jsonStore = new jsonMod.Store(path.join(jsonDir, 'test.db'));
    jsonChanged = 0;
    jsonMod.onPubsChanged(function () { jsonChanged++; });
    H.restoreDrivers();
    // 重新装回 SQLite 版供后续用例使用
    mod = H.loadStoreFresh(false);
    store = new mod.Store(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    H.restoreDrivers();
    H.rmTmpDir(jsonDir);
  });

  it('J1 JSON Store：同一 pub_key 幂等、不同 pub_key 各自成行、精确删除语义与 SQLite 一致', () => {
    function addJson(o) {
      const opt = o || {};
      jsonStore.addPub({
        work_id: opt.work_id || 'w1', platform: opt.platform || 'GitHub',
        platform_id: opt.platform_id || 'github', status: opt.status || 'manual',
        title: opt.title || '', body: '', tags: '', time: '10:00', url: '', error: '', video_id: '',
        pub_key: opt.pub_key || ''
      });
    }
    // 幂等：同一 key 两次 → 一条
    addJson({ pub_key: 'manual|github|w1|mk_op1', title: '第一次' });
    addJson({ pub_key: 'manual|github|w1|mk_op1', title: '第二次' });
    expect(jsonStore.listPubs().length).toBe(1);
    expect(jsonStore.listPubs()[0].title).toBe('第二次');

    // 不同 key → 两条
    addJson({ pub_key: 'manual|github|w1|mk_op2', title: '第二条' });
    expect(jsonStore.listPubs().length).toBe(2);

    // 精确删除：只删匹配的那一条
    const res = jsonStore.deleteManualPub('manual|github|w1|mk_op1');
    expect(res.deleted).toBe(1);
    expect(jsonStore.listPubs().length).toBe(1);
    expect(jsonStore.listPubs()[0].pub_key).toBe('manual|github|w1|mk_op2');

    // 空删 → 不删除、不通知
    const before = jsonChanged;
    expect(jsonStore.deleteManualPub('manual|github|w1|mk_不存在').deleted).toBe(0);
    expect(jsonChanged).toBe(before);

    // 拒绝非新格式手动键
    addJson({ pub_key: 'youtube|w1|1699999999-auto', platform_id: 'youtube', status: 'ok', title: '自动发布' });
    addJson({ pub_key: 'plan|w1|stage1|wechat', platform_id: 'wechat', status: 'pending', title: '首秀计划' });
    addJson({ pub_key: 'manual|github|w1', title: '旧三段式' });
    expect(jsonStore.deleteManualPub('youtube|w1|1699999999-auto').deleted).toBe(0);
    expect(jsonStore.deleteManualPub('plan|w1|stage1|wechat').deleted).toBe(0);
    expect(jsonStore.deleteManualPub('manual|github|w1').deleted).toBe(0);
    expect(jsonStore.listPubs().length).toBe(4);
  });
});
