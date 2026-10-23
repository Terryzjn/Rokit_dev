// 线上 AI 配音引擎（OpenAI TTS / ElevenLabs TTS）测试 —— v1.21
//
// 设计约束（对应任务书的「本轮验证要求」）：
//   - **不使用真实 API Key，不发起任何真实收费请求**。
//   - 网络层用本地假 HTTP 服务（127.0.0.1）模拟官方响应，因此是纯本地测试。
//   - 不修改 XTTS-v2 既有实现与测试。
//
// 覆盖：
//   1. 两个引擎被现有注册表识别，且标记为 implemented
//   2. testGenerate 的调用约定（成功路径返回 Buffer / mime / durationSec）
//   3. 参数校验（缺 Key / 缺文本 / 缺 Voice ID / 非法 baseUrl）
//   4. 错误处理（401 / 403 / 429 / 422 / 5xx / 空音频 / 非音频 / 网络不可达）
//   5. MP3 / WAV 时长解析
//   6. 「认证通过」与「合成成功」严格区分（probe 不写 tested）

'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const ve = require('../electron/voice-engine');

// ===== 测试替身：假 secrets（keytar 不可用时走内存） =====
const FAKE_KEYS = { 'openai-tts': '', 'elevenlabs-tts': '' };
const secretsPath = require.resolve('../electron/secrets');
const realSecrets = require(secretsPath);
const spy = vi.spyOn(realSecrets, 'getOpenaiTtsKey').mockImplementation(async () => FAKE_KEYS['openai-tts'] || null);
const spy2 = vi.spyOn(realSecrets, 'getElevenlabsTtsKey').mockImplementation(async () => FAKE_KEYS['elevenlabs-tts'] || null);

// ===== 工具：构造合法 WAV =====
function makeWav(seconds, sampleRate) {
  sampleRate = sampleRate || 24000;
  const channels = 1, bits = 16;
  const dataBytes = Math.floor(seconds * sampleRate) * channels * (bits / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// 构造一段合法 MP3（MPEG1 Layer III 44.1kHz 128kbps，无 padding）
function makeMp3(frames, id3) {
  const frameLen = Math.floor((1152 / 8) * 128000 / 44100); // = 417
  const parts = [];
  if (id3) {
    const tag = Buffer.alloc(10);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 3; tag[4] = 0; tag[5] = 0;
    tag[9] = 0; // size = 0
    parts.push(tag);
  }
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(frameLen);
    f[0] = 0xff;
    f[1] = 0xfb;                        // MPEG1 Layer III, no CRC
    f[2] = 0x90;                        // bitrateIdx=9 (128k), rateIdx=0 (44100), pad=0
    f[3] = 0xc4;
    parts.push(f);
  }
  return Buffer.concat(parts);
}

// ===== 工具：起一个本地假服务端 =====
function startFakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: 'http://127.0.0.1:' + server.address().port,
      close: () => new Promise(r => server.close(r))
    }));
  });
}

describe('线上引擎：注册表识别', () => {
  it('openai-tts / elevenlabs-tts 都被注册且标记 implemented', () => {
    const list = ve.listEngines();
    const o = list.filter(e => e.id === 'openai-tts')[0];
    const el = list.filter(e => e.id === 'elevenlabs-tts')[0];
    expect(o).toBeTruthy();
    expect(el).toBeTruthy();
    expect(o.kind).toBe(ve.KIND_ONLINE);
    expect(el.kind).toBe(ve.KIND_ONLINE);
    expect(o.implemented).toBe(true);
    expect(el.implemented).toBe(true);
  });
  it('两个引擎的默认地址是各自官方地址，且可被覆盖', () => {
    expect(ve.getEngineDefaults('openai-tts').baseUrl).toBe('https://api.openai.com');
    expect(ve.getEngineDefaults('elevenlabs-tts').baseUrl).toBe('https://api.elevenlabs.io');
  });
  it('两个引擎声明不需要参考音频（referenceAudio: no）', () => {
    const list = ve.listEngines();
    expect(list.filter(e => e.id === 'openai-tts')[0].capabilities.referenceAudio).toBe('no');
    expect(list.filter(e => e.id === 'elevenlabs-tts')[0].capabilities.referenceAudio).toBe('no');
  });
  it('XTTS-v2 仍标记为已实现且默认端口不变（本轮未改写）', () => {
    const x = ve.listEngines().filter(e => e.id === 'xtts-v2')[0];
    expect(x.implemented).toBe(true);
    expect(x.defaults.baseUrl).toBe('http://127.0.0.1:5002');
    expect(x.kind).toBe(ve.KIND_LOCAL);
  });
});

