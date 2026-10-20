'use strict';
// Rokit · 成品视频合成（冻结插入 + 字幕烧录 + AI 配音混音）
//
// 用途：把字幕轨道上的实际片段烧录进最终 MP4，使用户用普通播放器打开即可看到字幕。
//
// 时间轴模型（与渲染层 _capSourceToOutput 严格同源）：
//   output = source + Σ(frozen.duration | frozen.at < source)
//   展开后输出时间轴是一条简单的主序列：
//     源[0→f1.at] → 冻结帧f1(d1) → 源[f1.at→f2.at] → 冻结帧f2(d2) → … → 源[fn.at→srcDur]
//   冻结帧占用输出区间 [f.at, f.at + f.duration)。
//   字幕用渲染层算好的 OUT 时间（seg.outStart/outEnd），天然与最终视频一致。
//
// 字幕文字唯一来源：调用方传入的 segments[].text（字幕轨道上的真实片段）。
// 不读字幕素材库、不读原始文章正文。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');

const ffmpegResolver = require('./ffmpeg-resolver');

// ---------- 与 video.js 一致的串行队列，避免并发 ffmpeg 打满 CPU ----------
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(function () { return fn(); }, function () { return fn(); });
  queue = next.catch(function () { return null; });
  return next;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_e) {}
}

function outputDir(sub) {
  try {
    return path.join(app.getPath('userData'), 'video', sub || '');
  } catch (_e) {
    return path.join(os.tmpdir(), 'rokit-video', sub || '');
  }
}

// ffmpeg filter/filter_complex 参数里的路径转义（Windows 盘符 + 反斜杠 + 引号）
function _ffPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ---------- ASS 字幕 ----------
// 时间格式 h:mm:ss.cc（厘秒）
function _assTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// ASS 内需要转义的字符（反斜杠最先处理，避免二次转义）
function _assEscape(t) {
  return String(t == null ? '' : t)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, ' ');
}

// 简单清晰易读的样式：画面下方居中、白字黑边，无特效
function buildAss(segments, opts) {
  const o = opts || {};
  const height = Number(o.height) || 1920;
  const width = Number(o.width) || 1080;
  // 字号同时受高度与宽度约束：竖屏短视频（窄）若只按高度算会溢出画面，
  // 因此取"按短边折算"的结果作为上限。
  const byHeight = height * (o.fontScale || 0.042);
  const byWidth = width * (o.widthScale || 0.075);
  const fontSize = Math.max(14, Math.round(Math.min(byHeight, byWidth)));
  const marginV = Math.round(height * 0.06);
  const marginH = Math.round(width * 0.06);
  const outline = Math.max(1.5, Math.round(fontSize * 0.1));
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // 关键：显式声明播放分辨率，libass 才会按真实画面尺寸折算字号；
    // 缺省时它会用视频的 SAR/DAR 自行猜测，导致竖屏视频字号溢出。
    'PlayResX: ' + width,
    'PlayResY: ' + height,
    // WrapStyle 0 =智能换行：长字幕自动折行，避免超出画面被裁切
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,' + (o.fontName || 'Microsoft YaHei') + ',' + fontSize
      + ',&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000'
      + ',0,0,0,0,100,100,0,0,1,' + outline + ',1,2,' + marginH + ',' + marginH + ',' + marginV + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  let n = 0;
  (segments || []).forEach(function (seg) {
    if (!seg) return;
    const text = _assEscape(seg.text);
    if (!text.trim()) return;
    const start = Number(seg.outStart);
    const end = Number(seg.outEnd);
    if (!isFinite(start) || !isFinite(end) || end <= start) return;
    n++;
    lines.push('Dialogue: 0,' + _assTime(start) + ',' + _assTime(end) + ',Default,,0,0,0,,' + text);
  });
  return { content: lines.join('\n') + '\n', count: n, fontSize: fontSize };
}

