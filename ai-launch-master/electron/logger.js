// Rokit · 极简日志模块（主进程）
// 落盘到 userData/logs/rokit.log，单文件最大 1MB，自动 rotate 保留 3 个
const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024; // 1MB
const KEEP_FILES = 3;

let logFile = null;
let initialized = false;

function init(userDataDir) {
  if (initialized) return;
  try {
    const dir = path.join(userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'rokit.log');
    initialized = true;
  } catch (_e) {
    // 初始化失败时不抛，降级为 console 输出
    logFile = null;
  }
}

function ts() {
  const d = new Date();
  function p(x) { return ('0' + x).slice(-2); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function rotate() {
  if (!logFile || !fs.existsSync(logFile)) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < MAX_SIZE) return;
    // rokit.log.2 → 删除，rokit.log.1 → .2，rokit.log → .1
    for (let i = KEEP_FILES; i >= 1; i--) {
      const src = i === 1 ? logFile : logFile + '.' + (i - 1);
      const dst = logFile + '.' + i;
      if (fs.existsSync(src)) {
        if (i === KEEP_FILES && fs.existsSync(dst)) {
          try { fs.unlinkSync(dst); } catch (_e) {}
        }
        try { fs.renameSync(src, dst); } catch (_e) {}
      }
    }
  } catch (_e) {}
}

function write(level, msg, extra) {
  const line = '[' + ts() + '] [' + level.toUpperCase() + '] ' + msg
    + (extra ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '');

  // 永远打到 stderr（开发期可见）
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }

  if (!logFile) return;
  try {
    rotate();
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (_e) {}
}

function debug(msg, extra) { write('debug', msg, extra); }
function info(msg, extra) { write('info', msg, extra); }
function warn(msg, extra) { write('warn', msg, extra); }
function error(msg, extra) { write('error', msg, extra); }

// 安装全局异常兜底（在主进程 require 此模块时调用一次）
function installGlobalHandlers(extra) {
  process.on('uncaughtException', function (e) {
    error('uncaughtException', { message: e && e.message, stack: e && e.stack, extra: extra || null });
  });
  process.on('unhandledRejection', function (reason) {
    const msg = reason && reason.message ? reason.message : String(reason);
    const stack = reason && reason.stack ? reason.stack : null;
    error('unhandledRejection', { message: msg, stack: stack, extra: extra || null });
  });
}

module.exports = {
  init: init,
  debug: debug,
  info: info,
  warn: warn,
  error: error,
  installGlobalHandlers: installGlobalHandlers
};
