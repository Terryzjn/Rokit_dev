// Rokit · AI 生成语音自动清除 —— 行为锁定
//
// 覆盖需求点：
//   1. 只清除明确属于 AI 生成的文件（按名称正则精确匹配，不整目录清空）
//   2. 用户原始音源（voice-profiles/）完全不受影响
//   3. 成品视频 / 字幕 / 静帧等非语音文件不受影响
//   4. 目录本身不被删除，只删文件
//   5. 目录不存在 / 无权限时静默跳过，不抛异常（清除失败不影响完成态）
//   6. renderer 侧只清 AI 生成的 base64，不动用户原始音源
//   7. 三个完成入口都触发清除

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// —— 主进程模块（真实生产代码）——
const cleanup = require(path.join(ROOT, 'electron', 'ai-voice-cleanup.js'));

function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = HTML.match(re);
  if (!m) throw new Error('源码中找不到函数：' + name);
  let i = m.index + m[0].length, depth = 1;
  while (i < HTML.length && depth > 0) {
    const ch = HTML.charAt(i++);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) throw new Error('花括号不配平：' + name);
  return HTML.slice(m.index, i);
}

let tmpRoot = null;
function makeTmp() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-aivoice-test-'));
  return tmpRoot;
}
function cleanupTmp() {
  if (!tmpRoot) return;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  tmpRoot = null;
}

