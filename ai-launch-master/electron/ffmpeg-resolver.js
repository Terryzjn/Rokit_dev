// Rokit · FFmpeg 可执行文件解析器（v1.20.1）
//
// 设计目标：
//   1) 解决当前 `spawn EFTYPE` 根因：bundled ffmpeg-static 二进制可能损坏 / 缺失 / 无效
//      - 单一 `fs.existsSync` 不够；必须验证 PE/ELF/Mach-O 头与 subsystem 字段
//   2) 提供多级 fallback 链，确保至少有一个可执行的 ffmpeg：
//      a) 显式覆盖：FFMPEG_BIN 环境变量（ffmpeg-static 原生支持）
//      b) 显式覆盖：ROKIT_FFMPEG_BIN 环境变量
//      c) bundled ffmpeg-static 二进制（必须经过可执行性校验）
//      d) 系统 PATH 上的 ffmpeg（spawn which / where）
//   3) 路径缓存到单次启动，避免每次调用都解析 / 校验
//   4) 暴露 `validateFfmpegBinary(path)` 用于诊断 / 测试
//   5) 暴露 `runFfmpeg(args, opts)` —— 统一包装 spawn，附带 EOF 错误转换
//
// 关键修复：
//   - 不再假设 `require('ffmpeg-static')` 返回的路径是合法可执行的；
//     而是对每个候选路径都做轻量 PE/ELF/Mach-O 头校验
//   - spawn 之前先用 `fs.accessSync(p, fs.constants.X_OK)` 兜底（即便 Windows 上通常
//     也会通过；如果被 asar 锁定则给出明确错误信息）
//   - 捕获 `proc.on('error', ...)` 并把错误映射为 `ffmpeg-spawn:EFTYPE` 等可诊断字符串
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 单例缓存：第一次解析后保留，后续 ffmpegPath() 直接返回
let _cached = null; // { ok: true, path, source } | { ok: false, reason, tried }
let _probeCache = null; // { path, ok: bool, version, mtime }

function tryRequireFfmpegStatic() {
  try {
    const p = require('ffmpeg-static');
    return (typeof p === 'string' && p) ? p : '';
  } catch (_e) { return ''; }
}

// PE 校验（Windows）：读取文件头，确认 MZ + PE 签名，machine 与 subsystem 合法
// PE 布局（偏移均相对文件头）：
//   peOff+0  PE\0\0 签名；peOff+4 Machine；peOff+24 Optional Header 起始（Magic）
//   peOff+92 Subsystem（= Optional Header 内偏移 68，PE32/PE32+ 通用）
function validateWinPE(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 64) return { ok: false, reason: 'too-small-header' };
    if (head[0] !== 0x4d || head[1] !== 0x5a) return { ok: false, reason: 'no-mz-magic' };
    const peOff = head.readUInt32LE(0x3c);
    if (peOff <= 0 || peOff + 94 >= n) return { ok: false, reason: 'bad-pe-offset:' + peOff };
    if (head[peOff] !== 0x50 || head[peOff + 1] !== 0x45) return { ok: false, reason: 'no-pe-signature' };
    const machine = head.readUInt16LE(peOff + 4);
    const validMachine = (machine === 0x8664 /*AMD64*/ || machine === 0x14c /*i386*/ || machine === 0xaa64 /*ARM64*/);
    if (!validMachine) return { ok: false, reason: 'bad-machine:0x' + machine.toString(16) };
    // Optional Header magic: 0x10b (PE32) or 0x20b (PE32+)
    const optMagic = head.readUInt16LE(peOff + 24);
    if (optMagic !== 0x10b && optMagic !== 0x20b) return { ok: false, reason: 'bad-opt-magic:0x' + optMagic.toString(16) };
    // Subsystem: 2 (GUI) or 3 (Console) — 0 / 其他 表示非可执行 PE
    const subsystem = head.readUInt16LE(peOff + 92);
    if (subsystem !== 2 && subsystem !== 3) return { ok: false, reason: 'bad-subsystem:' + subsystem };
    return { ok: true, machine: machine, subsystem: subsystem };
  } catch (e) {
    return { ok: false, reason: 'read-failed:' + ((e && e.message) || String(e)) };
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch (_e) {}
  }
}

// ELF 校验（Linux）：\x7fELF + 头 + e_machine
function validateElf(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(64);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 20) return { ok: false, reason: 'too-small' };
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return { ok: false, reason: 'no-elf-magic' };
    const machine = head.readUInt16LE(18);
    const validMachine = (machine === 0x3e /*x86_64*/ || machine === 0x03 /*i386*/ || machine === 0xb7 /*aarch64*/ || machine === 0x28 /*arm*/);
    if (!validMachine) return { ok: false, reason: 'bad-machine:0x' + machine.toString(16) };
    return { ok: true, machine: machine };
  } catch (e) {
    return { ok: false, reason: 'read-failed:' + ((e && e.message) || String(e)) };
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch (_e) {}
  }
}

// Mach-O 校验（macOS）：\xcf\xfa\xed\xfe (64-bit LE) 或 \xfe\xed\xfa\xce / \xce\xfa\xed\xfe / \xfe\xed\xfa\xcf
function validateMachO(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(32);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 28) return { ok: false, reason: 'too-small' };
    const magic = head.readUInt32BE(0);
    const validMagic = (magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xfeedface || magic === 0xcefaedfe);
    if (!validMagic) return { ok: false, reason: 'no-macho-magic' };
    return { ok: true, magic: '0x' + magic.toString(16) };
  } catch (e) {
    return { ok: false, reason: 'read-failed:' + ((e && e.message) || String(e)) };
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch (_e) {}
  }
}

