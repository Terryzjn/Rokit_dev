// voice-engine module 测试 (v1.20.6)
//   - listEngines 至少返回 LOCAL_MODEL + ONLINE_SERVICE
//   - XTTS-v2 标记为 implemented: true
//   - probe('xtts-v2', {baseUrl:''}) 应返回 ok:false（无地址）
//   - probe('xtts-v2', {baseUrl:'http://127.0.0.1:1'}) 应不可达
//   - probe('f5-tts', {}) 返回 engine-not-implemented
//   - wavDurationSec 在 44 byte WAV 头下安全

'use strict';

const fs = require('fs');
const path = require('path');
const veModule = require('../electron/voice-engine');

describe('voice-engine module', () => {
  it('XTTS-v2 默认端口是 Coqui 官方 5002（不是 8020）', () => {
    const xtts = veModule.listEngines().filter(e => e.id === 'xtts-v2')[0];
    expect(xtts).toBeTruthy();
    expect(xtts.defaults && xtts.defaults.baseUrl).toBe('http://127.0.0.1:5002');
    expect(xtts.defaults.baseUrl).not.toMatch(/:8020\b/); // v1.20.9: 不再用 8020
  });
  it('列出引擎：LOCAL_MODEL + ONLINE_SERVICE 同时存在', () => {
    const engines = veModule.listEngines();
    expect(Array.isArray(engines)).toBe(true);
    const locals = engines.filter(e => e.kind === veModule.KIND_LOCAL);
    const onlines = engines.filter(e => e.kind === veModule.KIND_ONLINE);
    expect(locals.length).toBeGreaterThan(0);
    expect(onlines.length).toBeGreaterThan(0);
  });
  it('XTTS-v2 标记为 implemented', () => {
    const xtts = veModule.listEngines().filter(e => e.id === 'xtts-v2')[0];
    expect(xtts).toBeTruthy();
    expect(xtts.implemented).toBe(true);
  });
  it('F5-TTS / GPT-SoVITS / OpenVoice / CosyVoice 暂未实现', () => {
    ['f5-tts','gpt-sovits','openvoice','cosyvoice'].forEach(function(id){
      const e = veModule.listEngines().filter(function(x){return x.id===id;})[0];
      expect(e).toBeTruthy();
      expect(e.implemented).toBeFalsy();
    });
  });
  it('probe(xtts-v2, {}) 在缺 baseUrl 时返回失败', async () => {
    const r = await veModule.probe('xtts-v2', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-baseUrl');
  });
  it('probe(xtts-v2, 不可达端口) → ok=false 给出网络错误', async () => {
    // 127.0.0.1:1 通常不可达；timeout 5s
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:1' });
    expect(r.ok).toBe(false);
    expect(r.capabilities).toBeDefined();
  }, 30000);
  it('probe(xtts-v2, http://127.0.0.1:4) 测试本地栈拒绝能力字段透明', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:4' });
    expect(r).toBeDefined();
    expect(r.capabilities).toBeDefined();
    // 不可达时 caps.reachable 应该 false（可能 true 仅在几乎不可能存在服务的情况下）
    expect(typeof r.ok === 'boolean').toBe(true);
  }, 20000);
  it('probe(已实现本地引擎，未启动服务) → 返回 ECONNREFUSED 而非 engine-not-implemented', async () => {
    // v1.20.10：f5-tts 现在有通用探测（healthPaths=['/','/info']）—— 不可达时返回 ECONNREFUSED
    const r = await veModule.probe('f5-tts', { baseUrl: 'http://127.0.0.1:7860' });
    expect(r.ok).toBe(false);
    // 不再返回 'engine-not-implemented'：每款引擎都有独立的探测路径
    expect(String(r.error)).not.toBe('engine-not-implemented:f5-tts');
    expect(String(r.errorDetail || '')).toMatch(/ECONNREFUSED|no-endpoint-responding/);
  });
  it('testGenerate(未实现真实调用的引擎) → not-implemented', async () => {
    // f5-tts 等本地引擎：探测已实现，但**真实生成调用**仍只 xtts-v2 落地
    const r = await veModule.testGenerate('f5-tts', { baseUrl: 'http://x' }, { text: 't' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('engine-not-implemented');
  });
  it('testGenerate(xtts-v2, 不可达) → 返回失败，**不**伪造成功', async () => {
    const r = await veModule.testGenerate('xtts-v2', { baseUrl: 'http://127.0.0.1:1' }, { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.audio).toBeFalsy();
  }, 30000);
  // v1.20.9：新增 — 无参考音频时拒绝合成（不伪造"默认音色"）
  it('testGenerate(xtts-v2, 无 refBase64) → 拒绝 + 给出可操作错误', async () => {
    const r = await veModule.testGenerate('xtts-v2', { baseUrl: 'http://127.0.0.1:5002' }, { text: 'hi', refBase64: '' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/speaker_wav|参考音频/);
    expect(r.audio).toBeFalsy();
  });
  // v1.20.9：probe 错误应携带 actionableHint（用户操作建议）
  it('probe 不可达 → 携带 actionableHint（提示默认端口 5002）', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.ok).toBe(false);
    expect(r.actionableHint).toBeTruthy();
    expect(String(r.actionableHint)).toMatch(/5002|本.*服务.*启/);
  }, 30000);
  // v1.20.9：probe 无 baseUrl 也要有 actionableHint
  it('probe 无 baseUrl → 携带 actionableHint（提示填写地址）', async () => {
    const r = await veModule.probe('xtts-v2', {});
    expect(r.ok).toBe(false);
    expect(r.actionableHint).toBeTruthy();
    expect(String(r.actionableHint)).toMatch(/5002|填写/);
  });
  // v1.20.9：probe ECONNREFUSED → errorDetail 完整保留
  it('probe ECONNREFUSED → errorDetail 含 ECONNREFUSED', async () => {
    const r = await veModule.probe('xtts-v2', { baseUrl: 'http://127.0.0.1:65535' });
    expect(r.ok).toBe(false);
    expect(r.errorDetail).toBeTruthy();
    expect(String(r.errorDetail)).toMatch(/ECONNREFUSED/);
  }, 30000);
  it('wavDurationSec 对非 WAV 返回 0', () => {
    expect(veModule.wavDurationSec(Buffer.alloc(0))).toBe(0);
    expect(veModule.wavDurationSec(Buffer.from('not a wav', 'utf8'))).toBe(0);
  });
});
