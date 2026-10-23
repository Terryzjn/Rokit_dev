// Rokit ·「我的作品」登记时机修复
//
// 覆盖需求验证点：
//   - 点击「登记新作品」：作品数量不变
//   - 打开登记界面并关闭 / 用户取消：作品数量不变
//   - 发布失败：作品数量不变
//   - 发布成功：新增一条**正确**的作品记录
//   - 重试或重复回调：不重复新增同一作品
//   - 现有作品仍能正常查看 / 编辑 / 删除
//
// 策略：addWork / launch / dedupeLaunchDone 的真实行为用同构副本做行为测试
//   （可注入假 state、假 api），并用源码断言防止实现与测试副本漂移。

'use strict';

const fs = require('fs');
const path = require('path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');

// ============================================================
// 可注入的行为副本（与 index.html 实现保持同构）
// ============================================================

const SAMPLE_WORK_IDS = ['w1', 'w2', 'w3', 'w4'];
const STATUS_COLOR = { '首秀中': '#F59E0B' };

function makeCtx(works) {
  const saved = [];
  const state = {
    works: works.slice(),
    curWork: 'w1',
    project: { name: '', type: '', intro: '', url: '' },
    copies: {},
    sel: {},
    platforms: {},
    pubLog: [],
    pubByPlatform: {},
    kpis: {},
    milestones: [],
    messages: []
  };
  const api = {
    saveWork(w) { saved.push(JSON.parse(JSON.stringify(w))); return Promise.resolve(w); },
    addPub() { return Promise.resolve({}); }
  };
  return { state, api, saved };
}

// 复制自 index.html window.addWork（关键部分：只重置向导，不建记录）
function addWork(ctx) {
  const { state } = ctx;
  state.curWork = null;
  state._launchBatchToken = null;
  state._launchedInBatch = {};
  state.project = { name: '', type: '', intro: '', url: '' };
  state.copies = {};
}

// 复制自 index.html dedupeLaunchDone
function dedupeLaunchDone(state, doneIds) {
  if (!state._launchBatchToken) {
    state._launchBatchToken = 'tk' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }
  if (!state._launchedInBatch) state._launchedInBatch = {};
  const token = state._launchBatchToken;
  const out = [];
  doneIds.forEach(function (id) {
    const key = token + '|' + id;
    if (state._launchedInBatch[key]) return;
    state._launchedInBatch[key] = 1;
    out.push(id);
  });
  return out;
}

// 复制自 index.html window.launch 的「作品记录创建」段
function launchCreateWork(state) {
  const doneIds = Object.keys(state.copies).filter(function (id) {
    return state.copies[id] && state.copies[id].done;
  });
  if (!doneIds.length) return { created: null, doneIds: [] };

  const fresh = dedupeLaunchDone(state, doneIds);
  if (!fresh.length) return { created: null, doneIds: [] };

  fresh.forEach(function (id) {
    const c = state.copies[id];
    state.pubLog.push({ platform: id, time: c.time, title: c.title, id: id });
    state.pubByPlatform[id] = (state.pubByPlatform[id] || 0) + 1;
  });

  let w = null;
  for (let i = 0; i < state.works.length; i++) {
    if (state.works[i].id === state.curWork && !state.works[i].isSample) { w = state.works[i]; break; }
  }
  let created = false;
  if (!w) {
    const exists = state.works.filter(function (x) { return !x.isSample; }).map(function (x) { return x.id; });
    let n = 1;
    while (exists.indexOf('w' + n) >= 0 || SAMPLE_WORK_IDS.indexOf('w' + n) >= 0) n++;
    w = {
      id: 'w' + n,
      name: state.project.name || '未命名作品',
      type: state.project.type || '',
      intro: state.project.intro || '',
      url: state.project.url || '',
      yt_url: state.project.ytUrl || '',
      status: '首秀中',
      color: STATUS_COLOR['首秀中'] || '#F59E0B',
      queue: '主推',
      star: 0, dl: 0, play: '0',
      next: '看反馈，准备迭代'
    };
    state.works.push(w);
    state.curWork = w.id;
    created = true;
    if (w.name) {
      state.works = state.works.filter(function (x) { return !(x.isSample && x.name === w.name); });
    }
  } else {
    if (state.project.name) w.name = state.project.name;
    if (state.project.type) w.type = state.project.type;
    if (state.project.intro) w.intro = state.project.intro;
    if (state.project.url) w.url = state.project.url;
    if ('ytUrl' in state.project) w.yt_url = state.project.ytUrl || '';
    w.status = (w.status === '待启动' || !w.status) ? '首秀中' : w.status;
    w.color = STATUS_COLOR[w.status] || w.color;
  }
  w.next = '看反馈，准备迭代';
  return { created: created ? w : null, work: w, doneIds: fresh };
}

