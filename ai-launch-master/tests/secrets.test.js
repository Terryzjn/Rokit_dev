// Rokit · secrets 凭据管理层单元测试（v1.5）
// 目标：setSecret / getSecret / deleteSecret / getApiKey / setApiKey / clearApiKey
//       purgeLegacySecretSlots / migratePlaintextApiKey
// v1.21：GitHub PAT 与 YouTube Data API Key 的全部读写接口已删除
//       （github-pat / youtube-api-key 槽位仅供 purgeLegacySecretSlots 一次性清理）
// 关键：keytar 是原生模块，本机若无原生构建会降级为内存；测试通过 mock keytar 控制行为

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

let tmpDir;
let mockKeytar;

function mockKeytarModule() {
  const store = Object.create(null);
  return {
    setPassword: async function (service, account, value) { store[service + '|' + account] = value; },
    getPassword: async function (service, account) { return store[service + '|' + account] || null; },
    deletePassword: async function (service, account) { delete store[service + '|' + account]; }
  };
}

// 通过劫持 require 缓存注入 mock keytar
function injectMockKeytar() {
  mockKeytar = mockKeytarModule();
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'keytar') return mockKeytar;
    return origLoad.call(this, request, parent, ...rest);
  };
  return function restore() {
    Module._load = origLoad;
    Module._resolveFilename = origResolve;
  };
}

let restoreKeytar;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-secrets-'));
  restoreKeytar = injectMockKeytar();
});

afterEach(() => {
  if (restoreKeytar) restoreKeytar();
  try { fs.rmdirSync(tmpDir); } catch (_) {}
});

describe('secrets · 凭据读写', () => {
  it('setSecret + getSecret 应能写入并取回', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null; s._cache.githubPat = null;
    await s.setSecret('test-acct', 'value-1');
    const got = await s.getSecret('test-acct');
    expect(got).toBe('value-1');
  });

  it('setSecret(null) 等价于 deleteSecret', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null; s._cache.githubPat = null;
    await s.setSecret('a', 'x');
    expect(await s.getSecret('a')).toBe('x');
    await s.setSecret('a', null);
    expect(await s.getSecret('a')).toBe(null);
  });

  it('deleteSecret 应清空缓存', async () => {
    const s = require('../electron/secrets');
    await s.setSecret('a', 'y');
    await s.deleteSecret('a');
    expect(s._cache.a).toBe(null);
    expect(await s.getSecret('a')).toBe(null);
  });
});

describe('secrets · API Key / GitHub PAT 专属接口', () => {
  it('setApiKey + getApiKey 应能往返', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null;
    await s.setApiKey('sk-test-1234');
    expect(await s.getApiKey()).toBe('sk-test-1234');
  });

  it('clearApiKey 应清空 keytar + cache', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null;
    await s.setApiKey('sk-test');
    await s.clearApiKey();
    expect(await s.getApiKey()).toBe(null);
    expect(s._cache.apiKey).toBe(null);
  });

  // v1.21：setGithubPat / clearGithubPat / getGithubPat / getYoutubeApiKey 全部删除。
  //   github-pat 槽位仅供purgeLegacySecretSlots 一次性清理，测试直接用通用
  //   setSecret / deleteSecret / getSecret 覆盖同样的存取行为。
  it('github-pat 槽位应能通过通用接口读写', async () => {
    const s = require('../electron/secrets');
    s._cache.githubPat = null;
    await s.setSecret('github-pat', 'ghp_abc');
    expect(await s.getSecret('github-pat')).toBe('ghp_abc');
  });

  it('deleteSecret 应能清空 github-pat 槽位', async () => {
    const s = require('../electron/secrets');
    s._cache.githubPat = null;
    await s.setSecret('github-pat', 'ghp_abc');
    await s.deleteSecret('github-pat');
    expect(await s.getSecret('github-pat')).toBe(null);
  });
});

describe('secrets · migratePlaintextApiKey', () => {
  it('没有明文 key 时应返回 migrated=false', async () => {
    const s = require('../electron/secrets');
    const fakeStore = { getSettings: () => ({ api_key: '' }) };
    const r = await s.migratePlaintextApiKey(fakeStore);
    expect(r.migrated).toBe(false);
  });

  it('明文迁移：写入 keytar + 清空 SQLite 字段', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null;
    const fakeStore = {
      getSettings: () => ({ api_key: 'sk-plain' }),
      clearPlaintextApiKey: () => { fakeStore._cleared = true; }
    };
    const r = await s.migratePlaintextApiKey(fakeStore);
    expect(r.migrated).toBe(true);
    expect(await s.getApiKey()).toBe('sk-plain');
    expect(fakeStore._cleared).toBe(true);
  });

  it('明文已存在于 keytar：仅清空 SQLite，不重复写入', async () => {
    const s = require('../electron/secrets');
    s._cache.apiKey = null;
    await s.setApiKey('sk-already');
    let writes = 0;
    const fakeStore = {
      getSettings: () => ({ api_key: 'sk-already' }),
      clearPlaintextApiKey: () => { writes++; }
    };
    const r = await s.migratePlaintextApiKey(fakeStore);
    expect(r.migrated).toBe(true);
    expect(writes).toBe(1);
  });

  it('null store 应返回 reason=no-store', async () => {
    const s = require('../electron/secrets');
    const r = await s.migratePlaintextApiKey(null);
    expect(r.migrated).toBe(false);
    expect(r.reason).toBe('no-store');
  });
});

