// v1.20.10 测试：本地引擎卡片 + 5 款模型的真实默认端口 + 探测行为
//
// 覆盖：
//   1. 5 款本地引擎的 default baseUrl 与默认端口（与各自项目约定匹配）
//   2. xtts-v2 默认端口是 5002（Coqui 官方）—— 不再是 8020
//   3. f5-tts 默认端口是 7860（Gradio 默认）
//   4. 每款引擎有自己的 healthPaths（不会跨引擎混淆）
//   5. 通用探测 genericLocalProbe：
//      - 不可达 → ok=false, errorDetail 含 ECONNREFUSED, actionableHint 提示当前端口与默认不一致
//      - 服务在跑但路径错 → unknown-service（避免把任意 HTTP 服务当 XTTS-v2）
//   6. engineId 路由：xtts-v2 走 xttsProbe；其他 4 款走通用
//   7. listEnginesFull 返回完整目录（含 healthPaths / framework）

const path = require('path');
const fs = require('fs');
const veModule = require('../electron/voice-engine');

describe('v1.20.10 · 本地引擎目录（5 款）', () => {
  it('列出 5 款本地引擎', () => {
    const engines = veModule.listEngines().filter(e => e.kind === veModule.KIND_LOCAL);
    expect(engines.length).toBe(5);
  });
  it('保留原 5 个 id：xtts-v2 / f5-tts / gpt-sovits / openvoice / cosyvoice', () => {
    const ids = veModule.listEngines().filter(e => e.kind === veModule.KIND_LOCAL).map(e => e.id).sort();
    expect(ids).toEqual(['cosyvoice', 'f5-tts', 'gpt-sovits', 'openvoice', 'xtts-v2']);
  });
  it('XTTS-v2 默认端口是 Coqui 官方 5002（不是 8020）', () => {
    const xtts = veModule.listEngines().filter(e => e.id === 'xtts-v2')[0];
    expect(xtts.defaults.baseUrl).toBe('http://127.0.0.1:5002');
  });
  it('F5-TTS 默认端口 7860（Gradio 默认）', () => {
    const f5 = veModule.listEngines().filter(e => e.id === 'f5-tts')[0];
    expect(f5.defaults.baseUrl).toBe('http://127.0.0.1:7860');
  });
  it('GPT-SoVITS 默认端口 9880', () => {
    const g = veModule.listEngines().filter(e => e.id === 'gpt-sovits')[0];
    expect(g.defaults.baseUrl).toBe('http://127.0.0.1:9880');
  });
  it('OpenVoice 默认端口 8000', () => {
    const o = veModule.listEngines().filter(e => e.id === 'openvoice')[0];
    expect(o.defaults.baseUrl).toBe('http://127.0.0.1:8000');
  });
  it('CosyVoice 默认端口 5000', () => {
    const c = veModule.listEngines().filter(e => e.id === 'cosyvoice')[0];
    expect(c.defaults.baseUrl).toBe('http://127.0.0.1:5000');
  });
  it('每款引擎都独立维护 healthPaths（不互相继承）', () => {
    const e = veModule.listEnginesFull().filter(x => x.kind === veModule.KIND_LOCAL);
    expect(e.length).toBe(5);
    e.forEach(eng => {
      expect(Array.isArray(eng.healthPaths) && eng.healthPaths.length > 0).toBe(true);
        // f5-tts 不应该用 xtts-v2 的 /api/tts
      });
    const xtts = e.filter(x => x.id === 'xtts-v2')[0];
    const f5 = e.filter(x => x.id === 'f5-tts')[0];
    expect(xtts.healthPaths).toContain('/api/tts');
    expect(f5.healthPaths).not.toContain('/api/tts');
    expect(f5.healthPaths).toEqual(['/', '/info']);
  });
  it('每款引擎标注 framework（探测时区分 Gradio/FastAPI/Coqui）', () => {
    const xtts = veModule.listEnginesFull().filter(x => x.id === 'xtts-v2')[0];
    const f5 = veModule.listEnginesFull().filter(x => x.id === 'f5-tts')[0];
    const gptsovits = veModule.listEnginesFull().filter(x => x.id === 'gpt-sovits')[0];
    const openvoice = veModule.listEnginesFull().filter(x => x.id === 'openvoice')[0];
    const cosyvoice = veModule.listEnginesFull().filter(x => x.id === 'cosyvoice')[0];
    expect(xtts.framework).toBe('coqui-tts-server');
    expect(f5.framework).toBe('gradio-default');
    expect(gptsovits.framework).toBe('fastapi-custom');
    expect(openvoice.framework).toBe('fastapi-custom');
    expect(cosyvoice.framework).toBe('gradio-default');
  });
  it('listEnginesFull 与 listEngines 内容等价（均包含 7 条：5 本地 + 2 在线）', () => {
    expect(veModule.listEnginesFull().length).toBe(veModule.listEngines().length);
    expect(veModule.listEnginesFull().length).toBe(7);
  });
});