// ============================================================
// 行为测试
// ============================================================
describe('登记时机 · 点击不新增', () => {
  it('点击「登记新作品」：作品数量不变，且不写库', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    const before = ctx.state.works.length;
    addWork(ctx);
    expect(ctx.state.works.length).toBe(before);
    expect(ctx.saved.length).toBe(0);          // 未调用 saveWork
    expect(ctx.state.curWork).toBeNull();      // 未指向任何作品
  });

  it('打开登记界面并关闭（用户未填完就退出）：数量仍不变', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    const before = ctx.state.works.length;
    addWork(ctx);
    ctx.state.project.name = '半途而废的项目';   // 填了一点又关掉
    expect(ctx.state.works.length).toBe(before);
    expect(ctx.saved.length).toBe(0);
  });

  it('用户取消发布（无任何平台 done）：不新增', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = '取消的项目';
    ctx.state.copies = { github: { done: false }, x: { done: false } };
    const before = ctx.state.works.length;
    const r = launchCreateWork(ctx.state);
    expect(r.created).toBeNull();
    expect(ctx.state.works.length).toBe(before);
  });

  it('发布失败（平台 done=false）：不新增', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = '失败的项目';
    ctx.state.copies = { github: { done: false, time: null } };
    const before = ctx.state.works.length;
    launchCreateWork(ctx.state);
    expect(ctx.state.works.length).toBe(before);
    expect(ctx.state.pubLog.length).toBe(0);
  });
});

describe('登记时机 · 发布成功才新增', () => {
  it('发布成功：新增一条记录，字段取自真实发布结果', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    const before = ctx.state.works.length;
    addWork(ctx);
    ctx.state.project = { name: 'Rokit', type: '效率工具', intro: '一键发布', url: 'https://example.com' };
    ctx.state.copies = { github: { done: true, title: 'Rokit 发布', time: '10:00' } };

    const r = launchCreateWork(ctx.state);
    expect(ctx.state.works.length).toBe(before + 1);
    expect(r.created).toBeTruthy();
    expect(r.created.name).toBe('Rokit');
    expect(r.created.status).toBe('首秀中');
    expect(r.created.id).toBeTruthy();
    expect(ctx.state.curWork).toBe(r.created.id);
  });

  it('id 不与既有真实作品或示例作品冲突', () => {
    const ctx = makeCtx([
      { id: 'w1', name: 'A', isSample: false },
      { id: 'w2', name: 'B', isSample: true }
    ]);
    addWork(ctx);
    ctx.state.project.name = 'C';
    ctx.state.copies = { github: { done: true, time: '10:00' } };
    const r = launchCreateWork(ctx.state);
    const id = r.created.id;
    expect(id).not.toBe('w1');
    expect(SAMPLE_WORK_IDS.indexOf(id)).toBe(-1);
  });

  it('批量发射：只登记真实成功的平台', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = '批量项目';
    // github 成功、x 失败
    ctx.state.copies = {
      github: { done: true, time: '10:00' },
      x: { done: false },
      wechat: { done: true, time: '10:01' }
    };
    const before = ctx.state.works.length;
    launchCreateWork(ctx.state);
    expect(ctx.state.works.length).toBe(before + 1);   // 只 +1，不按平台数累加
    const logged = ctx.state.pubLog.map((r) => r.id).sort();
    expect(logged).toEqual(['github', 'wechat']);      // 失败平台不登记
  });

  it('部分成功（文章成功、视频失败）不会重复登记同一作品', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = '部分成功项目';
    ctx.state.copies = { github: { done: true, time: '10:00' } };
    const before = ctx.state.works.length;
    launchCreateWork(ctx.state);
    // 重试：done 仍为 true
    launchCreateWork(ctx.state);
    launchCreateWork(ctx.state);
    expect(ctx.state.works.length).toBe(before + 1);   // 始终只有 1 条
    expect(ctx.state.pubLog.length).toBe(1);            // pubLog 也只记一次
  });
});

