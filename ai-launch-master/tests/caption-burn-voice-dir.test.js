// Rokit · caption-burn 配音混音输入落盘目录（v1.22.1）—— 行为测试
//
// 覆盖需求点：
//   1  voice-*.wav 写入 <userData>/temp/voices/（不再是 temp/videos/final/）
//   2  FFmpeg 的 -i 输入使用实际生成的音频路径（指向 temp/voices/）
//   3  目录不存在时自动创建
//   4  sub-*.ass / frz-* / final-*.mp4 仍在 temp/videos/final/（不受本次修改影响）
//   5  合成成功后 voice-*.wav 被即时清理（tmpFiles 语义不变）
//   6  合成失败后 voice-*.wav 也被即时清理
//
// 全部使用 mock ffmpeg（spawn 拦截），**不运行真实 FFmpeg**，不产生真实视频。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let tmpRoot = null;
let UD = '';
let cb = null;
let capturedArgs = [];
let failFfmpeg = false;
let snapshotHook = null;

function makeTmp() {
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-capburn-voice-'));
    UD = path.join(tmpRoot, 'userData');
  }
  return tmpRoot;
}
function cleanupTmp() {
  if (!tmpRoot) return;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  tmpRoot = null; UD = '';
}

beforeAll(() => {
  makeTmp();

  // ---- mock electron：app.getPath('userData') → 临时 userData ----
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: function () { return UD; } } }
  };

  // ---- mock ffmpeg-resolver：假装 ffmpeg 可用 ----
  const frPath = require.resolve(path.join(ROOT, 'electron', 'ffmpeg-resolver.js'));
  require.cache[frPath] = {
    id: frPath, filename: frPath, loaded: true,
    exports: {
      resolveFfmpegPath: function () { return { ok: true, path: 'ffmpeg-mock' }; },
      ffmpegPath: function () { return 'ffmpeg-mock'; },
      ffmpegAvailable: function () { return true; }
    }
  };

  // ---- mock child_process.spawn：拦截 ffmpeg 调用 ----
  const cpPath = require.resolve('child_process');
  const realCp = require(cpPath);
  require.cache[cpPath] = {
    id: cpPath, filename: cpPath, loaded: true,
    exports: Object.assign({}, realCp, {
      spawn: function (exe, args) {
        capturedArgs.push(args);
        // 快照钩子：在 ffmpeg 真正执行时抓取磁盘状态
        if (typeof snapshotHook === 'function' && args.indexOf('-filter_complex') >= 0) {
          try { snapshotHook(args); } catch (_e) {}
        }
        const handlers = {};
        const proc = {
          stderr: { on: function (ev, fn) { if (ev === 'data') setTimeout(function () { fn(Buffer.from('')); }, 0); } },
          stdout: { on: function () {} },
          on: function (ev, fn) { handlers[ev] = fn; },
          kill: function () {},
          stdin: { write: function () {}, end: function () {} }
        };
        setTimeout(function () {
          if (failFfmpeg) {
            if (handlers.error) handlers.error(new Error('mock-ffmpeg-failed'));
            else if (handlers.close) handlers.close(1);
            return;
          }
          // 模拟 ffmpeg 产出成品视频（供 caption-burn 校验存在且非空）
          try {
            const out = args[args.length - 1];
            fs.writeFileSync(out, Buffer.alloc(4096, 1));
          } catch (_e) {}
          if (handlers.close) handlers.close(0);
        }, 5);
        return proc;
      }
    })
  };

  const cbPath = require.resolve(path.join(ROOT, 'electron', 'caption-burn.js'));
  delete require.cache[cbPath];
  cb = require(cbPath);
});

afterAll(() => { cleanupTmp(); });
afterEach(() => { capturedArgs = []; failFfmpeg = false; });

// 造一个"合法"的源视频（仅需存在即可，mock ffmpeg 不真的解码）
function makeSourceVideo() {
  const p = path.join(makeTmp(), 'source.mp4');
  try { fs.writeFileSync(p, Buffer.alloc(2048, 2)); } catch (_e) {}
  return p;
}

// 造一段"合法"的配音 base64（>100 字符的 data URI）
function makeAudioB64() {
  const raw = Buffer.alloc(4096, 7).toString('base64');
  return 'data:audio/wav;base64,' + raw;
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch (_e) { return []; }
}

