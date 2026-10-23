// Rokit · 微信公众号 v1.3：不调用视频上传、不被视频字段阻塞
//
// 关键不变量：
//   1. rocketGo wechat 分支：从 payload 中**剥离** videoAssetId / videoName / videoMime / videoDataUrl
//      / videoUploadSkipped / video / images，确保公众号图文接口（draft/add）不会收到本地视频字段
//   2. _runWechatPublishFlow 内部不再因 state.videoAsset 提前拒绝（v1.3 移除 step 0 视频检测）
//   3. UI 不调用 wechatUploadVideo / wechatPublishVideo IPC（保持视频能力只在 main.js 暴露但渲染进程不调用）
//   4. 不影响其他平台视频上传：XHS / X / jike / producthunt 仍读 state.videoAsset
//
// 通过 grep + indexOf 直接检查，理由是本脚本（环境为 node-only，无浏览器）
//   不便于真实运行 _runWechatPublishFlow，源代码层断言更直接、可重复
'use strict';

const fs = require('fs');
const path = require('path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

describe('微信公众号 v1.3：移除视频上传流程', () => {
  it('rocketGo wechat 分支应剥离 videoAssetId / videoName / videoMime / videoDataUrl 等字段', () => {
    // 找到 rocketGo 内的 wechat 分支
    const m = htmlSrc.match(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)\s*\{([\s\S]*?)\r?\n\s+\}\s*\/\/\s*YouTube/);
    expect(m).toBeTruthy();
    const wb = m ? m[1] : '';
    // 6 个 delete 语句必须存在
    expect(wb).toMatch(/delete\s+payload\.videoAssetId/);
    expect(wb).toMatch(/delete\s+payload\.videoName/);
    expect(wb).toMatch(/delete\s+payload\.videoMime/);
    expect(wb).toMatch(/delete\s+payload\.videoDataUrl/);
    expect(wb).toMatch(/delete\s+payload\.videoUploadSkipped/);
    expect(wb).toMatch(/delete\s+payload\.video\b/);
    expect(wb).toMatch(/delete\s+payload\.images/);
  });

  it('_runWechatPublishFlow 内部不应再有 state.videoAsset 提前拒绝', () => {
    // 函数体
    const startIdx = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
    const endIdx = htmlSrc.indexOf('window.launch=function()', startIdx);
    expect(startIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const fn = htmlSrc.slice(startIdx, endIdx);
    // v1.3 删除了整个 step 0 视频检测块（包含检测 + fail）
    expect(fn).not.toMatch(/step 0:.*\u89c6\u9891\u68c0\u6d4b/);
    // 不应再有「检测到 Rokit 已加载视频资产」的报错文案
    expect(fn).not.toMatch(/\u68c0\u6d4b\u5230 Rokit \u5df2\u52a0\u8f7d\u89c6\u9891\u8d44\u4ea7/);
    // 不应再有对 state.videoAsset.id 的判断
    expect(fn).not.toMatch(/state\.videoAsset\s*&&\s*state\.videoAsset\.id/);
  });

  it('微信公众号 UI 不应调用 wechatUploadVideo / wechatPublishVideo IPC', () => {
    // 整份 index.html（不限于 _runWechatPublishFlow）都不能调这俩 API
    expect(htmlSrc).not.toMatch(/window\.api\.wechatUploadVideo\s*\(/);
    expect(htmlSrc).not.toMatch(/window\.api\.wechatPublishVideo\s*\(/);
  });

  it('其他平台视频上传逻辑应保持不变（XHS / X / jike / producthunt）', () => {
    // 验证其他平台仍读 state.videoAsset
    expect(htmlSrc).toMatch(/id==='jike' \|\| id==='producthunt'.*state\.videoAsset/);
    expect(htmlSrc).toMatch(/id==='xiaohongshu' && state\.videoAsset/);
    expect(htmlSrc).toMatch(/id==='x' && state\.videoAsset/);
    // 火箭发射里也有 jike/producthunt/xiaohongshu/x 的 videoAssetId 注入
    expect(htmlSrc).toMatch(/state\.videoAsset\s*&&\s*state\.videoAsset\.id/);
  });

  it('rocketGo wechat 分支不应被 45s setTimeout 保险覆盖（v1.2 已修复，v1.3 保持）', () => {
    const m = htmlSrc.match(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)\s*\{([\s\S]*?)\r?\n\s+\}\s*\/\/\s*YouTube/);
    expect(m).toBeTruthy();
    const wb = m ? m[1] : '';
    expect(wb).not.toMatch(/setTimeout\([^,]+,\s*45000\s*\)/);
  });

  it('wechat 流程应继续创建草稿 / 提交群发 / 轮询状态（核心 API 链路未变）', () => {
    const m = htmlSrc.match(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)\s*\{([\s\S]*?)\r?\n\s+\}\s*\/\/\s*YouTube/);
    expect(m).toBeTruthy();
    const wb = m ? m[1] : '';
    // 调 _runWechatPublishFlow（仍是 API 流程入口）
    expect(wb).toMatch(/await\s+window\._runWechatPublishFlow\s*\(/);
    // 失败/成功/permission_denied 三态映射仍存在
    expect(htmlSrc).toMatch(/STEP\.PUBLISHED/);
    expect(htmlSrc).toMatch(/STEP\.FAILED/);
    expect(htmlSrc).toMatch(/STEP\.PERMISSION_DENIED/);
    expect(htmlSrc).toMatch(/STEP\.UNKNOWN/);
  });
});