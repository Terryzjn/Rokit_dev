// Rokit · X (Twitter) 寻找「帖子编辑器」IIFE 脚本（v1.0 phase 1）
// ----------------------------------------------------------------
// 唯一职责：在 /compose/post 页面里寻找发推文本编辑器，**不做任何填表**。
//
// 输出形状：
//   {
//     found:           boolean,
//     selector:        string | null,        // 命中用的 selector（多 selector fallback 中第一个命中）
//     composer: {
//   tag, role, ariaLabel, placeholder,
//   contenteditable, dataTestid,
//   visible, height, width
// } | null,
//     currentUrl:      string,
//     waitMs:          number,    // 实际等待时长（毫秒）
//     attempts:        number,    // 探测次数
//     elapsedMs:       number,    // 总耗时
//   }
//
// 候选 selector（按特异性从高到低）：
//   - X 官方实际用 [data-testid="tweetTextarea_0"] 作为发推文本框
//   - 兜底用 [role="textbox"][contenteditable="true"]（与 publishers.js 老 adapter 同源）
//   - 不依赖容易变化的 CSS class
//
// 等待策略：
//   - 默认 800ms × 30 次（最长 24s），可由 waitTimeoutMs / pollIntervalMs 覆盖。
//   - 超过上限返回 found=false，**不**报错（phase 1 让 UI 看到明确状态）。
//
// ⚠ 关于实测：
//   本文件中的 selector 是基于 X (Twitter) 公开页面快照 + 老 Rokit 代码产生
//   的保守候选清单。**沙盒无 GUI**，我无法替你实测。首次实测时若某个
//   selector 不命中：
//     1) 打开 Electron 内置浏览器手动到 https://x.com/compose/post
//     2) 在 DevTools 用 document.querySelector 找真实编辑器的 selector
//     3) 更新本文件 X_COMPOSER_SELECTORS 列表
//   不需要改测试按钮 / 流程代码。
'use strict';

// ----------------------------------------------------------------
// X 帖子编辑器 selector 候选（按特异性从高到低）
// ----------------------------------------------------------------
var X_COMPOSER_SELECTORS = [
  // X 官方发推文本框（最稳定）
  '[data-testid="tweetTextarea_0"]',
  // 兼容：旧版 / 备用
  '[data-testid="tweetTextarea_1"]',
  '[data-testid="tweetTextarea_2"]',
  // 通用：role + contenteditable
  '[role="textbox"][contenteditable="true"]',
  // Draft.js / Slate.js 等富文本编辑器常用属性
  '[contenteditable="true"][data-text="true"]',
  '[contenteditable="true"][aria-label]',
  '[contenteditable="true"][aria-multiline="true"]',
  '[contenteditable="true"][role="textbox"]',
  // 兜底
  '[contenteditable="true"]'
];

// ----------------------------------------------------------------
// 排除非「发推框」的元素
//   - 搜索框（顶栏 Search）
//   - DM / 私信输入框
//   - 回复框（reply modal 内的二级输入框）
// 我们只认 tweetTextarea_0..2 与「明显是大块编辑器」的元素。
// ----------------------------------------------------------------
function _isExcluded(el) {
  try {
    var role = (el.getAttribute && el.getAttribute('role')) || '';
    var ph = String((el.getAttribute && el.getAttribute('placeholder')) || '').trim();
    var al = String((el.getAttribute && el.getAttribute('aria-label')) || '').trim();
    var dt = String((el.getAttribute && el.getAttribute('data-testid')) || '').trim();
    var parentTest = '';
    try {
        var p = el.parentElement;
        while (p && p !== document.body) {
          var pdt = (p.getAttribute && p.getAttribute('data-testid')) || '';
          if (pdt) { parentTest = pdt; break; }
          p = p.parentElement;
        }
    } catch (_e) {}
    // 搜索框
    if (/search/i.test(role)) return 'search-by-role';
    if (/search/i.test(ph)) return 'search-by-placeholder';
    if (/search/i.test(al)) return 'search-by-aria';
    if (/Search/i.test(dt)) return 'search-by-testid';
    if (/search/i.test(parentTest)) return 'search-by-parent';
    // DM / 私信
    if (/message|DM|私信/i.test(al)) return 'dm-by-aria';
    if (/message|DM|私信/i.test(ph)) return 'dm-by-placeholder';
    if (/DMDialog|DMTweetCompose/i.test(parentTest)) return 'dm-by-parent';
    return null;
  } catch (_e) {
    return null;
  }
}