describe('secrets · purgeLegacySecretSlots（v1.21 一次性清理）', () => {
  // 本组用例需要**干净的真实存量状态**：secrets.js 在首次 require 时就绑定了当时的
  // mock keytar 实例，而全局 beforeEach 每次都会注入新的 mock。因此这里先清模块缓存
  // 让本组每个用例都重新 require，绑定当轮的 mock（store 为空 = 模拟新装机器）。
  beforeEach(() => {
    delete require.cache[require.resolve('../electron/secrets')];
  });

  it('老用户只有 github-pat、无 oauth-github 时：应迁移进 oauth 再删槽位', async () => {
    const s = require('../electron/secrets');
    await s.setSecret('github-pat', 'ghp_legacy');
    const r = await s.purgeLegacySecretSlots();
    expect(r.githubPat).toBe('migrated');
    // 槽位已清空
    expect(await s.getSecret('github-pat')).toBe(null);
    // 凭据已搬到 oauth-github，发布链路仍能拿到 token
    const rec = await s.getOauthToken('github');
    expect(rec).toBeTruthy();
    expect(rec.access_token).toBe('ghp_legacy');
    expect(rec.token_type).toBe('pat');
    expect(rec.migrated_from).toBe('github-pat');
  });

  it('已有 oauth-github 记录时：github-pat 视为冗余直接删', async () => {
    const s = require('../electron/secrets');
    await s.setSecret('github-pat', 'ghp_old');
    await s.setOauthToken('github', {
      access_token: 'ghp_new', refresh_token: null, token_type: 'pat',
      scope: '', expires_at: null, account: { login: 'terry' }
    });
    const r = await s.purgeLegacySecretSlots();
    expect(r.githubPat).toBe('dropped');
    expect(await s.getSecret('github-pat')).toBe(null);
    // 不能覆盖用户已有的 oauth 记录
    const rec = await s.getOauthToken('github');
    expect(rec.access_token).toBe('ghp_new');
    expect(rec.account.login).toBe('terry');
  });

  it('youtube-api-key 槽位应被清掉', async () => {
    const s = require('../electron/secrets');
    await s.setSecret('youtube-api-key', 'AIzaLegacy');
    const r = await s.purgeLegacySecretSlots();
    expect(r.youtubeApiKey).toBe('dropped');
    expect(await s.getSecret('youtube-api-key')).toBe(null);
  });

  it('两个槽位都没有时：应报 absent 且不产生副作用', async () => {
    const s = require('../electron/secrets');
    const r = await s.purgeLegacySecretSlots();
    expect(r.githubPat).toBe('absent');
    expect(r.youtubeApiKey).toBe('absent');
  });

  it('幂等：连续跑两次第二次应全为 absent', async () => {
    const s = require('../electron/secrets');
    await s.setSecret('github-pat', 'ghp_legacy');
    const first = await s.purgeLegacySecretSlots();
    expect(first.githubPat).toBe('migrated');
    const second = await s.purgeLegacySecretSlots();
    expect(second.githubPat).toBe('absent');
    // 迁移来的凭据仍在
    const rec = await s.getOauthToken('github');
    expect(rec.access_token).toBe('ghp_legacy');
  });
});

describe('secrets · 降级路径', () => {
  it('keytar 加载失败时 setSecret 应只写内存并返回 false', async () => {
    // 重新 require，禁用 mock keytar（让模块自身找不到 keytar）
    if (restoreKeytar) restoreKeytar();
    // 通过劫持 Module._load 让 keytar 抛错
    const orig = Module._load;
    Module._load = function (req) {
      if (req === 'keytar') throw new Error('mock: native module not built');
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../electron/secrets')];
    const s = require('../electron/secrets');
    s._cache.apiKey = null; s._cache.githubPat = null;
    expect(s.hasNative()).toBe(false);
    const r = await s.setApiKey('sk-x');
    expect(r).toBe(false);
    // 降级路径下应仍能通过 getApiKey() 从内存取出
    expect(await s.getApiKey()).toBe('sk-x');
    Module._load = orig;
    delete require.cache[require.resolve('../electron/secrets')];
  });
});