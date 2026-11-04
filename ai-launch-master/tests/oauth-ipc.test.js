'use strict';

// oauth-ipc 行为测试：fake ipcMain + mock oauth / oauthNet / logger。
// 不启动 Electron，不访问 keytar，不发网络请求。
// 断言的是「注册后真实调用 handler 的行为」，而非源码字符串。

const { registerOauthIpc } = require('../electron/oauth-ipc');

const CHANNELS = [
  'oauth:start',
  'oauth:status',
  'oauth:net-diag',
  'oauth:disconnect',
  'oauth:list',
  'oauth:save-credential',
  'oauth:refresh',
  'oauth:get-valid-token'
];

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

  const oauth = overrides.oauth || fakeOauth();
  const oauthNet = overrides.oauthNet || fakeOauthNet();
  const logger = overrides.logger || fakeLogger();

  registerOauthIpc(ipcMain, {
    oauth: oauth,
    oauthNet: oauthNet,
    logger: logger
  });

  return {
    handlers: handlers,
    registered: registered,
    ipcMain: ipcMain,
    oauth: oauth,
    oauthNet: oauthNet,
    logger: logger
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

function fakeOauth(overrides) {
  overrides = overrides || {};
  return {
    start: overrides.start || vi.fn(async function () { return { ok: true }; }),
    status: overrides.status || vi.fn(async function () { return { connected: true }; }),
    disconnect: overrides.disconnect || vi.fn(async function () { return { ok: true }; }),
    list: overrides.list || vi.fn(async function () { return [{ providerId: 'github' }]; }),
    saveCredential: overrides.saveCredential || vi.fn(async function () { return { ok: true }; }),
    refresh: overrides.refresh || vi.fn(async function () { return { ok: true }; }),
    getValidAccessToken: overrides.getValidAccessToken || vi.fn(async function () { return 'tok-123'; })
  };
}

function fakeOauthNet(overrides) {
  overrides = overrides || {};
  return {
    testGoogleOAuthNetwork: overrides.testGoogleOAuthNetwork
      || vi.fn(async function () { return { ok: true, reachable: true }; })
  };
}

function fakeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  };
}

function boom(message) {
  const err = new Error(message);
  return err;
}

