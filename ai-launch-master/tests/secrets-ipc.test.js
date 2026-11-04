'use strict';

// secrets-ipc 行为测试：fake ipcMain + 注入 stub 依赖。
// 不启动 Electron，不访问 keytar，不写数据库。
// 断言的是「注册后真实调用 handler 的行为」，而非源码字符串。

const { registerSecretsIpc } = require('../electron/secrets-ipc');

const CHANNELS = [
  'secrets:set-api-key',
  'secrets:clear-api-key',
  'secrets:status'
];

function fakeSecrets(overrides) {
  overrides = overrides || {};
  const s = {
    setApiKey: overrides.setApiKey || vi.fn(async function () { return true; }),
    clearApiKey: overrides.clearApiKey || vi.fn(async function () { return true; }),
    getApiKey: overrides.getApiKey || vi.fn(async function () { return ''; }),
    hasNative: overrides.hasNative || vi.fn(function () { return true; })
  };
  if (overrides.keytarError === undefined) {
    s._keytarError = vi.fn(function () { return null; });
  } else if (overrides.keytarError !== 'omit') {
    s._keytarError = overrides.keytarError;
  }
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

  const secrets = overrides.secrets || fakeSecrets();
  const storeRef = { current: overrides.store === undefined ? null : overrides.store };
  const getStore = overrides.getStore || vi.fn(function () { return storeRef.current; });

  registerSecretsIpc(ipcMain, {
    secrets: secrets,
    getStore: getStore
  });

  return {
    handlers: handlers,
    registered: registered,
    ipcMain: ipcMain,
    secrets: secrets,
    getStore: getStore,
    storeRef: storeRef
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

describe('secrets-ipc · 注册契约', () => {
  it('只注册 3 个目标频道，顺序为 set → clear → status，各只注册一次', () => {
    const { handlers, registered, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    expect(handlers.size).toBe(3);
    expect(registered).toEqual(CHANNELS);

    CHANNELS.forEach(function (channel) {
      expect(registered.filter(function (c) { return c === channel; })).toHaveLength(1);
    });
  });

  it('不额外注册其它 secrets / settings / oauth / works / wechat 频道', () => {
    const { registered } = createHarness();

    expect(registered).not.toContain('secrets:online-tts-key');
    expect(registered).not.toContain('secrets:set-online-tts-key');
    expect(registered).not.toContain('secrets:clear-online-tts-key');
    expect(registered).not.toContain('settings:get');
    expect(registered).not.toContain('settings:save');
    expect(registered).not.toContain('oauth:start');
    expect(registered).not.toContain('works:list');
    expect(registered).not.toContain('wechat:credentials-status');
  });

  it('不使用 ipcMain 的其它方法（无 removeHandler / on）', () => {
    const { ipcMain } = createHarness();

    expect(ipcMain.removeHandler).toBeUndefined();
    expect(ipcMain.on).toBeUndefined();
  });
});

describe('secrets-ipc · secrets:set-api-key', () => {
  it('空值短路返回 { ok:false, error:\'empty-key\' } 且不调用 setApiKey', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, '');

    expect(r).toEqual({ ok: false, error: 'empty-key' });
    expect(secrets.setApiKey).not.toHaveBeenCalled();
  });

  it('undefined / null / 0 也走空值短路（不调用 setApiKey）', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'secrets:set-api-key');

    expect(await h({}, undefined)).toEqual({ ok: false, error: 'empty-key' });
    expect(await h({}, null)).toEqual({ ok: false, error: 'empty-key' });
    expect(await h({}, 0)).toEqual({ ok: false, error: 'empty-key' });
    expect(secrets.setApiKey).not.toHaveBeenCalled();
  });

  it('非字符串输入经 String() 归一化后写入', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await h({}, 12345);

    expect(secrets.setApiKey).toHaveBeenCalledTimes(1);
    expect(secrets.setApiKey).toHaveBeenCalledWith('12345');
  });

  it('setApiKey 返回 true 时 persisted 为 true', async () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, 'sk-test');

    expect(r).toEqual({ ok: true, persisted: true });
  });

  it('setApiKey 返回 false 时 persisted 为 false', async () => {
    const secrets = fakeSecrets({ setApiKey: vi.fn(async function () { return false; }) });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, 'sk-test');

    expect(r).toEqual({ ok: true, persisted: false });
  });

  it('store 为 null 时不报错、不调用 clearPlaintextApiKey', async () => {
    const { handlers, secrets } = createHarness({ store: null });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, 'sk-test');

    expect(r).toEqual({ ok: true, persisted: true });
    expect(secrets.setApiKey).toHaveBeenCalledTimes(1);
  });

  it('store 没有 clearPlaintextApiKey 方法时不报错', async () => {
    const { handlers } = createHarness({ store: { getSettings: function () { return {}; } } });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, 'sk-test');

    expect(r).toEqual({ ok: true, persisted: true });
  });

  it('store 有效时调用 clearPlaintextApiKey 清库', async () => {
    const store = { clearPlaintextApiKey: vi.fn(function () { return 1; }) };
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await h({}, 'sk-test');

    expect(store.clearPlaintextApiKey).toHaveBeenCalledTimes(1);
  });

  it('clearPlaintextApiKey 抛错被局部捕获吞掉，handler 仍正常返回', async () => {
    const store = {
      clearPlaintextApiKey: vi.fn(function () { throw new Error('db-locked'); })
    };
    const { handlers } = createHarness({ store: store });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    const r = await h({}, 'sk-test');

    expect(r).toEqual({ ok: true, persisted: true });
    expect(store.clearPlaintextApiKey).toHaveBeenCalledTimes(1);
  });

  it('setApiKey 在 clearPlaintextApiKey 之前被调用（保持原调用顺序）', async () => {
    const order = [];
    const secrets = fakeSecrets({
      setApiKey: vi.fn(async function () { order.push('setApiKey'); return true; })
    });
    const store = {
      clearPlaintextApiKey: vi.fn(function () { order.push('clearPlaintextApiKey'); return 1; })
    };
    const { handlers } = createHarness({ secrets: secrets, store: store });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await h({}, 'sk-test');

    expect(order).toEqual(['setApiKey', 'clearPlaintextApiKey']);
  });

  it('getStore 在 handler 调用时才读取，不在注册时缓存 store', async () => {
    const { handlers, getStore, storeRef } = createHarness({ store: null });

    expect(getStore).not.toHaveBeenCalled();

    const store = { clearPlaintextApiKey: vi.fn(function () { return 1; }) };
    storeRef.current = store;

    const h = handlerOf(handlers, 'secrets:set-api-key');
    await h({}, 'sk-test');

    expect(getStore).toHaveBeenCalledTimes(1);
    expect(store.clearPlaintextApiKey).toHaveBeenCalledTimes(1);
  });

  it('每次调用都重新读取 store（不缓存首次结果）', async () => {
    const storeA = { clearPlaintextApiKey: vi.fn(function () { return 1; }) };
    const storeB = { clearPlaintextApiKey: vi.fn(function () { return 1; }) };
    const { handlers, getStore, storeRef } = createHarness({ store: storeA });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await h({}, 'sk-1');
    storeRef.current = storeB;
    await h({}, 'sk-2');

    expect(getStore).toHaveBeenCalledTimes(2);
    expect(storeA.clearPlaintextApiKey).toHaveBeenCalledTimes(1);
    expect(storeB.clearPlaintextApiKey).toHaveBeenCalledTimes(1);
  });
});

