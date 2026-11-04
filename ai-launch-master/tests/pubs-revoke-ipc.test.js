// Rokit · 撤销「标记已发布」IPC（pubs:revoke）—— 批次二定向测试
//
// 覆盖：
//   I1  pubs:revoke 已注册（且与 pubs:delete 是**两个不同**的通道）
//   I2  合法新格式键 → 调用 store.deleteManualPub，且**只调用一次**
//   I3  Store 不存在（null）→ 安全返回失败，**不调用** Store
//   I4  store.mode === 'error' → 安全返回失败，**不调用** Store
//   I5  自动发布键 → 拒绝，**不调用** Store
//   I6  首秀计划键 → 拒绝，**不调用** Store
//   I7  旧三段式手动键 → 拒绝，**不调用** Store
//   I8  空字符串 / null / undefined / 非字符串 → 拒绝，**不调用** Store
//   I9  删除成功 → { ok:true, deleted, id, key }
//   I10 合法键但记录不存在（deleted=0）→ 失败，**不视为成功**
//   I11 rejected:true → 明确的"非法键"错误（与"记录不存在"区分开）
//   I12 Store 抛异常 → handler 捕获，**不向 Renderer 抛异常**
//   I13 preload 暴露 revokePub，且调用的是 'pubs:revoke' 通道
//
// 手法：按既有测试惯例，从 main.js / preload.js **源码**里切出 handler 并用
//   fake ipcMain + mock Store 执行。
//   **不启动 Electron、不访问活动数据库、不调用任何真实平台 API。**
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 通用：从源码里按花括号配平切出一段代码 ---------- */
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

// extractBlock 只切到箭头函数体的收尾花括号（`}`），
//   而完整的注册语句还差一个 `);` —— 这里补齐，得到可直接执行的完整语句。
const REVOKE_STMT = extractBlock(MAIN_SRC, "ipcMain.handle('pubs:revoke', (_e, pubKey) => {") + ');';

/**
 * 搭建一个可执行的 pubs:revoke 运行环境。
 * 依赖注入：fake ipcMain（记录注册的 handler）+ mock store
 */
function makeRevokeEnv(overrides) {
  const o = overrides || {};
  const handlers = new Map();
  const ipcMain = {
    handle: vi.fn(function (channel, fn) {
      if (handlers.has(channel)) throw new Error('通道重复注册：' + channel);
      handlers.set(channel, fn);
    })
  };

  const deleteCalls = [];
  const store = o.store === undefined ? {
    mode: o.mode === undefined ? 'sqlite' : o.mode,
    deleteManualPub: function (pubKey) {
      deleteCalls.push(pubKey);
      if (o.throwOnDelete) throw new Error(o.throwOnDelete);
      if (o.reject) return { deleted: 0, key: pubKey, id: null, rejected: true };
      if (o.notFound) return { deleted: 0, key: pubKey, id: null };
      return { deleted: 1, key: pubKey, id: o.deletedId === undefined ? 42 : o.deletedId };
    }
  } : o.store;

  // 把切出来的 handler 放进一个可执行作用域：ipcMain / store 都是注入的
  const factory = new Function(
    'ipcMain', 'store', 'handlers',
    REVOKE_STMT + '\nreturn handlers;'
  );
  factory(ipcMain, store, handlers);

  return {
    handlers: handlers,
    ipcMain: ipcMain,
    store: store,
    deleteCalls: deleteCalls,
    call: function (pubKey) {
      const fn = handlers.get('pubs:revoke');
      if (!fn) throw new Error('pubs:revoke 未注册');
      return fn({}, pubKey);
    }
  };
}

const VALID_KEY = 'manual|github|w1|mk_11111111-2222-3333-4444-555555555555';

