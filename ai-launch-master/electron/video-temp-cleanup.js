// Rokit · 临时成品视频的自动清除
//
// 目的：作品流程最终完成后，把 <userData>/temp/videos/final/ 下**不再被需要**的
//   成品视频清掉，避免临时目录无限堆积。
//
// 语义与「AI 生成语音的自动清除」（ai-voice-cleanup.js）完全一致：
//   - 只按「目录 + 名称正则」匹配**具体文件**，绝不整目录清空；
//   - 只删**普通文件**（不删目录、不跟随符号链接）；
//   - 任何失败都被记录下来，绝不抛异常影响调用方主流程。
//
// ★ 删除资格由**既有的** store.assessFinalVideoCleanup() 判定（不另建判定规则）：
//   该函数是已验收的多平台引用保护事实来源，语义为：
//     1) 仍是某个作品的「最新成品视频」        → 不合格（保留）
//     2) 不是 Rokit 管理的成品视频              → 不合格（保留）
//     3) 无法确认是否还有未完成计划引用它        → 不合格（保留）
//     4) 仍有未完成（pending/running/needs_review/failed）计划引用 → 不合格（保留）
//     5) 既不是最新视频、也没有任何未完成引用   → 合格（可删）
//   本模块只负责「拿到合格结论后如何安全删除」，**不改变**上述任何判定。
//
// 明确保护（永不触碰）：
//   - <userData>/work-videos/**         与作品关联的成品视频归档（作品生命周期资产）
//   - <userData>/saved-videos/**        用户主动保存的成品
//   - <userData>/videos/**              用户保留的录屏
//   - <userData>/voice-profiles/**      用户原始音源
//   - temp/videos/final/ 下的 sub-*.ass / frz-* 等非成品视频文件（本批只清 final-*.mp4）
//   - temp/videos/source|work|recorder/ 原始视频工作副本、转码中间物、临时录屏
//
// 通用性：cleanupManagedFiles() 是通用内核（按「目录 + 名称正则」清除文件），
//   复用 ai-voice-cleanup.js 的同名内核语义，但本模块额外带「删除前资格判定」钩子。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 临时成品视频目录（与 caption-burn.js 的 outputDir('final') 同口径）。
//   <userData>/temp/videos/final
//   非 Electron 环境回退到 os.tmpdir()/rokit-temp/videos/final。
function _tempFinalVideoRoot() {
  try {
    const electron = require('electron');
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === 'function') {
      const ud = app.getPath('userData');
      if (ud) return path.join(ud, 'temp', 'videos', 'final');
    }
  } catch (_e) { /* 非 Electron 环境 → fallback */ }
  return path.join(os.tmpdir(), 'rokit-temp', 'videos', 'final');
}

// 合成产出的成品视频文件名规则：final-<stamp>.mp4（见 caption-burn.js）。
//   · 只匹配 .mp4 成品；sub-*.ass（字幕）/ frz-*（静帧）**不在**本批范围。
const FINAL_VIDEO_PATTERN = /^final-[\w-]+\.mp4$/i;

// ---------- 通用内核：按「目录 + 名称正则」清除文件 ----------
//
//   opts.beforeDelete(filePath) → 可选。
//     · 返回 true（或 truthy）才允许删除该文件；
//     · 返回 false / null / undefined → 跳过该文件（保留）；
//     · 抛出异常 → 视为「资格判断失败」，跳过该文件并记入 failed（保守保留）。
//   目录不存在 / 无权限 → 静默跳过。
//   返回 { removed:[路径], failed:[{path,error}], skipped:[路径], count }
function cleanupManagedFiles(groups, opts) {
  opts = opts || {};
  const removed = [];
  const failed = [];
  const skipped = [];
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
      // 删除前的资格判定（默认没有钩子 → 直接允许）
      if (typeof opts.beforeDelete === 'function') {
        let allowed = false;
        try { allowed = !!opts.beforeDelete(full); }
        catch (e) {
          failed.push({ path: full, error: 'before-delete-failed:' + String((e && e.message) || e) });
          continue;
        }
        if (!allowed) { skipped.push(full); continue; }
      }
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) { skipped.push(full); continue; }   // 不删符号链接
        if (!st.isFile()) { skipped.push(full); continue; }           // 只删普通文件，目录一律保留
        if (opts.dryRun) { removed.push(full); continue; }
        fs.unlinkSync(full);
        removed.push(full);
      } catch (e) {
        failed.push({ path: full, error: String((e && e.message) || e) });
      }
    }
  });
  return { removed: removed, failed: failed, skipped: skipped, count: removed.length };
}