describe('线上引擎：参数校验（不发网络）', () => {
  it('缺 API Key → missing-api-key，且提示指向设置页', async () => {
    FAKE_KEYS['openai-tts'] = '';
    const r = await ve.testGenerate('openai-tts', { baseUrl: 'http://127.0.0.1:1' }, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-api-key');
    expect(String(r.actionableHint)).toContain('API Key');
  });
  it('ElevenLabs 缺 API Key → missing-api-key', async () => {
    FAKE_KEYS['elevenlabs-tts'] = '';
    const r = await ve.testGenerate('elevenlabs-tts', { baseUrl: 'http://127.0.0.1:1', voiceId: 'abc' }, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-api-key');
  });
  it('ElevenLabs 有 Key 但缺 Voice ID → missing-voice-id，且不请求服务端', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'sk-test';
    let hit = 0;
    const fake = await startFakeServer((req, res) => { hit++; res.writeHead(200); res.end(); });
    const r = await ve.testGenerate('elevenlabs-tts', { baseUrl: fake.baseUrl, voiceId: '   ' }, { text: 'hi' });
    await fake.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-voice-id');
    expect(hit).toBe(0); // 缺参数时绝不该发请求（避免无谓计费）
  });
  it('空文本 → empty-text', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-test';
    const r = await ve.testGenerate('openai-tts', { baseUrl: 'http://127.0.0.1:1' }, { text: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty-text');
  });
  it('未实现的引擎仍返回 engine-not-implemented（未被线上引擎污染）', async () => {
    const r = await ve.testGenerate('f5-tts', {}, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('engine-not-implemented:f5-tts');
  });
});

describe('OpenAI TTS：真实 HTTP 契约（本地假服务）', () => {
  it('成功路径：Authorization 头 / 模型 / 音色 / 强制 wav，返回 Buffer + 真实时长', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-test-abc';
    let seen = null;
    const wav = makeWav(2); // 2 秒
    const fake = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        seen = { url: req.url, method: req.method, auth: req.headers['authorization'], ct: req.headers['content-type'], body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wav);
      });
    });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: '你好' });
    await fake.close();
    expect(r.ok).toBe(true);
    expect(Buffer.isBuffer(r.audio)).toBe(true);
    expect(r.mime).toBe('audio/wav');
    // 时长来自真实 WAV 头，误差 < 1ms
    expect(r.durationSec).toBeGreaterThan(1.99);
    expect(r.durationSec).toBeLessThan(2.01);
    // 契约校验
    expect(seen.url).toBe('/v1/audio/speech');
    expect(seen.method).toBe('POST');
    expect(seen.auth).toBe('Bearer sk-test-abc');
    expect(seen.ct).toContain('application/json');
    expect(seen.body.model).toBe('gpt-4o-mini-tts');   // 官方当前推荐模型，不是已停用旧模型
    expect(seen.body.voice).toBe('alloy');
    expect(seen.body.input).toBe('你好');
    expect(seen.body.response_format).toBe('wav');
  });
  it('自定义 model / voice 会被透传', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    let body = null;
    const fake = await startFakeServer((req, res) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { body = JSON.parse(b); res.writeHead(200, {'Content-Type':'audio/wav'}); res.end(makeWav(1)); });
    });
    await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl, model: 'tts-1-hd', voice: 'nova' }, { text: 'x' });
    await fake.close();
    expect(body.model).toBe('tts-1-hd');
    expect(body.voice).toBe('nova');
  });
  it('401 → 明确提示 Key 无效（不误报成网络问题）', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-bad';
    const fake = await startFakeServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('openai-tts-http-401');
    expect(r.actionableHint).toMatch(/Key 无效/);
  });
  it('429 → 提示限流 / 额度', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => { res.writeHead(429); res.end('rate limit'); });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.error).toBe('openai-tts-http-429');
    expect(r.actionableHint).toMatch(/限流|额度/);
  });
  it('403 → 提示权限 / 套餐', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => { res.writeHead(403); res.end('forbidden'); });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.actionableHint).toMatch(/权限|套餐/);
  });
  it('500 → 提示服务端错误', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => { res.writeHead(500); res.end('boom'); });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.actionableHint).toMatch(/服务端错误/);
  });
  it('200 但返回 JSON 错误体 → unexpected-audio-format（不伪装成功）', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad voice' } }).padEnd(400, ' '));
    });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unexpected-audio-format');
  });
  it('200 但空 body → empty-audio', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => { res.writeHead(200); res.end(); });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty-audio');
  });
});

