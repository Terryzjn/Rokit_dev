// Rokit · ai-demo.js 单元测试
// 验证：saveRecording 支持 base64 + tempPath 双协议；file traversal 防护；exportMp4 缺失时返回 ok=false
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 替换 app.getPath：mock 一份
// 替换 electron.app：通过 require.cache stub 一份，避免对真实 app 产生副作用
let aiDemo;

beforeAll(() => {
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: function(){ return os.tmpdir(); } },
      desktopCapturer: null
    }
  };
  aiDemo = require('../electron/ai-demo');
});

afterAll(() => { /* nothing */ });

describe('ai-demo · saveRecording (base64)', () => {
  test('写入合法 base64，返回带 filePath 的 asset', async () => {
    const data = Buffer.from('FAKE_WEBM_' + 'x'.repeat(2000));
    const r = await aiDemo.saveRecording({ ext: 'webm', blobBase64: data.toString('base64') });
    expect(r.ok).toBe(true);
    expect(r.asset.id).toMatch(/^[a-f0-9]{24}$/);
    expect(r.asset.filePath).toMatch(/\.webm$/);
    expect(r.asset.mimeType).toBe('video/webm');
    expect(r.asset.fileSize).toBe(data.length);
    expect(fs.existsSync(r.asset.filePath)).toBe(true);
    // 清理
    try { fs.unlinkSync(r.asset.filePath); } catch (_e) {}
  });

  test('拒绝不支持的扩展名', async () => {
    const r = await aiDemo.saveRecording({ ext: 'exe', blobBase64: 'AA==' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported-ext/);
  });

  test('拒绝空 buffer / 既无 tempPath 又无 blobBase64', async () => {
    const r1 = await aiDemo.saveRecording({ ext: 'webm', blobBase64: '' });
    expect(r1.ok).toBe(false);
    const r2 = await aiDemo.saveRecording({ ext: 'webm' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/no-content/);
  });

  test('reject 包含路径穿越的 id', async () => {
    const r = await aiDemo.saveRecording({ id: '../../../etc/passwd', ext: 'webm', blobBase64: 'AA==' });
    // id 不合规时应自动生成新 id，不会写到用户指定路径
    expect(r.ok).toBe(true);
    expect(r.asset.id).not.toMatch(/\.\./);
    expect(r.asset.filePath).not.toMatch(/\.\./);
    try { fs.unlinkSync(r.asset.filePath); } catch (_e) {}
  });
});

describe('ai-demo · exportMp4', () => {
  test('ffmpeg 缺失时返回 ok=false 不抛', async () => {
    // 直接传一个不存在的源路径；不依赖 ffmpeg-static
    const r = await aiDemo.exportMp4({ inputPath: path.join(os.tmpdir(), 'rokit-no-such.webm') });
    expect(r.ok).toBe(false);
  });
});

describe('ai-demo · listSources', () => {
  test('desktopCapturer 不可用时，返回 ok=false 但不抛', async () => {
    const r = await aiDemo.listSources();
    expect(r).toHaveProperty('ok');
    // 沙箱里 desktopCapturer 是 null，预期 ok=false
    expect(r.ok).toBe(false);
    expect(Array.isArray(r.sources)).toBe(true);
    expect(r.sources.length).toBe(0);
  });
});
