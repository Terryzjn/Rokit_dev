// Rokit · 运行上下文探测：当前进程令牌的完整性级别（Windows）
//
// 为什么单独成模块：Low 完整性是「调用系统浏览器不成功」的唯一根因，
// main.js（启动时告警）与 oauth.js（决定是否走剪贴板兜底）都要用它，
// 放两份实现迟早会漂移。
//
// 判定用完整性 SID，而不是 "High/Medium Mandatory Level" 这类英文标签文本 ——
// 后者在非英文系统或 Low 完整性下永远匹配不到，会恒定打印误导性的 "whoami 不可用"。
//
// 关键结论（实测，见 CHANGELOG）：
//   Low 完整性下 Windows 会拒绝把 URL 交给已运行的浏览器 —— msedge.exe 会被启动
//   但立刻退出，ShellExecute 仍返回成功（shell.openExternal 的 Promise 会 resolve），
//   属于"静默假成功"：不开标签页、也不报错。
//   用独立 user-data-dir 直接起一个全新浏览器实例同样无效（spawn 无错、进程数归零、
//   页面从未被加载）——即客户端没有任何代码级绕行方案。
//
// Low 令牌的来源已实测定位：**可执行文件所在目录被打了低完整性标签**。
//   同一个 whoami.exe：放 C:\Windows\System32 跑 = High(S-1-16-12288)，
//   复制进被打标的工程目录（C:\workspace\...）= Low(S-1-16-4096)，
//   复制到 %TEMP% = High。把 Electron 整个 dist 复制到 %TEMP% 运行后，
//   完整性恢复 High，且浏览器**真的加载了页面**（本机 HTTP 探针收到请求）。
//   所以修复方式是：把应用放到未被低完整性标记的目录运行（例如 C:\Rokit，
//   或安装到 Program Files），而不是改代码。
'use strict';

const child_process = require('child_process');

const INTEGRITY_BY_SID = {
  'S-1-16-4096': 'low',
  'S-1-16-8192': 'medium',
  'S-1-16-12288': 'high',
  'S-1-16-16384': 'system'
};

let cached = null;

function detect() {
  const result = { level: 'unknown', sid: '' };
  if (process.platform !== 'win32') return result;
  // Electron 是 GUI subsystem，可能没有完整 PATH；用绝对路径调 whoami
  const candidates = [
    (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\whoami.exe',
    'whoami.exe',
    'whoami'
  ];
  for (const exe of candidates) {
    try {
      const out = child_process.execSync(`"${exe}" /groups`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      const m = out.match(/S-1-16-\d+/);
      if (m) {
        result.sid = m[0];
        result.level = INTEGRITY_BY_SID[m[0]] || 'unknown';
      }
      break;
    } catch (_e) { /* 试下一个 */ }
  }
  return result;
}

// 整个进程生命周期只探测一次（execSync 是同步阻塞调用）
function getIntegrity() {
  if (!cached) cached = detect();
  return { level: cached.level, sid: cached.sid };
}

// Low 完整性 = 受限 / 沙箱上下文：系统浏览器无法被自动调起（会静默假成功）
function isRestrictedContext() {
  return getIntegrity().level === 'low';
}

module.exports = {
  getIntegrity,
  isRestrictedContext,
  INTEGRITY_BY_SID,
  _resetCache: function () { cached = null; }
};
