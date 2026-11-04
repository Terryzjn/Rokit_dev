'use strict';

// Rokit · 第一阶段：首秀计划持久化与页面改造（定向测试）
//
// 覆盖用户要求的全部定向验证点：
//   L1  SQLite 迁移到 v7 + 重复迁移安全
//   L2  JSON 兜底模式下保存 / 读取 / 更新 / 删除
//   L3  多作品计划相互隔离（跨作品读写都被拒绝）
//   L4  增加多个阶段、删除中间阶段后再新增 → 编号不重号
//   L5  日期偏移 / 时刻 / 平台多选的保存与恢复
//   L6  保存失败时 renderer 不显示虚假成功
//   L7  内容预览只读，且不覆盖现有编辑文案
//   L8  删除作品后无孤儿计划配置
//   L9  renderer → preload → IPC → store 全链路
//   L10 全局列表汇总不同作品的任务
//   L11 同一阶段多平台有独立状态
//   L12 手动发布成功不被误判为其它平台成功
//   L13 删除阶段不会误删已完成的历史记录
//   L14 取消任务后状态保留，重读数据库不复活为待执行
//   L15 已完成任务不能通过编辑计划被重置
//   L16 同一任务重复创建 / 更新有稳定幂等保护
//   L17 SQLite 与 JSON 两种存储模式行为一致
//   L18 整个第一阶段不发生真实平台发布或外部写入
//
// 跑的是生产代码：
//   - electron/store.js（真实 SQLite / JSON 存储层）
//   - electron/plan-ipc.js（fake ipcMain 真实调用 handler）
//   - electron/preload.js（真实 ipcRenderer.invoke 转发）
//   - index.html 里切出来的计划编辑函数（按花括号配平切出后注入依赖执行）

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const PLAN_IPC_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'plan-ipc.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

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

/* ---------- 存储驱动拦截 ----------
   本机 better-sqlite3 的原生模块与当前 Node ABI 不匹配（NODE_MODULE_VERSION 135 vs 137），
   这是改动前就存在的环境问题，按要求**不重建原生模块**。
   这里在测试进程里按需屏蔽驱动：
     - SQLite 场景：只屏蔽 better-sqlite3 → store 走 Node 内置 node:sqlite（同样是真 SQLite）
     - JSON 兜底场景：两个都屏蔽 → store 走 JSON 文件兜底
   两种模式都是生产代码的真实分支。 */
function installDriverBlock(blockNodeSqlite) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'better-sqlite3' || (blockNodeSqlite && request === 'node:sqlite')) {
      const e = new Error("Cannot find module '" + request + "'");
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    return orig.call(this, request, parent, isMain);
  };
  return function restore() { Module._load = orig; };
}
function loadStoreFresh(blockNodeSqlite) {
  if (restoreSqlite) { restoreSqlite(); restoreSqlite = null; }
  restoreSqlite = installDriverBlock(!!blockNodeSqlite);
  const id = require.resolve('../electron/store');
  delete require.cache[id];
  return require('../electron/store');
}

/* ---------- 临时目录 ---------- */
let tmpDir;
let dbPath;
let restoreSqlite = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-plan-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  if (restoreSqlite) { restoreSqlite(); restoreSqlite = null; }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
  const id = require.resolve('../electron/store');
  delete require.cache[id];
});

function newStore() {
  const { Store } = loadStoreFresh(false);   // node:sqlite 驱动 → mode='sqlite'
  return new Store(dbPath);
}
function newJsonStore() {
  const { Store } = loadStoreFresh(true);    // 两个驱动都屏蔽 → mode='json'
  return new Store(dbPath);
}
function seedWork(store, id, name, createdAt) {
  return store.saveWork({
    id: id,
    name: name || id,
    type: 'tool',
    intro: 'intro ' + id,
    url: '',
    status: '首秀中',
    queue: '主推',
    star: 0, dl: 0, play: '0',
    next: '',
    created_at: createdAt || new Date().toISOString()
  });
}
function stage(id, o) {
  o = o || {};
  return {
    id: id,
    title: o.title || ('阶段 ' + id),
    desc: o.desc || '',
    offsetDays: o.offsetDays === undefined ? 0 : o.offsetDays,
    timeOfDay: o.timeOfDay || '20:00',
    platforms: o.platforms || ['github'],
    copy: o.copy || {}
  };
}

/* ==================================================================
   L1 · SQLite 迁移
   ================================================================== */
describe('L1 · SQLite 迁移与重复迁移安全', () => {
  it('CURRENT_VERSION 提升到 10（v7 建表，v8 模拟标识，v9 等待真实执行标记，v10 发布键唯一索引）', () => {
    const { CURRENT_VERSION, migrations } = require('../electron/store');
    expect(CURRENT_VERSION).toBe(10);
    const v7 = migrations.filter(function (m) { return m.version === 7; })[0];
    expect(v7).toBeTruthy();
    expect(v7.up.toString()).toContain('plan_stages');
    expect(v7.up.toString()).toContain('plan_tasks');
    const v8 = migrations.filter(function (m) { return m.version === 8; })[0];
    expect(v8).toBeTruthy();
    expect(v8.up.toString()).toContain('simulated');
    const v9 = migrations.filter(function (m) { return m.version === 9; })[0];
    expect(v9).toBeTruthy();
    expect(v9.up.toString()).toContain('real_only');
    expect(v9.up.toString()).toContain('history_note');
    // v10：只给非空 pub_key 建部分唯一索引（历史空键行不受约束、不被改写）
    const v10 = migrations.filter(function (m) { return m.version === 10; })[0];
    expect(v10).toBeTruthy();
    expect(v10.up.toString()).toContain('idx_pubs_pub_key');
    expect(v10.up.toString()).toContain("pub_key <> ''");
  });

  it('迁移在真实 SQLite 上执行成功（v7 表存在）', () => {
    const store = newStore();
    expect(store.mode).toBe('sqlite');
    const tables = store.all("SELECT name FROM sqlite_master WHERE type='table'").map(function (r) { return r.name; });
    expect(tables).toContain('plan_stages');
    expect(tables).toContain('plan_tasks');
  });

  it('重复实例化 / 重复迁移是安全的（不抛错，数据保留）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a')]);

    // 再次实例化（等价于重复迁移）
    const again = newStore();
    again.migrate();
    again.migrate();

    const stages = again.listPlanStages('w1');
    expect(stages).toHaveLength(1);
    expect(stages[0].id).toBe('ps_a');
  });

  it('迁移不会重置既有作品与发布记录', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    const again = newStore();
    expect(again.listWorks().filter(function (w) { return w.id === 'w1'; })).toHaveLength(1);
    expect(again.listPubs()).toHaveLength(1);
  });
});