describe('防重复登记', () => {
  it('同一轮内重复 launch：同一平台只登记一次', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = 'X';
    ctx.state.copies = { github: { done: true, time: '10:00' }, x: { done: true, time: '10:01' } };
    const r1 = dedupeLaunchDone(ctx.state, ['github', 'x']);
    expect(r1.sort()).toEqual(['github', 'x']);
    // 重复调用
    const r2 = dedupeLaunchDone(ctx.state, ['github', 'x']);
    expect(r2).toEqual([]);
    const r3 = dedupeLaunchDone(ctx.state, ['github']);
    expect(r3).toEqual([]);
  });

  it('新一轮登记（addWork）后去重标记重置，可再次登记', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    ctx.state.project.name = '第一个';
    ctx.state.copies = { github: { done: true, time: '10:00' } };
    launchCreateWork(ctx.state);
    const afterFirst = ctx.state.works.length;

    // 用户再点「登记新作品」开第二轮
    addWork(ctx);
    ctx.state.project.name = '第二个';
    ctx.state.copies = { github: { done: true, time: '11:00' } };
    launchCreateWork(ctx.state);
    expect(ctx.state.works.length).toBe(afterFirst + 1);  // 第二轮产生新作品
  });

  it('跨轮次不会误跳过：不同轮次的同一平台都能登记', () => {
    const ctx = makeCtx([{ id: 'w1', name: '旧作品', isSample: false }]);
    addWork(ctx);
    expect(dedupeLaunchDone(ctx.state, ['github'])).toEqual(['github']);
    addWork(ctx);
    expect(dedupeLaunchDone(ctx.state, ['github'])).toEqual(['github']);
  });
});

describe('现有作品功能不受影响', () => {
  it('openWork 仍设置 curWork（进入已有作品首秀）', () => {
    expect(htmlSrc).toMatch(/window\.openWork=function\(id\)\{[\s\S]{0,400}?state\.curWork=id;/);
  });

  it('delWork 仍存在且带示例作品保护', () => {
    const fn = htmlSrc.slice(htmlSrc.indexOf('window.delWork=function(id){'));
    expect(fn.slice(0, 600)).toMatch(/示例作品不可删除/);
    expect(fn.slice(0, 600)).toMatch(/isSample/);
  });

  it('renderWorks 仍渲染真实作品列表', () => {
    expect(htmlSrc).toMatch(/function renderWorks\(/);
    expect(htmlSrc).toMatch(/window\.openWork=/);
  });

  it('store.saveWork 无 id 时不落库（persistCurrentWork 不会误建记录）', () => {
    expect(storeSrc).toMatch(/saveWork\(w\)\s*\{\s*if \(!w \|\| !w\.id\) return w;/);
  });

  it('launch 仍在 doneIds 为空时直接返回（不会空建记录）', () => {
    const fn = htmlSrc.slice(htmlSrc.indexOf('window.launch=function(){'));
    expect(fn.slice(0, 900)).toMatch(/if\(!doneIds\.length\)return;/);
  });
});

// ============================================================
// 源码断言：防止实现与测试副本漂移
// ============================================================
describe('源码约束', () => {
  it('addWork 不再 push / 分配 id / 调用 saveWork', () => {
    const fn = htmlSrc.slice(
      htmlSrc.indexOf('window.addWork=function(){'),
      htmlSrc.indexOf('window.delWork=function')
    );
    expect(fn).not.toMatch(/state\.works\.push/);
    expect(fn).not.toMatch(/var id='w'/);
    // 只允许注释里提到 saveWork，不允许真实调用
    const code = fn.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/saveWork/);
    expect(fn).toMatch(/state\.curWork=null/);
  });

  it('addWork 重置去重标记', () => {
    const fn = htmlSrc.slice(
      htmlSrc.indexOf('window.addWork=function(){'),
      htmlSrc.indexOf('window.delWork=function')
    );
    expect(fn).toMatch(/_launchBatchToken=null/);
    expect(fn).toMatch(/_launchedInBatch=\{\}/);
  });

  it('launch 使用 dedupeLaunchDone 做防重复', () => {
    const fn = htmlSrc.slice(htmlSrc.indexOf('window.launch=function(){'));
    expect(fn.slice(0, 1200)).toMatch(/doneIds=dedupeLaunchDone\(doneIds\)/);
  });

  it('只有 launch（发布成功确认点）才创建作品记录', () => {
    // addWork 不含 works.push；launch 含
    const addFn = htmlSrc.slice(
      htmlSrc.indexOf('window.addWork=function(){'),
      htmlSrc.indexOf('window.delWork=function')
    );
    const launchFn = htmlSrc.slice(htmlSrc.indexOf('window.launch=function(){'));
    expect(addFn).not.toMatch(/state\.works\.push/);
    expect(launchFn).toMatch(/state\.works\.push\(w\)/);
  });

  it('未改动 markPub 的发布记录逻辑', () => {
    const fn = htmlSrc.slice(htmlSrc.indexOf('window.markPub=function(id){'));
    expect(fn.slice(0, 800)).toMatch(/window\.api\.addPub\(/);
  });

  it('未改动 AI 配音 / 字幕编辑器 / 视频合成', () => {
    expect(htmlSrc).toMatch(/function captionStepBack\(\)/);
    expect(htmlSrc).toMatch(/id="capSaveBtn"/);
    expect(htmlSrc).toMatch(/captionBurnFinal/);
  });
});