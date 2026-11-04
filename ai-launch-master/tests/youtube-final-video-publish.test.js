// Rokit · YouTube 发布必须使用「字幕 + AI 配音」最终成品 MP4
//
// 覆盖需求点（全部使用本地临时文件 + 测试替身，不发起真实上传、不访问网络）：
//   1. 有有效成品时，uploadResumable 收到的 videoPath 就是校验后的成品路径
//   2. 成品路径缺失 / 目录越界 / 非 MP4 / 文件不存在 / 空文件 → 全部明确失败
//   3. 任何校验失败场景都不得调用 uploadResumable（绝无回退上传原始视频）
//   4. payload 里即使带 videoAssetId / videoPath（原始视频）也不会被使用
//   5. renderer 侧：YouTube payload 只带 finalVideoPath；两个发布入口都阻断无成品
//   6. 六个状态重置点都会清掉 state.__captionFinalVideo（跨作品/换源不会误用旧成品）
//   7. GitHub 发布链路与成品生成/播放/保存逻辑未被改动；本次不涉及任何画质参数
//
// 策略：**不复制** resolveFinalVideoFile 的校验逻辑——直接从 electron/main.js 源码里
//   切出生产函数并注入依赖执行，测试跑的就是生产代码本身。
//   （main.js 是 Electron 入口，无法整体 require；这里只切出这两个无外部副作用的纯函数，
//     与 tests/github-video-publish.test.js 的源码断言范式一致。）

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// 从源码里按大括号配平切出一个函数体（不依赖缩进风格）
function extractFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到函数：' + header);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error('函数缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

// ---- 生产实现：resolveFinalVideoFile（userData/video/final 白名单 + .mp4 + 存在 + 非空）
function makeResolveFinalVideoFile(userDataDir) {
  const text = extractFn(MAIN_SRC, 'function resolveFinalVideoFile(filePath)');
  const factory = new Function('path', 'fs', 'app', text + '\nreturn resolveFinalVideoFile;');
  return factory(path, fs, { getPath: function () { return userDataDir; } });
}

// ---- 生产实现：pubExecYouTube（只上传最终成品，没有任何原始资产回退）
function makePubExecYouTube(deps) {
  const text = extractFn(MAIN_SRC, 'async function pubExecYouTube(payload)');
  const factory = new Function(
    'resolveFinalVideoFile', 'youtubePublisher', 'logger', 'safeSendYoutubeProgress',
    text + '\nreturn pubExecYouTube;'
  );
  return factory(
    deps.resolveFinalVideoFile,
    deps.youtubePublisher,
    deps.logger,
    function () { /* onProgress 替身 */ }
  );
}

function makeLogger() {
  const rec = { info: [], warn: [], error: [] };
  return {
    rec: rec,
    info: function (m, x) { rec.info.push([m, x]); },
    warn: function (m, x) { rec.warn.push([m, x]); },
    error: function (m, x) { rec.error.push([m, x]); }
  };
}