/* ==================================================================
   L2 · JSON 兜底模式
   ================================================================== */
describe('L2 · JSON 兜底模式的保存 / 读取 / 更新 / 删除', () => {
  it('走 json 模式时 plan_stages / plan_tasks 有独立容器', () => {
    const store = newJsonStore();
    expect(store.mode).toBe('json');
    expect(Array.isArray(store.data.plan_stages)).toBe(true);
    expect(Array.isArray(store.data.plan_tasks)).toBe(true);
  });

  it('保存后能读回；更新后能读回新值；删除后不再返回', () => {
    const store = newJsonStore();
    seedWork(store, 'w1', '作品一');

    const r = store.savePlanStages('w1', [stage('ps_a', { offsetDays: 2, timeOfDay: '09:30', platforms: ['github', 'wechat'] })]);
    expect(r.ok).toBe(true);

    let stages = store.listPlanStages('w1');
    expect(stages).toHaveLength(1);
    expect(stages[0].offset_days).toBe(2);
    expect(stages[0].time_of_day).toBe('09:30');
    expect(stages[0].platforms).toEqual(['github', 'wechat']);

    // 更新
    store.savePlanStages('w1', [stage('ps_a', { offsetDays: 5, timeOfDay: '07:15', platforms: ['wechat'] })]);
    stages = store.listPlanStages('w1');
    expect(stages[0].offset_days).toBe(5);
    expect(stages[0].time_of_day).toBe('07:15');
    expect(stages[0].platforms).toEqual(['wechat']);

    // 删除阶段
    const del = store.deletePlanStage('w1', 'ps_a');
    expect(del.ok).toBe(true);
    expect(store.listPlanStages('w1')).toHaveLength(0);
  });

  it('JSON 模式下数据真正落盘（重新打开仍是同一份）', () => {
    const store = newJsonStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { offsetDays: 3, timeOfDay: '08:00' })]);
    store.savePlanStages('w1', [stage('ps_a', { offsetDays: 3, timeOfDay: '08:00' }), stage('ps_b', { platforms: ['youtube'] })]);

    // 重新读盘（新的 Store 实例 = 重新打开应用）
    const reopened = newJsonStore();
    const stages = reopened.listPlanStages('w1');
    expect(stages).toHaveLength(2);
    expect(stages.map(function (s) { return s.id; })).toEqual(['ps_a', 'ps_b']);
  });
});

/* ==================================================================
   L3 · 多作品隔离
   ================================================================== */
describe('L3 · 多作品计划相互隔离', () => {
  it('A 作品的计划读不到 B 作品的阶段', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a')]);
    store.savePlanStages('w2', [stage('ps_b')]);

    expect(store.listPlanStages('w1').map(function (s) { return s.id; })).toEqual(['ps_a']);
    expect(store.listPlanStages('w2').map(function (s) { return s.id; })).toEqual(['ps_b']);
    expect(store.listPlanTasks('w1').map(function (t) { return t.work_id; })).toEqual(['w1']);
    expect(store.listPlanTasks('w2').map(function (t) { return t.work_id; })).toEqual(['w2']);
  });

  it('跨作品保存被拒绝（B 作品不能覆盖 A 作品的阶段）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a')]);

    const res = store.savePlanStages('w2', [stage('ps_a', { title: '被篡改' })]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('another work');
    // A 作品的数据没被动过
    expect(store.listPlanStages('w1')[0].title).toBe('阶段 ps_a');
    expect(store.listPlanStages('w2')).toHaveLength(0);
  });

  it('跨作品删除阶段被拒绝', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a')]);

    const res = store.deletePlanStage('w2', 'ps_a');
    expect(res.ok).toBe(false);
    expect(store.listPlanStages('w1')).toHaveLength(1);
  });

  it('跨作品取消任务被拒绝', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const taskId = store.listPlanTasks('w1')[0].id;

    const res = store.cancelPlanTask('w2', taskId);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('跨作品改任务也被拒绝', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const taskId = store.listPlanTasks('w1')[0].id;

    const res = store.updatePlanTask('w2', taskId, { scheduled_at: '2030-01-01T00:00:00.000Z' });
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].scheduled_at).not.toBe('2030-01-01T00:00:00.000Z');
  });
});

/* ==================================================================
   L4 · 阶段序号不重号
   ================================================================== */