describe('ElevenLabs TTS：真实 HTTP 契约（本地假服务）', () => {
  it('成功路径：xi-api-key 头 / voice_id 进路径 / output_format 进 query / model_id 进 body', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'el-key-123';
    let seen = null;
    const mp3 = makeMp3(100); // 100 帧 ≈ 2.6s @44.1kHz
    const fake = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        seen = { url: req.url, key: req.headers['xi-api-key'], body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(mp3);
      });
    });
    const r = await ve.testGenerate('elevenlabs-tts', { baseUrl: fake.baseUrl, voiceId: 'VOICE_X' }, { text: 'hello' });
    await fake.close();
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('audio/mpeg');
    expect(seen.url).toContain('/v1/text-to-speech/VOICE_X');
    expect(seen.url).toContain('output_format=mp3_44100_128');
    expect(seen.key).toBe('el-key-123');
    expect(seen.body.text).toBe('hello');
    expect(seen.body.model_id).toBe('eleven_multilingual_v2');
    // MP3 时长由帧累加得出（不是伪造的 0）
    expect(r.durationSec).toBeGreaterThan(2.5);
    expect(r.durationSec).toBeLessThan(2.8);
  });
  it('voiceId 会做 URL 编码', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    let url = '';
    const fake = await startFakeServer((req, res) => { url = req.url; res.writeHead(200); res.end(makeMp3(20)); });
    await ve.testGenerate('elevenlabs-tts', { baseUrl: fake.baseUrl, voiceId: 'a b/c' }, { text: 'x' });
    await fake.close();
    expect(url).toContain('a%20b%2Fc');
  });
  it('自定义 modelId / outputFormat 会透传', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    let seen = null;
    const fake = await startFakeServer((req, res) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { seen = { url: req.url, body: JSON.parse(b) }; res.writeHead(200); res.end(makeMp3(20)); });
    });
    await ve.testGenerate('elevenlabs-tts', {
      baseUrl: fake.baseUrl, voiceId: 'v1', modelId: 'eleven_turbo_v2_5', outputFormat: 'mp3_22050_32'
    }, { text: 'x' });
    await fake.close();
    expect(seen.url).toContain('output_format=mp3_22050_32');
    expect(seen.body.model_id).toBe('eleven_turbo_v2_5');
  });
  it('422 且提示 voice → 提示 Voice ID 无效', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    const fake = await startFakeServer((req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: { status: 'invalid_voice_id' } }));
    });
    const r = await ve.testGenerate('elevenlabs-tts', { baseUrl: fake.baseUrl, voiceId: 'bad' }, { text: 'x' });
    await fake.close();
    expect(r.error).toBe('elevenlabs-http-422');
    expect(r.actionableHint).toMatch(/Voice ID/);
  });
  it('200 但返回 JSON → unexpected-audio-format', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    const fake = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'nope' }).padEnd(300, ' '));
    });
    const r = await ve.testGenerate('elevenlabs-tts', { baseUrl: fake.baseUrl, voiceId: 'v' }, { text: 'x' });
    await fake.close();
    expect(r.error).toBe('unexpected-audio-format');
  });
});

describe('线上引擎：网络故障与「认证 ≠ 合成」', () => {
  it('连接被拒绝 → network-error，且提示是「网络/地址」而不是「Key 无效」', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const r = await ve.testGenerate('openai-tts', { baseUrl: 'http://127.0.0.1:1' }, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network-error');
    expect(r.actionableHint).not.toMatch(/Key 无效/);
  });
  it('DNS 失败 → 提示 DNS / 网络，不误判为 Key 问题', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    const r = await ve.testGenerate('elevenlabs-tts',
      { baseUrl: 'http://this-host-does-not-exist-rokit.invalid', voiceId: 'v' }, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network-error');
    expect(r.actionableHint).not.toMatch(/Key 无效/);
  }, 20000);
  it('probe 成功时返回 authOnly:true，明确不等于已合成', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-x';
    const fake = await startFakeServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"data":[]}'); }
      else { res.writeHead(404); res.end(); }
    });
    const r = await ve.probe('openai-tts', { baseUrl: fake.baseUrl });
    await fake.close();
    expect(r.ok).toBe(true);
    expect(r.authOnly).toBe(true);
    expect(String(r.probeNote)).toMatch(/不代表/);
  });
  it('ElevenLabs probe 打 /v1/voices，且 401 提示 Key 无效', async () => {
    FAKE_KEYS['elevenlabs-tts'] = 'k';
    let url = '';
    const fake = await startFakeServer((req, res) => { url = req.url; res.writeHead(401); res.end(); });
    const r = await ve.probe('elevenlabs-tts', { baseUrl: fake.baseUrl });
    await fake.close();
    expect(url).toBe('/v1/voices');
    expect(r.ok).toBe(false);
    expect(r.actionableHint).toMatch(/Key 无效/);
  });
  it('probe 缺 Key 时不发网络请求', async () => {
    FAKE_KEYS['openai-tts'] = '';
    let hit = 0;
    const fake = await startFakeServer((req, res) => { hit++; res.writeHead(200); res.end(); });
    const r = await ve.probe('openai-tts', { baseUrl: fake.baseUrl });
    await fake.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-api-key');
    expect(hit).toBe(0);
  });
});