// ---------- 输出时间轴展开 ----------
// 返回 { pieces:[...], finalDuration }
//   piece = { type:'video', from, to }            源视频区间 [from,to)
//   piece = { type:'freeze', at, duration }       冻结帧（输出起点 = at + 之前累计冻结）
function buildTimeline(srcDur, frozen) {
  const fr = (frozen || [])
    .filter(function (f) { return f && Number(f.duration) > 0; })
    .map(function (f) {
      const at = Math.max(0, Number(f.at) || 0);
      const duration = Number(f.duration) || 0;
      return { at: at, duration: duration };
    })
    .sort(function (a, b) { return a.at - b.at; });

  // 同一位置的冻结段合并，避免生成 0 长度的视频片段
  const merged = [];
  fr.forEach(function (f) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.at - f.at) < 0.001) last.duration += f.duration;
    else merged.push({ at: f.at, duration: f.duration });
  });

  const pieces = [];
  let cursor = 0;
  let frozenSoFar = 0;
  merged.forEach(function (f) {
    const at = Math.max(0, Math.min(srcDur, f.at));
    if (at > cursor + 0.001) {
      pieces.push({ type: 'video', from: cursor, to: at });
    }
    const dur = f.duration;
    if (dur > 0) {
      pieces.push({ type: 'freeze', at: at, duration: dur, outStart: at + frozenSoFar });
      frozenSoFar += dur;
    }
    cursor = Math.max(cursor, at);
  });
  if (srcDur > cursor + 0.001) {
    pieces.push({ type: 'video', from: cursor, to: srcDur });
  }
  return { pieces: pieces, finalDuration: srcDur + frozenSoFar, frozenTotal: frozenSoFar };
}

// 与渲染层 _capSourceToOutput 同源映射（供测试与校验）
function sourceToOutputMap(frozen) {
  const fr = (frozen || [])
    .filter(function (f) { return f && Number(f.duration) > 0; })
    .slice()
    .sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0); });
  return function (sourceT) {
    let out = Number(sourceT) || 0;
    for (let i = 0; i < fr.length; i++) {
      if ((Number(fr[i].at) || 0) < sourceT) out += Number(fr[i].duration) || 0;
    }
    return out;
  };
}

// ---------- ffmpeg 执行 ----------
function runFfmpeg(args, timeoutMs) {
  const r = ffmpegResolver.resolveFfmpegPath();
  if (!r.ok) {
    const tried = (r.tried || []).map(function (t) {
      return t.source + (t.path ? '(' + t.path + ')' : '');
    }).join(' | ');
    return Promise.reject(new Error('ffmpeg-unavailable:' + (r.reason || 'no-runnable-ffmpeg') + ' | tried=' + (tried || 'none')));
  }
  return new Promise(function (resolve, reject) {
    let stderr = '';
    let proc;
    try {
      proc = spawn(r.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return reject(new Error('ffmpeg-spawn-failed:' + (e && e.message || e))); }
    const timer = setTimeout(function () {
      try { proc.kill(); } catch (_e) {}
      reject(new Error('ffmpeg-timeout:' + Math.round((timeoutMs || 300000) / 1000) + 's'));
    }, timeoutMs || 300000);
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function (e) { clearTimeout(timer); reject(new Error('ffmpeg-error:' + (e && e.message || e))); });
    proc.on('close', function (code) {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const tail = stderr.split('\n').filter(function (l) { return l.trim(); }).slice(-10).join(' | ');
      reject(new Error('ffmpeg-exit-' + code + ': ' + tail.slice(0, 800)));
    });
  });
}

// ---------- 探测源视频尺寸 ----------
// concat 滤镜要求所有输入尺寸一致，静帧/黑帧必须对齐源视频尺寸，否则报
// "Input link ... parameters do not match the corresponding output link"。
function probeVideoSize(inputPath) {
  return new Promise(function (resolve) {
    const r = ffmpegResolver.resolveFfmpegPath();
    if (!r.ok) return resolve(null);
    let stderr = '';
    let proc;
    try {
      proc = spawn(r.path, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_e) { return resolve(null); }
    const timer = setTimeout(function () {
      try { proc.kill(); } catch (_e) {}
      resolve(null);
    }, 8000);
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function () { clearTimeout(timer); resolve(null); });
    proc.on('close', function () {
      clearTimeout(timer);
      const m = /Stream\b[^\n]*?Video:[^\n]*?(\d{2,5})x(\d{2,5})/i.exec(stderr);
      if (m) {
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (w > 0 && h > 0) return resolve({ width: w, height: h });
      }
      resolve(null);
    });
  });
}

// 把任意尺寸输入统一到 targetW × targetH（等比缩放 + 居中补边），并归一 SAR/pix_fmt
function _fitTo(w, h, targetW, targetH, label) {
  return '[' + label + ']scale=w=' + targetW + ':h=' + targetH
    + ':force_original_aspect_ratio=decrease'
    + ',pad=' + targetW + ':' + targetH + ':(ow-iw)/2:(oh-ih)/2:color=black'
    + ',setsar=1,format=yuv420p,fps=25,settb=AVTB[vfit' + label + ']';
}