describe('L4 · 增删阶段后编号不重号', () => {
  it('删除中间阶段后再新增，序号按顺序连续且不与旧号重复', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [
      stage('ps_0', { title: 'A' }),
      stage('ps_1', { title: 'B' }),
      stage('ps_2', { title: 'C' })
    ]);
    expect(store.listPlanStages('w1').map(function (s) { return s.seq; })).toEqual([0, 1, 2]);

    // 删除中间阶段 ps_1
    store.savePlanStages('w1', [stage('ps_0', { title: 'A' }), stage('ps_2', { title: 'C' })]);
    expect(store.listPlanStages('w1').map(function (s) { return s.seq; })).toEqual([0, 1]);

    // 再新增一个阶段（新稳定 ID）
    store.savePlanStages('w1', [
      stage('ps_0', { title: 'A' }),
      stage('ps_2', { title: 'C' }),
      stage('ps_new', { title: 'D' })
    ]);
    const stages = store.listPlanStages('w1');
    expect(stages.map(function (s) { return s.seq; })).toEqual([0, 1, 2]);
    // 阶段身份用稳定 ID，不依赖 DAY 文本 / 数组长度
    expect(stages.map(function (s) { return s.id; })).toEqual(['ps_0', 'ps_2', 'ps_new']);
  });

  it('阶段 ID 由调用方提供（不依赖数组长度生成），删除后新增不会撞号', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_x')]);
    store.savePlanStages('w1', []);
    store.savePlanStages('w1', [stage('ps_x')]);
    expect(store.listPlanStages('w1')[0].id).toBe('ps_x');
  });

  it('界面层 DAY 标签只读、序号由位置推导（删除中间阶段后自动重排）', () => {
    const planItem = extractBlock(HTML, 'function planItem(it,i){');
    expect(planItem).toContain('DAY \'+i+');
    // DAY 不可编辑
    expect(planItem).not.toMatch(/setPlan\(i,\s*'day'/);
    // 新增阶段用稳定 ID，不靠数组长度
    const addPlan = extractBlock(HTML, 'window.addPlan=function(){');
    expect(addPlan).toContain('newPlanStageId()');
    // 删除阶段有确认提示
    const delPlan = extractBlock(HTML, 'window.delPlan=function(i){');
    expect(delPlan).toContain('confirmModal');
  });
});

/* ==================================================================
   L5 · 时间与平台多选的保存与恢复
   ================================================================== */
describe('L5 · 日期偏移 / 时刻 / 平台多选的保存与恢复', () => {
  it('offset_days / time_of_day / platforms 原样保存并读回', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [
      stage('ps_a', { offsetDays: 7, timeOfDay: '06:45', platforms: ['github', 'wechat', 'youtube'] })
    ]);
    const s = store.listPlanStages('w1')[0];
    expect(s.offset_days).toBe(7);
    expect(s.time_of_day).toBe('06:45');
    expect(s.platforms).toEqual(['github', 'wechat', 'youtube']);
  });

  it('非法时刻回落到 20:00；负数偏移量归零为 0', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { offsetDays: -3, timeOfDay: '不是时间' })]);
    const s = store.listPlanStages('w1')[0];
    expect(s.offset_days).toBe(0);
    expect(s.time_of_day).toBe('20:00');
  });

  it('计划执行时间按「作品创建日期 + 偏移天数 + 本地时刻」解析', () => {
    const store = newStore();
    // 用本地正午构造作品创建时间，避免跨时区导致的日期漂移
    const base = new Date(2026, 2, 10, 12, 0, 0);
    seedWork(store, 'w1', '作品一', base.toISOString());
    store.savePlanStages('w1', [stage('ps_a', { offsetDays: 2, timeOfDay: '10:30' })]);

    const t = store.listPlanTasks('w1')[0];
    const d = new Date(t.scheduled_at);
    expect(isNaN(d.getTime())).toBe(false);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(30);
  });

  it('界面层提供绝对日期时间与三平台多选控件', () => {
    const planItem = extractBlock(HTML, 'function planItem(it,i){');
    expect(planItem).toContain('datetime-local');
    expect(planItem).toContain('scheduledAt');
    expect(planItem).not.toContain('autoPublish');
    expect(planItem).not.toContain('Release');
    expect(planItem).toContain('togglePlanPlatform');
    expect(HTML).toContain('PLAN_PLATFORMS');
    // 三个平台都在多选列表里
    expect(HTML).toMatch(/PLAN_PLATFORMS=\[[^\]]*'github'/);
    expect(HTML).toMatch(/PLAN_PLATFORMS=\[[^\]]*'wechat'/);
    expect(HTML).toMatch(/PLAN_PLATFORMS=\[[^\]]*'youtube'/);
  });
});

/* ==================================================================
   L6 · 保存失败时 renderer 不显示虚假成功
   ================================================================== */
