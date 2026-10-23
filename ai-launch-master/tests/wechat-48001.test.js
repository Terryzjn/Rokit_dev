// Rokit · 微信公众号 v1.5：errcode 48001/48002 权限类映射 + 日志记录 + 错误路径区分
//
// 用户报告：「微信接口 48001：api unauthorized rid: 6acc59f6-4b3403ff-31847290」
//
// 真根因：原 ERRCODE_NOTES 没有 48001 条目（fallback 用 errmsg）；publishDraft 的
//   permission_denied 白名单只覆盖 40279/40248/43004/50005，未覆盖 48001/48002/45008。
//   requestJson 也没有把 rid 写入调试日志。
//
// 修复内容：
//   1. ERRCODE_NOTES 增加 48001/48002/48004/45008 中文释义
//   2. publishDraft / getPublishStatus / uploadImageMaterial 的 permission_denied 白名单
//      增加 48001/48002/48004/45008/45009/45011
//   3. requestJson 第四参数 stage + _logErrcode 调用（写入 endpoint + errcode + rid）
//   4. callWechat 根据 path 自动填 stage 名

'use strict';

const fs = require('fs');
const path = require('path');

const wechatSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'wechat.js'), 'utf8');

describe('微信公众号 v1.5：48001/48002 权限错误处理', () => {
  it('ERRCODE_NOTES 必须包含 48001 + 48002 + 45008 中文说明', () => {
    expect(wechatSrc).toMatch(/48001:\s*'API \u672a\u6388\u6743/);
    expect(wechatSrc).toMatch(/48002:\s*'\u516c\u4f17\u53f7\u672a\u5f00\u901a\u7fa4\u53d1/);
    expect(wechatSrc).toMatch(/45008:/);
  });

  it('publishDraft catch 块必须把 48001/48002/48004 映射到 permission_denied', () => {
    var m = wechatSrc.match(/async function publishDraft[\s\S]*?\}\s*\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).toMatch(/code === 48001/);
    expect(fn).toMatch(/code === 48002/);
    expect(fn).toMatch(/code === 48004/);
    expect(fn).toMatch(/status: 'permission_denied'/);
  });

  it('getPublishStatus catch 必须把 48001/48002 映射到 status=permission_denied', () => {
    var m = wechatSrc.match(/async function getPublishStatus[\s\S]*?\}\s*\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).toMatch(/c === 48001/);
    expect(fn).toMatch(/c === 48002/);
    expect(fn).toMatch(/status: 'permission_denied'/);
  });

  it('requestJson 必须把 endpoint + rid 写入 _logErrcode', () => {
    var m = wechatSrc.match(/async function requestJson[\s\S]*?\}\s*\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).toMatch(/_logErrcode/);
    expect(fn).toMatch(/rid/);
  });

  it('callWechat 必须根据 path 自动填 stage', () => {
    var m = wechatSrc.match(/async function callWechat[\s\S]*?\}\s*\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).toMatch(/'\/freepublish\/submit'.*stage = 'publish_submit'/);
    expect(fn).toMatch(/'\/freepublish\/get'.*stage = 'publish_get'/);
    expect(fn).toMatch(/'\/draft\/add'.*stage = 'draft_add'/);
  });

  it('_logErrcode 严禁打印 access_token / appSecret 真实值（只打 endpoint/errcode/errmsg/rid）', () => {
    expect(wechatSrc).toMatch(/function _logErrcode/);
    var m = wechatSrc.match(/function _logErrcode[\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).not.toMatch(/access_token/);
    expect(fn).not.toMatch(/appSecret/);
    expect(fn).toMatch(/errcode/);
    expect(fn).toMatch(/endpoint/);
    expect(fn).toMatch(/rid/);
  });

  it('noteFromError 必须接收 endpoint 参数（用于错误显示带接口路径）', () => {
    var m = wechatSrc.match(/function noteFromError\([\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    var fn = m ? m[0] : '';
    expect(fn).toMatch(/function noteFromError\(\s*data\s*,\s*endpoint\s*\)/);
  });
});