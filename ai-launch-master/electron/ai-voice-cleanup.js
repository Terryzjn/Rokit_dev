// Rokit · AI 生成语音的自动清除
//
// 只清除**明确属于 AI 生成**的语音文件，不整目录清空、不碰用户原始音源。
//
// v1.22（目录统一）：清理目标随 voice-engine.js 的落盘位置同步收敛到 temp/voices。
//
// 清除范围（磁盘）：
//   1. AI 参考音频临时文件   <tempVoices>/rokit-tts-speaker-<rand>.<ext>
//   2. AI 合成中间文件       <tempVoices>/rokit-tts-in-<rand>.<ext>
//                             <tempVoices>/rokit-tts-out-<rand>.wav
//                             （tempVoices = <userData>/temp/voices；
//                              非 Electron 环境回退到 os.tmpdir()/rokit-temp/voices）
//   3. AI 配音段落盘文件     <tempVoices>/voice-<stamp>-<i>.wav
//                             （caption-burn 的 FFmpeg 混音输入；
//                              v1.22.1 起与 TTS 临时文件同目录）
//                             （tempVoices = <userData>/temp/voices；
//                              非 Electron 环境回退到 os.tmpdir()/rokit-temp/voices）
//
// 明确保护：
//   - <userData>/voice-profiles/**            用户自己录制 / 导入的原始音源
//   - <tempVideos>/final/ 下其它文件（成品视频 final-*.mp4、字幕 sub-*.ass、静帧 frz-*）
//   - 任何文件名不符合上述特征的临时文件
//
// 通用性：cleanupGeneratedFiles() 是通用内核（按「目录 + 名称正则」清除文件），
//   以后要自动清除视频等其它生成物，只需再加一个语义包装函数即可，不必重写匹配逻辑。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// —— 通用内核 ——
// 只删除**文件**（绝不递归删目录），只删除名称匹配 patterns 的文件。
// 返回 { removed:[路径], failed:[{path,error}] }；任何失败都被吞掉，不影响调用方主流程。
function cleanupGeneratedFiles(groups, opts) {
  opts = opts || {};
  const removed = [];
  const failed = [];
  (groups || []).forEach(function (g) {
    if (!g || !g.dir || !Array.isArray(g.patterns)) return;
    let names;
    try { names = fs.readdirSync(g.dir); }
    catch (_e) { return; }   // 目录不存在 / 无权限 → 静默跳过
    for (const name of names) {
      let matched = false;
      for (const re of g.patterns) {
        try { if (re.test(name)) { matched = true; break; } } catch (_e) {}
      }
      if (!matched) continue;
      const full = path.join(g.dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;    // 只删文件，目录一律保留
        if (opts.dryRun) { removed.push(full); continue; }
        fs.unlinkSync(full);
        removed.push(full);
      } catch (e) {
        failed.push({ path: full, error: String((e && e.message) || e) });
      }
    }
  });
  return { removed: removed, failed: failed, count: removed.length };
}

// TTS 临时输出根目录（与 electron/voice-engine.js 的 _resolveTtsTmpRoot 同口径）。
// v1.22（目录统一）：<userData>/temp/voices（非 Electron 环境回退 os.tmpdir()/rokit-temp/voices）。
// 这里只**计算路径**，不 mkdir、不做写权限探测（仅用于扫描目录）。
function _ttsTmpRoot() {
  try {
    const electron = require('electron');
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === 'function') {
      const ud = app.getPath('userData');
      if (ud) return path.join(ud, 'temp', 'voices');
    }
  } catch (_e) { /* 非 Electron 环境 → fallback */ }
  return path.join(os.tmpdir(), 'rokit-temp', 'voices');
}

// 临时视频根目录（与 electron/caption-burn.js / video.js 的 outputDir 同口径）。
// v1.22（目录统一）：<userData>/temp/videos（非 Electron 环境回退 os.tmpdir()/rokit-temp/videos）。
function _tempVideosRoot() {
  try {
    const electron = require('electron');
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === 'function') {
      const ud = app.getPath('userData');
      if (ud) return path.join(ud, 'temp', 'videos');
    }
  } catch (_e) { /* 非 Electron 环境 → fallback */ }
  return path.join(os.tmpdir(), 'rokit-temp', 'videos');
}

// —— AI 语音专用包装 ——
// 语义化入口：清除本次作品 / 上次会话遗留的 AI 生成语音文件。
// 保护：voice-profiles（用户原始音源）、temp/videos/final 下的成品视频与字幕。
function cleanupAiVoiceFiles(opts) {
  opts = opts || {};
  const groups = [
    // 1) 参考音频 + ffmpeg 输入中间文件（与 TTS 输出同目录）
    {
      dir: _ttsTmpRoot(),
      patterns: [/^rokit-tts-speaker-/i, /^rokit-tts-in-/i]
    },
    // 2) ffmpeg 输出中间文件（与 TTS 输出同目录）
    {
      dir: _ttsTmpRoot(),
      patterns: [/^rokit-tts-out-/i]
    },
    // 3) caption-burn 落盘的 AI 配音段
    //    v1.22.1：voice-*.wav 已迁到 <userData>/temp/voices/（与 TTS 临时文件同目录），
    //    前缀规则不变；temp/videos/final/ 下的 final-*.mp4 / sub-*.ass / frz-* 不在清除范围。
    {
      dir: _ttsTmpRoot(),
      patterns: [/^voice-/i]
    }
  ];
  const r = cleanupGeneratedFiles(groups, opts);
  return {
    ok: r.failed.length === 0,
    removedCount: r.count,
    removed: r.removed,
    failed: r.failed
  };
}

module.exports = {
  cleanupAiVoiceFiles,
  cleanupGeneratedFiles,
  _ttsTmpRoot,
  _tempVideosRoot
};