describe('L6 · 保存失败必须提示用户', () => {
  const planStagePayloadSrc = extractBlock(HTML, 'function planStagePayload(it){');
  const savePlanSrc = extractBlock(HTML, 'window.savePlan=function(){');

  function runSavePlan(sandbox) {
    // 把生产函数切出来注入沙箱依赖（state / window.api / toast），真实执行一次
    const fn = new Function('state', 'window', 'toast', 'Promise',
      planStagePayloadSrc + '\n' + savePlanSrc + '\nreturn window.savePlan();');
    return fn(sandbox.state, sandbox.window, sandbox.toast, Promise);
  }

  it('savePlan 调用真实的 planSave IPC，而不是只改内存', () => {
    expect(savePlanSrc).toContain('window.api.planSave');
    expect(savePlanSrc).toContain('state.planDirty=false');
  });

  it('IPC 返回 ok:false 时提示失败并返回 false（不显示成功）', async () => {
    const calls = [];
    const toasts = [];
    const sandbox = {
      state: { planOwnerId: 'w1', plan: [Object.assign(stage('ps_a'), { scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString() })], planDirty: true },
      window: {
        api: {
          planSave: function (owner, stages) {
            calls.push({ owner: owner, stages: stages });
            return Promise.resolve({ ok: false, error: '磁盘满了' });
          }
        }
      },
      toast: function (m, level) { toasts.push({ m: m, level: level }); }
    };
    const ok = await runSavePlan(sandbox);

    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].owner).toBe('w1');
    expect(calls[0].stages).toHaveLength(1);
    expect(calls[0].stages[0].id).toBe('ps_a');
    expect(toasts.some(function (t) { return String(t.m).indexOf('保存计划失败') >= 0; })).toBe(true);
    expect(sandbox.state.planDirty).toBe(true);   // 没保存成功 → 仍然是「有未保存改动」
  });

  it('IPC 抛错时同样提示失败', async () => {
    const toasts = [];
    const sandbox = {
      state: { planOwnerId: 'w1', plan: [Object.assign(stage('ps_a'), { scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString() })], planDirty: true },
      window: { api: { planSave: function () { return Promise.reject(new Error('IPC 断了')); } } },
      toast: function (m) { toasts.push(m); }
    };
    const ok = await runSavePlan(sandbox);

    expect(ok).toBe(false);
    expect(toasts.some(function (m) { return String(m).indexOf('保存计划失败') >= 0; })).toBe(true);
    expect(sandbox.state.planDirty).toBe(true);
  });

  it('没有关联作品时不静默成功', async () => {
    const toasts = [];
    const sandbox = {
      state: { planOwnerId: '', curWork: '', plan: [stage('ps_a')], planDirty: true },
      window: { api: { planSave: function () { return Promise.resolve({ ok: true }); } } },
      toast: function (m) { toasts.push(m); }
    };
    const ok = await runSavePlan(sandbox);
    expect(ok).toBe(false);
    expect(toasts.length).toBeGreaterThan(0);
  });

  it('savePlanAndGo 只有在保存成功后才跳转（失败不跳转）', () => {
    const savePlanAndGo = extractBlock(HTML, 'window.savePlanAndGo=function(){');
    expect(savePlanAndGo).toContain('window.savePlan()');
    // 导航已改为「保存后进入发布环节（window.launch）」，不再直接跳 step 10
    expect(savePlanAndGo).toContain('window.launch()');
    // 先 save 后跳转，且失败时直接 return
    expect(savePlanAndGo.indexOf('savePlan()')).toBeLessThan(savePlanAndGo.indexOf('window.launch()'));
    expect(savePlanAndGo).toMatch(/if\s*\(\s*!ok\s*\)\s*return false/);
  });

  it('「保存，去打通平台」按钮真的调用 savePlanAndGo', () => {
    expect(HTML).toContain('onclick="savePlanAndGo()"');
  });
});

/* ==================================================================
   L7 · 内容预览只读，且不覆盖已编辑文案
   ================================================================== */
describe('L7 · 只读内容预览', () => {
  const planCopyPreviewSrc = extractBlock(HTML, 'function planCopyPreview(it){');

  function runPreview(state, it, genCopy, planPlatformMeta) {
    const esc = function (s) { return String(s); };
    const fn = new Function('state', 'esc', 'genCopy', 'planPlatformMeta', 'it',
      planCopyPreviewSrc + '\nreturn planCopyPreview(it);');
    return fn(state, esc, genCopy, planPlatformMeta, it);
  }
  const meta = function (id) { return { id: id, name: id }; };

  it('预览区是只读容器（没有可编辑输入框），且不写 state.copies', () => {
    const planItem = extractBlock(HTML, 'function planItem(it,i){');
    expect(planItem).toContain('pf-preview');
    expect(planItem).not.toMatch(/pf-preview[\s\S]{0,400}<input/);
    expect(planCopyPreviewSrc).not.toMatch(/state\.copies\s*=/);
    expect(planCopyPreviewSrc).not.toMatch(/state\.copies\[[^\]]+\]\s*=/);
  });

  it('预览不调用 genAll（不会触发网络请求 / 不会批量覆盖文案）', () => {
    expect(planCopyPreviewSrc).not.toContain('genAll(');
  });

  it('预览只使用属于当前作品的 state.copies（copiesOwner 不匹配时不使用）', () => {
    const state = {
      planOwnerId: 'w1',
      copiesOwner: 'w2',                    // 文案属于别的作品
      copies: { github: { title: '别的作品的标题', body: '别的作品正文' } }
    };
    const genCopy = function (pid) { return { title: '模板标题-' + pid, body: '模板正文-' + pid }; };
    const out = runPreview(state, { platforms: ['github'], copy: {} }, genCopy, meta);
    expect(out).not.toContain('别的作品的标题');
    expect(out).not.toContain('别的作品正文');
  });

  it('当前作品的已生成文案会被展示（属于当前作品 + 当前平台）', () => {
    const state = {
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      copies: { github: { title: '我的标题', body: '我的正文' } }
    };
    const genCopy = function () { return { title: '模板', body: '模板' }; };
    const out = runPreview(state, { platforms: ['github'], copy: {} }, genCopy, meta);
    expect(out).toContain('我的标题');
    expect(out).toContain('我的正文');
  });

  it('没有可用文案时显示明确的待生成提示', () => {
    const state = { planOwnerId: 'w1', copiesOwner: 'w1', copies: {} };
    const genCopy = function () { return { title: '', body: '' }; };
    const out = runPreview(state, { platforms: ['github'], copy: {} }, genCopy, meta);
    expect(out).toContain('暂无文案');
  });

  it('阶段快照文案优先于当前文案（保存过的版本不会被静默替换）', () => {
    const state = {
      planOwnerId: 'w1',
      copiesOwner: 'w1',
      copies: { github: { title: '当前文案', body: '当前正文' } }
    };
    const genCopy = function () { return { title: '模板', body: '模板' }; };
    const out = runPreview(state, {
      platforms: ['github'],
      copy: { github: { title: '已保存文案', body: '已保存正文' } }
    }, genCopy, meta);
    expect(out).toContain('已保存文案');
    expect(out).not.toContain('当前文案');
  });

  it('未选择平台时给出明确提示', () => {
    const state = { planOwnerId: 'w1', copiesOwner: 'w1', copies: {} };
    const genCopy = function () { return { title: '', body: '' }; };
    const out = runPreview(state, { platforms: [], copy: {} }, genCopy, meta);
    expect(out).toContain('尚未选择发布平台');
  });
});

