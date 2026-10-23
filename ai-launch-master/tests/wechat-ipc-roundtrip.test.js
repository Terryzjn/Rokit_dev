// Rokit · 微信公众号凭据 IPC 端到端往返测试（不依赖 UI / 浏览器）
//
// 真实场景重现：模拟主进程内的 wechat:credentials-save / load / status 三个 handler，
//   验证：(1) save 写入的三个值能在 load 中取回；(2) status 正确反映「全有 / 全无 / 部分有」；
//   (3) 走 _directWechatRead 直读 keytar，绕过 secrets.js 模块级 cache。
//
// 通过 Module._load 注入 mock keytar，与 secrets.test.js 同一套机制。
//
// 该测试是「问题 B · 数据链路」的程序化验收：
//   - 前端表单（mock values）→ IPC handler → keytar mock → 重读 → 状态

'use strict';

const Module = require('module');

// 在 require secrets.js 之前，注入 mock keytar，避免落到真实原生模块
function injectMockKeytar(store) {
  const mockKeytar = {
    setPassword: async (svc, account, value) => { store[svc + '|' + account] = value; },
    getPassword: async (svc, account) => (store[svc + '|' + account] == null ? null : store[svc + '|' + account]),
    deletePassword: async (svc, account) => { delete store[svc + '|' + account]; }
  };
  const origLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'keytar') return mockKeytar;
    return origLoad.call(this, req, parent, ...rest);
  };
  return function restore() { Module._load = origLoad; };
}

// 模拟主进程 _directWechatRead 的核心逻辑（与 main.js L963-L978 一致语义）
function makeDirectRead(WECHAT_SECRET_KEYS) {
  return async function directRead() {
    const keytar = require('keytar');
    const SERVICE = 'Rokit';
    const out = { appId: '', appSecret: '', thumbMediaId: '' };
    out.appId = (await keytar.getPassword(SERVICE, WECHAT_SECRET_KEYS.appId)) || '';
    out.appSecret = (await keytar.getPassword(SERVICE, WECHAT_SECRET_KEYS.appSecret)) || '';
    out.thumbMediaId = (await keytar.getPassword(SERVICE, WECHAT_SECRET_KEYS.thumbMediaId)) || '';
    return out;
  };
}

// 模拟主进程 wechat:credentials-save 核心逻辑（与 main.js L1007-L1019 一致）
// 关键：把外部字段名 appId/appSecret/thumbMediaId 映射到 keytar 账号 wechat-app-id / wechat-app-secret / wechat-thumb-media-id
const WECHAT_SECRET_KEYS_GLOBAL = {
  appId: 'wechat-app-id',
  appSecret: 'wechat-app-secret',
  thumbMediaId: 'wechat-thumb-media-id'
};

async function wechatSave(secrets, values) {
  const input = values || {};
  let persisted = true;
  for (const field of Object.keys(WECHAT_SECRET_KEYS_GLOBAL)) {
    const keytarAccount = WECHAT_SECRET_KEYS_GLOBAL[field];
    const value = String(input[field] || '').trim();
    if (value) {
      const ok = await secrets.setSecret(keytarAccount, value);
      persisted = ok && persisted;
    }
  }
  return { ok: true, persisted };
}

async function wechatStatus(secrets, directRead) {
  const direct = await directRead();
  const missing = [];
  if (!direct.appId) missing.push('appId');
  if (!direct.appSecret) missing.push('appSecret');
  if (!direct.thumbMediaId) missing.push('thumbMediaId');
  return {
    hasAppId: !!direct.appId,
    hasAppSecret: !!direct.appSecret,
    hasThumbMediaId: !!direct.thumbMediaId,
    missing,
    configured: missing.length === 0,
    persisted: secrets.hasNative()
  };
}

async function wechatLoad(directRead) {
  const direct = await directRead();
  return { appId: direct.appId, appSecret: direct.appSecret, thumbMediaId: direct.thumbMediaId };
}