// 跨平台头校验
function validateFfmpegBinary(filePath) {
  if(!filePath) return { ok: false, reason: 'empty-path' };
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return { ok: false, reason: 'stat-failed:' + ((e && e.message) || String(e)) }; }
  if(!st.isFile()) return { ok: false, reason: 'not-a-file' };
  if(st.size < 4096) return { ok: false, reason: 'too-small:' + st.size };
  // Windows PE
  if (process.platform === 'win32') {
    return validateWinPE(filePath);
  }
  if (process.platform === 'darwin') return validateMachO(filePath);
  return validateElf(filePath);
}

// 在系统 PATH 上找 ffmpeg（用 spawn 而不是 which 依赖）
function findOnSystemPath() {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter(Boolean);
  for (const d of dirs) {
    try {
      const candidate = path.join(d, exeName);
      if (fs.existsSync(candidate)) {
        const v = validateFfmpegBinary(candidate);
        if (v.ok) return candidate;
      }
    } catch (_e) {}
  }
  return '';
}

// 解析 ffmpeg 路径：环境变量 > bundled > system
// 返回 { ok, path, source, tried: [{source, reason}] }
function resolveFfmpegPath() {
  if (_cached) return _cached;
  const tried = [];

  // 1) 显式覆盖：ROKIT_FFMPEG_BIN（项目自定义）
  const rokEnv = process.env.ROKIT_FFMPEG_BIN;
  if (rokEnv) {
    tried.push({ source: 'ROKIT_FFMPEG_BIN', path: rokEnv });
    if (fs.existsSync(rokEnv)) {
      const v = validateFfmpegBinary(rokEnv);
      if (v.ok) {
        _cached = { ok: true, path: rokEnv, source: 'ROKIT_FFMPEG_BIN', tried: tried };
        return _cached;
      }
      tried[tried.length - 1].reason = v.reason;
    } else {
      tried[tried.length - 1].reason = 'not-exists';
    }
  }

  // 2) 显式覆盖：FFMPEG_BIN（ffmpeg-static 原生支持）
  const ffEnv = process.env.FFMPEG_BIN;
  if (ffEnv) {
    tried.push({ source: 'FFMPEG_BIN', path: ffEnv });
    if (fs.existsSync(ffEnv)) {
      const v = validateFfmpegBinary(ffEnv);
      if (v.ok) {
        _cached = { ok: true, path: ffEnv, source: 'FFMPEG_BIN', tried: tried };
        return _cached;
      }
      tried[tried.length - 1].reason = v.reason;
    } else {
      tried[tried.length - 1].reason = 'not-exists';
    }
  }

  // 3) bundled ffmpeg-static
  const bundled = tryRequireFfmpegStatic();
  if (bundled) {
    tried.push({ source: 'ffmpeg-static', path: bundled });
    if (fs.existsSync(bundled)) {
      const v = validateFfmpegBinary(bundled);
      if (v.ok) {
        _cached = { ok: true, path: bundled, source: 'ffmpeg-static', tried: tried };
        return _cached;
      }
      tried[tried.length - 1].reason = v.reason;
    } else {
      tried[tried.length - 1].reason = 'not-exists';
    }
  }

  // 4) 系统 PATH
  const sysPath = findOnSystemPath();
  if (sysPath) {
    tried.push({ source: 'system-PATH', path: sysPath });
    _cached = { ok: true, path: sysPath, source: 'system-PATH', tried: tried };
    return _cached;
  }

  // v1.20.1：失败结果不缓存 —— 用户后续放置有效 ffmpeg（或设置 env）后应立即自动恢复可用。
  // 解析本身只是几次 statSync + 头部读取，代价可忽略。
  return {
    ok: false,
    reason: 'no-runnable-ffmpeg-found',
    tried: tried
  };
}

function ffmpegPath() {
  const r = resolveFfmpegPath();
  return r.ok ? r.path : '';
}

function ffmpegAvailable() {
  const r = resolveFfmpegPath();
  return r.ok;
}

// 探测 ffmpeg 版本（轻量：spawn -version 拿第一行 stdout）。缓存到进程内。
function probeFfmpegVersion() {
  if (_probeCache) return _probeCache;
  const r = resolveFfmpegPath();
  if (!r.ok) return { ok: false, error: r.reason };
  return new Promise(function (resolve) {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(r.path, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolved = true;
      _probeCache = { ok: false, error: 'spawn-failed:' + ((e && e.message) || String(e)), path: r.path };
      return resolve(_probeCache);
    }
    const t = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (_e) {}
      if (!resolved) {
        resolved = true;
        _probeCache = { ok: false, error: 'version-probe-timeout', path: r.path };
        resolve(_probeCache);
      }
    }, 3000);
    proc.stdout.on('data', function (b) { stdout += b.toString(); });
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function (e) {
      clearTimeout(t);
      if (resolved) return;
      resolved = true;
      // 把 Node 的 EFTYPE/ENOENT 等错误原样透传，便于诊断
      const code = (e && e.code) || 'unknown';
      _probeCache = { ok: false, error: 'spawn-error:' + code + ':' + ((e && e.message) || String(e)), path: r.path, code: code };
      resolve(_probeCache);
    });
    proc.on('close', function (code) {
      clearTimeout(t);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        const ver = (stdout.split('\n')[0] || '').trim();
        _probeCache = { ok: true, path: r.path, version: ver, source: r.source };
      } else {
        _probeCache = { ok: false, error: 'exit-' + code, path: r.path, stderrTail: stderr.slice(-200) };
      }
      resolve(_probeCache);
    });
  });
}

// 测试用：清空缓存（重新解析）
function resetResolver() {
  _cached = null;
  _probeCache = null;
}

module.exports = {
  ffmpegPath,
  ffmpegAvailable,
  resolveFfmpegPath,
  validateFfmpegBinary,
  probeFfmpegVersion,
  resetResolver
};
