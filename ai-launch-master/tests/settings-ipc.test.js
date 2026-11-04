'use strict';

// settings-ipc 行为测试：fake ipcMain + 注入 stub 依赖。
// 不启动 Electron，不访问数据库，不发出网络请求。
// 断言的是「注册后真实调用 handler 的行为」，而非源码字符串。

const { registerSettingsIpc } = require('../electron/settings-ipc');

const CHANNELS = [
  'settings:get',
  'settings:save',
  'llm:generate'
];

function fakeStore(overrides) {
  overrides = overrides || {};
  const s = {
    getSettings: overrides.getSettings || vi.fn(function () { return { base_url: 'https://api.deepseek.com' }; }),
    saveSettings: overrides.saveSettings || vi.fn(function (x) { return { saved: true, echo: x }; })
  };
  return s;
}

function createHarness(overrides) {
  overrides = overrides || {};
  const handlers = new Map();
  const registered = [];
  const ipcMain = {
    handle: vi.fn(function (channel, fn) {
      registered.push(channel);
      handlers.set(channel, fn);
    })
  };

  const store = overrides.store === undefined ? fakeStore() : overrides.store;
  const storeRef = { current: store };
  const getStore = overrides.getStore || vi.fn(function () { return storeRef.current; });
  const chatComplete = overrides.chatComplete || vi.fn(async function (settings, req) {
    return { ok: true, settings: settings, req: req };
  });

  registerSettingsIpc(ipcMain, {
    getStore: getStore,
    chatComplete: chatComplete
  });

  return {
    handlers: handlers,
    registered: registered,
    ipcMain: ipcMain,
    getStore: getStore,
    chatComplete: chatComplete,
    storeRef: storeRef
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

describe('settings-ipc · 注册契约', () => {
  it('只注册 3 个目标频道，顺序为 settings:get → settings:save → llm:generate', () => {
    const { handlers, registered, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    expect(handlers.size).toBe(3);
    expect(registered).toEqual(CHANNELS);
  });

  it('每个频道仅注册一次', () => {
    const { registered } = createHarness();

    CHANNELS.forEach(function (channel) {
      expect(registered.filter(function (c) { return c === channel; })).toHaveLength(1);
    });
  });

  it('不注册其他任何频道', () => {
    const { registered } = createHarness();

    expect(registered).not.toContain('settings:other');
    expect(registered).not.toContain('secrets:status');
    expect(registered).not.toContain('feedback:collect');
    expect(registered).not.toContain('works:list');
    expect(registered).not.toContain('oauth:start');
    expect(registered).not.toContain('wechat:credentials-status');
    expect(registered).not.toContain('channels:health');
    expect(registered).not.toContain('queue:schedule');
  });

  it('不调用 ipcMain.removeHandler / on', () => {
    const { ipcMain } = createHarness();

    expect(ipcMain.removeHandler).toBeUndefined();
    expect(ipcMain.on).toBeUndefined();
  });
});

describe('settings-ipc · settings:get', () => {
  it('原样返回 store.getSettings() 的返回值（保持对象身份）', () => {
    const payload = { base_url: 'https://api.deepseek.com', model: 'deepseek-chat' };
    const store = fakeStore({ getSettings: vi.fn(function () { return payload; }) });
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'settings:get');

    const r = h({});

    expect(store.getSettings).toHaveBeenCalledTimes(1);
    expect(r).toBe(payload);
  });

  it('每次调用都重新执行 getStore()，不缓存 store 实例', () => {
    const storeA = fakeStore({ getSettings: vi.fn(function () { return { tag: 'A' }; }) });
    const storeB = fakeStore({ getSettings: vi.fn(function () { return { tag: 'B' }; }) });
    const { handlers, getStore, storeRef } = createHarness({ store: storeA });
    const h = handlerOf(handlers, 'settings:get');

    const r1 = h({});
    storeRef.current = storeB;
    const r2 = h({});

    expect(getStore).toHaveBeenCalledTimes(2);
    expect(storeA.getSettings).toHaveBeenCalledTimes(1);
    expect(storeB.getSettings).toHaveBeenCalledTimes(1);
    expect(r1).not.toBe(r2);
    expect(r2).toEqual({ tag: 'B' });
  });

  it('注册时不会执行 getStore()', () => {
    const { getStore } = createHarness();

    expect(getStore).not.toHaveBeenCalled();
  });

  it('保持非 async（同步返回，不产生 Promise）', () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'settings:get');

    expect(h.constructor.name).toBe('Function');
    expect(h({})).not.toBeInstanceOf(Promise);
  });

  it('store 为 null 时同步抛出 TypeError（不加兜底）', () => {
    const { handlers } = createHarness({ store: null });
    const h = handlerOf(handlers, 'settings:get');

    expect(function () { h({}); }).toThrow(TypeError);
  });

  it('store.getSettings() 抛错时异常原样向上传播', () => {
    const store = fakeStore({
      getSettings: vi.fn(function () { throw new Error('settings-down'); })
    });
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'settings:get');

    expect(function () { h({}); }).toThrow('settings-down');
  });
});