describe('wechat · 凭据 IPC 端到端往返（mock keytar）', () => {
  let store;
  let restore;
  let secrets;
  let directRead;
  const WECHAT_SECRET_KEYS = {
    appId: 'wechat-app-id',
    appSecret: 'wechat-app-secret',
    thumbMediaId: 'wechat-thumb-media-id'
  };

  beforeEach(() => {
    store = Object.create(null);
    restore = injectMockKeytar(store);
    delete require.cache[require.resolve('../electron/secrets')];
    secrets = require('../electron/secrets');
    secrets._cache.apiKey = null;
    secrets._cache.githubPat = null;
    directRead = makeDirectRead(WECHAT_SECRET_KEYS);
  });

  afterEach(() => { if (restore) restore(); });

  it('save 三个非空字段 → load 应原样返回', async () => {
    const sRes = await wechatSave(secrets, {
      appId: 'wx-test-id-001',
      appSecret: 'a'.repeat(32),
      thumbMediaId: 'thumb-9X9'
    });
    expect(sRes.ok).toBe(true);
    expect(sRes.persisted).toBe(true);

    const lRes = await wechatLoad(directRead);
    expect(lRes.appId).toBe('wx-test-id-001');
    expect(lRes.appSecret).toBe('a'.repeat(32));
    expect(lRes.thumbMediaId).toBe('thumb-9X9');
  });

  it('三个字段都有 → status 应配置完整', async () => {
    await wechatSave(secrets, { appId: 'wx', appSecret: 's', thumbMediaId: 'th' });
    const st = await wechatStatus(secrets, directRead);
    expect(st.hasAppId).toBe(true);
    expect(st.hasAppSecret).toBe(true);
    expect(st.hasThumbMediaId).toBe(true);
    expect(st.configured).toBe(true);
    expect(st.missing).toEqual([]);
  });

  it('缺 appId → status 应只指出 appId 缺失', async () => {
    await wechatSave(secrets, { appSecret: 's', thumbMediaId: 'th' });
    const st = await wechatStatus(secrets, directRead);
    expect(st.hasAppId).toBe(false);
    expect(st.hasAppSecret).toBe(true);
    expect(st.hasThumbMediaId).toBe(true);
    expect(st.configured).toBe(false);
    expect(st.missing).toEqual(['appId']);
  });

  it('只填一个字段 → status 应只列出另两个', async () => {
    await wechatSave(secrets, { appId: 'wx' });
    const st = await wechatStatus(secrets, directRead);
    expect(st.configured).toBe(false);
    expect(st.missing.slice().sort()).toEqual(['appSecret', 'thumbMediaId']);
  });

  it('save 全空字符串 → 不应误删已有凭据（与 UI 行为一致：留空=保留）', async () => {
    await wechatSave(secrets, { appId: 'wx', appSecret: 's', thumbMediaId: 'th' });
    let st = await wechatStatus(secrets, directRead);
    expect(st.configured).toBe(true);
    // 全空提交：因为 handler 只对非空 value 调 setSecret，留空=保留原值
    await wechatSave(secrets, { appId: '', appSecret: '', thumbMediaId: '' });
    st = await wechatStatus(secrets, directRead);
    expect(st.configured).toBe(true); // 之前已填的值应保留
  });

  it('clear 后再 save → load 应只有新写入的值', async () => {
    await wechatSave(secrets, { appId: 'old', appSecret: 'olds', thumbMediaId: 'oldt' });
    await Promise.all(Object.values(WECHAT_SECRET_KEYS).map((k) => secrets.deleteSecret(k)));
    let st = await wechatStatus(secrets, directRead);
    expect(st.configured).toBe(false);
    await wechatSave(secrets, { appId: 'new', appSecret: 'news', thumbMediaId: 'newt' });
    const l = await wechatLoad(directRead);
    expect(l.appId).toBe('new');
    expect(l.appSecret).toBe('news');
    expect(l.thumbMediaId).toBe('newt');
  });

  it('完整链路：mock 表单值 → IPC save → 直读 keytar → status 完整', async () => {
    const formValue = {
      appId: 'wx-direct-test',
      appSecret: 'secret-32-chars-aaaaaaaaaaaaaaaaaa',
      thumbMediaId: 'thumb-direct-test'
    };
    await wechatSave(secrets, formValue);
    const direct = await directRead();
    expect(direct.appId).toBe(formValue.appId);
    expect(direct.appSecret).toBe(formValue.appSecret);
    expect(direct.thumbMediaId).toBe(formValue.thumbMediaId);
    const st = await wechatStatus(secrets, directRead);
    expect(st.configured).toBe(true);
  });

  it('保存只改一个字段不应影响其他字段（只传 appId）', async () => {
    await wechatSave(secrets, { appId: 'orig', appSecret: 'origs', thumbMediaId: 'origt' });
    await wechatSave(secrets, { appId: 'new' });
    const l = await wechatLoad(directRead);
    expect(l.appId).toBe('new');
    expect(l.appSecret).toBe('origs');
    expect(l.thumbMediaId).toBe('origt');
  });
});