// —— 临时成品视频专用包装 ——
//
//   store  必须提供 assessFinalVideoCleanup(videoPath, opts)（生产环境是 Store 实例）
//   opts.managed   是否位于 Rokit 受管成品目录（由主进程按白名单判定）；缺省为 true
//   opts.isManaged 自定义白名单判定（主进程传入，与 resolveFinalVideoFile 同口径）
//   opts.root      覆盖目标目录（缺省为 <userData>/temp/videos/final）
//   opts.protectPaths  **当前流程仍在使用**的路径（本次会话内存里的成品视频）。
//     这些路径一律保留 —— 即使它已经不是任何作品的映射目标，
//     删掉它会让「同一会话内再次发布」拿不到视频。
//
//   返回 { ok, removedCount, removed[], skipped[], failed[] }
function cleanupTempFinalVideos(store, opts) {
  opts = opts || {};
  const removed = [];
  const skipped = [];
  const failed = [];

  // 判定能力缺失 → **不清理**（绝不在无法确认引用关系时删除文件）
  if (!store || typeof store.assessFinalVideoCleanup !== 'function') {
    return { ok: false, removedCount: 0, removed: [], skipped: [], failed: [], error: '缺少清理资格判断能力，保留文件' };
  }

  // 当前流程仍在使用的路径（规范化后比较；Windows 下不区分大小写）
  //   ★ 空路径（null / undefined / ''）直接返回空串：
  //     path.resolve('') 会返回**当前工作目录**，若不短路，
  //     一个空路径会被误当成"cwd 这个真实路径"加入保护集合（语义错误）。
  const norm = function (p) {
    if (p === null || p === undefined) return '';
    const raw = String(p);
    if (!raw) return '';
    try {
      const r = path.resolve(raw);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    } catch (_e) { return ''; }
  };
  const protectedPaths = {};
  (Array.isArray(opts.protectPaths) ? opts.protectPaths : (opts.protectPaths ? [opts.protectPaths] : []))
    .forEach(function (p) {
      const n = norm(p);
      if (n) protectedPaths[n] = true;
    });

  const groups = [{
    dir: String(opts.root || _tempFinalVideoRoot()),
    patterns: [FINAL_VIDEO_PATTERN]
  }];

  const r = cleanupManagedFiles(groups, {
    beforeDelete: function (filePath) {
      // 1) 当前流程仍在用 → 保留
      if (protectedPaths[norm(filePath)]) return false;
      // 2) 白名单：必须是 Rokit 管理的成品目录下的文件
      let managed = opts.managed !== false;
      if (typeof opts.isManaged === 'function') {
        try { managed = !!opts.isManaged(filePath); }
        catch (_e) { managed = false; }
      }
      if (!managed) return false;
      // 3) 引用资格（既有判定，含多平台引用保护；无法确认 → 不合格）
      const verdict = store.assessFinalVideoCleanup(filePath, { managed: true });
      if (!verdict || verdict.ok !== true || verdict.eligible !== true) return false;
      return true;
    }
  });

  removed.push.apply(removed, r.removed);
  skipped.push.apply(skipped, r.skipped);
  failed.push.apply(failed, r.failed);

  return {
    ok: failed.length === 0,
    removedCount: removed.length,
    removed: removed,
    skipped: skipped,
    failed: failed
  };
}

module.exports = {
  cleanupTempFinalVideos,
  cleanupManagedFiles,
  _tempFinalVideoRoot,
  FINAL_VIDEO_PATTERN
};
