// Rokit · caption:save-final（保存视频到固定目录 saved-videos/）行为锁定
//
// 覆盖需求点（全部使用**真实生产代码** —— 用 vm 加载完整的 electron/video-source.js，
// 只替换 require('electron') 的 dialog / app，其余全部跑生产实现）：
//   1. 保存成功后文件实际位于 <userData>/saved-videos/
//   2. 原成品（temp/videos/final/）仍然存在 —— 是复制不是移动
//   3. 同名保存不覆盖已有文件（自动生成 -1 / -2 …）
//   4. 返回数据结构与修改前一致（ok / path / bytes / error）
//   5. 目录不存在时自动创建
//   6. 路径白名单仍然生效（temp/videos/final 之外的文件拒绝复制）
//   7. saved-videos/ 不在 AI 语音临时清理范围内
//   8. 不再调用 showSaveDialog

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VS_PATH = path.join(ROOT, 'electron', 'video-source.js');
const VS_SRC = fs.readFileSync(VS_PATH, 'utf8').replace(/\r\n/g, '\n');

let ud = '';           // 本轮测试的 userData 目录
let finalDir = '';     // <userData>/temp/videos/final

// 用 vm 加载真实生产模块，只把 require('electron') 换成可控替身
function loadProductionModule() {
  const fakeDialog = {
    // 保存路径不再弹窗：若被调用即视为回归失败
    showSaveDialog: function () { throw new Error('showSaveDialog 不得再被调用'); },
    showOpenDialog: async function () { return { canceled: true, filePaths: [] }; }
  };
  const fakeApp = {
    getPath: function (k) {
      if (k === 'userData') return ud;
      return ud;
    }
  };
  const fakeLogger = { info() {}, warn() {}, error() {} };
  const fakeRequire = function (id) {
    if (id === 'electron') return { dialog: fakeDialog, app: fakeApp };
    if (id === './logger') return fakeLogger;
    return require(id);
  };
  const sandbox = {
    require: fakeRequire,
    module: { exports: {} },
    exports: {},
    console: console,
    Buffer: Buffer,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    __dirname: path.dirname(VS_PATH),
    __filename: VS_PATH
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(VS_SRC, sandbox, { filename: VS_PATH });
  return sandbox.module.exports;
}

function makeSourceFile(name, size) {
  const p = path.join(finalDir, name);
  fs.writeFileSync(p, Buffer.alloc(size, 7));
  return p;
}

describe('caption:save-final · 固定保存到 saved-videos/', function () {

  let prod;
  let handlers;

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-savefinal-'));
    finalDir = path.join(ud, 'temp', 'videos', 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    prod = loadProductionModule();
    handlers = {};
    prod.registerVideoSourceIpc({ handle: (ch, fn) => { handlers[ch] = fn; } });
  });

  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
  });

  it('1. 保存成功后文件位于 <userData>/saved-videos/，且原成品仍在', async function () {
    const src = makeSourceFile('final-1.mp4', 4096);
    const r = await handlers['caption:save-final']({}, {
      filePath: src,
      defaultPath: 'Rokit-视频成品-20260101-120000.mp4'
    });

    expect(r.ok).toBe(true);
    expect(path.dirname(r.path)).toBe(path.join(ud, 'saved-videos'));
    expect(path.basename(r.path)).toBe('Rokit-视频成品-20260101-120000.mp4');
    expect(fs.existsSync(r.path)).toBe(true);
    // 原成品仍然存在（复制，不是移动）
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.statSync(r.path).size).toBe(4096);
  });

  it('2. 返回数据结构与修改前一致：{ ok, path, bytes }', async function () {
    const src = makeSourceFile('final-2.mp4', 2048);
    const r = await handlers['caption:save-final']({}, { filePath: src, defaultPath: 'a.mp4' });
    expect(Object.keys(r).sort()).toEqual(['bytes', 'ok', 'path']);
    expect(typeof r.ok).toBe('boolean');
    expect(typeof r.path).toBe('string');
    expect(typeof r.bytes).toBe('number');
    expect(r.bytes).toBe(2048);
  });

  it('3. 目录不存在时自动创建 saved-videos/', async function () {
    expect(fs.existsSync(path.join(ud, 'saved-videos'))).toBe(false);
    const src = makeSourceFile('final-3.mp4', 1024);
    const r = await handlers['caption:save-final']({}, { filePath: src, defaultPath: 'x.mp4' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ud, 'saved-videos'))).toBe(true);
  });

  it('4. 同名保存不覆盖已有文件（自动追加 -1 / -2）', async function () {
    const src = makeSourceFile('final-4.mp4', 4096);
    const name = 'Rokit-视频成品-同名.mp4';

    const r1 = await handlers['caption:save-final']({}, { filePath: src, defaultPath: name });
    const r2 = await handlers['caption:save-final']({}, { filePath: src, defaultPath: name });
    const r3 = await handlers['caption:save-final']({}, { filePath: src, defaultPath: name });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(new Set([r1.path, r2.path, r3.path]).size).toBe(3);
    expect(path.basename(r1.path)).toBe(name);
    expect(path.basename(r2.path)).toBe('Rokit-视频成品-同名-1.mp4');
    expect(path.basename(r3.path)).toBe('Rokit-视频成品-同名-2.mp4');
    // 第一个文件内容未被覆盖
    expect(fs.statSync(r1.path).size).toBe(4096);
    expect(fs.existsSync(r1.path)).toBe(true);
    expect(fs.existsSync(r2.path)).toBe(true);
    expect(fs.existsSync(r3.path)).toBe(true);
  });

  it('5. 路径白名单仍然生效：temp/videos/final 之外的文件拒绝复制', async function () {
    const outside = path.join(ud, 'original-local-video.mp4');
    fs.writeFileSync(outside, Buffer.alloc(4096, 1));
    const r = await handlers['caption:save-final']({}, { filePath: outside, defaultPath: 'x.mp4' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-not-allowed');
    expect(fs.existsSync(path.join(ud, 'saved-videos', 'x.mp4'))).toBe(false);
  });

  it('6. 源文件不存在 / 为空 → 明确失败，不产生空文件', async function () {
    const missing = path.join(finalDir, 'not-exist.mp4');
    const r1 = await handlers['caption:save-final']({}, { filePath: missing, defaultPath: 'x.mp4' });
    expect(r1.ok).toBe(false);
    expect(String(r1.error)).toContain('成品文件不存在');

    const empty = path.join(finalDir, 'empty.mp4');
    fs.writeFileSync(empty, Buffer.alloc(0));
    const r2 = await handlers['caption:save-final']({}, { filePath: empty, defaultPath: 'y.mp4' });
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toContain('为空');
  });

  it('7. 文件名只取 basename（杜绝路径穿越），并补齐 .mp4 扩展名', async function () {
    const src = makeSourceFile('final-7.mp4', 1024);
    const r = await handlers['caption:save-final']({}, {
      filePath: src,
      defaultPath: '../../evil/名字.mp4'
    });
    expect(r.ok).toBe(true);
    expect(path.dirname(r.path)).toBe(path.join(ud, 'saved-videos'));
    expect(path.basename(r.path)).toBe('名字.mp4');

    const r2 = await handlers['caption:save-final']({}, { filePath: src, defaultPath: '无扩展名' });
    expect(r2.ok).toBe(true);
    expect(path.basename(r2.path)).toBe('无扩展名.mp4');
  });

  it('8. saved-videos/ 不在 AI 语音临时清理范围内', function () {
    const cleanupSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ai-voice-cleanup.js'), 'utf8');
    const codeOnly = cleanupSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/saved-videos/);
  });

  it('9. 源码约束：不再调用 showSaveDialog，固定写入 saved-videos/', function () {
    const body = VS_SRC.slice(VS_SRC.indexOf("ipcMain.handle('caption:save-final'"));
    expect(body.slice(0, body.indexOf('\n  });'))).not.toMatch(/showSaveDialog/);
    expect(body).toMatch(/'saved-videos'/);
    expect(body).toMatch(/fs\.copyFileSync\(resolved, dest\)/);
    // 不删除既有目标文件（不覆盖策略）
    expect(body.slice(0, body.indexOf('\n  });'))).not.toMatch(/unlinkSync\(dest\)/);
  });
});
