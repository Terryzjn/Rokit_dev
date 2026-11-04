'use strict';

// wechat-credentials-ipc 行为测试：fake ipcMain + 注入 stub 依赖。
// 不启动 Electron，不访问 keytar，不写凭据。
// 断言的是「注册后真实调用 handler 的行为」，而非源码字符串。

const { registerWechatCredentialsIpc } = require('../electron/wechat-credentials-ipc');

const CHANNELS = [
  'wechat:credentials-status',
  'wechat:credentials-load',
  'wechat:credentials-save',
  'wechat:credentials-clear'
];

const SECRET_KEYS = {
  appId: 'wechat-app-id',
  appSecret: 'wechat-app-secret',
  thumbMediaId: 'wechat-thumb-media-id'
};

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
  const directWechatRead = overrides.directWechatRead || vi.fn(async function () {
    return { appId: '', appSecret: '', thumbMediaId: '' };
  });
  const secretKeys = overrides.secretKeys || SECRET_KEYS;

  registerWechatCredentialsIpc(ipcMain, {
    secrets: secrets,
    directWechatRead: directWechatRead,
    secretKeys: secretKeys
  });

  return {
    handlers: handlers,
    registered: registered,
    ipcMain: ipcMain,
    secrets: secrets,
    directWechatRead: directWechatRead,
    secretKeys: secretKeys
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

function fakeSecrets(overrides) {
  overrides = overrides || {};
  const s = {
    hasNative: overrides.hasNative !== undefined
      ? overrides.hasNative
      : vi.fn(function () { return true; }),
    setSecret: overrides.setSecret || vi.fn(async function () { return true; }),
    deleteSecret: overrides.deleteSecret || vi.fn(async function () { return true; }),
    getSecret: overrides.getSecret || vi.fn(async function () { return ''; })
  };
  if (overrides.omitHasNative) delete s.hasNative;
  return s;
}

function fullCreds() {
  return { appId: 'wx1', appSecret: 'sec1', thumbMediaId: 'tm1' };
}

describe('wechat-credentials-ipc · 注册契约', () => {
  it('只注册 4 个目标频道，名称与顺序准确，每个只注册一次', () => {
    const { handlers, registered, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(4);
    expect(handlers.size).toBe(4);
    expect(registered).toEqual(CHANNELS);

    CHANNELS.forEach(function (channel) {
      expect(registered.filter(function (c) { return c === channel; })).toHaveLength(1);
    });
  });

  it('不注册其它 wechat / secrets / settings / oauth / works 频道', () => {
    const { registered } = createHarness();

    registered.forEach(function (channel) {
      expect(channel.startsWith('wechat:credentials-')).toBe(true);
    });
    expect(registered).not.toContain('wechat:draft-create');
    expect(registered).not.toContain('wechat:publish');
    expect(registered).not.toContain('wechat:upload-image');
    expect(registered).not.toContain('secrets:status');
    expect(registered).not.toContain('secrets:set-api-key');
    expect(registered).not.toContain('settings:get');
    expect(registered).not.toContain('oauth:start');
    expect(registered).not.toContain('works:list');
  });

  it('不使用 ipcMain 的其它方法（无 removeHandler / on）', () => {
    const { ipcMain } = createHarness();

    expect(ipcMain.removeHandler).toBeUndefined();
    expect(ipcMain.on).toBeUndefined();
  });
});

describe('wechat-credentials-ipc · wechat:credentials-status', () => {
  it('三项凭据齐全时返回 configured:true 且 missing 为空', async () => {
    const { handlers, directWechatRead } = createHarness({
      directWechatRead: vi.fn(async function () { return fullCreds(); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(directWechatRead).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      hasAppId: true,
      hasAppSecret: true,
      hasThumbMediaId: true,
      missing: [],
      configured: true,
      persisted: true
    });
  });

  it('缺失字段进入 missing，且顺序为 appId → appSecret → thumbMediaId', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () {
        return { appId: '', appSecret: '', thumbMediaId: '' };
      })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(r.missing).toEqual(['appId', 'appSecret', 'thumbMediaId']);
    expect(r.hasAppId).toBe(false);
    expect(r.hasAppSecret).toBe(false);
    expect(r.hasThumbMediaId).toBe(false);
    expect(r.configured).toBe(false);
  });

  it('部分缺失时 missing 只含缺失项且保持既定顺序', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () {
        return { appId: 'wx1', appSecret: '', thumbMediaId: '' };
      })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(r.missing).toEqual(['appSecret', 'thumbMediaId']);
    expect(r.hasAppId).toBe(true);
    expect(r.configured).toBe(false);
  });

  it('configured 等价于 missing.length === 0', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () {
        return { appId: 'wx1', appSecret: 'sec1', thumbMediaId: '' };
      })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(r.configured).toBe(r.missing.length === 0);
    expect(r.configured).toBe(false);
  });

  it('persisted 忠实反映 secrets.hasNative() 的返回值', async () => {
    const { handlers } = createHarness({
      secrets: fakeSecrets({ hasNative: vi.fn(function () { return false; }) }),
      directWechatRead: vi.fn(async function () { return fullCreds(); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(r.persisted).toBe(false);
  });

  it('secrets.hasNative 不存在时走防御分支返回 persisted:false', async () => {
    const secrets = fakeSecrets({ omitHasNative: true });
    const { handlers } = createHarness({
      secrets: secrets,
      directWechatRead: vi.fn(async function () { return fullCreds(); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    const r = await h({});

    expect(secrets.hasNative).toBeUndefined();
    expect(r.persisted).toBe(false);
    expect(r.configured).toBe(true);
  });
});

describe('wechat-credentials-ipc · wechat:credentials-load', () => {
  it('调用一次 directWechatRead 并返回三项凭据', async () => {
    const { handlers, directWechatRead } = createHarness({
      directWechatRead: vi.fn(async function () { return fullCreds(); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-load');

    const r = await h({});

    expect(directWechatRead).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ appId: 'wx1', appSecret: 'sec1', thumbMediaId: 'tm1' });
  });

  it('凭据为空时返回三个空串字段', async () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-load');

    const r = await h({});

    expect(r).toEqual({ appId: '', appSecret: '', thumbMediaId: '' });
  });

  it('只回传三个字段，不带状态字段', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () { return fullCreds(); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-load');

    const r = await h({});

    expect(Object.keys(r).sort()).toEqual(['appId', 'appSecret', 'thumbMediaId']);
  });
});

describe('wechat-credentials-ipc · wechat:credentials-save', () => {
  it('按 field → secretKeys 映射写入正确密钥', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, { appId: 'wx1', appSecret: 'sec1', thumbMediaId: 'tm1' });

    expect(secrets.setSecret).toHaveBeenCalledTimes(3);
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-id', 'wx1');
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-secret', 'sec1');
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-thumb-media-id', 'tm1');
    expect(r).toEqual({ ok: true, persisted: true });
  });

  it('空字符串字段不写入（留空 = 保留已有值）', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    await h({}, { appId: 'wx1', appSecret: '', thumbMediaId: '' });

    expect(secrets.setSecret).toHaveBeenCalledTimes(1);
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-id', 'wx1');
    expect(secrets.setSecret).not.toHaveBeenCalledWith('wechat-app-secret', expect.anything());
    expect(secrets.setSecret).not.toHaveBeenCalledWith('wechat-thumb-media-id', expect.anything());
  });

  it('值按原逻辑做字符串化与 trim', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    await h({}, { appId: '  wx1  ', appSecret: 12345, thumbMediaId: '\ttm1\n' });

    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-id', 'wx1');
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-secret', '12345');
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-thumb-media-id', 'tm1');
  });

  it('空白串 trim 后为空 → 不写入', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    await h({}, { appId: '   ', appSecret: 'sec1', thumbMediaId: '' });

    expect(secrets.setSecret).toHaveBeenCalledTimes(1);
    expect(secrets.setSecret).toHaveBeenCalledWith('wechat-app-secret', 'sec1');
  });

  it('values 为 undefined 时归一为空对象且不抛错', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, undefined);

    expect(secrets.setSecret).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, persisted: true });
  });

  it('values 为 null 时归一为空对象且不抛错', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, null);

    expect(secrets.setSecret).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, persisted: true });
  });

  it('全部写入成功时 persisted 为 true', async () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, { appId: 'wx1', appSecret: 'sec1', thumbMediaId: 'tm1' });

    expect(r.persisted).toBe(true);
  });

  it('任一写入失败时 persisted 聚合为 false', async () => {
    const secrets = fakeSecrets({
      setSecret: vi.fn(async function (key) { return key !== 'wechat-app-secret'; })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, { appId: 'wx1', appSecret: 'sec1', thumbMediaId: 'tm1' });

    expect(r).toEqual({ ok: true, persisted: false });
  });

  it('只有部分字段写入时仍返回 ok:true', async () => {
    const { handlers } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-save');

    const r = await h({}, { appId: 'wx1' });

    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
  });
});

