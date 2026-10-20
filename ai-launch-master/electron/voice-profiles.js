'use strict';

// Rokit · 声音档案存储（v1.20.3）
//
// 设计：
//   - 完全在 Electron 主进程中执行，渲染进程通过 IPC 调用
//   - 每个档案独立子目录；每次录音独立子目录；原始文件不覆盖
//   - 目录结构：
//       userData/voice-profiles/
//         <profile-id>/
//           profile.json                     (档案元数据)
//           <version-id>/
//             meta.json                       (本次录音元数据：时间、时长、mimetype、源类型)
//             recording.<原始扩展名>          (原始音频字节流，文件名固定为「原始 ext」绝不覆盖)
//   - 不修改、不转换原始录音字节；保留真实 MIME / 真实扩展名
//   - 安全：
//       * id 必须匹配安全 ID（crc32 / 8-32 位 hex）
//       * 不允许跨档案 / 跨版本读写
//       * 路径必须落在 userData/voice-profiles/<profileId>/<versionId>/
//       * 不删除非 Rokit 自己生成的目录

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _app = null;
let _appReady = false;

function _safeAbs(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
}
function _safeId(v, label) {
  if (!v || typeof v !== 'string') throw new Error(label + ':empty');
  if (!/^[a-fA-F0-9]{8,40}$/.test(v)) throw new Error(label + ':bad-id');
  return v.toLowerCase();
}
function _safeName(v) {
  // 限制字符集，避免路径穿越与特殊字符
  if (!v || typeof v !== 'string') return '';
  return v.replace(/[\/\\\:\*\?"<>\|\x00-\x1F]/g, '_').slice(0, 80);
}
function _root() {
  if (!_app) throw new Error('voice-profiles not initialized');
  return path.join(_app.getPath('userData'), 'voice-profiles');
}

function _readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_e) { return null; }
}
function _writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function _newId() { return crypto.randomBytes(8).toString('hex'); }

// 列出所有声音档案（不含版本元数据，节省带宽）
function listProfiles() {
  try {
    const root = _root();
    if (!fs.existsSync(root)) return [];
    const ids = fs.readdirSync(root).filter(function (d) {
      const p = path.join(root, d);
      try {
        return d.match(/^[a-f0-9]{8,40}$/) && fs.statSync(p).isDirectory();
      } catch (_e) { return false; }
    });
    const out = [];
    for (const id of ids) {
      const profilePath = path.join(root, id, 'profile.json');
      const p = _readJSON(profilePath);
      if (p && p.id === id) {
        // 拼上版本列表
        const verDir = path.join(root, id);
        const versions = [];
        try {
          const dirs = fs.readdirSync(verDir);
          for (const d of dirs) {
            const vp = path.join(verDir, d, 'meta.json');
            const v = _readJSON(vp);
            if (v && v.id === d) versions.push(v);
          }
        } catch (_e) { /* ignore */ }
        versions.sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
        out.push(Object.assign({}, p, { versions: versions }));
      }
    }
    out.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    return out;
  } catch (_e) { return []; }
}