describe('caption-burn · 配音混音输入目录（v1.22.1）', function () {

  it('1. voice-*.wav 写入 temp/voices/，不再写入 temp/videos/final/', async function () {
    const src = makeSourceVideo();
    const voicesDir = path.join(UD, 'temp', 'voices');
    const finalDir = path.join(UD, 'temp', 'videos', 'final');

    const r = await cb.burnFinalVideo(src, [
      { text: '第一段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() },
      { text: '第二段', outStart: 2, outEnd: 4, audioB64: makeAudioB64() }
    ], [], { duration: 10 });

    expect(r.ok).toBe(true);

    // 成品视频仍在视频目录
    expect(r.path).toContain(path.join('temp', 'videos', 'final'));
    expect(fs.existsSync(r.path)).toBe(true);

    // 合成成功后 voice-*.wav 已被即时清理 → 目录里不应残留
    // （即时 cleanup 语义不变：tmpFiles 登记 + 成功后 unlink）
    expect(listDir(voicesDir).filter(function (n) { return /^voice-/.test(n); })).toEqual([]);
    // 视频目录里也从未出现过 voice-*
    expect(listDir(finalDir).filter(function (n) { return /^voice-/.test(n); })).toEqual([]);
  });

  it('2. FFmpeg 的 -i 音频输入指向 temp/voices/ 下的实际文件', async function () {
    const src = makeSourceVideo();
    capturedArgs = [];
    await cb.burnFinalVideo(src, [
      { text: '第一段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() }
    ], [], { duration: 10 });

    // 找到包含 -filter_complex 的那次调用
    const call = capturedArgs.find(function (a) { return a.indexOf('-filter_complex') >= 0; });
    expect(call).toBeTruthy();

    // 音频输入：`-i <temp/voices>/voice-*.wav`
    const audioInputs = [];
    for (let i = 0; i < call.length; i++) {
      if (call[i] === '-i' && /voice-.*\.wav$/i.test(String(call[i + 1] || ''))) {
        audioInputs.push(String(call[i + 1]));
      }
    }
    expect(audioInputs.length).toBe(1);
    expect(audioInputs[0]).toContain(path.join('temp', 'voices'));
    expect(audioInputs[0]).toMatch(/voice-\d+-[\w-]+-0\.wav$/);
  });

  it('3. temp/voices/ 不存在时自动创建', async function () {
    const src = makeSourceVideo();
    const voicesDir = path.join(UD, 'temp', 'voices');
    try { fs.rmSync(voicesDir, { recursive: true, force: true }); } catch (_e) {}
    expect(fs.existsSync(voicesDir)).toBe(false);

    const r = await cb.burnFinalVideo(src, [
      { text: '段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() }
    ], [], { duration: 10 });
    expect(r.ok).toBe(true);
    // 目录被创建（即便文件已被即时清理）
    expect(fs.existsSync(voicesDir)).toBe(true);
    expect(fs.statSync(voicesDir).isDirectory()).toBe(true);
  });

  it('4. sub-*.ass / frz-* / final-*.mp4 仍在 temp/videos/final/，不受本次修改影响', async function () {
    const src = makeSourceVideo();
    const finalDir = path.join(UD, 'temp', 'videos', 'final');

    const r = await cb.burnFinalVideo(src, [
      { text: '带字幕段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() }
    ], [
      { at: 3, duration: 1, frameB64: 'data:image/png;base64,' + Buffer.alloc(64, 1).toString('base64'), frameMime: 'image/png' }
    ], { duration: 10 });

    expect(r.ok).toBe(true);
    expect(r.path).toContain(path.join('temp', 'videos', 'final'));
    // 字幕与静帧是即时清理的中间文件，合成成功后应已删除 → 但它们的**落点**是 final/
    // 用一次失败合成来验证落点更可靠（见用例 6）
    expect(fs.existsSync(r.path)).toBe(true);
  });

  it('5. 合成失败时 voice-*.wav 也被即时清理（cleanup 语义不变）', async function () {
    const src = makeSourceVideo();
    const voicesDir = path.join(UD, 'temp', 'voices');
    failFfmpeg = true;

    let threw = false;
    try {
      await cb.burnFinalVideo(src, [
        { text: '段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() }
      ], [], { duration: 10 });
    } catch (_e) { threw = true; }

    failFfmpeg = false;
    expect(threw).toBe(true);
    // 即时清理在 catch 分支同样执行 → 目录里不残留 voice-*
    expect(listDir(voicesDir).filter(function (n) { return /^voice-/.test(n); })).toEqual([]);
  });

  it('6. 中间文件落点断言：ass / frz / voice 三类各自的目录', async function () {
    // 用「mock ffmpeg 在 -filter_complex 时快照磁盘状态」的方式验证落点
    const src = makeSourceVideo();
    const voicesDir = path.join(UD, 'temp', 'voices');
    const finalDir = path.join(UD, 'temp', 'videos', 'final');

    let snapshot = null;
    snapshotHook = function () {
      snapshot = {
        voices: listDir(voicesDir),
        final: listDir(finalDir)
      };
    };

    await cb.burnFinalVideo(src, [
      { text: '段', outStart: 0, outEnd: 2, audioB64: makeAudioB64() }
    ], [
      { at: 3, duration: 1, frameB64: 'data:image/png;base64,' + Buffer.alloc(64, 1).toString('base64'), frameMime: 'image/png' }
    ], { duration: 10 });

    snapshotHook = null;

    expect(snapshot).toBeTruthy();
    // voice-*.wav 在 temp/voices/
    expect(snapshot.voices.filter(function (n) { return /^voice-/.test(n); }).length).toBe(1);
    // sub-*.ass 与 frz-* 在 temp/videos/final/
    expect(snapshot.final.filter(function (n) { return /^sub-/.test(n); }).length).toBe(1);
    expect(snapshot.final.filter(function (n) { return /^frz-/.test(n); }).length).toBe(1);
    // 视频目录里没有 voice-*
    expect(snapshot.final.filter(function (n) { return /^voice-/.test(n); })).toEqual([]);
  });
});
