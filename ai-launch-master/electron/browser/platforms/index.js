// Rokit · 平台注册统一入口（v1.7）
// ----------------------------------------------------------------
// 引入此模块即可把所有 platforms/* 注册到 PublisherRegistry。
// 新增平台时只需要：
//   1. 创建 electron/browser/platforms/{platformId}/{PlatformName}Publisher.js
//   2. 在本文件中 require 一次即可。
//   3. BrowserManager / browser-ipc 都不需要任何改动。
'use strict';

// 顺序：测试平台先注册（保证用户首次体验能直接验证）
require('./browser-test');

// 第一个真实平台：知乎
require('./zhihu/ZhihuPublisher');

// 第二个真实平台：V2EX
require('./v2ex/V2EXPublisher');

// 第三个真实平台：掘金（v1.11）
require('./juejin/JuejinPublisher');

// 预留：未来真正接入 B站、小红书、即刻、Product Hunt 时
//       在这里 require 一次即可，例如：
// require('./bilibili/BilibiliPublisher');

// 列出当前已注册的平台
const PublisherRegistry = require('../PublisherRegistry');

module.exports = {
  registeredPlatforms: PublisherRegistry.list()
};