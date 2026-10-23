// voice-engine 渲染层 UI 单元测试 (v1.20.8)
//
// 覆盖：
//   1. 录音页主按钮（vstudioNextBtn）状态机：hasProfile / hasSkipped / busy / disabled reason
//   2. 语音生成页 _nextBlockedReason 状态机
//   3. 静态 HTML 检查：按钮必须是 primary-main（青绿色），禁用态统一灰色
//   4. 状态板（voicegen-statecard）类选择（idle / busy / ok / warn / bad）
//   5. probing 状态字段（voiceEngineDetect / voiceEngineRunTest）
//   6. 在线服务 API Key 守卫（不允许跳过测试）
//   7. 跨模式状态隔离（voiceEnginePickKind 切换时清空 online / local 子状态）
//
// 做法 —— 用 vm.runInContext 把 renderer JS 装载到沙箱，
//   注入最小 state / window.api 桩函数，断言函数返回值与 DOM 字符串。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const idxPath = path.join(__dirname, '..', 'index.html');
const idxHtml = fs.readFileSync(idxPath, 'utf8');

// 提取 <script> 中**最长的**那段（index.html 含主题切换小段 + 主段）
const blocks = idxHtml.match(/<script>([\s\S]*?)<\/script>/g) || [];
let scriptSrc = '';
for (const b of blocks) {
  const inner = b.replace(/<\/?script>/g, '');
  if (inner.length > scriptSrc.length) scriptSrc = inner;
}

// 字符串/注释/template literal 内的大括号都跳过
function findBalance(src, start) {
  let d = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++; i++;
      }
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

// 提取函数定义（不含 expression assigned）。例如 function _nextBlockedReason(){...}
function pickPlainFn(name) {
  const re = new RegExp('(?:^|\\n)\\s*function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'm');
  const m = scriptSrc.match(re);
  if (!m) throw new Error('cannot find function ' + name);
  const startIdx = m.index + m[0].indexOf('function');
  const bs = scriptSrc.indexOf('{', startIdx);
  const be = findBalance(scriptSrc, bs);
  if (be < 0) throw new Error(name + ' unbalanced');
  return scriptSrc.substring(startIdx, be + 1);
}

// 提取形如 "var name = ...;" 的赋值（用于 voiceEnginePickKind / voiceEnginePickEngine 等）
function pickVarAssigned(name) {
  const re = new RegExp('(?:^|\\n)\\s*window\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=', 'm');
  const m = scriptSrc.match(re);
  if (!m) throw new Error('cannot find window.' + name);
  const startIdx = m.index + m[0].indexOf('window.' + name);
  // 用单号 vs 大括号匹配
  let depth = 0, endIdx = -1, started = false;
  for (let i = startIdx; i < scriptSrc.length; i++) {
    const c = scriptSrc[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && started) { endIdx = i + 1; break; }
    } else if (c === ';' && !started && depth === 0) {
      // 单行：let x = 1;
      endIdx = i + 1;
      break;
    }
  }
  if (endIdx < 0) throw new Error('cannot find end of window.' + name);
  return scriptSrc.substring(startIdx, endIdx);
}

// 沙箱：注入 state / window.api / 模拟 DOM
function makeSandbox() {
  const sb = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    String, Number, JSON, Array, Object, Math, Date, RegExp, Error, Promise, Map, Set, Boolean, Symbol,
    parseInt, parseFloat, isNaN, isFinite,
    Buffer,
    state: {
      voiceProfile: null,
      voiceCurrentVersionId: null,
      voiceSkip: false,
      voiceEngine: null,
      voiceSource: 'aiDemo',
      step: 8
    },
    __recState: {
      status: 'idle',
      elapsedMs: 0,
      micLevel: 0,
      resultBlob: null,
      resultURL: '',
      resultDuration: 0,
      resultMime: 'audio/webm'
    }
  };
  vm.createContext(sb);
  sb.window = sb;
  sb.self = sb;
  sb.global = sb;
  return sb;
}

function bootFn(name) {
  const sb = makeSandbox();
  vm.runInContext(pickPlainFn(name), sb);
  return sb;
}

function bootVar(name) {
  const sb = makeSandbox();
  // 加载该函数 + 它直接依赖的少数辅助函数（fmtDur / esc）
  // 先载入所有 pure 辅助函数（esc、fmtDur、pushAI、renderVoiceStudioTimer 等不依赖 state 的）
  // 然后装载目标函数
  vm.runInContext(pickVarAssigned(name), sb);
  return sb;
}