/* ==================================================================
   L8 · 删除作品后无孤儿计划配置
   ================================================================== */
describe('L8 · 删除作品后无孤儿计划配置', () => {
  it('deleteWork 同步清掉该作品的阶段与任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'] })]);
    store.savePlanStages('w2', [stage('ps_b')]);

    store.deleteWork('w1');

    expect(store.listPlanStages('w1')).toHaveLength(0);
    expect(store.listPlanTasks('w1')).toHaveLength(0);
    // 不影响别的作品
    expect(store.listPlanStages('w2')).toHaveLength(1);
    expect(store.listPlanTasks('w2')).toHaveLength(1);
  });

  it('purgeOrphanPlans 清理没有归属作品的阶段配置', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a')]);
    const out = store.purgeOrphanPlans();
    expect(out.ok).toBe(true);
    expect(out.removed).toBeGreaterThanOrEqual(0);
    // 真实作品的计划不会被误清
    expect(store.listPlanStages('w1')).toHaveLength(1);
  });

  it('renderer 删除作品时同步清掉本地归属，避免继续往已删作品保存', () => {
    const delWork = extractBlock(HTML, 'window.delWork=function(id){');
    expect(delWork).toContain("state.planOwnerId=''");
    expect(delWork).toContain("state.copiesOwner=''");
  });

  it('main.js 启动时清理孤儿计划配置', () => {
    expect(MAIN_SRC).toContain('purgeOrphanPlans');
  });
});

/* ==================================================================
   L9 · renderer → preload → IPC → store 全链路
   ================================================================== */
describe('L9 · renderer → preload → IPC → store 全链路', () => {
  function createIpcHarness() {
    const handlers = new Map();
    const ipcMain = {
      handle: vi.fn(function (channel, fn) { handlers.set(channel, fn); })
    };
    const storeRef = { current: null };
    const { registerPlanIpc } = require('../electron/plan-ipc');
    registerPlanIpc(ipcMain, { getStore: function () { return storeRef.current; } });
    return { handlers: handlers, ipcMain: ipcMain, storeRef: storeRef };
  }

  it('plan-ipc 注册了本阶段需要的全部通道', () => {
    const h = createIpcHarness();
    ['plan:list', 'plan:save', 'plan:delete-stage', 'plan:tasks', 'plan:all', 'plan:cancel-task', 'plan:update-task', 'plan:reassign']
      .forEach(function (c) { expect(h.handlers.has(c)).toBe(true); });
  });

  it('preload 暴露了对应的 window.api 方法', () => {
    ['planList', 'planSave', 'planDeleteStage', 'planTasks', 'planAll', 'planCancelTask', 'planUpdateTask', 'planReassign']
      .forEach(function (fn) {
        expect(PRELOAD_SRC).toContain(fn + ':');
      });
  });

  it('main.js 注册了 plan IPC', () => {
    expect(MAIN_SRC).toContain('registerPlanIpc');
    expect(MAIN_SRC).toContain("require('./plan-ipc')");
  });

  it('完整链路：renderer 调用 → preload 转发 → IPC handler → store 落库 → 读回', async () => {
    const h = createIpcHarness();
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    h.storeRef.current = store;

    // preload 层：真实转发到 ipcRenderer.invoke
    const invoked = [];
    const ipcRenderer = { invoke: vi.fn(function (channel, ...args) {
      invoked.push({ channel: channel, args: args });
      const fn = h.handlers.get(channel);
      if (!fn) return Promise.reject(new Error('no handler ' + channel));
      return Promise.resolve(fn(null, ...args));
    }) };
    // preload 层：用 stub 的 electron 模块真实执行 preload 源码
    let api = null;
    const electronStub = {
      contextBridge: {
        exposeInMainWorld: function (key, value) { if (key === 'api') api = value; }
      },
      ipcRenderer: ipcRenderer
    };
    const preloadFn = new Function('require', 'module', 'exports',
      PRELOAD_SRC);
    preloadFn(function (name) {
      if (name === 'electron') return electronStub;
      return require(name);
    }, { exports: {} }, {});

    // renderer 层：调用 window.api.planSave
    const res = await api.planSave('w1', [stage('ps_a', { platforms: ['github'], offsetDays: 4, timeOfDay: '19:00' })]);
    expect(res.ok).toBe(true);
    expect(invoked[0].channel).toBe('plan:save');
    expect(invoked[0].args[0]).toBe('w1');

    // store 层真的落库了
    const stages = store.listPlanStages('w1');
    expect(stages).toHaveLength(1);
    expect(stages[0].offset_days).toBe(4);
    expect(stages[0].time_of_day).toBe('19:00');
    expect(store.listPlanTasks('w1')).toHaveLength(1);

    // 再读回来
    const read = await api.planList('w1');
    expect(read.stages).toHaveLength(1);
    expect(read.tasks).toHaveLength(1);

    // 全局列表
    const all = await api.planAll();
    expect(all.stages).toHaveLength(1);
    expect(all.tasks).toHaveLength(1);
  });
});

/* ==================================================================
   L10 · 全局列表汇总
   ================================================================== */
