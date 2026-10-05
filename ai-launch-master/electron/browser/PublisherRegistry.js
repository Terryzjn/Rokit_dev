// Rokit · Publisher 注册中心（v1.7）
// ----------------------------------------------------------------
// 与需求文档第七、二十三条对应：
//   - 集中管理 platformId -> Publisher 类的映射。
//   - 提供 get(id) / has(id) / list() / register(id, Ctor) / instantiate(id, opts)。
//   - 平台可通过 PublisherRegistry.register('xxx', XxxPublisher) 注册，
//     BrowserManager 不需要任何修改即可支持新平台。
//   - 默认情况下会注册 BrowserTestPublisher（用于测试整个浏览器框架）。
'use strict';

var registry = Object.create(null);

function register(platformId, Ctor) {
  if (!platformId) throw new Error('PublisherRegistry.register: platformId 必填');
  if (typeof Ctor !== 'function') throw new Error('PublisherRegistry.register: Ctor 必须是 class/function');
  registry[String(platformId)] = Ctor;
}

function unregister(platformId) {
  delete registry[String(platformId)];
}

function has(platformId) {
  return Object.prototype.hasOwnProperty.call(registry, String(platformId || ''));
}

function get(platformId) {
  return registry[String(platformId || '')] || null;
}

function list() {
  return Object.keys(registry).slice();
}

// instantiate(id, opts) -> Publisher 实例
// opts 至少需要 { browserManager }；platformId 自动取自 id。
function instantiate(platformId, opts) {
  var Ctor = get(platformId);
  if (!Ctor) throw new Error('PublisherRegistry: 未注册平台 "' + platformId + '"');
  var o = Object.assign({}, opts || {});
  o.platformId = String(platformId);
  return new Ctor(o);
}

module.exports = {
  register: register,
  unregister: unregister,
  has: has,
  get: get,
  list: list,
  instantiate: instantiate
};