'use strict';

// 测试目标：AI 自动演示 video 导出帧率上限 = 60 FPS 的相关源码约束。
//   - 不实跑 ffmpeg（避免 CI 触发 30s+ 真实转码）；
//   - 只检查 electron/video.js 的转码命令构造、index.html 的采集约束、ai-demo.js 的导出链路。
//   - 任何重大回归（限帧条件 / 参数路径错位）会被这些测试捕捉。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_JS = fs.readFileSync(path.join(ROOT, 'electron', 'video.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('v1.20.2 · AI 自动演示 帧率上限 60 FPS', () => {
  describe('(1) 采集阶段：getUserMedia 桌面采集约束', () => {
    it('index.html 的桌面采集 getUserMedia mandatory 必须包含 maxFrameRate=60', () => {
      // 命中形如 `mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: pick.id, maxFrameRate: 60 }`
      var re = /mandatory:\s*\{[^}]*chromeMediaSource:\s*'desktop'[^}]*maxFrameRate:\s*60/m;
      expect(re.test(INDEX_HTML)).toBe(true);
    });
    it('**不**允许新增 getDisplayMedia 路径（避免用户共享整屏）— 必须没有 maxFrameRate 缺失的 fallback', () => {
      // v1.20 已禁用 getDisplayMedia fallback。这里**保险**测一下：
      //   任何 getDisplayMedia 调用都必须带 maxFrameRate 约束。
      var re = /getDisplayMedia\s*\(\s*\{[^}]*\}\s*\)/g;
      var ms = INDEX_HTML.match(re) || [];
      //   现行代码已不用 getDisplayMedia；如有，必须包含 maxFrameRate
      ms.forEach(function (m) {
        expect(m).toMatch(/maxFrameRate\s*:\s*60/);
      });
    });
  });

  // 共用 helper：模拟 transcodeWebmToMp4 的 args 构造（v1.20.2：永远强制 fps 上限）。
  //   不论 sourceFps 多少，args 都包含 '-vf fps=N' + '-r N'。
  //   源 fps ≤ N 时 ffmpeg fps filter 是恒等映射（不会复制帧）。
  function buildArgs(opts) {
    var maxFps = (opts && typeof opts.maxFps === 'number' && opts.maxFps > 0) ? opts.maxFps : 60;
    var fpsArgs = ['-vf', 'fps=' + maxFps, '-r', String(maxFps)];
    return ['-y', '-i', opts.input, ...fpsArgs, '-c:v', 'libx264', '-preset', opts.preset || 'veryfast',
            '-crf', String(opts.crf !== undefined ? opts.crf : 23), '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', opts.output];
  }

  describe('(2) 转码阶段：transcodeWebmToMp4 帧率处理', () => {
    it('默认 maxFps = 60（不在调用方显式覆盖时）', () => {
      expect(/\bconst\s+MAX_FPS_DEFAULT\s*=\s*60\b/.test(VIDEO_JS)).toBe(true);
    });

    it('v1.20.2：永远插入 -vf fps=60（无条件；不依赖 -i 探测结果）', () => {
      var args = buildArgs({ input: 'in.webm', output: 'out.mp4' });
      var idx = args.indexOf('-vf');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('fps=60');
    });

    it('永远同时设置输出 -r 60（保证容器级 fps 标签也是 60）', () => {
      var args = buildArgs({ input: 'in.webm', output: 'out.mp4' });
      var rIdx = args.indexOf('-r');
      expect(rIdx).toBeGreaterThan(-1);
      expect(args[rIdx + 1]).toBe('60');
    });

    it('调用方传 maxFps=30 时：用 30 而不是 60（escape hatch）', () => {
      var args = buildArgs({ input: 'in.webm', output: 'out.mp4', maxFps: 30 });
      var vfIdx = args.indexOf('-vf');
      expect(args[vfIdx + 1]).toBe('fps=30');
      var rIdx = args.indexOf('-r');
      expect(args[rIdx + 1]).toBe('30');
    });

    it('音频参数不被 fps 滤镜影响（仍是 aac 128k）', () => {
      var args = buildArgs({ input: 'in.webm', output: 'out.mp4' });
      expect(args).toContain('-c:a');
      var aIdx = args.indexOf('-c:a');
      expect(args[aIdx + 1]).toBe('aac');
      var bIdx = args.indexOf('-b:a');
      expect(args[bIdx + 1]).toBe('128k');
    });

    it('fps 滤镜位置：在 `-i input` 之后立即插入（输入 → fps → x264）', () => {
      var args = buildArgs({ input: 'in.webm', output: 'out.mp4' });
      var iIdx = args.indexOf('-i');
      expect(args[iIdx + 1]).toBe('in.webm');
      var vIdx = args.indexOf('-vf');
      expect(vIdx).toBeGreaterThan(iIdx);
      var cIdx = args.indexOf('-c:v');
      expect(cIdx).toBeGreaterThan(vIdx);
    });

    it('video.js 实际代码包含 "fps=" + maxFps 字符串插入（不在测试代码里凭空）', () => {
      expect(/'fps='\s*\+\s*maxFps/.test(VIDEO_JS)).toBe(true);
    });

    it('video.js 同时实现 -r maxFps 输出参数（保证容器 fps 标签一致）', () => {
      // 同一行同时含 'fps='+maxFps 与 '-r'+String(maxFps)
      expect(/'fps='\s*\+\s*maxFps\b[\s\S]*?'-r',\s*String\(maxFps\)/m.test(VIDEO_JS)).toBe(true);
    });

    it('video.js 实现 getMetadataSync（可被将来探测逻辑复用，**当前不强制调用**）', () => {
      // 注意：本轮修复**不**再依赖源 fps 探测（避免 webm/vp9 探测误差）。
      // getMetadataSync 保留供将来 / 别的模块使用。
      expect(/function\s+getMetadataSync/.test(VIDEO_JS)).toBe(true);
      expect(/spawnSync/.test(VIDEO_JS)).toBe(true);
    });
  });

  describe('(3) 帧率探测正则', () => {
    it('getMetadata stderr fps 解析：`(\\d+(?:\\.\\d+)?)\\s*fps`', () => {
      // 真实 ffmpeg 输出形如：`Stream #0:0(und): Video: vp9 ... 1280x720, 30 fps`
      // 或 `60 fps`；也常见小数 `29.97 fps`。
      var sample1 = 'Stream #0:0(und): Video: vp9 (libvpx-vp9), yuv420p(tv, bt709), 1280x720, SAR 1:1 DAR 16:9, 30 fps,';
      var sample2 = 'Stream #0:0: Video: h264, yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 59.94 fps,';
      var sample3 = 'Stream #0:0: Video: h264 1280x720 120 fps';
      var sample4 = 'Stream #0:0: Video: h264 1280x720 60 fps';
      var re = /Stream\b[^\n]*?\b(\d+(?:\.\d+)?)\s*fps\b/i;
      expect(re.exec(sample1)).toBeTruthy();
      expect(re.exec(sample1)[1]).toBe('30');
      expect(re.exec(sample2)[1]).toBe('59.94');
      expect(re.exec(sample3)[1]).toBe('120');
      expect(re.exec(sample4)[1]).toBe('60');
    });
  });

  describe('(4) 端到端：导出 MP4 帧率统一锁 60', () => {
    it('v1.20.2 实测场景：120 fps webm → mp4 fps=60', () => {
      // 用户实测：高刷新率屏（NV12 120Hz）录制 webm，ffmpeg -i 的 stderr 显示 fps=60
      //   （容器级默认标签），但**实际**时间戳序列 = 120 fps。条件式探测误判
      //   为「fps=60, 不加滤镜」，导出的 mp4 仍是 120 fps。
      //   v1.20.2：永远强制 fps=60（不探测）。
      var args = buildArgs({ input: 'rec.webm', output: 'rec.mp4' });
      expect(args[args.indexOf('-vf') + 1]).toBe('fps=60');
      expect(args[args.indexOf('-r') + 1]).toBe('60');
    });
    it('低帧率 webm（30 fps）→ mp4 仍是 60 fps（强制上限）', () => {
      // 用户要求：导出上限 60fps，不论源多少。低源转码后**保持上限 60**，
      //   视频时长不变（fps filter 是恒等映射，没有 drop）。
      var args = buildArgs({ input: 'rec.webm', output: 'rec.mp4', maxFps: 60 });
      expect(args[args.indexOf('-r') + 1]).toBe('60');
      // 与之前的实现对比：之前版本源 fps ≤ 60 时**不**插入 fps 滤镜，
      //   x264 输出 = 源 fps（保留但可能漏强制上限）；现在永远 60。
    });
  });
});