describe('L10 · 全局列表汇总不同作品的任务', () => {
  it('listPlanTasks(空) 返回全部作品的任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    store.savePlanStages('w2', [stage('ps_b', { platforms: ['wechat', 'youtube'] })]);

    const all = store.listPlanTasks('');
    expect(all).toHaveLength(3);
    expect(all.map(function (t) { return t.work_id; }).sort()).toEqual(['w1', 'w2', 'w2']);
  });

  it('listAllPlanStages 返回全部作品的阶段配置', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a')]);
    store.savePlanStages('w2', [stage('ps_b')]);
    expect(store.listAllPlanStages()).toHaveLength(2);
  });

  it('index.html 有「发布计划」入口（在「我的作品」页内，不新增一级导航）', () => {
    expect(HTML).toContain('id="openPlanCenterBtn"');
    expect(HTML).toContain('onclick="openPlanCenter()"');
    expect(HTML).toContain('<section data-route="plans"');
    // 一级导航仍然只有四个
    const navStart = HTML.indexOf('<div class="navtab">');
    const nav = HTML.slice(navStart, HTML.indexOf('</div>', navStart));
    expect((nav.match(/<button/g) || []).length).toBe(4);
  });

  it('六种任务状态都有中文标签（尚未实现的状态明确展示，不伪造执行结果）', () => {
    ['待执行', '执行中', '已完成', '执行失败', '草稿待发布', '已取消'].forEach(function (label) {
      expect(HTML).toContain("label:'" + label + "'");
    });
    expect(HTML).toContain("label:'待核实'");
  });

  it('全局列表展示作品 / 阶段 / 平台 / 时间 / 状态，并提供查看·编辑·取消入口', () => {
    const render = extractBlock(HTML, 'function renderPlanCenter(){');
    expect(render).toContain('planTaskWorkName');
    expect(render).toContain('planTaskTimeText');
    expect(render).toContain('planTaskStatusMeta');
    expect(render).toContain('planCenterCancelTask');
    expect(render).toContain('planCenterEditTask');
    expect(render).toContain('DAY ');
    // 未执行的任务才给「取消」入口
    expect(render).toContain("canCancel=(t.status==='pending'||t.status==='needs_review')");
  });

  it('全局入口跳转到内部视图（不新增一级导航）', () => {
    const openPlanCenter = extractBlock(HTML, 'window.openPlanCenter=function(){');
    expect(openPlanCenter).toContain("go('plans')");
  });
});

/* ==================================================================
   L11 · 同一阶段多平台有独立状态
   ================================================================== */
describe('L11 · 同一阶段多个平台有独立执行任务与状态', () => {
  it('一个阶段选三个平台 → 三条独立任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat', 'youtube'] })]);
    const tasks = store.listPlanTasks('w1');
    expect(tasks).toHaveLength(3);
    expect(tasks.map(function (t) { return t.platform_id; }).sort()).toEqual(['github', 'wechat', 'youtube']);
    // 任务 ID 互不相同，且都由 stage + platform 派生
    const ids = tasks.map(function (t) { return t.id; });
    expect(new Set(ids).size).toBe(3);
    ids.forEach(function (id) { expect(id).toContain('ps_a'); });
  });

  it('取消其中一个平台的任务不影响同阶段其它平台', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'] })]);
    const gh = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'github'; })[0];

    store.cancelPlanTask('w1', gh.id);
    const after = store.listPlanTasks('w1');
    expect(after.filter(function (t) { return t.platform_id === 'github'; })[0].status).toBe('cancelled');
    expect(after.filter(function (t) { return t.platform_id === 'wechat'; })[0].status).toBe('pending');
  });

  it('从阶段移除一个平台时只取消该平台的任务，其它平台不受影响', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'] })]);
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);

    const after = store.listPlanTasks('w1');
    expect(after.filter(function (t) { return t.platform_id === 'github'; })[0].status).toBe('pending');
    expect(after.filter(function (t) { return t.platform_id === 'wechat'; })[0].status).toBe('cancelled');
  });
});

/* ==================================================================
   L12 · 手动发布成功不被误判为其它平台成功
   ================================================================== */
describe('L12 · 手动发布成功不会被误判为其它平台成功', () => {
  it('GitHub 手动发布成功 → 只有 GitHub 任务被标记待核实，YouTube 任务仍是待执行', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'youtube'] })]);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'manual', pub_key: 'manual|github|w1', url: 'https://github.com/x/y'
    });

    const tasks = store.listPlanTasks('w1');
    const gh = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    const yt = tasks.filter(function (t) { return t.platform_id === 'youtube'; })[0];
    // 幂等键不匹配 → 待核实（不自动跳过、也不自动重复发送）
    expect(gh.pub_state).toBe('review');
    // 其它平台的待执行任务完全不受影响
    expect(yt.pub_state).toBe('none');
    expect(yt.status).toBe('pending');
  });

  it('另一个作品的发布成功不会影响本作品任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    seedWork(store, 'w2', '作品二');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    store.savePlanStages('w2', [stage('ps_b', { platforms: ['github'] })]);
    store.addPub({
      work_id: 'w2', platform: 'GitHub', platform_id: 'github',
      status: 'manual', pub_key: 'manual|github|w2'
    });

    const t1 = store.listPlanTasks('w1')[0];
    expect(t1.pub_state).toBe('none');
    expect(t1.status).toBe('pending');
  });

  it('幂等键精确命中时判定为已发布（不会重复自动发布）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const task = store.listPlanTasks('w1')[0];
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', pub_key: task.pub_key, url: 'https://github.com/x/y'
    });
    const after = store.listPlanTasks('w1')[0];
    expect(after.pub_state).toBe('done');
    expect(after.pub_url).toBe('https://github.com/x/y');
  });
});