// ----------------------------------------------------------------
// 描述元素给 Main 看的形状
// ----------------------------------------------------------------
function _describe(el) {
  try {
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var visible = !!(
      rect && rect.width > 0 && rect.height > 0
    );
    return {
      tag: el.tagName,
      role: (el.getAttribute && el.getAttribute('role')) || '',
      ariaLabel: String((el.getAttribute && el.getAttribute('aria-label')) || ''),
      placeholder: String((el.getAttribute && el.getAttribute('placeholder')) || ''),
      contenteditable: String((el.getAttribute && el.getAttribute('contenteditable')) || ''),
      dataTestid: String((el.getAttribute && el.getAttribute('data-testid')) || ''),
      visible: visible,
      height: rect ? rect.height : 0,
      width: rect ? rect.width : 0
    };
  } catch (_e) {
    return null;
  }
}

// ----------------------------------------------------------------
// 主 IIFE
// ----------------------------------------------------------------
function buildXFindComposerScript(opts) {
  opts = opts || {};
  var selectors = Array.isArray(opts.selectors) && opts.selectors.length
    ? opts.selectors.slice()
    : X_COMPOSER_SELECTORS.slice();
  var pollIntervalMs = Number(opts.pollIntervalMs) || 800;
  var maxAttempts = Number(opts.maxAttempts) || 30;
  var payload = JSON.stringify({
    selectors: selectors,
    pollIntervalMs: pollIntervalMs,
    maxAttempts: maxAttempts
  });

  // 在页面里：
  //  - sleep / 探测 selectors / 返回 found / selector / composer 描述
  return '(' +
    'async function xFindComposer(p){\n' +
    '  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    '  var log = function(msg, extra){ try{ console.log("[X-publish][diag] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} };\n' +
    '  var _isExcluded = ' + _isExcluded.toString() + ';\n' +
    '  var _describe = ' + _describe.toString() + ';\n' +
    '  function probeOne(){\n' +
    '    for(var i=0;i<p.selectors.length;i++){\n' +
    '      var sel = p.selectors[i];\n' +
    '      try{\n' +
    '        var el = document.querySelector(sel);\n' +
    '        if(!el) continue;\n' +
    '        var ex = _isExcluded(el);\n' +
    '        if(ex){\n' +
    '          log("selector hit but excluded", { selector: sel, excludedBy: ex });\n' +
    '          continue;\n' +
    '        }\n' +
    '        // 验证可见（width/height > 0）\n' +
    '        var rect = el.getBoundingClientRect();\n' +
    '        if(!rect || rect.width <= 0 || rect.height <= 0){\n' +
    '          log("selector hit but not visible", { selector: sel });\n' +
    '          continue;\n' +
    '        }\n' +
    '        return { el: el, selector: sel };\n' +
    '      }catch(_e){}\n' +
    '    }\n' +
    '    return null;\n' +
    '  }\n' +
    '  var t0 = Date.now();\n' +
    '  var attempts = 0;\n' +
    '  while(attempts < p.maxAttempts){\n' +
    '    attempts++;\n' +
    '    var hit = probeOne();\n' +
    '    if(hit){\n' +
    '      var desc = _describe(hit.el);\n' +
    '      log("composer found", { selector: hit.selector, attempts: attempts, composer: desc });\n' +
    '      return {\n' +
    '        found: true,\n' +
    '        selector: hit.selector,\n' +
    '        composer: desc,\n' +
    '        currentUrl: location.href,\n' +
    '        waitMs: Date.now() - t0,\n' +
    '        attempts: attempts,\n' +
    '        elapsedMs: Date.now() - t0\n' +
    '      };\n' +
    '    }\n' +
    '    await sleep(p.pollIntervalMs);\n' +
    '  }\n' +
    '  log("composer NOT found after waiting", { attempts: attempts, waitMs: Date.now() - t0, url: location.href });\n' +
    '  return {\n' +
    '    found: false,\n' +
    '    selector: null,\n' +
    '    composer: null,\n' +
    '    currentUrl: location.href,\n' +
    '    waitMs: Date.now() - t0,\n' +
    '    attempts: attempts,\n' +
    '    elapsedMs: Date.now() - t0\n' +
    '  };\n' +
    '}' +
    ')(' + payload + ')';
}

module.exports = {
  buildXFindComposerScript: buildXFindComposerScript,
  X_COMPOSER_SELECTORS: X_COMPOSER_SELECTORS
};