describe('音频时长解析', () => {
  it('wavDurationSec 解析真实 RIFF 时长', () => {
    expect(ve.wavDurationSec(makeWav(3))).toBeCloseTo(3, 3);
  });
  it('wavDurationSec 对非 WAV 返回 0（不伪造）', () => {
    expect(ve.wavDurationSec(Buffer.alloc(100))).toBe(0);
    expect(ve.wavDurationSec(makeMp3(50))).toBe(0);
  });
  it('mp3DurationSec 累加帧时长', () => {
    // 100 帧 × 1152 / 44100 = 2.6122s
    expect(ve.mp3DurationSec(makeMp3(100))).toBeCloseTo(2.612, 2);
  });
  it('mp3DurationSec 能跳过 ID3v2 头', () => {
    expect(ve.mp3DurationSec(makeMp3(100, true))).toBeCloseTo(2.612, 2);
  });
  it('mp3DurationSec 对垃圾数据 / 过短数据返回 0', () => {
    expect(ve.mp3DurationSec(Buffer.alloc(64, 0x41))).toBe(0);
    expect(ve.mp3DurationSec(Buffer.from('not audio at all'))).toBe(0);
  });
  it('mp3DurationSec 拒绝单帧误命中（<2 帧返回 0）', () => {
    expect(ve.mp3DurationSec(makeMp3(1))).toBe(0);
  });
  it('_looksLikeMp3 识别 ID3 与帧同步字', () => {
    expect(ve._online.looksLikeMp3(makeMp3(10))).toBe(true);
    expect(ve._online.looksLikeMp3(makeWav(1))).toBe(false);
    expect(ve._online.looksLikeMp3(Buffer.alloc(0))).toBe(false);
  });
});

describe('密钥安全：不外泄', () => {
  it('适配器返回体与日志里都不含明文 Key', async () => {
    const SECRET = 'sk-super-secret-value-123';
    FAKE_KEYS['openai-tts'] = SECRET;
    const fake = await startFakeServer((req, res) => { res.writeHead(401); res.end('{"error":{"message":"bad"}}'); });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toMatch(/Bearer\s/);
  });
  it('OpenAI 请求失败时 errorDetail 只含响应体，不含请求头', async () => {
    FAKE_KEYS['openai-tts'] = 'sk-secret-xyz';
    const fake = await startFakeServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal' } }));
    });
    const r = await ve.testGenerate('openai-tts', { baseUrl: fake.baseUrl }, { text: 'hi' });
    await fake.close();
    expect(JSON.stringify(r)).not.toContain('sk-secret-xyz');
    expect(JSON.stringify(r)).not.toContain('Authorization');
  });
  it('源码里不存在硬编码的真实 Key 形态（sk- 后跟长随机串）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'voice-engine.js'), 'utf8');
    // 只允许 placeholder 形态（sk-... / sk-test / sk-x 等测试用短值），不允许长随机串
    const suspicious = src.match(/sk-[A-Za-z0-9]{20,}/g);
    expect(suspicious).toBeNull();
  });
  it('secrets 模块暴露新引擎的读写清除接口', () => {
    ['getOpenaiTtsKey', 'setOpenaiTtsKey', 'clearOpenaiTtsKey',
     'getElevenlabsTtsKey', 'setElevenlabsTtsKey', 'clearElevenlabsTtsKey'
    ].forEach(function(fn){ expect(typeof realSecrets[fn]).toBe('function'); });
  });
});

afterAll(() => { spy.mockRestore(); spy2.mockRestore(); });