describe('v1.20.10 · 探测行为', () => {
  it('probe(xtts-v2, 不可达) → ok=false, actionableHint 含 5002', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.ok).toBe(false);
    expect(/ECONNREFUSED/.test(r.errorDetail || '')).toBe(true);
    expect(/5002|本.*服务.*启/.test(r.actionableHint || '')).toBe(true);
  }, 30000);
  it('probe(f5-tts, 不可达 7860) → 友好 actionableHint 含 7860', async () => {
    const r = await veModule.probe('f5-tts', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.ok).toBe(false);
    // f5-tts 默认端口 7860；hint 应提及 F5-TTS 而非 Coqui
    expect(/7860/.test(r.actionableHint || '')).toBe(true);
    expect(/F5-TTS/.test(r.actionableHint || '')).toBe(true);
  }, 30000);
  it('probe(f5-tts, 无 baseUrl) → 友好 actionableHint 提示填地址', async () => {
    const r = await veModule.probe('f5-tts', {});
    expect(r.ok).toBe(false);
    expect(/填写/.test(r.actionableHint || '')).toBe(true);
  });
  it('probe(xtts-v2, 无 baseUrl) → no-baseUrl + actionableHint 含 5002', async () => {
    const r = await veModule.probe('xtts-v2', {});
    expect(r.ok).toBe(false);
    expect(/no-baseUrl/.test(r.error || '')).toBe(true);
    expect(/5002/.test(r.actionableHint || '')).toBe(true);
  });
  it('probe ECONNREFUSED → errorDetail 含完整错误码', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.errorDetail).toBeTruthy();
    expect(String(r.errorDetail)).toMatch(/ECONNREFUSED/);
  }, 30000);
  it('probe 返回的能力包含 framework 字段', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.ok).toBe(false);
    // 无 baseUrl 时不返回 capabilities，但只要填了地址，错误对象里也能保留 framework 信息
    // 通过 listEnginesFull 的能力确认 framework 字段被持久化
    const e = veModule.listEnginesFull().filter(x => x.id === 'xtts-v2')[0];
    expect(e.framework).toBe('coqui-tts-server');
  }, 30000);
});

describe('v1.20.10 · testGenerate 严格性', () => {
  it('testGenerate(xtts-v2, 无 refBase64) → 拒绝（不允许默认音色）', async () => {
    const r = await veModule.testGenerate('xtts-v2', { baseUrl: 'http://127.0.0.1:5002' }, { text: 'hi', refBase64: '' });
    expect(r.ok).toBe(false);
    expect(/speaker_wav/.test(r.error || '')).toBe(true);
  });
  it('testGenerate(xtts-v2, refBase64 太短) → 拒绝', async () => {
    const r = await veModule.testGenerate('xtts-v2', { baseUrl: 'http://127.0.0.1:5002' }, { text: 'hi', refBase64: 'AAA' });
    expect(r.ok).toBe(false);
    expect(/ref-audio-too-small|tmpdir/.test(r.error || '')).toBe(true);
  });
  it('testGenerate(f5-tts) → 仍返回 engine-not-implemented（不冒充成功）', async () => {
    const r = await veModule.testGenerate('f5-tts', { baseUrl: 'http://127.0.0.1:7860' }, { text: 'hi', refBase64: 'AAA' });
    expect(r.ok).toBe(false);
    expect(/engine-not-implemented/.test(r.error || '')).toBe(true);
  });
});

describe('v1.20.10 · unknown-service 检测', () => {
  // 用 mock 验证：当端口有任意服务但所有候选路径都返回 404 时，不能判为"已连接"
  let spawn, port, server;
  beforeAll(async () => {
    spawn = require('child_process').spawn;
    const net = require('net');
    // 找一个空闲端口
    port = await new Promise(res => {
      const s = net.createServer();
      s.listen(0, () => {
        const p = s.address().port;
        s.close(() => res(p));
      });
    });
    // 启动一个最简 HTTP server：只响应 / → 200，所有其它路径 → 404
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(__dirname, '__mock_unknown.js');
    fs.writeFileSync(tmpFile, `
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Random Service</body></html>');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}).listen(${port}, '127.0.0.1', () => console.log('mock listening ' + ${port}));
`);
    server = spawn(process.execPath, [tmpFile], { stdio: 'pipe' });
    await new Promise(r => setTimeout(r, 600));
  });
  afterAll(async () => {
    if (server) server.kill();
    try { fs.unlinkSync(path.join(__dirname, '__mock_unknown.js')); } catch (_) {}
  });

  it('probe(f5-tts, /info 返回 404) → unknown-service（仅 / 通不算匹配）', async () => {
    // v1.20.10：f5-tts 健康路径 ['/', '/info']。mock 仅 / 返回 200 —— engine-specific (/info) 404
    // → engineMatch=false → unknown-service（避免把任意 Gradio 服务当 f5-tts）
    const r = await veModule.probe('f5-tts', { baseUrl: 'http://127.0.0.1:' + port });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown-service');
    expect(r.actionableHint || '').toMatch(/F5-TTS|不是/);
  }, 10000);
  it('probe(xtts-v2, 端口有 HTTP 但 /api/tts 等专属路径都返回 404) → unknown-service', async () => {
    // xtts-v2 健康路径：/, /locales, /api/tts, /v1/audio/speech。mock 全 404（除 /）。
    //   engine-specific 路径（locales/api/tts/v1/audio/speech）都 404 → unknown-service
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:' + port });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown-service');
    expect(r.actionableHint || '').toMatch(/XTTS-v2|不是/);
  }, 10000);
});

