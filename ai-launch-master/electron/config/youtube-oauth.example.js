'use strict';
// Rokit · YouTube / Google OAuth 应用配置 — 占位模板
//
// 这个文件**可以**安全提交到公开仓库（不含真实凭据）。
// 真实凭据请放在 `youtube-oauth.local.js`（已加入 .gitignore）。
//
// 如何获取：
//   1. 打开 https://console.cloud.google.com/apis/credentials
//   2. Create Credentials → OAuth client ID → Application type: **Desktop app**
//   3. 复制 Client ID 和 Client Secret
//   4. 复制本文件为 `youtube-oauth.local.js`，填入真实值
//
// Authorized redirect URI（Google Cloud 里加）：
//   http://127.0.0.1/oauth2callback   ← Rokit 自动用 loopback 端口
//
// 启用 API：APIs & Services → Library → YouTube Data API v3 → Enable

module.exports = {
  // 必填；来自 Google Cloud OAuth Client ID
  clientId: '',
  // 必填；来自 Google Cloud OAuth Client Secret（confidential client 必须）
  clientSecret: ''
};