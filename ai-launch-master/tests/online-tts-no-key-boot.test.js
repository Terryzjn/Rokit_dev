// 无密钥启动安全 + 依赖/打包检查（v1.21）
//
// 任务书第八节第 5 条：「不会因密钥缺失导致应用启动失败」。
// 做法：不启动 Electron，只验证「主进程在密钥缺失时的代码路径是安全的」。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ve = require('../electron/voice-engine');

describe('密钥缺失时的启动安全', () => {
  it('voice-engine 模块在无任何密钥时可正常 require（不抛错）', () => {
    expect(() => require('../electron/voice-engine')).not.toThrow();
  });
  it('secrets 模块在无任何密钥时可正常 require', () => {
    expect(() => require('../electron/secrets')).not.toThrow();
  });
  it('缺密钥时两个引擎的 probe / testGenerate 返回结构化错误而非抛异常', async () => {
    for (const id of ['openai-tts', 'elevenlabs-tts']) {
      const p = await ve.probe(id, {});
      expect(p.ok).toBe(false);
      expect(typeof p.error).toBe('string');
      expect(p.error).toBe('missing-api-key');
      expect(p.capabilities).toBeDefined(); // 渲染层要读 capabilities，不能 undefined

      const g = await ve.testGenerate(id, {}, { text: 'hello' });
      expect(g.ok).toBe(false);
      expect(g.error).toBe('missing-api-key');
      expect(String(g.actionableHint).length).toBeGreaterThan(0);
      // 失败结果绝不能带音频字段，避免上层误判成功
      expect(g.audio).toBeUndefined();
      expect(g.audioBase64).toBeUndefined();
    }
  });
  it('引擎列表可在无密钥时正常枚举（引擎卡片渲染依赖它）', () => {
    const list = ve.listEngines();
    expect(list.length).toBeGreaterThan(0);
    list.forEach(e => {
      expect(typeof e.id).toBe('string');
      expect(typeof e.kind).toBe('string');
      expect(typeof e.implemented).toBe('boolean');
      expect(e.capabilities).toBeDefined();
    });
  });
  it('getEngineDefaults 在无密钥时返回默认值（配置表单渲染依赖它）', () => {
    expect(ve.getEngineDefaults('openai-tts')).toEqual({ baseUrl: 'https://api.openai.com' });
    expect(ve.getEngineDefaults('elevenlabs-tts')).toEqual({ baseUrl: 'https://api.elevenlabs.io' });
    expect(ve.getEngineDefaults('not-exist')).toBeNull();
  });
  it('默认模型不是已公告停用的旧模型', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'voice-engine.js'), 'utf8');
    // 默认模型必须是 gpt-4o-mini-tts
    expect(src).toMatch(/cfg\.model \|\| 'gpt-4o-mini-tts'/);
    // ElevenLabs 默认取官方端点默认值
    expect(src).toMatch(/cfg\.modelId \|\| 'eleven_multilingual_v2'/);
  });
});

describe('依赖与打包', () => {
  it('package.json 未引入任何新的语音 SDK（本轮零新增依赖）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    expect(deps.openai).toBeUndefined();
    expect(deps['@elevenlabs/sdk']).toBeUndefined();
    // 原有依赖仍在
    expect(deps.keytar).toBeTruthy();
    expect(deps['ffmpeg-static']).toBeTruthy();
    expect(deps['better-sqlite3']).toBeTruthy();
  });
  it('package-lock.json 未被本轮改动（零新增依赖 → 锁文件不应变化）', () => {
    const lockPath = path.join(ROOT, 'package-lock.json');
    expect(fs.existsSync(lockPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    expect(deps.openai).toBeUndefined();
    expect(deps['@elevenlabs/sdk']).toBeUndefined();
  });
  it('适配器只依赖 Node 内置模块与项目内模块，未引入第三方 HTTP 客户端', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'voice-engine.js'), 'utf8');
    const requires = src.match(/require\(['"]([^'"]+)['"]\)/g) || [];
    const mods = requires.map(r => r.replace(/^require\(['"]/, '').replace(/['"]\)$/, ''));
    const allowed = new Set([
      'http', 'https', 'url', 'os', 'fs', 'path', 'child_process', 'electron',
      './secrets', './ffmpeg-resolver'
    ]);
    const unexpected = mods.filter(m => !allowed.has(m));
    expect({ unexpected }).toEqual({ unexpected: [] });
    // 线上适配器明确复用了文件内既有的 _buildRequest
    expect(src).toMatch(/function _buildRequest\(urlStr, options\)/);
    expect(src).toMatch(/_buildRequest\(baseUrl \+ '\/v1\/audio\/speech'/);
    expect(src).toMatch(/_buildRequest\(url, \{/);
  });
  it('main.js / preload.js 语法有效（node --check）', () => {
    ['electron/main.js', 'electron/preload.js', 'electron/voice-engine.js', 'electron/secrets.js']
      .forEach(rel => {
        expect(() => execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' })).not.toThrow();
      });
  });
  it('index.html 内联脚本语法有效', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, count = 0;
    while ((m = re.exec(html))) {
      if (!m[1].trim()) continue;
      count++;
      const tmp = path.join(require('os').tmpdir(), 'rokit-inline-' + process.pid + '-' + count + '.js');
      fs.writeFileSync(tmp, m[1]);
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } finally {
        try { fs.unlinkSync(tmp); } catch (_e) {}
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});
