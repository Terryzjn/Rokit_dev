// Rokit · oauth 浏览器启动判定单元测试（v0.1.6 回归）
//
// 背景（真实故障）：oauth.start() 旧实现用「调度后 1.5s 内浏览器进程数必须增长」
// 作为"浏览器是否打开成功"的判据，导致两类误报：
//   1. 浏览器已经在运行时，新标签页复用已有进程 → 进程数不变 → 真开成功也被判失败；
//   2. tasklist 调用失败（受限令牌 / PATH 不全）会静默返回 0，
//      调用方无法区分"这次没测出来"和"一个浏览器都没有" → 4 种策略被依次判失败。
// 用户看到的现象是「⚠ 浏览器启动失败，URL 已复制到剪贴板」，但浏览器其实已经打开，
// 而且 4 种策略会各弹一次、重复打开多个相同标签页。
//
// 本文件锁定修正后的契约：**只看调用本身是否成功**（shell.openExternal resolve 即成功）；
// 进程数只作为日志观测，绝不参与判定。
//
// 依赖注入沿用 tests/store-json.test.js 的 Module._load 钩子（项目内既有惯例）。
const Module = require('module');

const OAUTH_PATH = require.resolve('../electron/oauth');

// 可控的 child_process 替身：同时充当"计数失败"和"spawn 失败"的注入点
function makeChildProcess(opts) {
  const o = opts || {};
  const calls = [];
  return {
    calls: calls,
    spawn: function (cmd, args) {
      calls.push({ fn: 'spawn', cmd: cmd, args: args });
      if (o.spawnThrows) throw new Error('spawn EPERM');
      return { on: function () { return this; }, unref: function () {} };
    },
    spawnSync: function (cmd) {
      calls.push({ fn: 'spawnSync', cmd: cmd });
      if (o.spawnSyncError) return { error: o.spawnSyncError };
      return {
        status: 0,
        stdout: typeof o.stdout === 'string' ? o.stdout : '"msedge.exe","1","Console","1","1 K"\r\n'
      };
    }
  };
}

function makeState() {
  const s = {
    lastUrl: null,
    written: [],
    openExternalError: null,
    clipboardError: null,
    restricted: false,
    childProcess: makeChildProcess(),
    provider: {
      id: 'youtube',
      name: 'YouTube',
      clientId: 'test-client-id',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      callbackPath: '/oauth2callback',
      accountUrl: null, // 跳过拉账号信息，聚焦浏览器启动判定
      defaultScopes: ['scope.a'],
      extraAuthParams: {},
      usePKCE: true,
      supportsRefresh: true
    }
  };
  s.openExternal = async function (url) {
    s.lastUrl = url; // 先记录，再决定是否抛错（回调需要从 URL 取 state）
    if (s.openExternalError) throw s.openExternalError;
  };
  s.writeText = function (t) {
    if (s.clipboardError) throw s.clipboardError;
    s.written.push(t);
  };
  return s;
}

let state;
let restoreHooks;