describe('oauth-ipc · 注册契约', () => {
  it('只注册 8 个 oauth 通道，名称与顺序准确，每个只注册一次', () => {
    const { handlers, registered, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(8);
    expect(handlers.size).toBe(8);
    expect(registered).toEqual(CHANNELS);

    CHANNELS.forEach(function (channel) {
      expect(registered.filter(function (c) { return c === channel; })).toHaveLength(1);
    });
  });

  it('不额外注册 settings / feedback / works / channels 等其它频道', () => {
    const { registered } = createHarness();

    registered.forEach(function (channel) {
      expect(channel.startsWith('oauth:')).toBe(true);
    });
    expect(registered).not.toContain('settings:get');
    expect(registered).not.toContain('settings:save');
    expect(registered).not.toContain('feedback:list');
    expect(registered).not.toContain('works:list');
    expect(registered).not.toContain('works:save');
    expect(registered).not.toContain('works:delete');
    expect(registered).not.toContain('channels:list');
    expect(registered).not.toContain('llm:generate');
  });

  it('不调用 removeHandler / 其它 ipcMain 方法', () => {
    const { ipcMain } = createHarness();

    expect(ipcMain.removeHandler).toBeUndefined();
    expect(ipcMain.on).toBeUndefined();
  });
});

describe('oauth-ipc · oauth:start', () => {
  it('把 providerId 归一化为字符串后传给 oauth.start', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:start');

    const r = await h({}, 'github');

    expect(oauth.start).toHaveBeenCalledTimes(1);
    expect(oauth.start).toHaveBeenCalledWith('github');
    expect(r).toEqual({ ok: true });
  });

  it('providerId 为 undefined 时归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:start');

    await h({}, undefined);

    expect(oauth.start).toHaveBeenCalledWith('');
  });

  it('providerId 为 null 时同样归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:start');

    await h({}, null);

    expect(oauth.start).toHaveBeenCalledWith('');
  });

  it('异常时记录 logger.warn 并返回 { ok:false, reason, detail }', async () => {
    const oauth = fakeOauth({ start: vi.fn(async function () { throw boom('start-fail'); }) });
    const logger = fakeLogger();
    const { handlers } = createHarness({ oauth: oauth, logger: logger });
    const h = handlerOf(handlers, 'oauth:start');

    const r = await h({}, 'github');

    expect(r).toEqual({ ok: false, reason: 'exception', detail: 'start-fail' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[oauth] start 抛出', {
      providerId: 'github',
      error: 'start-fail'
    });
  });

  it('成功路径不写 logger.warn', async () => {
    const logger = fakeLogger();
    const { handlers } = createHarness({ logger: logger });
    const h = handlerOf(handlers, 'oauth:start');

    await h({}, 'github');

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('oauth-ipc · oauth:status', () => {
  it('把 providerId 传给 oauth.status 并原样返回结果', async () => {
    const oauth = fakeOauth({ status: vi.fn(async function () { return { connected: true, user: 'u1' }; }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:status');

    const r = await h({}, 'github');

    expect(oauth.status).toHaveBeenCalledTimes(1);
    expect(oauth.status).toHaveBeenCalledWith('github');
    expect(r).toEqual({ connected: true, user: 'u1' });
  });

  it('providerId 为 undefined 时归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:status');

    await h({}, undefined);

    expect(oauth.status).toHaveBeenCalledWith('');
  });

  it('异常时返回 { connected:false, error }', async () => {
    const oauth = fakeOauth({ status: vi.fn(async function () { throw boom('status-fail'); }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:status');

    const r = await h({}, 'github');

    expect(r).toEqual({ connected: false, error: 'status-fail' });
  });
});

describe('oauth-ipc · oauth:net-diag', () => {
  it('调用 oauthNet.testGoogleOAuthNetwork 并原样返回结果', async () => {
    const oauthNet = fakeOauthNet({
      testGoogleOAuthNetwork: vi.fn(async function () { return { ok: true, reachable: true }; })
    });
    const { handlers } = createHarness({ oauthNet: oauthNet });
    const h = handlerOf(handlers, 'oauth:net-diag');

    const r = await h({});

    expect(oauthNet.testGoogleOAuthNetwork).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, reachable: true });
  });

  it('异常时返回 { ok:false, error }', async () => {
    const oauthNet = fakeOauthNet({
      testGoogleOAuthNetwork: vi.fn(async function () { throw boom('net-fail'); })
    });
    const { handlers } = createHarness({ oauthNet: oauthNet });
    const h = handlerOf(handlers, 'oauth:net-diag');

    const r = await h({});

    expect(r).toEqual({ ok: false, error: 'net-fail' });
  });

  it('不触碰 oauth 模块的任何方法', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:net-diag');

    await h({});

    expect(oauth.start).not.toHaveBeenCalled();
    expect(oauth.status).not.toHaveBeenCalled();
    expect(oauth.list).not.toHaveBeenCalled();
  });
});

describe('oauth-ipc · oauth:disconnect', () => {
  it('把 providerId 传给 oauth.disconnect 并原样返回结果', async () => {
    const oauth = fakeOauth({ disconnect: vi.fn(async function () { return { ok: true, disconnected: true }; }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:disconnect');

    const r = await h({}, 'github');

    expect(oauth.disconnect).toHaveBeenCalledTimes(1);
    expect(oauth.disconnect).toHaveBeenCalledWith('github');
    expect(r).toEqual({ ok: true, disconnected: true });
  });

  it('providerId 为 undefined 时归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:disconnect');

    await h({}, undefined);

    expect(oauth.disconnect).toHaveBeenCalledWith('');
  });

  it('异常时返回 { ok:false, error }', async () => {
    const oauth = fakeOauth({ disconnect: vi.fn(async function () { throw boom('disconnect-fail'); }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:disconnect');

    const r = await h({}, 'github');

    expect(r).toEqual({ ok: false, error: 'disconnect-fail' });
  });
});

describe('oauth-ipc · oauth:list', () => {
  it('原样返回 oauth.list 的结果', async () => {
    const list = [{ providerId: 'github', connected: true }];
    const oauth = fakeOauth({ list: vi.fn(async function () { return list; }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:list');

    const r = await h({});

    expect(oauth.list).toHaveBeenCalledTimes(1);
    expect(r).toBe(list);
  });

  it('异常时返回空对象（无参 catch 语义）', async () => {
    const oauth = fakeOauth({ list: vi.fn(async function () { throw boom('list-fail'); }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:list');

    const r = await h({});

    expect(r).toEqual({});
    expect(Object.keys(r)).toHaveLength(0);
  });
});

describe('oauth-ipc · oauth:save-credential', () => {
  it('把 providerId 与 payload 原样传给 oauth.saveCredential', async () => {
    const payload = { access_token: 'tok-abc' };
    const oauth = fakeOauth({ saveCredential: vi.fn(async function () { return { ok: true, saved: true }; }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:save-credential');

    const r = await h({}, 'github', payload);

    expect(oauth.saveCredential).toHaveBeenCalledTimes(1);
    expect(oauth.saveCredential).toHaveBeenCalledWith('github', payload);
    expect(oauth.saveCredential.mock.calls[0][1]).toBe(payload);
    expect(r).toEqual({ ok: true, saved: true });
  });

  it('payload 为 undefined 时退化为空对象', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:save-credential');

    await h({}, 'github', undefined);

    expect(oauth.saveCredential).toHaveBeenCalledWith('github', {});
  });

  it('payload 为 null 时同样退化为空对象', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:save-credential');

    await h({}, 'github', null);

    expect(oauth.saveCredential).toHaveBeenCalledWith('github', {});
  });

  it('异常时记录 logger.warn 并返回 { ok:false, reason, detail }', async () => {
    const oauth = fakeOauth({ saveCredential: vi.fn(async function () { throw boom('save-fail'); }) });
    const logger = fakeLogger();
    const { handlers } = createHarness({ oauth: oauth, logger: logger });
    const h = handlerOf(handlers, 'oauth:save-credential');

    const r = await h({}, 'github', { access_token: 'x' });

    expect(r).toEqual({ ok: false, reason: 'exception', detail: 'save-fail' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[oauth] saveCredential 抛出', {
      providerId: 'github',
      error: 'save-fail'
    });
  });
});

describe('oauth-ipc · oauth:refresh', () => {
  it('把 providerId 传给 oauth.refresh 并原样返回结果', async () => {
    const oauth = fakeOauth({ refresh: vi.fn(async function () { return { ok: true, refreshed: true }; }) });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:refresh');

    const r = await h({}, 'github');

    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(oauth.refresh).toHaveBeenCalledWith('github');
    expect(r).toEqual({ ok: true, refreshed: true });
  });

  it('providerId 为 undefined 时归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:refresh');

    await h({}, undefined);

    expect(oauth.refresh).toHaveBeenCalledWith('');
  });

  it('异常时记录 logger.warn 并返回 { ok:false, reason, detail }', async () => {
    const oauth = fakeOauth({ refresh: vi.fn(async function () { throw boom('refresh-fail'); }) });
    const logger = fakeLogger();
    const { handlers } = createHarness({ oauth: oauth, logger: logger });
    const h = handlerOf(handlers, 'oauth:refresh');

    const r = await h({}, 'github');

    expect(r).toEqual({ ok: false, reason: 'exception', detail: 'refresh-fail' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[oauth] refresh 抛出', {
      providerId: 'github',
      error: 'refresh-fail'
    });
  });
});

describe('oauth-ipc · oauth:get-valid-token', () => {
  it('只返回 { ok, hasToken }，不泄露 token 值', async () => {
    const oauth = fakeOauth({
      getValidAccessToken: vi.fn(async function () { return 'super-secret-token'; })
    });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:get-valid-token');

    const r = await h({}, 'github');

    expect(oauth.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(oauth.getValidAccessToken).toHaveBeenCalledWith('github');
    expect(r).toEqual({ ok: true, hasToken: true });
    expect(Object.keys(r).sort()).toEqual(['hasToken', 'ok']);
    expect(JSON.stringify(r)).not.toContain('super-secret-token');
  });

  it('token 为空时返回 { ok:false, hasToken:false }', async () => {
    const oauth = fakeOauth({
      getValidAccessToken: vi.fn(async function () { return null; })
    });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:get-valid-token');

    const r = await h({}, 'github');

    expect(r).toEqual({ ok: false, hasToken: false });
  });

  it('异常时返回 { ok:false, hasToken:false }（无参 catch 语义）', async () => {
    const oauth = fakeOauth({
      getValidAccessToken: vi.fn(async function () { throw boom('token-fail'); })
    });
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:get-valid-token');

    const r = await h({}, 'github');

    expect(r).toEqual({ ok: false, hasToken: false });
    expect(Object.keys(r).sort()).toEqual(['hasToken', 'ok']);
  });

  it('providerId 为 undefined 时归一为空字符串', async () => {
    const oauth = fakeOauth();
    const { handlers } = createHarness({ oauth: oauth });
    const h = handlerOf(handlers, 'oauth:get-valid-token');

    await h({}, undefined);

    expect(oauth.getValidAccessToken).toHaveBeenCalledWith('');
  });
});

describe('oauth-ipc · 异步语义', () => {
  it('8 个 handler 全部返回 Promise', () => {
    const { handlers } = createHarness();

    handlers.forEach(function (fn) {
      const r = fn({}, 'github');
      expect(r).toBeInstanceOf(Promise);
      expect(typeof r.then).toBe('function');
      return r.catch(function () {});
    });
  });

  it('handler 声明为 async（构造函数名为 AsyncFunction）', () => {
    const { handlers } = createHarness();

    handlers.forEach(function (fn) {
      expect(fn.constructor.name).toBe('AsyncFunction');
    });
  });

  it('异常不会逃逸出 handler（全部被转换为返回对象）', async () => {
    const oauth = fakeOauth({
      start: vi.fn(async function () { throw boom('x'); }),
      status: vi.fn(async function () { throw boom('x'); }),
      disconnect: vi.fn(async function () { throw boom('x'); }),
      list: vi.fn(async function () { throw boom('x'); }),
      saveCredential: vi.fn(async function () { throw boom('x'); }),
      refresh: vi.fn(async function () { throw boom('x'); }),
      getValidAccessToken: vi.fn(async function () { throw boom('x'); })
    });
    const oauthNet = fakeOauthNet({
      testGoogleOAuthNetwork: vi.fn(async function () { throw boom('x'); })
    });
    const { handlers } = createHarness({ oauth: oauth, oauthNet: oauthNet });

    await expect(handlerOf(handlers, 'oauth:start')({}, 'github')).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:status')({}, 'github')).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:net-diag')({})).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:disconnect')({}, 'github')).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:list')({})).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:save-credential')({}, 'github', {})).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:refresh')({}, 'github')).resolves.toBeTruthy();
    await expect(handlerOf(handlers, 'oauth:get-valid-token')({}, 'github')).resolves.toBeTruthy();
  });
});