describe('批次二 · 撤销 IPC 接线', () => {
  it('I1 pubs:revoke 已正确注册（且与 pubs:delete 是不同通道）', () => {
    const env = makeRevokeEnv();
    expect(env.handlers.has('pubs:revoke')).toBe(true);
    expect(typeof env.handlers.get('pubs:revoke')).toBe('function');
    // 撤销走的是**独立**通道，不复用 pubs:delete
    expect(env.handlers.has('pubs:delete')).toBe(false);
    expect(MAIN_SRC).toContain("ipcMain.handle('pubs:revoke'");
  });

  it('I2 合法新格式键 → 调用 store.deleteManualPub，且只调用一次', () => {
    const env = makeRevokeEnv();
    const res = env.call(VALID_KEY);
    expect(env.deleteCalls.length).toBe(1);
    expect(env.deleteCalls[0]).toBe(VALID_KEY);
    expect(res.ok).toBe(true);
  });

  it('I3 Store 不存在 → 安全返回失败，不调用 Store', () => {
    const env = makeRevokeEnv({ store: null });
    const res = env.call(VALID_KEY);
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
    // store 为 null → 不可能调用 Store
    expect(env.deleteCalls.length).toBe(0);
  });

  it('I4 store.mode === "error" → 安全返回失败，不调用 Store', () => {
    const env = makeRevokeEnv({ mode: 'error' });
    const res = env.call(VALID_KEY);
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(env.deleteCalls.length).toBe(0);   // ★ 关键：不能落到 Store（否则会抛 TypeError）
  });

  it('I5 自动发布键被拒绝，不调用 Store', () => {
    const env = makeRevokeEnv();
    const res = env.call('youtube|w1|1699999999-auto');
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(env.deleteCalls.length).toBe(0);
  });

  it('I6 首秀计划键被拒绝，不调用 Store', () => {
    const env = makeRevokeEnv();
    const res = env.call('plan|w1|stage1|wechat');
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(env.deleteCalls.length).toBe(0);
  });

  it('I7 旧三段式手动键被拒绝，不调用 Store', () => {
    const env = makeRevokeEnv();
    const res = env.call('manual|github|w1');
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(env.deleteCalls.length).toBe(0);
  });

  it('I8 空字符串 / null / undefined / 非字符串被拒绝，不调用 Store', () => {
    const env = makeRevokeEnv();
    const bad = ['', '   ', null, undefined, 123, {}, [], true];
    bad.forEach(function (v) {
      const res = env.call(v);
      expect(res.ok).toBe(false);
      expect(res.deleted).toBe(0);
      expect(typeof res.error).toBe('string');
    });
    expect(env.deleteCalls.length).toBe(0);
  });

  it('I9 删除成功 → { ok:true, deleted, id, key }', () => {
    const env = makeRevokeEnv({ deletedId: 77 });
    const res = env.call(VALID_KEY);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);
    expect(res.id).toBe(77);
    expect(res.key).toBe(VALID_KEY);
  });

  it('I10 合法键但记录不存在 → 返回失败，不视为成功', () => {
    const env = makeRevokeEnv({ notFound: true });
    const res = env.call(VALID_KEY);
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(res.error).toMatch(/未找到|不存在/);
    // 键合法 → 确实调用过 Store（由 Store 判定"没有这一条"）
    expect(env.deleteCalls.length).toBe(1);
  });

  it('I11 rejected:true → 明确的非法键错误（与"记录不存在"区分开）', () => {
    const env = makeRevokeEnv({ reject: true });
    const res = env.call(VALID_KEY);
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(res.error).not.toMatch(/未找到/);   // 不是"记录不存在"
    expect(res.error).toMatch(/手动标记/);
  });

  it('I12 Store 抛异常 → handler 捕获，不向 Renderer 抛异常', () => {
    const env = makeRevokeEnv({ throwOnDelete: '数据库写入失败' });
    let res = null;
    let threw = false;
    try {
      res = env.call(VALID_KEY);
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(false);                 // ★ 异常不得冒到 Renderer
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(typeof res.error).toBe('string');
    expect(res.error).toContain('数据库写入失败');
  });

  it('I13 preload 暴露 revokePub，且调用 pubs:revoke 通道', () => {
    expect(PRELOAD_SRC).toContain('revokePub');
    expect(PRELOAD_SRC).toMatch(/revokePub:\s*\(pubKey\)\s*=>\s*ipcRenderer\.invoke\('pubs:revoke',\s*pubKey\)/);
    // 只在发布记录区块新增这一个接口，不额外增加别的
    expect(PRELOAD_SRC).not.toMatch(/revokePubs\b/);
    expect(PRELOAD_SRC).not.toMatch(/deleteManualPub/);
  });
});