function installHooks() {
  const orig = Module._load;
  Module._load = function (request, parent, _isMain) {
    const fromOauth = !!parent && parent.filename === OAUTH_PATH;

    if (fromOauth && request === 'electron') {
      return {
        shell: { openExternal: function (u) { return state.openExternal(u); } },
        clipboard: { writeText: function (t) { return state.writeText(t); } }
      };
    }
    if (fromOauth && request === 'child_process') return state.childProcess;
    if (fromOauth && request === './oauth-providers') {
      return { getProvider: function (id) { return id === 'youtube' ? state.provider : null; } };
    }
    if (fromOauth && request === './oauth-loopback') {
      return {
        CALLBACK_PATH: '/oauth-callback',
        createLoopback: function () {
          return {
            port: Promise.resolve(45678),
            // 回调带上 authorize URL 里的 state，保证 state 校验通过
            awaitCallback: function () {
              const st = state.lastUrl ? new URL(state.lastUrl).searchParams.get('state') : 'missing';
              return Promise.resolve({ code: 'test-code', state: st, error: '', errorDescription: '' });
            }
          };
        }
      };
    }
    if (fromOauth && request === './secrets') {
      return { setOauthToken: async function () { return true; } };
    }
    if (fromOauth && request === './platform-context') {
      return {
        getIntegrity: function () {
          return {
            level: state.restricted ? 'low' : 'medium',
            sid: state.restricted ? 'S-1-16-4096' : 'S-1-16-8192'
          };
        },
        isRestrictedContext: function () { return !!state.restricted; }
      };
    }
    if (fromOauth && request === './logger') {
      return { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
    }
    return orig.call(this, request, parent, _isMain);
  };
  return function restore() { Module._load = orig; };
}

function freshOauth() {
  delete require.cache[OAUTH_PATH];
  return require('../electron/oauth');
}

function spawnedCommands() {
  return state.childProcess.calls
    .filter(function (c) { return c.fn === 'spawn'; })
    .map(function (c) { return c.cmd; });
}

const realFetch = globalThis.fetch;

beforeEach(function () {
  state = makeState();
  restoreHooks = installHooks();
  // exchangeCode 会走 fetch：返回一个最小的 token 响应
  globalThis.fetch = async function () {
    return {
      ok: true,
      status: 200,
      json: async function () {
        return { access_token: 'test-token', token_type: 'bearer', scope: 'scope.a', expires_in: 3600 };
      }
    };
  };
});

afterEach(function () {
  restoreHooks();
  globalThis.fetch = realFetch;
  delete require.cache[OAUTH_PATH];
});

describe('oauth · 浏览器启动判定', function () {
  it('shell.openExternal 正常 resolve → 判成功，且不降级、不动剪贴板', async function () {
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(true);
    expect(r.via).toBe('shell.openExternal');
    expect(state.written).toEqual([]);
    // 不应降级去 spawn cmd/rundll32/explorer
    expect(spawnedCommands()).toEqual([]);
  });

  it('tasklist 查询失败（spawnSync 报错）不影响判定 —— 旧实现误报的根因', async function () {
    state.childProcess = makeChildProcess({ spawnSyncError: new Error('spawnSync tasklist.exe EPERM') });
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    // 旧实现：进程数静默变 0 → 4 种策略全判失败 → via='clipboard'
    expect(r.ok).toBe(true);
    expect(r.via).toBe('shell.openExternal');
    expect(state.written).toEqual([]);
  });

  it('浏览器已在运行、进程数不增长时仍判成功 —— 旧实现要求必须增长', async function () {
    state.childProcess = makeChildProcess({ stdout: '' }); // 查询成功但计数恒为 0
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(true);
    expect(r.via).toBe('shell.openExternal');
    expect(state.written).toEqual([]);
  });

  it('shell.openExternal reject 时才降级到 cmd /c start', async function () {
    state.openExternalError = new Error('Failed to open path');
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(true);
    expect(r.via).toBe('cmd /c start');
    expect(spawnedCommands()).toContain('cmd.exe');
    expect(state.written).toEqual([]);
    expect(state.lastUrl).toContain('accounts.google.com');
  });

  it('全部策略失败 → 复制授权 URL 到剪贴板并标记 via=clipboard', async function () {
    state.openExternalError = new Error('nope');
    state.childProcess = makeChildProcess({ spawnThrows: true });
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(true);
    expect(r.via).toBe('clipboard');
    expect(state.written.length).toBe(1);
    expect(state.written[0]).toContain('accounts.google.com');
  });

  it('全部策略失败且剪贴板也不可用 → browser_open_failed', async function () {
    state.openExternalError = new Error('nope');
    state.childProcess = makeChildProcess({ spawnThrows: true });
    state.clipboardError = new Error('clipboard unavailable');
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('browser_open_failed');
  });

  it('受限上下文（Low 完整性）下不得谎报成功 → 强制剪贴板兜底并标记 restricted', async function () {
    // 真实故障：Low 完整性下 Windows 会拒绝把 URL 交给已运行的浏览器，
    // msedge.exe 被启动后立刻退出，而 shell.openExternal 仍然 resolve（"假成功"）。
    // 此时必须改走剪贴板，并让 Renderer 能说明原因。
    state.restricted = true;
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.ok).toBe(true);
    expect(r.via).toBe('clipboard');
    expect(r.restricted).toBe(true);
    expect(state.written.length).toBe(1);
    expect(state.written[0]).toContain('accounts.google.com');
  });

  it('非受限上下文下 restricted 为 false（不影响正常判定）', async function () {
    state.restricted = false;
    const oauth = freshOauth();
    const r = await oauth.start('youtube');

    expect(r.via).toBe('shell.openExternal');
    expect(r.restricted).toBe(false);
  });
});
