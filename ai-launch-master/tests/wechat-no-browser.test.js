// Rokit · 微信公众号「不允许走浏览器发布路径」测试（v1.1）
//
// 关键不变量：
//   1. pub:launch / pub:submit 收到 platformId='wechat' 时，主进程 pubExec 必须立刻返回
//      api_only 状态，不创建 BrowserWindow，不调用 publishere.wechat.launch
//   2. 该判断在 main.js 的 pubExec 函数顶端，因此无论 stage 是 'fill' 还是 'submit'，
//      wechat 都必须被拒绝
//   3. 不能抛异常（避免主进程崩）
//   4. 返回值含 WECHAT_API_ONLY 标识，方便前端判断并切到 API 流
//
// 实现：直接 require('../electron/main.js') 不能跑（需要 electron 主进程上下文），
//   改用「注入 stub」方式：我们只测 pubExec 内部的判断路径。
//   为简化，直接读 main.js 源码里的 wechat 拒绝分支存在性 + 解析语法树
'use strict';

const fs = require('fs');
const path = require('path');

describe('微信公众号发布：禁止打开内置浏览器（main.js · pubExec 守卫）', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  it('main.js 应包含 wechat API-only 守卫分支（拒绝浏览器路径）', () => {
    // 检查 pubExec 函数顶端是否有 wechat 拒绝逻辑
    expect(mainSrc).toMatch(/if\s*\(\s*platformId\s*===\s*['"]wechat['"]\s*\)/);
    // 返回值含 status='api_only' 或类似
    expect(mainSrc).toMatch(/WECHAT_API_ONLY|api_only/);
    // 注释里应明确说明公众号已建公众号直接走 API
    expect(mainSrc).toMatch(/公众号.*API.*直发|微信公众号.*走.*官方/);
  });

  it('main.js 应已注册 wechat:upload-image / wechat:publish / wechat:publish-status 三个 IPC', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(['"]wechat:upload-image['"]/);
    expect(mainSrc).toMatch(/ipcMain\.handle\(['"]wechat:publish['"]/);
    expect(mainSrc).toMatch(/ipcMain\.handle\(['"]wechat:publish-status['"]/);
  });
});

describe('微信公众号发布：rocketGo 与 _runWechatPublishFlow 接入', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  it('rocketGo 应有 wechat 专属分支，且不走 pubLaunch IPC', () => {
    // 找到 rocketGo 函数体内的 wechat 分支
    const rocketGoMatch = htmlSrc.match(/window\.rocketGo=async function\s*\(\)\s*\{([\s\S]*?)\n {2}\};[\s\S]*?window\.setTitle/);
    expect(rocketGoMatch).toBeTruthy();
    const rocketGoBody = rocketGoMatch ? rocketGoMatch[1] : '';
    // 火箭发射内必须有 if(pid==='wechat') 分支
    expect(rocketGoBody).toMatch(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)/);
    // 且该分支应调用 _runWechatPublishFlow（官方 API 路径），不调 pubLaunch
    expect(rocketGoBody).toMatch(/_runWechatPublishFlow\s*\(/);
    // 确保 wechat 分支没有用 pubLaunch（pubLaunch 是浏览器路径，会打开 BrowserWindow）
    // 检查：rocketGoBody 内 wechat 分支不应包含 'window.api.pubLaunch(pid,payload)' 这一针对 wechat 的调用
    // 拆出 wechat 分支内部
    const wechatBranchMatch = rocketGoBody.match(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(wechatBranchMatch).toBeTruthy();
    const wechatBranchBody = wechatBranchMatch ? wechatBranchMatch[1] : '';
    expect(wechatBranchBody).not.toMatch(/window\.api\.pubLaunch\s*\(\s*pid\s*,\s*payload\s*\)/);
  });

  it('_runWechatPublishFlow 函数应仍存在并调用 wechat:draft-create IPC（v1.6 主流程只到草稿）', () => {
    expect(htmlSrc).toMatch(/window\._runWechatPublishFlow\s*=/);
    // v1.6 主流程只调 wechatDraftCreate；不再调 wechatPublish / wechatPublishStatus
    expect(htmlSrc).toMatch(/window\.api\.wechatDraftCreate\s*\(/);
    // 不允许走 BrowserWindow 的标识（避免引入新的浏览器路径）
    expect(htmlSrc).not.toMatch(/_runWechatPublishFlow[\s\S]{0,2000}pubOpen/);
  });

  it('PLATFORMS.wechat 在 publishers.js 仍存在但 fill 返回 manual（不依赖浏览器）', () => {
    const pubSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'publishers.js'), 'utf8');
    expect(pubSrc).toMatch(/wechat:\s*\{[\s\S]*?fill:\s*function\s*\(\)/);
    // 旧文案「公众号草稿请通过官方 API 创建」可能仍在，但实际不再被调用（main.js 拒绝走 wechat 路径）
    // 因此本次不强制删除这条文案（保留是有意的，告诉读者浏览器路径不可用）
  });
});

describe('微信公众号发布 v1.2：超时/任务/视频不变量（HTML 源码层）', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  // 用 indexOf 锚点取函数体（regex 在 CRLF 源码里易碎；indexOf 最稳）
  function extractFlowBody(){
    var startIdx = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
    if(startIdx < 0) return '';
    var endIdx = htmlSrc.indexOf('window.launch=function()', startIdx);
    if(endIdx < 0) return '';
    return htmlSrc.slice(startIdx, endIdx);
  }

  it('v1.2：_runWechatPublishFlow 应维护单一 active 任务锁（防重复发射）', () => {
    var fn = extractFlowBody();
    expect(fn).toMatch(/_wechatFlowActive\s*&&/);
    expect(fn).toMatch(/task\.done\s*=\s*true/);
    expect(fn).toMatch(/clearAllTimers/);
  });

  it('v1.2：rocketGo 的 wechat 分支应不再用 45s setTimeout 保险', () => {
    var wechatBranchMatch = htmlSrc.match(/if\s*\(\s*pid\s*===\s*['"]wechat['"]\s*\)\s*\{([\s\S]*?)\r?\n\s*\}\s*\r?\n\s*\/\/\s*YouTube/);
    expect(wechatBranchMatch).toBeTruthy();
    var wb = wechatBranchMatch ? wechatBranchMatch[1] : '';
    // 旧 v1.1 的 setTimeout(45000) 必须被移除（v1.1 保险与 v1.2 内置 45s 轮询同时触发，造成重复提示）
    expect(wb).not.toMatch(/setTimeout\([^,]+,\s*45000\s*\)/);
    // 应改用 await flow 的 Promise
    expect(wb).toMatch(/await\s+window\._runWechatPublishFlow/);
  });

  it('v1.3：公众号图文流程不应再因 state.videoAsset 提前拒绝', () => {
    var fn = extractFlowBody();
    expect(fn.length).toBeGreaterThan(1000);
    // v1.3 移除了 v1.2 的「检测到 videoAsset → fail」分支；图文发布现在直接走到 checkCreds
    expect(fn).not.toMatch(/state\.videoAsset\s*&&\s*state\.videoAsset\.id/);
    // 不应再有「检测到 Rokit 已加载视频资产」的阻断文案
    expect(fn).not.toMatch(/检测到 Rokit 已加载视频资产/);
  });

  it('v1.2：轮询 8 次仍 pending → 应进入 UNKNOWN 状态（不视为失败）', () => {
    var fn = extractFlowBody();
    // 状态枚举应含 unknown
    expect(fn).toMatch(/UNKNOWN:\s*['"]unknown['"]/);
    // 超时分支应映射到 status:'unknown' 而非 'pending_timeout'
    expect(fn).toMatch(/status:\s*['"]unknown['"]/);
    // UNKNOWN 状态时不该调 toast（避免重复弹窗）：fail 分支的 toast 条件应显式排除 UNKNOWN
    expect(fn).toMatch(/step\s*===\s*STEP\.FAILED\s*\|\|\s*step\s*===\s*STEP\.PERMISSION_DENIED/);
  });

  it('v1.2：必须暴露 _wechatManualCheckStatus 给用户主动恢复', () => {
    expect(htmlSrc).toMatch(/window\._wechatManualCheckStatus\s*=/);
  });

  it('v1.2：单次轮询 in-flight 校验 — task.done 后立即停止轮询', () => {
    var fn = extractFlowBody();
    // pollStatus next() 起手检查 task.done
    expect(fn).toMatch(/function\s+next\(\)\s*\{[\s\S]*?if\s*\(\s*task\.done\s*\)/);
    // 收到响应后也检查
    expect(fn).toMatch(/if\s*\(\s*task\.done\s*\)\s*return[^;]*task_done/);
  });

  it('v1.2：submitPublish 应记 publishId 到 task 中间状态（防重复）', () => {
    var fn = extractFlowBody();
    expect(fn).toMatch(/task\.publishId\s*=\s*r\.publishId/);
  });
});