describe('secrets-ipc · secrets:clear-api-key', () => {
  it('调用 clearApiKey 并返回 { ok:true }', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'secrets:clear-api-key');

    const r = await h({});

    expect(secrets.clearApiKey).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true });
  });

  it('不触碰 setApiKey / getApiKey / getStore', async () => {
    const { handlers, secrets, getStore } = createHarness();
    const h = handlerOf(handlers, 'secrets:clear-api-key');

    await h({});

    expect(secrets.setApiKey).not.toHaveBeenCalled();
    expect(secrets.getApiKey).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });
});

describe('secrets-ipc · secrets:status', () => {
  it('返回完整结构 { hasNative, hasApiKey, keytarError }', async () => {
    const secrets = fakeSecrets({
      hasNative: vi.fn(function () { return true; }),
      getApiKey: vi.fn(async function () { return 'sk-live'; })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(r).toEqual({ hasNative: true, hasApiKey: true, keytarError: '' });
    expect(Object.keys(r).sort()).toEqual(['hasApiKey', 'hasNative', 'keytarError']);
  });

  it('hasNative 直接调用 secrets.hasNative() 并原样透出', async () => {
    const secrets = fakeSecrets({ hasNative: vi.fn(function () { return false; }) });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(secrets.hasNative).toHaveBeenCalledTimes(1);
    expect(r.hasNative).toBe(false);
  });

  it('apiKey 为空时 hasApiKey 为 false', async () => {
    const secrets = fakeSecrets({ getApiKey: vi.fn(async function () { return ''; }) });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(r.hasApiKey).toBe(false);
  });

  it('_keytarError 返回 null 时 keytarError 为空字符串（不抛 TypeError）', async () => {
    const secrets = fakeSecrets({ keytarError: vi.fn(function () { return null; }) });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(secrets._keytarError).toHaveBeenCalledTimes(1);
    expect(r.keytarError).toBe('');
  });

  it('_keytarError 返回 Error 时 keytarError 为其 message', async () => {
    const secrets = fakeSecrets({
      keytarError: vi.fn(function () { return new Error('keytar missing'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(r.keytarError).toBe('keytar missing');
  });

  it('_keytarError 返回非 Error 对象时回退为 String(err)', async () => {
    const secrets = fakeSecrets({
      keytarError: vi.fn(function () { return { code: 42 }; })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(r.keytarError).toBe('[object Object]');
  });

  it('secrets 缺少 _keytarError 方法时 keytarError 为空字符串', async () => {
    const secrets = fakeSecrets({ keytarError: 'omit' });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(secrets._keytarError).toBeUndefined();
    expect(r.keytarError).toBe('');
  });

  it('_keytarError 自身抛错时 keytarError 为空字符串（异常被兜底）', async () => {
    const secrets = fakeSecrets({
      keytarError: vi.fn(function () { throw new Error('boom'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    const r = await h({});

    expect(r.keytarError).toBe('');
    expect(r.hasNative).toBe(true);
  });

  it('不触碰 setApiKey / clearApiKey / getStore', async () => {
    const { handlers, secrets, getStore } = createHarness();
    const h = handlerOf(handlers, 'secrets:status');

    await h({});

    expect(secrets.setApiKey).not.toHaveBeenCalled();
    expect(secrets.clearApiKey).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });
});

describe('secrets-ipc · 异步语义与异常传播', () => {
  it('3 个 handler 全部返回 Promise 且声明为 async', () => {
    const { handlers } = createHarness();

    handlers.forEach(function (fn) {
      expect(fn.constructor.name).toBe('AsyncFunction');
      const r = fn({}, {});
      expect(r).toBeInstanceOf(Promise);
      return r.catch(function () {});
    });
  });

  it('setApiKey 抛错时 handler 返回 rejected Promise（异常不被吞掉）', async () => {
    const secrets = fakeSecrets({
      setApiKey: vi.fn(async function () { throw new Error('set-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await expect(h({}, 'sk-test')).rejects.toThrow('set-fail');
  });

  it('clearApiKey 抛错时 handler 返回 rejected Promise', async () => {
    const secrets = fakeSecrets({
      clearApiKey: vi.fn(async function () { throw new Error('clear-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:clear-api-key');

    await expect(h({})).rejects.toThrow('clear-fail');
  });

  it('hasNative 抛错时 status 返回 rejected Promise', async () => {
    const secrets = fakeSecrets({
      hasNative: vi.fn(function () { throw new Error('native-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    await expect(h({})).rejects.toThrow('native-fail');
  });

  it('getApiKey 抛错时 status 返回 rejected Promise', async () => {
    const secrets = fakeSecrets({
      getApiKey: vi.fn(async function () { throw new Error('get-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'secrets:status');

    await expect(h({})).rejects.toThrow('get-fail');
  });

  it('getStore 抛错时 set-api-key 返回 rejected Promise', async () => {
    const getStore = vi.fn(function () { throw new Error('store-fail'); });
    const { handlers } = createHarness({ getStore: getStore });
    const h = handlerOf(handlers, 'secrets:set-api-key');

    await expect(h({}, 'sk-test')).rejects.toThrow('store-fail');
  });
});