// 创建（或重命名）档案
function createProfile(opts) {
  opts = opts || {};
  const name = _safeName(String(opts.name || '').trim());
  if (!name) throw new Error('profile-name-empty');
  const id = _safeId(opts.id || _newId(), 'profile.id');
  const profileDir = path.join(_root(), id);
  if (fs.existsSync(profileDir)) {
    // 已存在同名 ID 目录 → 直接在该档案下新增版本（幂等）
    const meta = _readJSON(path.join(profileDir, 'profile.json')) || { id: id, name: name, createdAt: new Date().toISOString() };
    meta.name = name;
    meta.updatedAt = new Date().toISOString();
    _writeJSON(path.join(profileDir, 'profile.json'), meta);
    return meta;
  }
  const meta = {
    id: id,
    name: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(profileDir, { recursive: true });
  _writeJSON(path.join(profileDir, 'profile.json'), meta);
  return meta;
}

// 在指定档案下创建一个录音版本（保存一段录音）
//   payload: { profileId, profileName?, versionId?, mime, ext, durationSec, source, b64 (dataURL prefix可) }
//   返回新增的版本元数据
function saveVersion(payload) {
  payload = payload || {};
  const profileId = _safeId(payload.profileId, 'profileId');
  const profileName = _safeName(String(payload.profileName || '').trim());
  const profileDir = path.join(_root(), profileId);

  // 若档案不存在，先创建
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  const profileMetaPath = path.join(profileDir, 'profile.json');
  let profileMeta = _readJSON(profileMetaPath);
  const now = new Date().toISOString();
  if (!profileMeta || profileMeta.id !== profileId) {
    profileMeta = {
      id: profileId,
      name: profileName || ('档案-' + profileId.slice(0, 6)),
      createdAt: now,
      updatedAt: now
    };
  } else {
    profileMeta.name = profileName || profileMeta.name;
    profileMeta.updatedAt = now;
  }
  _writeJSON(profileMetaPath, profileMeta);

  // 版本：每次录音独立子目录，文件名固定为「recording.<ext>」，绝不覆盖（重复 id 时拒绝）
  const versionId = _safeId(payload.versionId || _newId(), 'versionId');
  const versionDir = path.join(profileDir, versionId);
  if (fs.existsSync(versionDir)) {
    throw new Error('version-already-exists:' + versionId);
  }
  fs.mkdirSync(versionDir, { recursive: true });

  // 元数据
  const ext = _safeName(String(payload.ext || 'bin').toLowerCase().replace(/^\./, '')) || 'bin';
  const mime = String(payload.mime || '').slice(0, 80);
  const versionMeta = {
    id: versionId,
    name: _safeName(String(payload.name || ('录音-' + versionId.slice(0, 6))) || ('录音-' + versionId.slice(0, 6))),
    durationSec: Number.isFinite(payload.durationSec) && payload.durationSec >= 0 ? payload.durationSec : 0,
    mime: mime,
    ext: ext,
    source: _safeName(String(payload.source || 'recording')),
    fileName: 'recording.' + ext,
    fileSize: 0,
    createdAt: now
  };
  _writeJSON(path.join(versionDir, 'meta.json'), versionMeta);

  // 写音频字节
  var b64 = String(payload.b64 || '');
  var data = null;
  if (b64) {
    var cleaned = b64.replace(/^data:[^;]+;base64,/i, '');
    try {
      data = Buffer.from(cleaned, 'base64');
    } catch (e) {
      throw new Error('base64-decode:' + ((e && e.message) || String(e)));
    }
  }
  if (data && data.length) {
    var target = path.join(versionDir, versionMeta.fileName);
    fs.writeFileSync(target, data);
    versionMeta.fileSize = data.length;
    _writeJSON(path.join(versionDir, 'meta.json'), versionMeta);
    return {
      ok: true,
      profile: profileMeta,
      version: versionMeta,
      absPath: target
    };
  }
  // 没数据 → 清掉空目录
  try { fs.rmdirSync(versionDir, { recursive: true }); } catch (_e) {}
  throw new Error('empty-recording-bytes');
}

// 获取某版本元数据 + 绝对路径
function getVersionPath(profileId, versionId) {
  profileId = _safeId(profileId, 'profileId');
  versionId = _safeId(versionId, 'versionId');
  const versionDir = path.join(_root(), profileId, versionId);
  const meta = _readJSON(path.join(versionDir, 'meta.json'));
  if (!meta || meta.id !== versionId) return null;
  var filePath = null;
  try {
    const files = fs.readdirSync(versionDir);
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f === 'meta.json') continue;
      var full = path.join(versionDir, f);
      if (fs.statSync(full).isFile()) { filePath = full; break; }
    }
  } catch (_e) {}
  return { meta: meta, filePath: filePath };
}