describe('wechat-credentials-ipc · wechat:credentials-clear', () => {
  it('对 secretKeys 的每个值调用 deleteSecret 并返回 { ok:true }', async () => {
    const { handlers, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-clear');

    const r = await h({});

    expect(secrets.deleteSecret).toHaveBeenCalledTimes(3);
    expect(secrets.deleteSecret).toHaveBeenCalledWith('wechat-app-id');
    expect(secrets.deleteSecret).toHaveBeenCalledWith('wechat-app-secret');
    expect(secrets.deleteSecret).toHaveBeenCalledWith('wechat-thumb-media-id');
    expect(r).toEqual({ ok: true });
  });

  it('保持并发删除语义（三个 deleteSecret 同时在途）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const secrets = fakeSecrets({
      deleteSecret: vi.fn(async function () {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(function (resolve) { setTimeout(resolve, 5); });
        inFlight--;
        return true;
      })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'wechat:credentials-clear');

    await h({});

    expect(maxInFlight).toBe(3);
  });

  it('不调用 directWechatRead 与 setSecret', async () => {
    const { handlers, directWechatRead, secrets } = createHarness();
    const h = handlerOf(handlers, 'wechat:credentials-clear');

    await h({});

    expect(directWechatRead).not.toHaveBeenCalled();
    expect(secrets.setSecret).not.toHaveBeenCalled();
  });
});