describe('settings-ipc · settings:save', () => {
  it('参数原样透传给 store.saveSettings(s)', () => {
    const payload = { base_url: 'https://x', api_key: 'sk-1' };
    const store = fakeStore({
      saveSettings: vi.fn(function (_s) { return { ok: true }; })
    });
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'settings:save');

    h({}, payload);

    expect(store.saveSettings).toHaveBeenCalledTimes(1);
    expect(store.saveSettings.mock.calls[0][0]).toBe(payload);
  });

  it('原样返回 saveSettings 的返回值', () => {
    const result = { ok: true, updated: 1 };
    const store = fakeStore({
      saveSettings: vi.fn(function () { return result; })
    });
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'settings:save');

    expect(h({}, { a: 1 })).toBe(result);
  });

  it('不校验也不转换参数（null / undefined 原样传入）', () => {
    const store = fakeStore({
      saveSettings: vi.fn(function () { return { ok: true }; })
    });
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'settings:save');

    h({}, null);
    h({}, undefined);

    expect(store.saveSettings.mock.calls[0][0]).toBeNull();
    expect(store.saveSettings.mock.calls[1][0]).toBeUndefined();
  });

  it('每次调用都重新执行 getStore()', () => {
    const { handlers, getStore } = createHarness();
    const h = handlerOf(handlers, 'settings:save');

    h({}, { a: 1 });
    h({}, { b: 2 });

    expect(getStore).toHaveBeenCalledTimes(2);
  });

  it('保持非 async（同步返回，不产生 Promise）', () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'settings:save');

    expect(h.constructor.name).toBe('Function');
    expect(h({}, { a: 1 })).not.toBeInstanceOf(Promise);
  });

  it('store 为 null 时同步抛出 TypeError（不加兜底）', () => {
    const { handlers } = createHarness({ store: null });
    const h = handlerOf(handlers, 'settings:save');

    expect(function () { h({}, {}); }).toThrow(TypeError);
  });
});

describe('settings-ipc · llm:generate', () => {
  it('把当前 store 的 settings 与 req 原样传给 chatComplete', async () => {
    const settings = { base_url: 'https://api.deepseek.com', model: 'deepseek-chat' };
    const req = { messages: [{ role: 'user', content: 'hi' }] };
    const store = fakeStore({ getSettings: vi.fn(function () { return settings; }) });
    const { handlers, chatComplete } = createHarness({ store: store });
    const h = handlerOf(handlers, 'llm:generate');

    await h({}, req);

    expect(chatComplete).toHaveBeenCalledTimes(1);
    expect(chatComplete.mock.calls[0][0]).toBe(settings);
    expect(chatComplete.mock.calls[0][1]).toBe(req);
  });

  it('先读取 store.getSettings() 再调用 chatComplete（顺序固定）', async () => {
    const order = [];
    const store = fakeStore({
      getSettings: vi.fn(function () { order.push('getSettings'); return { m: 1 }; })
    });
    const chatComplete = vi.fn(async function () { order.push('chatComplete'); return { ok: true }; });
    const { handlers } = createHarness({ store: store, chatComplete: chatComplete });
    const h = handlerOf(handlers, 'llm:generate');

    await h({}, { q: 1 });

    expect(order).toEqual(['getSettings', 'chatComplete']);
  });

  it('返回 Promise（保持 async 语义）', () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'llm:generate');

    expect(h.constructor.name).toBe('AsyncFunction');
    const r = h({}, {});
    expect(r).toBeInstanceOf(Promise);
    return r.catch(function () {});
  });

  it('每次调用都重新执行 getStore()，不缓存 store 实例', async () => {
    const storeA = fakeStore({ getSettings: vi.fn(function () { return { tag: 'A' }; }) });
    const storeB = fakeStore({ getSettings: vi.fn(function () { return { tag: 'B' }; }) });
    const { handlers, getStore, storeRef, chatComplete } = createHarness({ store: storeA });
    const h = handlerOf(handlers, 'llm:generate');

    await h({}, { n: 1 });
    storeRef.current = storeB;
    await h({}, { n: 2 });

    expect(getStore).toHaveBeenCalledTimes(2);
    expect(storeA.getSettings).toHaveBeenCalledTimes(1);
    expect(storeB.getSettings).toHaveBeenCalledTimes(1);
    expect(chatComplete.mock.calls[0][0]).toEqual({ tag: 'A' });
    expect(chatComplete.mock.calls[1][0]).toEqual({ tag: 'B' });
  });

  it('chatComplete 抛错时 handler 返回 rejected Promise（异常不被吞掉）', async () => {
    const chatComplete = vi.fn(async function () { throw new Error('llm-down'); });
    const { handlers } = createHarness({ chatComplete: chatComplete });
    const h = handlerOf(handlers, 'llm:generate');

    await expect(h({}, {})).rejects.toThrow('llm-down');
  });

  it('store.getSettings() 抛错时 handler 返回 rejected Promise', async () => {
    const store = fakeStore({
      getSettings: vi.fn(function () { throw new Error('settings-down'); })
    });
    const { handlers, chatComplete } = createHarness({ store: store });
    const h = handlerOf(handlers, 'llm:generate');

    await expect(h({}, {})).rejects.toThrow('settings-down');
    expect(chatComplete).not.toHaveBeenCalled();
  });

  it('store 为 null 时返回 rejected Promise（TypeError，不加兜底）', async () => {
    const { handlers } = createHarness({ store: null });
    const h = handlerOf(handlers, 'llm:generate');

    await expect(h({}, {})).rejects.toThrow(TypeError);
  });
});
