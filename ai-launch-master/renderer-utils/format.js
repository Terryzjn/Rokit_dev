// Rokit · renderer 工具（第一批：低风险模块化）
// 归档内容：HTML 转义工具 esc（纯函数，无副作用，234 处调用点）。
//
// 导出方式：UMD-lite 风格，浏览器端落到 window.esc；其它环境（Node 测试）挂 globalThis。
//   - 不依赖任何其它模块；脚本可以被任意顺序加载（不会改变其它 IIFE 的变量查找）。
//   - 与 index.html 内联脚本中对 esc 的调用语义 100% 一致。
//
// 历史：原实现来自 ai-launch-master/index.html 内嵌 IIFE，约第 3753 行。
(function (root) {
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  if (typeof root.esc !== 'function') {
    root.esc = esc;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