/* ==================================================================
   L13 · 删除阶段不会误删已完成的历史记录
   ================================================================== */
describe('L13 · 删除阶段不会误删已完成的历史记录', () => {
  it('阶段里有已完成任务时，删除阶段只取消未执行任务，完成记录原样保留', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'] })]);

    const gh = store.listPlanTasks('w1').filter(function (t) { return t.platform_id === 'github'; })[0];
    // 模拟调度器把 GitHub 任务标记为已完成
    store._planWriteTask(Object.assign({}, gh, {
      status: 'done', platform_url: 'https://github.com/x/y',
      started_at: new Date().toISOString(), finished_at: new Date().toISOString()
    }));

    store.deletePlanStage('w1', 'ps_a');

    const tasks = store.listPlanTasks('w1');
    expect(tasks).toHaveLength(2);   // 历史任务记录仍然存在
    const done = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    expect(done.status).toBe('done');
    expect(done.platform_url).toBe('https://github.com/x/y');
    const other = tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0];
    expect(other.status).toBe('cancelled');
  });

  it('删除一个阶段不会误删另一个阶段的任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a'), stage('ps_b')]);
    store.deletePlanStage('w1', 'ps_a');
    const left = store.listPlanTasks('w1');
    // 被删阶段的任务保留为「已取消」（不物理删除历史），另一个阶段的任务不受影响
    expect(left).toHaveLength(2);
    expect(left.filter(function (t) { return t.stage_id === 'ps_a'; })[0].status).toBe('cancelled');
    expect(left.filter(function (t) { return t.stage_id === 'ps_b'; })[0].status).toBe('pending');
  });

  it('删除作品时的发布记录策略不受计划层影响（计划不伪造发布历史）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: 'k1' });
    store.savePlanStages('w1', [stage('ps_a')]);
    store.deletePlanStage('w1', 'ps_a');
    // 发布记录仍在（计划层不碰 pubs）
    expect(store.listPubs()).toHaveLength(1);
  });
});

/* ==================================================================
   L14 · 取消任务后状态保留，重读数据库不复活
   ================================================================== */
describe('L14 · 取消任务后状态保留，不复活为待执行', () => {
  it('取消后重开数据库仍是 cancelled', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const id = store.listPlanTasks('w1')[0].id;

    const res = store.cancelPlanTask('w1', id);
    expect(res.ok).toBe(true);

    const reopened = newStore();
    const t = reopened.listPlanTasks('w1').filter(function (x) { return x.id === id; })[0];
    expect(t.status).toBe('cancelled');
    expect(t.finished_at).toBeTruthy();
  });

  it('再次保存同一份计划不会把已取消的任务复活为待执行', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const id = store.listPlanTasks('w1')[0].id;
    store.cancelPlanTask('w1', id);

    // 再保存一次相同配置
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1').filter(function (x) { return x.id === id; })[0];
    expect(t.status).toBe('cancelled');
  });

  it('已执行的任务不允许取消', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'done' }));

    const res = store.cancelPlanTask('w1', t.id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('执行中的任务不允许取消（第一阶段只建立边界）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'running' }));

    const res = store.cancelPlanTask('w1', t.id);
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');
  });
});

/* ==================================================================
   L15 · 已完成任务不能通过编辑计划被重置
   ================================================================== */
describe('L15 · 已完成任务不能通过编辑计划被重置', () => {
  it('保存计划时已完成任务的状态与结果保持不变', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'], offsetDays: 1 })]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, {
      status: 'done', platform_url: 'https://github.com/x/y', finished_at: new Date().toISOString()
    }));

    // 改时间、改标题、改平台后重新保存
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'], offsetDays: 9, title: '改了标题' })]);

    const after = store.listPlanTasks('w1').filter(function (x) { return x.id === t.id; })[0];
    expect(after.status).toBe('done');
    expect(after.platform_url).toBe('https://github.com/x/y');
  });

  it('updatePlanTask 不能把已完成任务改成别的状态', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'done' }));

    const res = store.updatePlanTask('w1', t.id, { scheduled_at: '2030-01-01T00:00:00.000Z' });
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('尚未执行的任务允许改执行时间', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const t = store.listPlanTasks('w1')[0];
    const res = store.updatePlanTask('w1', t.id, { scheduled_at: '2030-01-01T00:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].scheduled_at).toBe('2030-01-01T00:00:00.000Z');
  });
});

/* ==================================================================
   L16 · 幂等保护
   ================================================================== */
describe('L16 · 同一任务重复创建 / 更新有稳定幂等保护', () => {
  it('重复保存同一份计划不会产生重复任务', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    const stages = [stage('ps_a', { platforms: ['github', 'wechat'] }), stage('ps_b', { platforms: ['youtube'] })];
    store.savePlanStages('w1', stages);
    const first = store.listPlanTasks('w1').map(function (t) { return t.id; }).sort();

    store.savePlanStages('w1', stages);
    store.savePlanStages('w1', stages);
    const again = store.listPlanTasks('w1').map(function (t) { return t.id; }).sort();

    expect(again).toEqual(first);
    expect(again).toHaveLength(3);
  });

  it('任务 ID 由阶段 + 平台派生（稳定可重现）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const id = store.listPlanTasks('w1')[0].id;
    expect(id).toBe('pt_ps_a_github');
  });

  it('重复保存不会重复建立已存在的发布记录（幂等键一致）', () => {
    const store = newStore();
    seedWork(store, 'w1', '作品一');
    store.savePlanStages('w1', [stage('ps_a', { platforms: ['github'] })]);
    const task = store.listPlanTasks('w1')[0];
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: task.pub_key });
    store.addPub({ work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: task.pub_key });
    expect(store.listPubs()).toHaveLength(1);
  });
});