// ---------- 主入口 ----------
// inputPath : 原视频绝对路径
// segments  : [{ text, outStart, outEnd, audioB64, audioMime }]
// frozen    : [{ at, duration, frameB64, frameMime }]
// opts.duration      原视频时长（秒）
// opts.burnSubtitle  是否烧录字幕（默认 true）
// opts.withVoice     是否混入 AI 配音（默认 true）
function burnFinalVideo(inputPath, segments, frozen, opts) {
  const o = opts || {};
  if (!inputPath || !fs.existsSync(inputPath)) return Promise.reject(new Error('input-not-found'));

  const srcDur = Number(o.duration) || 0;
  const burnSub = o.burnSubtitle !== false;
  const withVoice = o.withVoice !== false;

  const segs = (segments || []).filter(function (s) {
    return s && typeof s.text === 'string' && s.text.trim()
      && isFinite(Number(s.outStart)) && isFinite(Number(s.outEnd))
      && Number(s.outEnd) > Number(s.outStart);
  });
  const voiceSegs = withVoice
    ? segs.filter(function (s) { return typeof s.audioB64 === 'string' && s.audioB64.length > 100; })
    : [];

  const tl = buildTimeline(srcDur, frozen);
  if (!tl.pieces.length) return Promise.reject(new Error('empty-timeline:缺少可用的时间轴（视频时长为 0？）'));

  const workDir = outputDir('final');
  ensureDir(workDir);
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const outPath = path.join(workDir, 'final-' + stamp + '.mp4');
  const tmpFiles = [];

  function cleanup() {
    tmpFiles.forEach(function (p) { try { fs.unlinkSync(p); } catch (_e) {} });
  }

  // ---- 1) 字幕：生成 ASS（在拿到真实分辨率之后写，见下方 probeVideoSize 分支） ----
  let ass = { content: '', count: 0 };

  function writeAss(TW, TH) {
    if (!burnSub || !segs.length) return null;
    const a = buildAss(segs, { width: TW, height: TH, fontName: o.fontName });
    const p = path.join(workDir, 'sub-' + stamp + '.ass');
    try {
      fs.writeFileSync(p, a.content, 'utf8');
      tmpFiles.push(p);
      ass = a;
      return p;
    } catch (e) {
      cleanup();
      throw new Error('ass-write-failed:' + (e && e.message || e));
    }
  }

  // ---- 2) 冻结静帧落盘 ----
  const freezeFrames = {};
  (frozen || []).forEach(function (f, i) {
    if (!f || !f.frameB64) return;
    try {
      const ext = f.frameMime && /png/i.test(f.frameMime) ? '.png' : '.jpg';
      const p = path.join(workDir, 'frz-' + stamp + '-' + i + ext);
      fs.writeFileSync(p, Buffer.from(String(f.frameB64).replace(/^data:image\/[a-z0-9]+;base64,/i, ''), 'base64'));
      tmpFiles.push(p);
      freezeFrames[Number(f.at) || 0] = p;
    } catch (_e) { /* 无静帧则退化为黑帧 */ }
  });

  // ---- 3) 配音逐段落盘 ----
  const voiceFiles = [];
  for (let i = 0; i < voiceSegs.length; i++) {
    try {
      const clean = String(voiceSegs[i].audioB64).replace(/^data:audio\/[a-z0-9]+;base64,/i, '');
      const buf = Buffer.from(clean, 'base64');
      if (!buf || buf.length < 100) continue; // 空/截断音频不参与混音
      const vp = path.join(workDir, 'voice-' + stamp + '-' + i + '.wav');
      fs.writeFileSync(vp, buf);
      tmpFiles.push(vp);
      voiceFiles.push({ path: vp, at: Math.max(0, Number(voiceSegs[i].outStart) || 0) });
    } catch (_e) { /* 单段落盘失败跳过 */ }
  }

  return enqueue(function () {
    const args = ['-y'];
    const filters = [];
    // 调试开关：ROKIT_BURN_DEBUG=1 时把完整命令打到 stderr
    var __dbg = false;
    try { __dbg = !!process.env.ROKIT_BURN_DEBUG; } catch (_e) {}

    return probeVideoSize(inputPath).then(function (size) {
    return probeHasAudio(inputPath).then(function (hasAudio) {
    // 未探测到尺寸时退回 720p（保证filter 图自洽，优于直接失败）
    const TW = (size && size.width) || 1280;
    const TH = (size && size.height) || 720;
    if (__dbg) {
      try {
        console.error('[caption-burn] target size ' + TW + 'x' + TH + ' 源含音轨=' + hasAudio);
      } catch (_e) {}
    }
    // 字幕样式依赖真实分辨率，必须在这里生成
    const ASS_PATH = writeAss(TW, TH);

    // ---- 输入布局（索引必须严格对应，先规划再拼 args） ----
    //   input 0        : 原视频（取原音轨 / 无冻结时兜底）
    //   input 1..R     : 各视频区间（-ss/-t 精确读取，R = 视频区间个数）
    //   input ..      : 各冻结静帧（-loop 1 -i 逐帧输入）
    //   最后 R+F+1..   : 各配音 wav
    //   注意：freeze 片段**必须**占用一个 input（用 -loop 1 -i 读静帧），
    //   不能用 movie= 滤镜读图片 —— movie= 的路径不支持 '\:' 转义，
    //   在 Windows 上会报 Failed to avformat_open_input 'C'。
    let inputCursor = 1;
    const pieceInputIdx = [];   // 每个 piece 对应的 input 索引
    const freezePieceIdx = [];  // 冻结段在 frozen 数组中的下标（video 段为 -1）
    tl.pieces.forEach(function (piece) {
      if (piece.type === 'video') {
        pieceInputIdx.push(inputCursor);
        freezePieceIdx.push(-1);
        inputCursor++;
      } else {
        pieceInputIdx.push(inputCursor);
        freezePieceIdx.push(piece.frozenIndex != null ? piece.frozenIndex : 0);
        inputCursor++;
      }
    });
    const voiceInputStart = inputCursor;

    // 依序追加 -i（顺序必须与上面规划一致）
    args.push('-i', inputPath);                                    // input 0
    tl.pieces.forEach(function (piece) {
      if (piece.type === 'video') {
        args.push('-ss', piece.from.toFixed(3), '-t', (piece.to - piece.from).toFixed(3), '-i', inputPath);
      } else {
        const fp = freezeFrames[piece.at];
        if (fp) {
          // 静帧：作为独立输入循环读入，按 -t 截断
          args.push('-loop', '1', '-t', piece.duration.toFixed(3), '-i', fp);
        } else {
          // 无静帧：用纯黑 lavfi 源（作为独立输入，尺寸对齐目标）
          args.push('-f', 'lavfi', '-t', piece.duration.toFixed(3),
            '-i', 'color=c=black:s=' + TW + 'x' + TH + ':r=25');
        }
      }
    });
    voiceFiles.forEach(function (vf) { args.push('-i', vf.path); });

    // ---- 视频链：所有片段统一到 TW×TH / SAR1 / yuv420p / 25fps ----
    const videoLabels = [];
    tl.pieces.forEach(function (piece, vi) {
      // _fitTo(..., label) 会产出名为 vfit<label> 的输出；label 直接用 raw<vi>，
      // 输出即 vfitraw<vi>，两者必须一致，不能再额外拼接前缀。
      const lbl = 'raw' + vi;
      const src = '[' + pieceInputIdx[vi] + ':v]setpts=PTS-STARTPTS[' + lbl + ']';
      filters.push(src);
      filters.push(_fitTo(TW, TH, TW, TH, lbl));
      videoLabels.push('vfit' + lbl);
    });

    let vLabel;
    if (videoLabels.length === 1) {
      vLabel = videoLabels[0];
    } else {
      filters.push(videoLabels.map(function (l) { return '[' + l + ']'; }).join('') + 'concat=n=' + videoLabels.length + ':v=1:a=0[vcat]');
      vLabel = 'vcat';
    }
    filters.push('[' + vLabel + ']settb=AVTB,setpts=PTS-STARTPTS[vbase]');

    // ---- 字幕烧录（时间戳已是 OUT 时间，直接对齐最终视频） ----
    let vFinal = 'vbase';
    if (burnSub && ass.count > 0 && ASS_PATH) {
      filters.push('[vbase]subtitles=filename=\'' + _ffPath(ASS_PATH) + '\'[vsub]');
      vFinal = 'vsub';
    }
    filters.push('[' + vFinal + ']null[vout]');

    // ---- 音频：原音轨（仅当源视频确实有音轨时）+ AI 配音 ----
    //   originalAudio: 'mute'（默认，AI 配音为主）/ 'keep'（保留原声）/ 'duck'（原声压低作底噪）
    //   修复：无条件写 [0:a] 会在「源视频无音轨」时导致 ffmpeg 报
    //     Stream specifier ':a' in filtergraph description ...（退出码 -22）。
    //   现在由 hasAudio 决定：有音轨才引用 [0:a]；没有音轨就不产出 orig 分支，
    //   仅用 AI 配音（有配音时）或 anullsrc 静音底床（无配音时）保证输出仍有音频流。
    const mode = o.originalAudio === 'keep' || o.originalAudio === 'duck' ? o.originalAudio : 'mute';
    const origGain = mode === 'keep' ? 1 : (mode === 'duck' ? 0.15 : 0);
    const aLabels = [];
    if (hasAudio) {
      filters.push('[0:a]volume=' + origGain + ',aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[orig]');
      aLabels.push('orig');
    }
    voiceFiles.forEach(function (vf, i) {
      const ms = Math.max(0, Math.round(vf.at * 1000));
      filters.push('[' + (voiceInputStart + i) + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=' + ms + '|' + ms + '[pv' + i + ']');
      aLabels.push('pv' + i);
    });

    let aFinal;
    if (aLabels.length === 0) {
      // 既无原音轨也无配音 → 造一段静音底床，保证输出文件含音频流
      filters.push('anullsrc=channel_layout=stereo:sample_rate=44100,'
        + 'aformat=sample_fmts=fltp:channel_layouts=stereo[amix]');
      aFinal = 'amix';
    } else if (aLabels.length === 1) {
      aFinal = aLabels[0];
    } else {
      // duration=longest：让配音长度决定总时长，与 -t finalDuration 共同收敛
      filters.push(aLabels.map(function (l) { return '[' + l + ']'; }).join('')
        + 'amix=inputs=' + aLabels.length + ':duration=longest:dropout_transition=0:normalize=0[amix]');
      aFinal = 'amix';
    }
    filters.push('[' + aFinal + ']aformat=sample_rates=44100:channel_layouts=stereo,apad[aout]');

    args.push('-filter_complex', filters.join(';'));
    if (__dbg) {
      try { console.error('[caption-burn] ARGS:\n' + args.join(' ')); } catch (_e) {}
    }
    args.push('-map', '[vout]', '-map', '[aout]');
    args.push('-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', String(o.crf || 23), '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '160k');
    args.push('-movflags', '+faststart');
    args.push('-t', tl.finalDuration.toFixed(3));
    args.push(outPath);

    return runFfmpeg(args, o.timeoutMs || 300000).then(function () {
      // ---- 成品校验：必须存在且非空 ----
      if (!fs.existsSync(outPath)) throw new Error('output-not-created');
      const st = fs.statSync(outPath);
      if (!st.size || st.size < 1024) throw new Error('output-too-small:' + st.size);
      cleanup();
      return {
        ok: true,
        path: outPath,
        bytes: st.size,
        subtitlesBurned: ass.count,
        voiceTracks: voiceFiles.length,
        sourceDuration: srcDur,
        frozenTotal: tl.frozenTotal,
        finalDuration: tl.finalDuration
      };
    }).catch(function (e) {
      cleanup();
      throw e;
    });
    });   // ← probeHasAudio().then(...)
    });   // ← probeVideoSize().then(...)
  });
}

// 探测源视频是否含音频流。
//   必须先探测再决定滤镜图怎么写：无条件引用 [0:a] 会在「源视频无音轨」时
//   让 ffmpeg 在构建 filtergraph 阶段直接失败：
//     Stream specifier ':a' in filtergraph description ...
//     （退出码 -22 / 4294967274）
function probeHasAudio(inputPath) {
  return new Promise(function (resolve) {
    const r = ffmpegResolver.resolveFfmpegPath();
    if (!r.ok) return resolve(false);
    let stderr = '';
    let proc;
    try {
      proc = spawn(r.path, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_e) { return resolve(false); }
    const timer = setTimeout(function () {
      try { proc.kill(); } catch (_e) {}
      resolve(false);
    }, 8000);
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function () { clearTimeout(timer); resolve(false); });
    proc.on('close', function () {
      clearTimeout(timer);
      resolve(/Stream #\d+:\d+.*:\s*Audio:/i.test(stderr));
    });
  });
}

module.exports = {
  burnFinalVideo,
  buildAss,
  buildTimeline,
  sourceToOutputMap,
  _internals: { _assTime: _assTime, _assEscape: _assEscape, runFfmpeg: runFfmpeg }
};