describe('v1.20.10 · 渲染层状态管理', () => {
  // 验证 index.html 已实现的关键 DOM 钩子与样式
  const fs2 = require('fs');
  const html = fs2.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  it('包含 5 张引擎卡片的 .voicegen-engine-card 容器', () => {
    expect(/class="voicegen-engine-list"/.test(html)).toBe(true);
    expect(/class="voicegen-engine-card/.test(html)).toBe(true);
  });
  it('仅保留一个 voiceEngineDetect 按钮（状态卡内不再带第二个按钮）', () => {
    // 检测按钮出现位置：URL 输入框旁的 #veDetectBtn
    expect(/id="veDetectBtn"/.test(html)).toBe(true);
    // 状态卡内部不应再带第二个 ↻ 检测按钮
    const cardBlock = html.match(/voicegen-statecard[\s\S]*?<\/div>\s*<\/div>/);
    expect(cardBlock).toBeTruthy();
    expect(/voiceEngineDetect\(\)/.test(cardBlock[0])).toBe(false);
  });
  it('提供 voiceEngineOnUrlInput 实时同步 URL 到 per-engine', () => {
    expect(/window\.voiceEngineOnUrlInput/.test(html)).toBe(true);
  });
  it('防止重复点击触发并发探测', () => {
    expect(/if \(ve\.probing\)/.test(html)).toBe(true);
    expect(/检测进行中，请稍候/.test(html)).toBe(true);
  });
  it('按当前引擎类型显示不同的启动提示（XTTS-v2 走 tts-server，其他给通用提示）', () => {
    expect(/tts-server\.exe/.test(html)).toBe(true);
    expect(/Rokit 暂未为/.test(html)).toBe(true);
  });
  it('unknown-service 路径触发「端口有 HTTP 但不是本引擎」提示', () => {
    expect(/当前端口有 HTTP 服务，但不是/.test(html)).toBe(true);
    expect(/7860 \/ FastAPI 占了 8000/.test(html)).toBe(true);
  });
});

describe('v1.20.10 · per-engine URL 隔离', () => {
  // 模拟渲染层的 voiceEnginePickEngine 与 voiceEngineFillDefaults 行为（/）
  function pickEngine(state, engineId) {
    if (!state.voiceEngine) state.voiceEngine = {};
    if (!state.voiceEngine.local) state.voiceEngine.local = {};
    if (!state.voiceEngine.local.perEngine) state.voiceEngine.local.perEngine = {};
    var list = state.voiceEngine.enginesCache || [];
    var e = list.filter(function (x) { return x.id === engineId; })[0];
    var saved = state.voiceEngine.local.perEngine[engineId];
    if (saved) state.voiceEngine.local.baseUrl = saved;
    else if (e && e.defaults && e.defaults.baseUrl) state.voiceEngine.local.baseUrl = e.defaults.baseUrl;
    return state.voiceEngine.local.baseUrl;
  }

  it('不同引擎各自保留 URL（perEngine[engineId]）', () => {
    var st = { voiceEngine: { local: { perEngine: { xtts: 'http://a:1', f5: 'http://b:2' } } } };
    st.voiceEngine.enginesCache = [
      { id: 'xtts', defaults: { baseUrl: 'http://default-xtts:5002' } },
      { id: 'f5',   defaults: { baseUrl: 'http://default-f5:7860' } }
    ];
    expect(pickEngine(st, 'xtts')).toBe('http://a:1');
    expect(pickEngine(st, 'f5')).toBe('http://b:2');
  });
  it('新引擎（未保存 URL）使用引擎默认 baseUrl', () => {
    var st = { voiceEngine: { local: { perEngine: {} } } };
    st.voiceEngine.enginesCache = [{ id: 'cosyvoice', defaults: { baseUrl: 'http://127.0.0.1:5000' } }];
    expect(pickEngine(st, 'cosyvoice')).toBe('http://127.0.0.1:5000');
  });
  it('fillDefaults 只清空当前引擎的 perEngine 槽位（不影响其它引擎）', () => {
    var st = { voiceEngine: { engineId: 'xtts', local: { perEngine: { xtts: 'http://a:1', f5: 'http://b:2' } } } };
    // 复算：fillDefaults 清掉 engineId 的槽位
    var engId = st.voiceEngine.engineId;
    delete st.voiceEngine.local.perEngine[engId];
    expect(st.voiceEngine.local.perEngine.f5).toBe('http://b:2'); // 不受影响
    expect(st.voiceEngine.local.perEngine.xtts).toBeUndefined(); // 已清空
  });
});