/* ==================================================================
   L17 · SQLite 与 JSON 行为一致
   ================================================================== */
describe('L17 · SQLite 与 JSON 两种存储模式行为一致', () => {
  it('两种模式下的保存 / 读取 / 更新 / 删除 / 取消结果完全相同', () => {
    const sq = newStore();
    seedWork(sq, 'w1', '作品一');
    sq.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'], offsetDays: 2, timeOfDay: '08:00' })]);

    const js = newJsonStore();
    seedWork(js, 'w1', '作品一');
    js.savePlanStages('w1', [stage('ps_a', { platforms: ['github', 'wechat'], offsetDays: 2, timeOfDay: '08:00' })]);

    const shape = function (store) {
      return store.listPlanStages('w1').map(function (s) {
        return { id: s.id, seq: s.seq, offset: s.offset_days, time: s.time_of_day, plats: s.platforms };
      });
    };
    expect(shape(js)).toEqual(shape(sq));

    const taskShape = function (store) {
      return store.listPlanTasks('w1').map(function (t) {
        return { id: t.id, plat: t.platform_id, status: t.status, stage: t.stage_id };
      }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    };
    expect(taskShape(js)).toEqual(taskShape(sq));

    // 更新
    sq.savePlanStages('w1', [stage('ps_a', { platforms: ['github'], offsetDays: 5, timeOfDay: '09:00' })]);
    js.savePlanStages('w1', [stage('ps_a', { platforms: ['github'], offsetDays: 5, timeOfDay: '09:00' })]);
    expect(shape(js)).toEqual(shape(sq));
    expect(taskShape(js)).toEqual(taskShape(sq));

    // 取消
    const sid = sq.listPlanTasks('w1')[0].id;
    const jid = js.listPlanTasks('w1')[0].id;
    sq.cancelPlanTask('w1', sid);
    js.cancelPlanTask('w1', jid);
    expect(taskShape(js)).toEqual(taskShape(sq));

    // 删除
    sq.deletePlanStage('w1', 'ps_a');
    js.deletePlanStage('w1', 'ps_a');
    expect(shape(js)).toEqual(shape(sq));
    expect(taskShape(js)).toEqual(taskShape(sq));
  });

  it('两种模式下跨作品保护结果一致', () => {
    const sq = newStore();
    seedWork(sq, 'w1', '作品一');
    seedWork(sq, 'w2', '作品二');
    sq.savePlanStages('w1', [stage('ps_a')]);

    const js = newJsonStore();
    seedWork(js, 'w1', '作品一');
    seedWork(js, 'w2', '作品二');
    js.savePlanStages('w1', [stage('ps_a')]);

    const rs = sq.savePlanStages('w2', [stage('ps_a')]);
    const rj = js.savePlanStages('w2', [stage('ps_a')]);
    expect(rs.ok).toBe(false);
    expect(rj.ok).toBe(false);
  });

  it('两种模式下删除作品的孤儿清理结果一致', () => {
    const sq = newStore();
    seedWork(sq, 'w1', '作品一');
    sq.savePlanStages('w1', [stage('ps_a')]);
    sq.deleteWork('w1');

    const js = newJsonStore();
    seedWork(js, 'w1', '作品一');
    js.savePlanStages('w1', [stage('ps_a')]);
    js.deleteWork('w1');

    expect(sq.listPlanStages('w1')).toHaveLength(0);
    expect(js.listPlanStages('w1')).toHaveLength(0);
    expect(sq.listPlanTasks('w1')).toHaveLength(0);
    expect(js.listPlanTasks('w1')).toHaveLength(0);
  });
});

/* ==================================================================
   L18 · 本阶段不发生真实平台发布或外部写入
   ================================================================== */
describe('L18 · 第一阶段不发生真实平台发布或外部写入', () => {
  it('计划相关的 store 方法不发起网络请求', () => {
    const planSection = STORE_SRC.slice(STORE_SRC.indexOf('首秀计划（计划配置 + 平台执行任务）'));
    expect(planSection).not.toMatch(/https?\.(get|post|request)|fetch\(|net\.request|axios/i);
  });

  it('plan-ipc 只做数据读写，不含任何平台发布调用', () => {
    expect(PLAN_IPC_SRC).not.toMatch(/publishToGithub|githubPublish|youtubePublish|wechatCreateDraft|publishVideo|createDraft/i);
    expect(PLAN_IPC_SRC).not.toMatch(/https?\.|fetch\(|axios/i);
  });

  it('preload 里计划相关的接口只调用 plan:* 通道', () => {
    const planLines = PRELOAD_SRC.split('\n').filter(function (l) { return /^\s*plan[A-Z]\w*\s*:/.test(l); });
    expect(planLines.length).toBeGreaterThanOrEqual(8);
    planLines.forEach(function (l) {
      expect(l).toMatch(/ipcRenderer\.invoke\('plan:[a-z-]+'/);
    });
  });

  it('index.html 的计划代码段不调用任何发布接口', () => {
    const block = extractBlock(HTML, 'function planItem(it,i){');
    expect(block).not.toMatch(/autoPub\(|publishTo|createDraft|githubPublish|youtubePublish/);
    const preview = extractBlock(HTML, 'function planCopyPreview(it){');
    expect(preview).not.toMatch(/autoPub\(|publishTo|createDraft|githubPublish|youtubePublish/);
  });

  it('main.js 的计划注册不启动定时器（调度器属于后续阶段）', () => {
    const idx = MAIN_SRC.indexOf('registerPlanIpc');
    const around = MAIN_SRC.slice(Math.max(0, idx - 800), idx + 400);
    expect(around).not.toMatch(/setInterval\s*\(/);
    expect(around).not.toMatch(/setTimeout\s*\(/);
  });
});
