// Rokit · 微信公众号 v1.6：端到端验证 v1.6 调整（草稿即结束）
//
// 用户第八节 7 个验收场景，对应 v1.6 renderer 层的 HTML 源码不变量：
//   1. 草稿成功 → finish(DRAFT_SAVED) → 不调 wechatPublish / wechatPublishStatus
//   2. 旧 48001 错误链路已被移除：src 中不应再依赖 freepublish/submit
//   3. 草稿成功后不再出现 "45 秒内未返回最终结果" 的旧 UNKNOWN 文案
//   4. 草稿成功后不再出现 "pObj is not defined"
//   5. 草稿失败 → 仍走 fail(FAILED)，真实错误透传
//   6. 草稿超时 → finish(UNKNOWN)，不重复 createDraft、不标记成功
//   7. 其他平台 launcher 不受影响（不修改 publishers.js / launch path）
'use strict';

const fs = require('fs');
const path = require('path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFlowBody(){
  var startIdx = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
  if(startIdx < 0) return '';
  var endIdx = htmlSrc.indexOf('window.launch=function()', startIdx);
  if(endIdx < 0) return '';
  return htmlSrc.slice(startIdx, endIdx);
}

function extractDraftThenBody(){
  var fnStart = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
  var fnEnd = htmlSrc.indexOf('window.launch=function()', fnStart);
  var all = htmlSrc.slice(fnStart, fnEnd);
  var start = all.indexOf('return createDraft().then(function(dr){');
  if(start < 0) return '';
  var braceStart = start + 'return createDraft().then(function(dr){'.length;
  var depth = 1;
  var i = braceStart;
  var inStr = null;
  while(i < all.length){
    var ch = all[i];
    if(inStr){
      if(ch === '\\'){ i += 2; continue; }
      if(ch === inStr) inStr = null;
      i++;
      continue;
    }
    if(ch === '"' || ch === "'" || ch === '`'){ inStr = ch; i++; continue; }
    if(ch === '/' && i + 1 < all.length && all[i + 1] === '/'){
      var nl = all.indexOf('\n', i);
      i = nl < 0 ? all.length : nl + 1;
      continue;
    }
    if(ch === '/' && i + 1 < all.length && all[i + 1] === '*'){
      var end2 = all.indexOf('*/', i + 2);
      i = end2 < 0 ? all.length : end2 + 2;
      continue;
    }
    if(ch === '{') depth++;
    else if(ch === '}'){
      depth--;
      if(depth === 0){ return all.slice(start, i + 1); }
    }
    i++;
  }
  return '';
}

describe('微信公众号 v1.6：草稿即结束 — 7 个验收场景（renderer 源码层）', () => {
  it('场景1：草稿成功 → finish(DRAFT_SAVED) → 主流程不调 wechatPublish / wechatPublishStatus', () => {
    var draft = extractDraftThenBody();
    expect(draft.length).toBeGreaterThan(100);
    expect(draft).toMatch(/finish\(STEP\.DRAFT_SAVED/);
    expect(draft).not.toMatch(/window\.api\.wechatPublish\s*\(/);
    expect(draft).not.toMatch(/window\.api\.wechatPublishStatus\s*\(/);
    expect(draft).not.toMatch(/submitPublish\s*\(/);
    expect(draft).not.toMatch(/pollStatus\s*\(/);
    // 手动恢复入口仍保留（用户在 UNKNOWN 草稿时点击「恢复」重新发起手动查询）
    expect(htmlSrc).toMatch(/window\._wechatManualCheckStatus\s*=/);
  });

  it('场景2：旧 48001 permission_denied 路径不再被自动调用（旧正式发布链路已去除）', () => {
    var draft = extractDraftThenBody();
    // 主流程内不允许再判断 pr.status === 'permission_denied'
    expect(draft).not.toMatch(/pr\.status\s*===\s*['"]permission_denied['"]/);
  });

  it('场景3：草稿成功后不再出现旧的「45 秒内未返回最终结果」超时文案', () => {
    var fn = extractFlowBody();
    expect(fn).not.toContain('45 秒内未返回最终结果');
  });

  it('场景4：草稿成功后不存在 pObj 引用（v1.4 历史 bug 修复仍保留）', () => {
    var fn = extractFlowBody();
    expect(fn).not.toMatch(/\bpObj\b/);
  });

  it('场景5：草稿失败仍正确透传真实错误（不把异常伪装成成功）', () => {
    var draft = extractDraftThenBody();
    // 三类分支都存在：config_required / timeout / 其他错误
    expect(draft).toMatch(/dr\.status\s*===\s*['"]config_required['"]/);
    expect(draft).toMatch(/dr\.status\s*===\s*['"]timeout['"]/);
    expect(draft).toMatch(/fail\(STEP\.FAILED,\s*dr\.note/);
    // config_required 文案应引导用户去设置中配齐
    expect(draft).toContain('请到设置中配置公众号');
  });

  it('场景6：草稿请求超时 → finish(UNKNOWN)，不重新 createDraft，也不标成功', () => {
    var draft = extractDraftThenBody();
    expect(draft).toMatch(/dr\.status\s*===\s*['"]timeout['"]/);
    expect(draft).toMatch(/finish\(STEP\.UNKNOWN/);
    expect(draft).toContain('草稿创建请求超时');
    expect(draft).toContain('结果未知');
    // 超时分支体不应再次调 createDraft
    var start = draft.indexOf("dr.status === 'timeout'");
    var endPos = draft.indexOf('return;', start);
    var branch = draft.slice(start, endPos);
    expect(branch).not.toMatch(/createDraft\s*\(/);
  });

  it('场景7：其他平台 launcher 不受影响（公众号隔离在 _runWechatPublishFlow）', () => {
    var launchStart = htmlSrc.indexOf('window.launch=function(){');
    expect(launchStart).toBeGreaterThan(0);
    var nextFnStart = htmlSrc.indexOf('window.rocketGo=', launchStart);
    var launchBody = htmlSrc.slice(launchStart, nextFnStart);
    expect(launchBody).not.toMatch(/if\s*\(\s*id\s*===\s*['"]wechat['"]/);
    // rocketGo 仍调用 _runWechatPublishFlow 兜住 wechat
    expect(htmlSrc).toMatch(/await\s+window\._runWechatPublishFlow/);
  });
});