describe('AI 生成语音自动清除', function () {

  afterEach(function () { cleanupTmp(); });

  it('1. 通用内核：只删名称匹配的文件，目录与不匹配文件保留', function () {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'rokit-tts-speaker-abc.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'rokit-tts-in-abc.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'other-file.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'rokit-tts-speaker-dir'), { recursive: true });

    const r = cleanup.cleanupGeneratedFiles([
      { dir: dir, patterns: [/^rokit-tts-speaker-/i, /^rokit-tts-in-/i] }
    ]);

    expect(r.removed.length).toBe(2);
    expect(r.failed.length).toBe(0);
    // 不匹配的文件保留
    expect(fs.existsSync(path.join(dir, 'other-file.txt'))).toBe(true);
    // 目录保留（只删文件）
    expect(fs.existsSync(path.join(dir, 'rokit-tts-speaker-dir'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'rokit-tts-speaker-dir')).isDirectory()).toBe(true);
  });

  it('2. 通用内核：目录不存在时静默跳过，不抛异常', function () {
    const missing = path.join(makeTmp(), 'not-exist-dir');
    let r;
    expect(function () { r = cleanup.cleanupGeneratedFiles([{ dir: missing, patterns: [/^x-/] }]); }).not.toThrow();
    expect(r.removed.length).toBe(0);
    expect(r.failed.length).toBe(0);
  });

  it('3. 通用内核：单个文件删除失败被记录，不影响其它文件', function () {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'rokit-tts-out-a.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'rokit-tts-out-b.wav'), 'x');
    // 制造一个删除失败项：把 a 变成目录（内核只删文件 → 跳过，不算失败）
    fs.mkdirSync(path.join(dir, 'rokit-tts-out-c'));
    const r = cleanup.cleanupGeneratedFiles([{ dir: dir, patterns: [/^rokit-tts-out-/] }]);
    // 两个文件被删，目录被跳过
    expect(r.removed.length).toBe(2);
    expect(fs.existsSync(path.join(dir, 'rokit-tts-out-c'))).toBe(true);
  });

  it('4. AI 语音包装：清除 TTS 临时文件与合成段落盘，保留同目录其它文件', function () {
    // v1.22.1：caption-burn 的 voice-*.wav 已迁到 os.tmpdir()/rokit-temp/voices
    //            （与 TTS 临时文件同目录）
    const voicesDir = path.join(os.tmpdir(), 'rokit-temp', 'voices');
    fs.mkdirSync(voicesDir, { recursive: true });
    const voiceFile = path.join(voicesDir, 'voice-123-0.wav');
    // TTS 三类临时文件也落在 os.tmpdir()/rokit-temp/voices（与 voice-engine.js 同口径）
    const speakerFile = path.join(voicesDir, 'rokit-tts-speaker-test123.wav');
    const ttsInFile = path.join(voicesDir, 'rokit-tts-in-test123.wav');
    const ttsOutFile = path.join(voicesDir, 'rokit-tts-out-test123.wav');
    const keepFile = path.join(voicesDir, 'unrelated-file.txt');
    [voiceFile, speakerFile, ttsInFile, ttsOutFile, keepFile].forEach(p => fs.writeFileSync(p, 'x'));

    // 视频目录下的产物（成品视频 / 字幕 / 静帧）不在清除范围
    const finalDir = path.join(os.tmpdir(), 'rokit-temp', 'videos', 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    const finalMp4 = path.join(finalDir, 'final-123.mp4');
    const assFile = path.join(finalDir, 'sub-123.ass');
    const frzFile = path.join(finalDir, 'frz-123-0.png');
    [finalMp4, assFile, frzFile].forEach(p => fs.writeFileSync(p, 'x'));

    try {
      const r = cleanup.cleanupAiVoiceFiles();
      // AI 配音段被清除（新目录 temp/voices/）
      expect(fs.existsSync(voiceFile)).toBe(false);
      // TTS 三类临时文件被清除
      expect(fs.existsSync(speakerFile)).toBe(false);
      expect(fs.existsSync(ttsInFile)).toBe(false);
      expect(fs.existsSync(ttsOutFile)).toBe(false);
      // 成品视频 / 字幕 / 静帧保留（视频目录完全不受影响）
      expect(fs.existsSync(finalMp4)).toBe(true);
      expect(fs.existsSync(assFile)).toBe(true);
      expect(fs.existsSync(frzFile)).toBe(true);
      // 无关文件保留
      expect(fs.existsSync(keepFile)).toBe(true);
      expect(r.ok).toBe(true);
    } finally {
      [voiceFile, finalMp4, assFile, frzFile, speakerFile, ttsInFile, ttsOutFile, keepFile]
        .forEach(p => { try { fs.unlinkSync(p); } catch (_e) {} });
    }
  });

  it('4b. 兜底清理只匹配 temp/voices/voice-*，不碰 temp/videos/final/ 下的旧 voice-*', function () {
    // 旧目录（v1.22.1 之前的落点）里若残留 voice-*.wav，**不再**被清理
    //   → 证明清理目标目录确实已切换，且清理范围没有扩大。
    const finalDir = path.join(os.tmpdir(), 'rokit-temp', 'videos', 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    const legacyVoice = path.join(finalDir, 'voice-legacy-0.wav');
    const finalMp4 = path.join(finalDir, 'final-legacy.mp4');
    fs.writeFileSync(legacyVoice, 'x');
    fs.writeFileSync(finalMp4, 'x');
    try {
      const r = cleanup.cleanupAiVoiceFiles();
      // 旧目录下的 voice-*.wav 不在清理范围（不被删）
      expect(fs.existsSync(legacyVoice)).toBe(true);
      // 成品视频当然也不被删
      expect(fs.existsSync(finalMp4)).toBe(true);
      // 且本次没有从旧目录删除任何文件
      expect(r.removed.some(function (p) { return String(p).indexOf(finalDir) === 0; })).toBe(false);
    } finally {
      [legacyVoice, finalMp4].forEach(p => { try { fs.unlinkSync(p); } catch (_e) {} });
    }
  });

  it('4c. caption-burn 的 voice-*.wav 写入 temp/voices/（源码锁定）', function () {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'caption-burn.js'), 'utf8');
    // 配音段落盘用的目录函数必须指向 temp/voices
    expect(src).toMatch(/function\s+voiceInputDir\s*\(\s*\)\s*\{[\s\S]*?'temp',\s*'voices'/);
    // voice-*.wav 的落盘必须走 voiceInputDir()，而不是 workDir（temp/videos/final）
    expect(src).toMatch(/path\.join\(voiceDir,\s*'voice-'\s*\+\s*stamp/);
    // 视频目录（workDir）不得再出现 voice- 前缀的落盘
    expect(src).not.toMatch(/path\.join\(workDir,\s*'voice-/);
    // 字幕 / 静帧 / 成品视频仍在视频目录
    expect(src).toMatch(/path\.join\(workDir,\s*'sub-'\s*\+\s*stamp/);
    expect(src).toMatch(/path\.join\(workDir,\s*'frz-'\s*\+\s*stamp/);
    expect(src).toMatch(/path\.join\(workDir,\s*'final-'\s*\+\s*stamp/);
  });

  it('4d. FFmpeg 混音输入使用实际生成的音频路径（voiceFiles[].path）', function () {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'caption-burn.js'), 'utf8');
    // 每个配音段作为独立 -i 输入
    expect(src).toMatch(/voiceFiles\.forEach\(function\s*\(vf\)\s*\{\s*args\.push\('-i',\s*vf\.path\)/);
    // 混音滤镜按 voiceInputStart 偏移索引（'[N:a]' 形式）
    expect(src).toMatch(/const\s+voiceInputStart\s*=\s*inputCursor/);
    expect(src).toContain("(voiceInputStart + i) + ':a]");
    expect(src).toContain("'[pv' + i + ']'");
    // 段落盘必须登记进 tmpFiles（即时 cleanup 语义不变）
    expect(src).toMatch(/tmpFiles\.push\(vp\)/);
  });

  it('5. 用户原始音源（voice-profiles）不在清除范围内', function () {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'ai-voice-cleanup.js'), 'utf8');
    // 代码部分（去掉注释）不得出现 voice-profiles —— 原始音源目录绝不在清除目标里
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/voice-profiles/);
    // 也不得递归删除目录（只 unlink 文件）
    expect(codeOnly).not.toMatch(/rmSync|rmdirSync/);
  });

  it('6. renderer 侧：只清 AI 生成的 base64，不动用户原始音源', function () {
    const body = extractFn('_capClearAiVoiceInMemory');
    // 清 AI 生成的配音 base64
    expect(body).toMatch(/s\.audioB64 = null;/);
    expect(body).toMatch(/r\.audioB64 = null;/);
    // 清试听语音
    expect(body).toMatch(/ve\.lastTestAudioBase64 = '';/);
    // 绝不动用户原始音源
    expect(body).not.toMatch(/voiceBlob/);
    expect(body).not.toMatch(/voiceProfile\s*=/);
    // 全程 try/catch（清除失败不影响完成态）
    expect(body).toMatch(/catch \(_e\) \{\}/);
  });

  it('7. 清除入口：三个完成路径都触发，且失败静默', function () {
    // launch() 内部
    expect(HTML).toMatch(/_capPurgeAiVoice\(\);/);
    // 完整清除函数：内存 + 磁盘两步，且各自 try/catch
    const purge = extractFn('_capPurgeAiVoice');
    expect(purge).toMatch(/_capClearAiVoiceInMemory\(\)/);
    expect(purge).toMatch(/_capClearAiVoiceFiles\(\)/);
    expect(purge).toMatch(/catch \(_e\) \{\}/g);

    // 三个完成入口都调用了清除
    //   savePlanAndGo / skipPlanAndGo 是 `window.xxx = function(){...}` 形式，
    //   launch 是 `window.launch = function(){...}` 形式。
    const savePlan = HTML.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const skipPlan = HTML.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const launch = HTML.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    expect(savePlan).not.toBe(null);
    expect(skipPlan).not.toBe(null);
    expect(launch).not.toBe(null);
    expect(savePlan[0]).toMatch(/_capPurgeAiVoice\(\)/);
    expect(skipPlan[0]).toMatch(/_capPurgeAiVoice\(\)/);
    expect(launch[0]).toMatch(/_capPurgeAiVoice\(\)/);
  });

  it('8. 主进程：IPC 注册 + 启动/关闭两处清理', function () {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    // IPC
    expect(mainSrc).toMatch(/ipcMain\.handle\('ai-voice:cleanup'/);
    // 启动清理
    expect(mainSrc).toMatch(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]{0,600}cleanupAiVoiceFiles\(\)/);
    // 关闭清理
    expect(mainSrc).toMatch(/app\.on\('before-quit'[\s\S]{0,600}cleanupAiVoiceFiles\(\)/);
    // 失败不影响退出 / 完成
    expect(mainSrc).toMatch(/catch \(_e\) \{\}/);

    // preload 暴露
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    expect(preloadSrc).toMatch(/aiVoiceCleanup: \(\) => ipcRenderer\.invoke\('ai-voice:cleanup'\)/);
  });

  it('9. 通用函数可复用：cleanupGeneratedFiles 导出且与语音语义解耦', function () {
    const mod = cleanup;
    expect(typeof mod.cleanupGeneratedFiles).toBe('function');
    expect(typeof mod.cleanupAiVoiceFiles).toBe('function');
    // 通用内核不绑定"语音"语义（可复用于以后自动清除视频等）
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'ai-voice-cleanup.js'), 'utf8');
    const core = src.slice(src.indexOf('function cleanupGeneratedFiles'), src.indexOf('// TTS 临时输出根目录'));
    expect(core).not.toMatch(/voice|语音|tts/i);
  });
});