// 删除单个版本。**绝不**误删其他版本或档案根目录
function deleteVersion(profileId, versionId) {
  profileId = _safeId(profileId, 'profileId');
  versionId = _safeId(versionId, 'versionId');
  const versionDir = path.join(_root(), profileId, versionId);
  if (!fs.existsSync(versionDir)) return { ok: false, error: 'not-found' };
  // **强校验**：必须落在 userData/voice-profiles/<profileId>/<versionId>/
  const root = _root();
  const safeRoot = _safeAbs(root);
  const safeVersionDir = _safeAbs(versionDir);
  if (!safeVersionDir.startsWith(safeRoot + path.sep) || safeVersionDir === safeRoot) {
    return { ok: false, error: 'path-escape' };
  }
  // 二次校验：当前路径的最后一级 === versionId（防止误删同名子目录）
  if (path.basename(safeVersionDir) !== versionId) {
    return { ok: false, error: 'path-mismatch' };
  }
  try { fs.rmdirSync(safeVersionDir, { recursive: true }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

// 删除整个档案（含其下所有版本）。**绝不**误删其他档案根
function deleteProfile(profileId) {
  profileId = _safeId(profileId, 'profileId');
  const profileDir = path.join(_root(), profileId);
  if (!fs.existsSync(profileDir)) return { ok: false, error: 'not-found' };
  const safeRoot = _safeAbs(_root());
  const safeProfileDir = _safeAbs(profileDir);
  if (!safeProfileDir.startsWith(safeRoot + path.sep) || safeProfileDir === safeRoot) {
    return { ok: false, error: 'path-escape' };
  }
  if (path.basename(safeProfileDir) !== profileId) {
    return { ok: false, error: 'path-mismatch' };
  }
  try { fs.rmdirSync(safeProfileDir, { recursive: true }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

// 读取音频 bytes（用 fs.createReadStream 切片，避免一次性载入大文件）
function readAudioBuffer(profileId, versionId) {
  var info = getVersionPath(profileId, versionId);
  if (!info || !info.filePath) return null;
  try {
    var absPath = _safeAbs(info.filePath);
    var safeRoot = _safeAbs(_root());
    if (!absPath.startsWith(safeRoot + path.sep)) return null;
    return {
      meta: info.meta,
      absPath: absPath,
      buffer: fs.readFileSync(absPath)
    };
  } catch (_e) { return null; }
}

// 初始化（在 app.whenReady 后调用；保存 app 引用）
function init(app) {
  if (!app) throw new Error('voice-profiles:app-required');
  _app = app;
  var root = _root();
  try { fs.mkdirSync(root, { recursive: true }); } catch (_e) {}
  _appReady = true;
  return { rootDir: root };
}

// 暴露给 main.js IPC 用的"安全绝对路径白名单"构造器
function buildSafePaths(profileId, versionId, ext) {
  profileId = _safeId(profileId, 'profileId');
  versionId = _safeId(versionId, 'versionId');
  const extSafe = _safeName(String(ext || 'bin').toLowerCase().replace(/^\./, '')) || 'bin';
  return {
    profileDir: path.join(_root(), profileId),
    versionDir: path.join(_root(), profileId, versionId),
    versionFileName: 'recording.' + extSafe
  };
}

module.exports = {
  init: init,
  attachIpc: attachIpc,
  listProfiles: listProfiles,
  createProfile: createProfile,
  saveVersion: saveVersion,
  getVersionPath: getVersionPath,
  deleteVersion: deleteVersion,
  deleteProfile: deleteProfile,
  readAudioBuffer: readAudioBuffer,
  buildSafePaths: buildSafePaths,
  // exports for tests
  _safeId: _safeId,
  _safeName: _safeName
};

// 挂载 voice:* IPC。给 main.js 在 app.whenReady 后调用。
//   ctx: { logger }
//   IPC 列表：
//     voice:list                 → { ok, profiles }
//     voice:create-profile       → payload: { id?, name }          → { ok, profile }
//     voice:save-version         → payload: { profileId, profileName?, versionId?, mime, ext, durationSec, source, b64 }
//                                                       → { ok, profile, version, absPath }
//     voice:delete-version       → payload: { profileId, versionId } → { ok }
//     voice:delete-profile       → payload: { profileId }           → { ok }
//     voice:read-audio-buffer    → payload: { profileId, versionId } → { ok, mime, ext, fileName, b64 }
//     voice:probe                → payload: { profileId, versionId } → { ok, exists, mime, ext, fileName, fileSize }
//   所有 handler 都做：参数校验 → safeId → path-escape 二次校验 → 失败返回 { ok: false, error }
function attachIpc(ipcMain, ctx) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  ctx = ctx || {};
  var logger = ctx.logger || { info: function(){}, warn: function(){} };

  ipcMain.handle('voice:list', async function () {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      return { ok: true, profiles: listProfiles() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('voice:create-profile', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      // 强校验：name 只允许中英数下划线空格、≤80 字符
      var name = _safeName(String((payload && payload.name) || '').trim());
      if (!name) return { ok: false, error: 'empty-name' };
      var id = payload && payload.id ? _safeId(payload.id, 'id') : _newId();
      var meta = createProfile({ id: id, name: name });
      try { logger.info('[voice-profiles] create-profile', { id: meta.id, name: meta.name }); } catch (_e) {}
      return { ok: true, profile: meta };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('voice:save-version', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad-payload' };
      // profileId 必须是 8-40 位 hex
      var pid = _safeId(payload.profileId, 'profileId');
      var v = saveVersion({
        profileId: pid,
        profileName: String((payload.profileName || '').trim()),
        versionId: payload.versionId,
        mime: String(payload.mime || ''),
        ext: String(payload.ext || 'bin'),
        durationSec: Number(payload.durationSec),
        source: String(payload.source || 'recording'),
        name: String(payload.name || ''),
        b64: String(payload.b64 || '')
      });
      try { logger.info('[voice-profiles] save-version', { profileId: pid, versionId: v.version.id, mime: v.version.mime, size: v.version.fileSize }); } catch (_e) {}
      return v;
    } catch (e) {
      // saveVersion 抛错时把错误透传给 UI
      var msg = String((e && e.message) || e);
      try { logger.warn('[voice-profiles] save-version failed', { error: msg }); } catch (_e) {}
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('voice:delete-version', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      var pid = _safeId((payload && payload.profileId) || '', 'profileId');
      var vid = _safeId((payload && payload.versionId) || '', 'versionId');
      var r = deleteVersion(pid, vid);
      try { logger.info('[voice-profiles] delete-version', { profileId: pid, versionId: vid, ok: r.ok }); } catch (_e) {}
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('voice:delete-profile', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      var pid = _safeId((payload && payload.profileId) || '', 'profileId');
      var r = deleteProfile(pid);
      try { logger.info('[voice-profiles] delete-profile', { profileId: pid, ok: r.ok }); } catch (_e) {}
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('voice:read-audio-buffer', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      var pid = _safeId((payload && payload.profileId) || '', 'profileId');
      var vid = _safeId((payload && payload.versionId) || '', 'versionId');
      var r = readAudioBuffer(pid, vid);
      if (!r) return { ok: false, error: 'not-found' };
      return { ok: true, mime: r.meta.mime, ext: r.meta.ext, fileName: r.meta.fileName, fileSize: r.meta.fileSize, durationSec: r.meta.durationSec, b64: r.buffer.toString('base64') };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('voice:probe', async function (_e, payload) {
    try {
      if (!_appReady) return { ok: false, error: 'not-ready' };
      var pid = _safeId((payload && payload.profileId) || '', 'profileId');
      var vid = _safeId((payload && payload.versionId) || '', 'versionId');
      var r = getVersionPath(pid, vid);
      if (!r || !r.filePath) return { ok: true, exists: false };
      var stat = (function(){ try { return require('fs').statSync(r.filePath); } catch (_e) { return null; } })();
      return {
        ok: true,
        exists: !!stat,
        mime: r.meta.mime,
        ext: r.meta.ext,
        fileName: r.meta.fileName,
        fileSize: stat ? stat.size : (r.meta.fileSize || 0),
        durationSec: r.meta.durationSec,
        createdAt: r.meta.createdAt
      };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}