describe('wechat-credentials-ipc · 依赖调用时机与异步语义', () => {
  it('status/load 调用 directWechatRead，save/clear 不调用', async () => {
    const { handlers, directWechatRead } = createHarness();
    const hStatus = handlerOf(handlers, 'wechat:credentials-status');
    const hLoad = handlerOf(handlers, 'wechat:credentials-load');
    const hSave = handlerOf(handlers, 'wechat:credentials-save');
    const hClear = handlerOf(handlers, 'wechat:credentials-clear');

    await hStatus({});
    expect(directWechatRead).toHaveBeenCalledTimes(1);

    await hLoad({});
    expect(directWechatRead).toHaveBeenCalledTimes(2);

    await hSave({}, { appId: 'wx1' });
    await hClear({});
    expect(directWechatRead).toHaveBeenCalledTimes(2);
  });

  it('4 个 handler 全部返回 Promise 且声明为 async', () => {
    const { handlers } = createHarness();

    handlers.forEach(function (fn) {
      expect(fn.constructor.name).toBe('AsyncFunction');
      const r = fn({}, {});
      expect(r).toBeInstanceOf(Promise);
      return r.catch(function () {});
    });
  });

  it('directWechatRead 抛错时 handler 返回 rejected Promise（异常不被吞掉）', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () { throw new Error('read-fail'); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-status');

    await expect(h({})).rejects.toThrow('read-fail');
  });

  it('credentials-load 的 directWechatRead 异常同样向上传播', async () => {
    const { handlers } = createHarness({
      directWechatRead: vi.fn(async function () { throw new Error('load-fail'); })
    });
    const h = handlerOf(handlers, 'wechat:credentials-load');

    await expect(h({})).rejects.toThrow('load-fail');
  });

  it('setSecret 抛错时 save 返回 rejected Promise', async () => {
    const secrets = fakeSecrets({
      setSecret: vi.fn(async function () { throw new Error('set-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'wechat:credentials-save');

    await expect(h({}, { appId: 'wx1' })).rejects.toThrow('set-fail');
  });

  it('deleteSecret 抛错时 clear 返回 rejected Promise', async () => {
    const secrets = fakeSecrets({
      deleteSecret: vi.fn(async function () { throw new Error('delete-fail'); })
    });
    const { handlers } = createHarness({ secrets: secrets });
    const h = handlerOf(handlers, 'wechat:credentials-clear');

    await expect(h({})).rejects.toThrow('delete-fail');
  });
});