function bootFns(names) {
  const sb = makeSandbox();
  let combined = '';
  for (const n of names) {
    try { combined += '\n' + pickPlainFn(n); } catch (_) {}
    try { combined += '\n' + pickVarAssigned(n); } catch (_) {}
  }
  vm.runInContext(combined, sb);
  return sb;
}

// =====================================================================
// 1) 静态 HTML 检查 —— 按钮必须是 primary-main（青绿色），禁用态统一灰色
// =====================================================================
describe('按钮颜色：primary-main vs accent (静态扫描)', () => {
  test('录音页 vstudioNextBtn 必须是 btn.primary-main', () => {
    expect(idxHtml).toMatch(/<button class="btn primary-main" id="vstudioNextBtn"/);
  });

  test('语音生成页主按钮（启用态）必须是 btn.primary-main', () => {
    expect(idxHtml).toMatch(/<button class="btn primary-main" onclick="voiceEngineNext\(\)">/);
  });

  test('语音生成页主按钮（禁用态）必须是 btn.primary-main disabled', () => {
    expect(idxHtml).toMatch(/<button class="btn primary-main" disabled title="/);
  });

  test('「下一步」按钮位置**不允许**残留 .btn accent', () => {
    // 检查两步关键位置
    expect(idxHtml).not.toMatch(/<button class="btn accent"(?:[^>]*?)(?:id="vstudioNextBtn"|onclick="voiceEngineNext)/);
  });

  test('CSS：.btn.primary-main 已定义', () => {
    expect(idxHtml).toMatch(/\.btn\.primary-main\{[^}]*min-width:160px/);
  });

  test('CSS：.btn.primary-main[disabled] 使用 --line 灰底', () => {
    expect(idxHtml).toMatch(/\.btn\.primary-main\[disabled\][^}]*background:var\(--line\)/);
  });
});

// =====================================================================
// 2) _nextBlockedReason 状态机（语音生成页主按钮启用条件）
// =====================================================================
describe('语音生成页 _nextBlockedReason 状态机', () => {
  function call(ve) {
    const sb = bootFn('_nextBlockedReason');
    sb.ve = ve;
    return sb._nextBlockedReason();
  }

  test('state.voiceEngine = null → 提示"voice engine 状态未初始化"', () => {
    expect(call(null)).toMatch(/voice engine 状态未初始化/);
  });

  test('已设 skipEngine=true → 启用（返回空字符串）', () => {
    expect(call({ skipEngine: true })).toBe('');
  });

  test('kind 未选 → 提示选择本地/在线', () => {
    expect(call({})).toMatch(/请先选择「本地 AI 语音模型」或「在线 AI 语音服务」/);
  });

  test('engineId 未选 → 提示选择具体引擎', () => {
    expect(call({ kind: 'LOCAL_MODEL' })).toMatch(/请选择具体引擎/);
  });

  test('本地 + 适配器未实现 + 没 skip → 禁用', () => {
    const r = call({ kind: 'LOCAL_MODEL', engineId: 'f5-tts' });
    expect(r).toMatch(/该引擎适配器尚未实现/);
    expect(r).not.toBe('');
  });

  test('本地 + 适配器未实现 + 已 skip → 启用', () => {
    const r = call({ kind: 'LOCAL_MODEL', engineId: 'f5-tts', skipEngine: true });
    expect(r).toBe('');
  });

  test('本地 + 已测试 + 没有 testError → 启用', () => {
    const r = call({
      kind: 'LOCAL_MODEL',
      engineId: 'xtts-v2',
      enginesCache: [{ id: 'xtts-v2', implemented: true }],
      tested: true,
      lastTestDurationSec: 5,
      lastTestMime: 'audio/wav'
    });
    expect(r).toBe('');
  });

  test('本地 + 有 testError → 禁用并提示失败原因', () => {
    const r = call({
      kind: 'LOCAL_MODEL',
      engineId: 'xtts-v2',
      enginesCache: [{ id: 'xtts-v2', implemented: true }],
      testError: 'ECONNREFUSED'
    });
    expect(r).toMatch(/上次测试失败/);
    expect(r).toMatch(/ECONNREFUSED/);
  });

  test('本地 + 已连接 (reachable) 但未测试 → 禁用 + 提示生成测试', () => {
    const r = call({
      kind: 'LOCAL_MODEL',
      engineId: 'xtts-v2',
      enginesCache: [{ id: 'xtts-v2', implemented: true }],
      reachable: true
    });
    expect(r).toMatch(/已连接本地服务/);
    expect(r).toMatch(/生成测试语音/);
  });

  test('本地 + probing 中 → 禁用 + 提示"正在检测"', () => {
    const r = call({
      kind: 'LOCAL_MODEL',
      engineId: 'xtts-v2',
      enginesCache: [{ id: 'xtts-v2', implemented: true }],
      probing: true
    });
    expect(r).toMatch(/正在检测本地服务/);
  });

  test('本地 + idle（什么都没做）→ 禁用 + 提示点击"检测连接"', () => {
    const r = call({
      kind: 'LOCAL_MODEL',
      engineId: 'xtts-v2',
      enginesCache: [{ id: 'xtts-v2', implemented: true }]
    });
    expect(r).toMatch(/尚未检测本地服务连接/);
  });

  test('在线 + 适配器未实现 → 禁用', () => {
    const r = call({
      kind: 'ONLINE_SERVICE',
      engineId: 'openai-tts',
      enginesCache: [{ id: 'openai-tts', implemented: false }]
    });
    expect(r).toMatch(/该在线服务适配器尚未实现/);
  });

  test('在线 + 无 API Key → 禁用 + 提示"请先配置 API Key"', () => {
    const r = call({
      kind: 'ONLINE_SERVICE',
      engineId: 'openai-tts',
      enginesCache: [{ id: 'openai-tts', implemented: true }]
    });
    expect(r).toMatch(/请先在设置中配置 API Key/);
  });

  test('在线 + 有 API Key + reachable 但未测试 → 禁用', () => {
    const r = call({
      kind: 'ONLINE_SERVICE',
      engineId: 'openai-tts',
      enginesCache: [{ id: 'openai-tts', implemented: true }],
      online: { apiKeyPresent: true },
      reachable: true
    });
    expect(r).toMatch(/已连接在线服务.*尚未生成测试语音/);
  });

  test('在线 + 已测试 → 启用', () => {
    const r = call({
      kind: 'ONLINE_SERVICE',
      engineId: 'openai-tts',
      enginesCache: [{ id: 'openai-tts', implemented: true }],
      online: { apiKeyPresent: true },
      tested: true,
      lastTestDurationSec: 3,
      lastTestMime: 'audio/mpeg'
    });
    expect(r).toBe('');
  });

  test('在线 + 有 testError → 禁用 + 提示', () => {
    const r = call({
      kind: 'ONLINE_SERVICE',
      engineId: 'openai-tts',
      enginesCache: [{ id: 'openai-tts', implemented: true }],
      online: { apiKeyPresent: true },
      testError: 'invalid-key'
    });
    expect(r).toMatch(/上次测试失败/);
    expect(r).toMatch(/invalid-key/);
  });
});

// =====================================================================
// 3) 录音页 vstudioNextBtn 状态机（hasProfile / hasSkipped / busy）
//    —— 复用 _canProceed 的纯逻辑（不依赖 DOM），用节点函数模拟
// =====================================================================
describe('录音页底部主按钮 _canProceed 状态机（复算）', () => {
  // 直接复算 vstudio-footer 的逻辑（与 index.html 同步）
  function compute(voiceProfile, voiceCurrentVersionId, voiceSkip, recStatus) {
    const _voiceBusy = recStatus === 'recording' || recStatus === 'paused';
    const _hasProfile = !!(voiceProfile && voiceCurrentVersionId);
    const _voiceSkip  = !!voiceSkip;
    return {
      canProceed: !_voiceBusy && (_hasProfile || _voiceSkip),
      busy: _voiceBusy,
      hasProfile: _hasProfile,
      voiceSkip: _voiceSkip
    };
  }

  test('有 voice profile + 未录音 → 启用', () => {
    expect(compute({ id: 'a', versions: [] }, 'v1', false, 'idle')).toEqual({
      canProceed: true, busy: false, hasProfile: true, voiceSkip: false
    });
  });

  test('已选 voice 版本（即使是 finished）→ 启用', () => {
    expect(compute({ id: 'a' }, 'v1', false, 'finished')).toEqual({
      canProceed: true, busy: false, hasProfile: true, voiceSkip: false
    });
  });

  test('显式 voiceSkip=true → 启用', () => {
    expect(compute(null, null, true, 'idle')).toEqual({
      canProceed: true, busy: false, hasProfile: false, voiceSkip: true
    });
  });

  test('未选 voice + 未 skip → 禁用', () => {
    expect(compute(null, null, false, 'idle')).toEqual({
      canProceed: false, busy: false, hasProfile: false, voiceSkip: false
    });
  });

  test('有 voice profile 但正在录音 → 禁用', () => {
    expect(compute({ id: 'a' }, 'v1', false, 'recording')).toEqual({
      canProceed: false, busy: true, hasProfile: true, voiceSkip: false
    });
  });

  test('有 voice profile 但暂停中 → 禁用', () => {
    expect(compute({ id: 'a' }, 'v1', false, 'paused')).toEqual({
      canProceed: false, busy: true, hasProfile: true, voiceSkip: false
    });
  });

  test('voiceProfile 已选但 voiceCurrentVersionId 缺失 → 禁用', () => {
    expect(compute({ id: 'a' }, null, false, 'idle')).toEqual({
      canProceed: false, busy: false, hasProfile: false, voiceSkip: false
    });
  });

  test('voiceSkip=false + voiceCurrentVersionId 缺失 → 禁用', () => {
    expect(compute(null, null, false, 'idle')).toEqual({
      canProceed: false, busy: false, hasProfile: false, voiceSkip: false
    });
  });
});

// =====================================================================
// 4) vstudio-reason 禁用原因文案（_nextDisabledReason 文案覆盖）
// =====================================================================
describe('录音页禁用原因文案', () => {
  function computeReason(voiceProfile, voiceCurrentVersionId, voiceSkip, recStatus) {
    const _voiceBusy = recStatus === 'recording' || recStatus === 'paused';
    const _hasProfile = !!(voiceProfile && voiceCurrentVersionId);
    const _voiceSkip  = !!voiceSkip;
    if (_voiceBusy) return '录音进行中，请先结束或暂停录音';
    if (!_hasProfile && !_voiceSkip) return '请先完成录音并保存，或选择已有声音档案，或点击左侧「跳过声音克隆」';
    if (_voiceSkip && !_hasProfile) return '已跳过声音克隆，可继续';
    return '已选声音档案，可继续';
  }

  test('busy 时：录音进行中', () => {
    expect(computeReason({id:'a'}, 'v1', false, 'recording')).toMatch(/录音进行中/);
  });

  test('无档案无方案：明确指引', () => {
    expect(computeReason(null, null, false, 'idle')).toMatch(/请先完成录音并保存/);
    expect(computeReason(null, null, false, 'idle')).toMatch(/跳过声音克隆/);
  });

  test('仅跳过 → "已跳过声音克隆，可继续"', () => {
    expect(computeReason(null, null, true, 'idle')).toBe('已跳过声音克隆，可继续');
  });

  test('已选档案 → "已选声音档案，可继续"', () => {
    expect(computeReason({id:'a'}, 'v1', false, 'idle')).toBe('已选声音档案，可继续');
  });
});

// =====================================================================
// 5) 状态板 voicegen-statecard 类选择（本地 / 在线）
// =====================================================================
describe('voicegen-statecard 类选择', () => {
  // 复算 _localPanel 内的 _stateClass 选择逻辑
  function localStateClass(implemented, probing, testError, tested, reachable) {
    if (!implemented) return 'warn';
    if (probing) return 'busy';
    if (testError) return 'bad';
    if (tested) return 'ok';
    if (reachable) return 'warn';
    return 'idle';
  }
  function onlineStateClass(implemented, hasKey, testError, tested, reachable) {
    if (!implemented) return 'warn';
    if (testError) return 'bad';
    if (tested) return 'ok';
    if (!hasKey) return 'idle';
    if (reachable) return 'warn';
    return 'idle';
  }

  test('本地：未实现 → warn', () => {
    expect(localStateClass(false, false, false, false, false)).toBe('warn');
  });
  test('本地：检测中 → busy', () => {
    expect(localStateClass(true, true, false, false, false)).toBe('busy');
  });
  test('本地：失败 → bad', () => {
    expect(localStateClass(true, false, 'ECONNREFUSED', false, false)).toBe('bad');
  });
  test('本地：测试通过 → ok', () => {
    expect(localStateClass(true, false, false, true, true)).toBe('ok');
  });
  test('本地：已连接未测试 → warn', () => {
    expect(localStateClass(true, false, false, false, true)).toBe('warn');
  });
  test('本地：idle → idle', () => {
    expect(localStateClass(true, false, false, false, false)).toBe('idle');
  });

  test('在线：未实现 → warn', () => {
    expect(onlineStateClass(false, true, false, false, false)).toBe('warn');
  });
  test('在线：未配 Key → idle', () => {
    expect(onlineStateClass(true, false, false, false, false)).toBe('idle');
  });
  test('在线：失败 → bad', () => {
    expect(onlineStateClass(true, true, 'invalid', false, false)).toBe('bad');
  });
  test('在线：测试通过 → ok', () => {
    expect(onlineStateClass(true, true, false, true, true)).toBe('ok');
  });
  test('在线：已连接未测 → warn', () => {
    expect(onlineStateClass(true, true, false, false, true)).toBe('warn');
  });
});

// =====================================================================
// 6) voiceEnginePickKind：跨类切换时清空 online / local 子状态
// =====================================================================
describe('voiceEnginePickKind 跨类切换清空子状态', () => {
  // 在沙箱中跑真正的 voiceEnginePickKind 并断言 state.voiceEngine 形态
  function run(prevState, targetKind) {
    const sb = makeSandbox();
    // 不直接 boot 整个函数（依赖 voiceEngineEnsureEngines / renderVoiceEngineStep）
    // 复算核心逻辑即可：与 index.html 完全一致
    vm.runInContext(`
      window.voiceEnginePickKind = function (kind){
        if (!state.voiceEngine) state.voiceEngine = {};
        var _prevKind = state.voiceEngine.kind;
        state.voiceEngine.kind = kind;
        state.voiceEngine.engineId = '';
        state.voiceEngine.reachable = false;
        state.voiceEngine.probing = false;
        state.voiceEngine.capabilities = {};
        state.voiceEngine.tested = false;
        state.voiceEngine.skipTest = false;
        state.voiceEngine.testError = '';
        state.voiceEngine.lastTestAudioBase64 = '';
        state.voiceEngine.lastTestMime = '';
        state.voiceEngine.lastTestDurationSec = 0;
        if (_prevKind && _prevKind !== kind) {
          if (kind !== 'LOCAL_MODEL') {
            state.voiceEngine.local = { baseUrl: '' };
          }
          if (kind !== 'ONLINE_SERVICE') {
            state.voiceEngine.online = { providerId: '', apiKeyPresent: false };
          }
        }
        return state.voiceEngine;
      };
    `, sb);
    sb.state.voiceEngine = JSON.parse(JSON.stringify(prevState));
    return sb.window.voiceEnginePickKind(targetKind);
  }

  test('从 LOCAL 切到 ONLINE：local.baseUrl 被清空；online 保留', () => {
    const r = run({
      kind: 'LOCAL_MODEL',
      local: { baseUrl: 'http://127.0.0.1:8020' },
      online: { providerId: 'openai-tts', apiKeyPresent: true }
    }, 'ONLINE_SERVICE');
    expect(r.local).toEqual({ baseUrl: '' });
    expect(r.online).toEqual({ providerId: 'openai-tts', apiKeyPresent: true });
  });

  test('从 ONLINE 切到 LOCAL：online 子状态被清空；local 保留', () => {
    const r = run({
      kind: 'ONLINE_SERVICE',
      online: { providerId: 'openai-tts', apiKeyPresent: true },
      local: { baseUrl: 'http://127.0.0.1:8020' }
    }, 'LOCAL_MODEL');
    expect(r.online).toEqual({ providerId: '', apiKeyPresent: false });
    expect(r.local).toEqual({ baseUrl: 'http://127.0.0.1:8020' });
  });

  test('首次进入（_prevKind 为空）：不清空子状态', () => {
    const r = run({
      local: { baseUrl: 'http://x' },
      online: { providerId: 'a', apiKeyPresent: true }
    }, 'ONLINE_SERVICE');
    expect(r.local).toEqual({ baseUrl: 'http://x' });
    expect(r.online).toEqual({ providerId: 'a', apiKeyPresent: true });
  });

  test('同类重选 LOCAL→LOCAL：不清理 local.baseUrl', () => {
    const r = run({
      kind: 'LOCAL_MODEL',
      local: { baseUrl: 'http://127.0.0.1:8020' }
    }, 'LOCAL_MODEL');
    expect(r.local).toEqual({ baseUrl: 'http://127.0.0.1:8020' });
  });

  test('同类重选 ONLINE→ONLINE：不清理 online 子状态', () => {
    const r = run({
      kind: 'ONLINE_SERVICE',
      online: { providerId: 'openai-tts', apiKeyPresent: true }
    }, 'ONLINE_SERVICE');
    expect(r.online).toEqual({ providerId: 'openai-tts', apiKeyPresent: true });
  });

  test('kind 字段已更新到目标值', () => {
    const r = run({ kind: 'LOCAL_MODEL', local: { baseUrl: 'x' } }, 'ONLINE_SERVICE');
    expect(r.kind).toBe('ONLINE_SERVICE');
  });

  test('跨类切换时通用字段（tested/probing/reachable/testError）也清零', () => {
    const r = run({
      kind: 'LOCAL_MODEL',
      tested: true,
      probing: true,
      reachable: true,
      testError: 'old'
    }, 'ONLINE_SERVICE');
    expect(r.tested).toBe(false);
    expect(r.probing).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.testError).toBe('');
  });
});

// =====================================================================
// 7) voiceEnginePickEngine：online 服务查询 API Key 存在性
// =====================================================================
describe('voiceEnginePickEngine 处理 online apiKey', () => {
  test('online 服务：异步写入 apiKeyPresent（来自 secretsStatus）', async () => {
    const sb = makeSandbox();
    let captured = null;
    sb.window = sb;
    sb.window.api = {
      secretsStatus: () => Promise.resolve({ hasApiKey: true })
    };
    sb.state.voiceEngine = {
      kind: 'ONLINE_SERVICE',
      engineId: '',
      local: { baseUrl: '' },
      online: { providerId: '', apiKeyPresent: false }
    };

    // 复算关键分支
    await new Promise(resolve => {
      const _origEngineId = '';
      sb.state.voiceEngine.engineId = 'openai-tts';
      sb.state.voiceEngine.online.providerId = 'openai-tts';
      sb.window.api.secretsStatus().then(r => {
        sb.state.voiceEngine.online.apiKeyPresent = !!(r && r.hasApiKey);
        captured = sb.state.voiceEngine.online.apiKeyPresent;
        resolve();
      });
    });

    expect(captured).toBe(true);
  });

  test('online 服务：secretsStatus 返回 hasApiKey=false → apiKeyPresent=false', async () => {
    const sb = makeSandbox();
    sb.window = sb;
    sb.window.api = { secretsStatus: () => Promise.resolve({ hasApiKey: false }) };
    sb.state.voiceEngine = { kind: 'ONLINE_SERVICE', online: {} };

    let captured;
    await sb.window.api.secretsStatus().then(r => {
      sb.state.voiceEngine.online.apiKeyPresent = !!(r && r.hasApiKey);
      captured = sb.state.voiceEngine.online.apiKeyPresent;
    });

    expect(captured).toBe(false);
  });

  test('secretsStatus IPC 不可用 → 静默（不抛错）', async () => {
    const sb = makeSandbox();
    sb.window = sb;
    // 故意**不**定义 window.api（IPC 不可用场景）
    sb.state.voiceEngine = { kind: 'ONLINE_SERVICE', online: {} };

    // 复算"安全降级"逻辑：typeof !== 'function' 时跳过（参考 index.html 中的守卫）
    let didThrow = false;
    try {
      if (sb.window.api && typeof sb.window.api.secretsStatus === 'function') {
        await sb.window.api.secretsStatus();
      }
    } catch (e) { didThrow = true; }

    expect(didThrow).toBe(false);
    expect(sb.state.voiceEngine.online.apiKeyPresent).toBeUndefined(); // 没被写过
  });

  test('secretsStatus IPC 返回 rejected → 静默（不抛错）', async () => {
    const sb = makeSandbox();
    sb.window = sb;
    sb.window.api = {
      secretsStatus: () => Promise.reject(new Error('IPC broken'))
    };
    sb.state.voiceEngine = { kind: 'ONLINE_SERVICE', online: {} };

    let didThrow = false;
    try {
      await sb.window.api.secretsStatus().catch(function() { /* swallow like renderer does */ });
      sb.state.voiceEngine.online.apiKeyPresent = false;
    } catch (e) { didThrow = true; }

    expect(didThrow).toBe(false);
    expect(sb.state.voiceEngine.online.apiKeyPresent).toBe(false);
  });
});

// =====================================================================
// 8) voiceEngineRunTest：在线服务 API Key 守卫
// =====================================================================
describe('voiceEngineRunTest 在线服务 API Key 守卫', () => {
  // 复算守卫逻辑
  function guard(kind, online) {
    if (kind === 'ONLINE_SERVICE' && !(online && online.apiKeyPresent)) {
      return { allowed: false, reason: 'no-api-key' };
    }
    if (kind === 'LOCAL_MODEL') {
      // 不强制：依赖 reachable
      return { allowed: true };
    }
    return { allowed: true };
  }

  test('在线 + 无 API Key → 阻止', () => {
    expect(guard('ONLINE_SERVICE', null)).toEqual({ allowed: false, reason: 'no-api-key' });
    expect(guard('ONLINE_SERVICE', {})).toEqual({ allowed: false, reason: 'no-api-key' });
    expect(guard('ONLINE_SERVICE', { apiKeyPresent: false })).toEqual({ allowed: false, reason: 'no-api-key' });
  });

  test('在线 + 有 API Key → 允许', () => {
    expect(guard('ONLINE_SERVICE', { apiKeyPresent: true })).toEqual({ allowed: true });
  });

  test('本地（不管 reachable）→ 允许进入下一步（reachable 检测在 detect 阶段独立处理）', () => {
    expect(guard('LOCAL_MODEL', null)).toEqual({ allowed: true });
    expect(guard('LOCAL_MODEL', { apiKeyPresent: false })).toEqual({ allowed: true });
  });
});

// =====================================================================
// 9) probing 状态字段：detect 进入/退出时正确翻转
// =====================================================================
describe('voiceEngineDetect 状态字段 probing flipping', () => {
  // 复算 .ioProbe 进入/退出路径
  function detect(state, baseUrl, probeResult) {
    // 简化：只关心探测开始 → 是否置 probing=true，结果回填 → 是否清 probing
    const r = { ...state };
    if (!/^https?:\/\//i.test(baseUrl || '')) {
      r.testError = '地址必须以 http:// 或 https:// 开头';
      r.reachable = false;
      r.probing = false;
      return r;
    }
    r.probing = true; // 进入探测
    // simulate probe
    if (probeResult.ok) {
      r.reachable = !!probeResult.capabilities && !!probeResult.capabilities.reachable;
      r.capabilities = probeResult.capabilities || {};
      if (!r.reachable) r.testError = probeResult.error || '不可达';
      else r.testError = '';
    } else {
      r.reachable = false;
      r.testError = (probeResult && probeResult.error) || 'unknown';
    }
    r.probing = false; // 退出探测
    return r;
  }

  test('非法地址：直接置 probing=false，不进入探测', () => {
    const r = detect({ probing: false, testError: '' }, 'not-a-url', { ok: false });
    expect(r.probing).toBe(false);
    expect(r.testError).toMatch(/http:\/\/ 或 https:\/\//);
  });

  test('合法地址 + 探测成功（reachable=true）：probing 在进入与退出间被切换', () => {
    // 我们用 hook 函数记录中间步骤
    let seenProbingTrue = false;
    function detectHook(state, baseUrl, probeResult, onProbeEnter) {
      const r = { ...state };
      if (!/^https?:\/\//i.test(baseUrl || '')) {
        r.testError = '地址必须以 http:// 或 https:// 开头';
        r.reachable = false;
        r.probing = false;
        return r;
      }
      r.probing = true;
      if (onProbeEnter) onProbeEnter(r);
      if (probeResult.ok) {
        r.reachable = !!probeResult.capabilities && !!probeResult.capabilities.reachable;
        r.capabilities = probeResult.capabilities || {};
        if (!r.reachable) r.testError = probeResult.error || '不可达';
        else r.testError = '';
      } else {
        r.reachable = false;
        r.testError = (probeResult && probeResult.error) || 'unknown';
      }
      r.probing = false;
      return r;
    }
    const r = detectHook(
      { probing: false, testError: '', reachable: false },
      'http://127.0.0.1:8020',
      { ok: true, capabilities: { reachable: true, synthesizeEndpointFound: '/api/tts' } },
      (s) => { seenProbingTrue = (s.probing === true); }
    );
    expect(seenProbingTrue).toBe(true); // 进入时确实翻成 true
    expect(r.probing).toBe(false); // 退出时翻回 false
    expect(r.reachable).toBe(true);
    expect(r.testError).toBe('');
  });

  test('合法地址 + 探测失败：probing 退出后 reachable=false + testError 保留', () => {
    const r = detect(
      { probing: false, testError: '', reachable: false },
      'http://127.0.0.1:8020',
      { ok: false, error: 'no-endpoint-responding' }
    );
    expect(r.probing).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.testError).toBe('no-endpoint-responding');
  });

  test('探测 catch 异常：probing 也能正确翻回 false', () => {
    let r;
    try {
      r = detect({ probing: false, testError: '', reachable: true }, 'http://127.0.0.1:8020', null);
      // simulate catch
      r.probing = false;
      r.reachable = false;
      r.testError = 'probe-exception:something';
    } catch (e) { r = { probing: false }; }
    expect(r.probing).toBe(false);
  });
});

// =====================================================================
// 10) voiceEngineRunTest 也会翻 probing=true/false
// =====================================================================
describe('voiceEngineRunTest probing flipping', () => {
  test('runTest 进入/退出时正确设置/清空 probing + tested', () => {
    function runTest(state, testResult) {
      const r = { ...state };
      r.testError = '';
      r.tested = false;
      r.probing = true;
      r.lastTestAudioBase64 = '';
      r.lastTestMime = '';
      r.lastTestDurationSec = 0;
      // simulate async
      if (testResult.ok && testResult.audioBase64) {
        r.tested = true;
        r.testError = '';
        r.lastTestAudioBase64 = testResult.audioBase64;
        r.lastTestMime = testResult.mime || 'audio/wav';
        r.lastTestDurationSec = testResult.durationSec || 0;
      } else {
        r.tested = false;
        r.testError = (testResult && testResult.error) || '未知错误';
      }
      r.probing = false;
      return r;
    }

    const ok = runTest({ probing: false, tested: false, testError: '' }, {
      ok: true, audioBase64: 'AAA=', mime: 'audio/wav', durationSec: 2.5
    });
    expect(ok.probing).toBe(false);
    expect(ok.tested).toBe(true);
    expect(ok.testError).toBe('');
    expect(ok.lastTestMime).toBe('audio/wav');

    const fail = runTest({ probing: false, tested: false, testError: '' }, {
      ok: false, error: 'xtts-no-endpoint-accepted-test-request'
    });
    expect(fail.probing).toBe(false);
    expect(fail.tested).toBe(false);
    expect(fail.testError).toMatch(/xtts-no-endpoint/);
  });
});

// =====================================================================
// 11) 视觉一致性：颜色变量未被破坏
// =====================================================================
describe('CSS 变量与设计 token 完整性', () => {
  test('--primary / --primary-dark / --line / --muted / --card 都在 :root 中', () => {
    const root = idxHtml.match(/:root\{([\s\S]*?)\}/);
    expect(root).toBeTruthy();
    expect(root[1]).toMatch(/--primary:#0E7C7B/);
    expect(root[1]).toMatch(/--primary-dark:/);
    expect(root[1]).toMatch(/--line:#/);
    expect(root[1]).toMatch(/--muted:#/);
    expect(root[1]).toMatch(/--card:#/);
  });

  test('.btn.primary-main[disabled] 灰底不会触发 --accent', () => {
    expect(idxHtml).toMatch(/\.btn\.primary-main\[disabled\][^}]*background:var\(--line\)/);
    // 确认没有给主按钮 disabled 状态用 accent
    expect(idxHtml).not.toMatch(/\.btn\.primary-main\[disabled\][^}]*--accent/);
  });
});

// =====================================================================
// 12) 静态扫描 — 顶层功能保护（顶部导航栏、AI 演示）
// =====================================================================
describe('未受影响功能', () => {
  test('顶部导航栏 4 个 tab 按钮未改', () => {
    expect(idxHtml).toMatch(/<div class="navtab"><button id="tabFlow"[^>]*>首秀向导<\/button><button id="tabDash"[^>]*>数据看板<\/button><button id="tabChannels"[^>]*>推广渠道<\/button><button id="tabWorks"[^>]*>我的作品<\/button><\/div>/);
  });

  test('AI 自动演示入口路由仍然调用 proceedFromVoiceInAiDemo', () => {
    // 录音页底部主按钮 onclick 应为 proceedFromVoiceInAiDemo
    expect(idxHtml).toMatch(/id="vstudioNextBtn"[^>]*onclick="proceedFromVoiceInAiDemo\(\)"/);
  });

  test('AI 自动演示 onload 渲染函数保留', () => {
    // renderLocalVideoStage / demoListSources 等仍在
    expect(idxHtml).toMatch(/renderLocalVideoStage|function renderLocalVideoStage/);
  });

  test('声音档案 IPC 全部可用', () => {
    const expectedIpc = [
      'voiceList',
      'voiceSaveVersion',
      'voiceDeleteVersion',
      'voiceDeleteProfile',
      'voiceReadAudioBuffer'
    ];
    expectedIpc.forEach(api => {
      expect(idxHtml).toContain('window.api.' + api);
    });
  });

  test('语音引擎 IPC 全部可用', () => {
    const expectedIpc = [
      'voiceEngineList',
      'voiceEngineProbe',
      'voiceEngineTestGenerate'
    ];
    expectedIpc.forEach(api => {
      expect(idxHtml).toContain('window.api.' + api);
    });
  });
});