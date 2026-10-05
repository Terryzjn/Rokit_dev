// Rokit · recorder 录制层单元测试（v1.5）
// 目标：session 管理（createSession/appendChunk/stopSession/discardSession/listSessions）
// 注意：recorder.js 在 require 时会 try electron.app.getPath('userData')；测试环境下
//       electron 未启动，因此走 os.tmpdir() 降级路径。

const fs = require('fs');
const path = require('path');
const os = require('os');

const recorder = require('../electron/recorder');

describe('recorder · session 管理', () => {
  it('createSession 应返回新 session（含 id / path / bytes=0）', () => {
    const s = recorder.createSession({ sourceName: 'screen-1' });
    expect(s.id).toMatch(/^rec_/);
    expect(s.path).toBeTruthy();
    expect(s.bytes).toBe(0);
    expect(s.finalized).toBe(false);
    expect(fs.existsSync(s.path)).toBe(true); // 空文件被立即创建
    recorder.discardSession(s.id); // 清理
  });

  it('appendChunk 应累加 bytes', () => {
    const s = recorder.createSession();
    const r1 = recorder.appendChunk(s.id, Buffer.from('hello'));
    expect(r1.ok).toBe(true);
    expect(r1.bytes).toBe(5);
    const r2 = recorder.appendChunk(s.id, Buffer.from(' world'));
    expect(r2.bytes).toBe(11);
    // 文件内容应正确
    const content = fs.readFileSync(s.path, 'utf8');
    expect(content).toBe('hello world');
    recorder.discardSession(s.id);
  });

  it('appendChunk 不存在的 sessionId 应返回 error', () => {
    const r = recorder.appendChunk('rec_nonexistent', Buffer.from('x'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('session-not-found');
  });

  it('appendChunk 空 buffer 应返回 error', () => {
    const s = recorder.createSession();
    const r = recorder.appendChunk(s.id, null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty-chunk');
    recorder.discardSession(s.id);
  });

  it('stopSession 应标记 finalized + 返回 path/durationMs', () => {
    const s = recorder.createSession();
    recorder.appendChunk(s.id, Buffer.from('test'));
    const r = recorder.stopSession(s.id);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(s.path);
    expect(typeof r.durationMs).toBe('number');
    expect(r.bytes).toBe(4);
    expect(r.suspicious).toBe(true); // < 1KB
    // 二次 stop 应返回 alreadyFinalized=true
    const r2 = recorder.stopSession(s.id);
    expect(r2.ok).toBe(true);
    expect(r2.alreadyFinalized).toBe(true);
    recorder.discardSession(s.id);
  });

  it('stopSession 不存在 session 应返回 error', () => {
    const r = recorder.stopSession('rec_nope');
    expect(r.ok).toBe(false);
  });

  it('discardSession 应删除文件', () => {
    const s = recorder.createSession();
    recorder.appendChunk(s.id, Buffer.from('data'));
    expect(fs.existsSync(s.path)).toBe(true);
    recorder.discardSession(s.id);
    expect(fs.existsSync(s.path)).toBe(false);
    expect(recorder.getSession(s.id)).toBe(null);
  });

  it('listSessions 应返回所有 session 概要', () => {
    recorder.createSession({ sourceName: 'screen-A' });
    recorder.createSession({ sourceName: 'screen-B' });
    const arr = recorder.listSessions();
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr[0]).toHaveProperty('id');
    expect(arr[0]).toHaveProperty('path');
    expect(arr[0]).toHaveProperty('startedAt');
    // 清理
    for (const it of arr) recorder.discardSession(it.id);
  });

  it('appendChunk finalized 后应返回 error', () => {
    const s = recorder.createSession();
    recorder.appendChunk(s.id, Buffer.from('x'));
    recorder.stopSession(s.id);
    const r = recorder.appendChunk(s.id, Buffer.from('y'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('session-finalized');
    recorder.discardSession(s.id);
  });
});

describe('recorder · probeDurationMs', () => {
  it('不存在的文件应返回 0', async () => {
    const ms = await recorder.probeDurationMs('/nonexistent.webm', '');
    expect(ms).toBe(0);
  });

  it('ffmpegPath 为空时应返回 0', async () => {
    const tmp = path.join(os.tmpdir(), 'fake-' + Date.now() + '.webm');
    fs.writeFileSync(tmp, '');
    const ms = await recorder.probeDurationMs(tmp, '');
    expect(ms).toBe(0);
    try { fs.unlinkSync(tmp); } catch (_) {}
  });
});

describe('recorder · tempDir', () => {
  it('应返回字符串路径（os.tmpdir 兜底）', () => {
    const d = recorder.tempDir();
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(0);
  });
});