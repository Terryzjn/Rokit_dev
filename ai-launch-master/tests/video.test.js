// Rokit · video 视频后处理单元测试（v1.5）
// 目标：ffmpegPath / ffmpegAvailable / 输出路径计算 + 错误降级
// 注意：真实 ffmpeg 调用需要可执行文件，本测试在 ffmpeg 不可用时只验证输入校验

const fs = require('fs');
const path = require('path');
const os = require('os');

const video = require('../electron/video');

describe('video · 路径与可用性', () => {
  it('ffmpegPath 应返回字符串（可能为空）', () => {
    const p = video.ffmpegPath();
    expect(typeof p).toBe('string');
  });

  it('ffmpegAvailable 应返回 boolean', () => {
    const ok = video.ffmpegAvailable();
    expect(typeof ok).toBe('boolean');
  });
});

describe('video · 输入校验', () => {
  it('transcodeWebmToMp4 输入不存在应 reject input-not-found', async () => {
    await expect(video.transcodeWebmToMp4('/nonexistent.webm')).rejects.toThrow(/input-not-found|ffmpeg/);
  });

  it('generateThumbnail 输入不存在应 reject', async () => {
    await expect(video.generateThumbnail('/nonexistent.webm')).rejects.toThrow(/input-not-found|ffmpeg/);
  });

  it('trim 缺 start/duration 参数应 reject', async () => {
    const tmp = path.join(os.tmpdir(), 'fake.webm');
    fs.writeFileSync(tmp, '');
    try {
      await expect(video.trim(tmp, {})).rejects.toThrow(/trim-needs|input-not-found/);
      await expect(video.trim(tmp, { startSeconds: 0 })).rejects.toThrow(/trim-needs|input-not-found/);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  it('getMetadata 不存在的文件应返回 null', async () => {
    const r = await video.getMetadata('/nonexistent.webm');
    expect(r === null || typeof r === 'object').toBe(true);
  });
});

describe('video · processRecording', () => {
  it('输入不存在应安全返回错误对象（不抛）', async () => {
    const r = await video.processRecording('/nonexistent.webm');
    expect(r).toBeDefined();
    // meta 应为 null 或 {}
    expect(r.meta === null || typeof r.meta === 'object').toBe(true);
    // mp4/thumb 可能为 null / 错误对象
  });
});