describe('YouTube 发布：只上传字幕 + AI 配音最终成品 MP4', function () {
  let userDataDir = '';
  let finalDir = '';

  beforeAll(function () {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-yt-final-'));
    finalDir = path.join(userDataDir, 'video', 'final');
    fs.mkdirSync(finalDir, { recursive: true });
  });

  afterAll(function () {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
  });

  function makePublisher() {
    const calls = [];
    return {
      calls: calls,
      uploadResumable: async function (opts) {
        calls.push(opts);
        return {
          ok: true,
          videoId: 'test-video-id',
          url: 'https://www.youtube.com/watch?v=test-video-id',
          fileSize: fs.statSync(opts.videoPath).size,
          mimeType: 'video/mp4',
          privacyStatus: 'public'
        };
      }
    };
  }

  function setup() {
    const publisher = makePublisher();
    const logger = makeLogger();
    const pubExecYouTube = makePubExecYouTube({
      resolveFinalVideoFile: makeResolveFinalVideoFile(userDataDir),
      youtubePublisher: publisher,
      logger: logger
    });
    return { publisher: publisher, logger: logger, pubExecYouTube: pubExecYouTube };
  }

  it('有有效成品：uploadResumable 收到的 videoPath 就是校验后的成品路径', async function () {
    const file = path.join(finalDir, 'final-1700000000000-ab12cd.mp4');
    fs.writeFileSync(file, Buffer.alloc(4096, 7));
    const s = setup();
    const r = await s.pubExecYouTube({
      finalVideoPath: file,
      title: '标题', description: '描述', tags: ['t'],
      categoryId: '22', privacyStatus: 'public'
    });
    expect(r.status).toBe('ok');
    expect(r.videoId).toBe('test-video-id');
    expect(s.publisher.calls.length).toBe(1);
    expect(s.publisher.calls[0].videoPath).toBe(path.resolve(file));
    // 既有行为保持不变：标题/描述/标签/分类/隐私设置原样透传给上传函数
    expect(s.publisher.calls[0].title).toBe('标题');
    expect(s.publisher.calls[0].description).toBe('描述');
    expect(s.publisher.calls[0].tags).toEqual(['t']);
    expect(s.publisher.calls[0].categoryId).toBe('22');
    expect(s.publisher.calls[0].privacyStatus).toBe('public');
  });

  // 校验失败场景统一断言：明确失败 + 绝不调用上传函数
  async function expectRejected(payload, reason) {
    const s = setup();
    const r = await s.pubExecYouTube(payload);
    expect(s.publisher.calls.length).toBe(0);
    expect(r.status).toBe('manual');
    expect(r.platformId).toBe('youtube');
    expect(r.error).toBe('FINAL_VIDEO_NOT_READY');
    expect(String(r.note || '')).toContain('成品');
    // 生产校验器的具体错误码被记录下来（证明跑的是生产 resolveFinalVideoFile）
    expect(s.logger.rec.warn.length).toBe(1);
    expect(s.logger.rec.warn[0][1].error).toBe(reason);
    return r;
  }

  it('成品路径缺失 → 明确失败，不调用上传函数', async function () {
    await expectRejected({ finalVideoPath: null, title: 't' }, 'no-final-video');
    await expectRejected({ title: 't' }, 'no-final-video');
  });

  it('成品路径越界（不在 userData/video/final 内）→ 明确失败，不调用上传函数', async function () {
    const outside = path.join(userDataDir, 'original-local-video.mp4');
    fs.writeFileSync(outside, Buffer.alloc(4096, 1));
    await expectRejected({ finalVideoPath: outside, title: 't' }, 'path-not-allowed');
  });

  it('成品不是 .mp4 → 明确失败，不调用上传函数', async function () {
    const txt = path.join(finalDir, 'final-not-mp4.txt');
    fs.writeFileSync(txt, 'not a video');
    await expectRejected({ finalVideoPath: txt, title: 't' }, 'not-mp4');
  });

  it('成品文件不存在 → 明确失败，不调用上传函数', async function () {
    const missing = path.join(finalDir, 'final-missing.mp4');
    await expectRejected({ finalVideoPath: missing, title: 't' }, 'file-missing');
  });

  it('成品文件为空 → 明确失败，不调用上传函数', async function () {
    const empty = path.join(finalDir, 'final-empty.mp4');
    fs.writeFileSync(empty, Buffer.alloc(0));
    await expectRejected({ finalVideoPath: empty, title: 't' }, 'file-empty');
  });

  it('payload 即使带 videoAssetId / videoPath（原始视频），也不会上传原始视频', async function () {
    const original = path.join(userDataDir, 'original-local-video.mp4');
    fs.writeFileSync(original, Buffer.alloc(4096, 3));
    const s = setup();
    const r = await s.pubExecYouTube({
      finalVideoPath: null,
      videoAssetId: 'asset-1',
      videoPath: original,
      title: 't'
    });
    expect(s.publisher.calls.length).toBe(0);
    expect(r.status).toBe('manual');
    expect(r.error).toBe('FINAL_VIDEO_NOT_READY');
  });

  it('main.js：pubExecYouTube 只用 resolveFinalVideoFile，不再有原始资产 / videoPath 回退', function () {
    const fn = extractFn(MAIN_SRC, 'async function pubExecYouTube(payload)');
    expect(fn).toMatch(/resolveFinalVideoFile\(payload\.finalVideoPath\)/);
    expect(fn).toMatch(/uploadResumable\(\{/);
    expect(fn).not.toMatch(/getInternalAsset/);
    expect(fn).not.toMatch(/videoSource/);
    expect(fn).not.toMatch(/payload\.videoPath/);
  });

  it('index.html：YouTube payload 只带 finalVideoPath（来源 state.__captionFinalVideo）', function () {
    const fn = extractFn(HTML_SRC, 'function youtubePublishPayload(){');
    expect(fn).toMatch(/state\.__captionFinalVideo/);
    expect(fn).toMatch(/finalVideoPath:\s*fvPath/);
    expect(fn).not.toMatch(/videoAssetId/);
  });

  it('index.html：普通发布与批量发布两个入口都在无成品时阻断', function () {
    expect(HTML_SRC).toMatch(/if\(!ytP\.finalVideoPath\)\{ toast\('尚未生成最终成品视频/);
    expect(HTML_SRC).toMatch(/if\(!ytPayload\.finalVideoPath\)\{/);
    // 旧的"用原始视频顶替"校验必须已经不存在
    expect(HTML_SRC).not.toMatch(/if\(!ytPayload\.videoAssetId\)/);
    expect(HTML_SRC).not.toMatch(/if\(!ytP\.videoAssetId\)/);
  });

  it('index.html：六个状态重置点都清掉 state.__captionFinalVideo', function () {
    const anchors = [
      'state.videoAsset=r.asset;',                                            // 重新选择本地视频
      'window.clearLocalVideo=async function(){',                             // 删除视频
      'function adoptAiDemoAsset(){',                                         // 采用 AI 录屏
      "state.project={name:w.name,type:w.type,intro:w.intro,url:w.url||'',ytUrl:w.yt_url||''};", // 切换作品
      'state.step=0;state.rec={running:false,blob:null,url:null,dur:0,stepIdx:0};state.videoAsset=null;', // 登记新作品
      'state.messages=[];'                                                    // 删除当前作品
    ];
    anchors.forEach(function (anchor) {
      const i = HTML_SRC.indexOf(anchor);
      expect(i, '锚点未找到：' + anchor).toBeGreaterThan(-1);
      // 锚点在整份源码中唯一 → 精确定位到那一个重置点
      expect(HTML_SRC.lastIndexOf(anchor), '锚点不唯一：' + anchor).toBe(i);
      expect(
        HTML_SRC.slice(i, i + anchor.length + 900),
        '锚点后没有清理 state.__captionFinalVideo：' + anchor
      ).toMatch(/state\.__captionFinalVideo\s*=\s*null/);
    });
    // 六处清理点全部到位
    expect((HTML_SRC.match(/state\.__captionFinalVideo\s*=\s*null/g) || []).length).toBe(6);
  });

  it('GitHub 发布链路未被改动（仍用 state.__captionFinalVideo.path + resolveFinalVideoFile）', function () {
    expect(HTML_SRC).toMatch(/finalVideoPath:\s*fv\.path/);
    expect(MAIN_SRC).toMatch(/resolveFinalVideoFile\(p\.finalVideoPath\)/);
  });

  it('本次改动不涉及画质参数：编码参数仍在 caption-burn.js，main.js / index.html 未出现 crf/pix_fmt/fps', function () {
    const cb = fs.readFileSync(path.join(ROOT, 'electron', 'caption-burn.js'), 'utf8');
    expect(cb).toMatch(/'-c:v', 'libx264'/);
    expect(cb).toMatch(/'-crf', String\(o\.crf \|\| 23\)/);
    expect(cb).toMatch(/'-pix_fmt', 'yuv420p'/);
    const fn = extractFn(MAIN_SRC, 'async function pubExecYouTube(payload)');
    expect(fn).not.toMatch(/-crf|-pix_fmt|fps=|scale=/);
    expect(HTML_SRC).not.toMatch(/-crf|-pix_fmt/);
  });
});
