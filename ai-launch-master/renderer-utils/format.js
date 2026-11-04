// Rokit · renderer 工具（第一批：低风险模块化）
// 归档内容：
//   - HTML 转义工具 esc（纯函数，无副作用，234 处调用点）。
//   - GitHub 文章 Markdown 组装（githubRelPrefix / videoSectionHtml / buildGithubArticleBody）。
//     普通自动发布（index.html）与首秀计划执行器（electron/plan-github-executor.js）
//     必须调用同一份实现：渲染层通过 <script> 加载，主进程直接 require。
//
// 导出方式：UMD-lite 风格，浏览器端落到 window；其它环境（Node）挂 globalThis，
//   并通过 module.exports 暴露给主进程 require（浏览器没有 module，不会触发）。
//   - 不依赖任何其它模块；脚本可以被任意顺序加载（不会改变其它 IIFE 的变量查找）。
//   - 与 index.html 内联脚本中对 esc 的调用语义 100% 一致。
//
// 历史：原实现来自 ai-launch-master/index.html 内嵌 IIFE，约第 3753 行；
//   GitHub 正文拼装原实现在 index.html 第 16747-16812 行附近。
(function (root) {
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------- GitHub 文章 Markdown 组装（普通自动发布 / 首秀计划共用） ----------
  // 相对路径规则：文章在 posts/<slug>.md，视频在 videos/<slug>.mp4。
  //   从文章所在目录出发回退到仓库根，再进入 videos/。
  //   例：posts/a.md → ../videos/a.mp4；blog/2026/posts/a.md → ../../../videos/a.mp4
  function githubRelPrefix(articlePath) {
    var p = String(articlePath || '').replace(/^\/+/, '');
    var dir = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '';
    var depth = dir ? dir.split('/').filter(Boolean).length : 0;
    // 文章位于仓库根时 depth=0，仍需回退一级才能进入 videos/
    return new Array(Math.max(depth, 1) + 1).join('../');   // posts/a.md → '../'；blog/x/posts/a.md → '../../../'
  }

  // 视频区域（不含正文），供正文拼接复用
  //   up: { articlePath, videoPath, coverPath }
  function videoSectionHtml(up) {
    var rel = githubRelPrefix(up.articlePath);
    return '\n\n---\n\n## 视频演示\n\n'
      + '[![' + rel + up.coverPath + '](' + rel + up.videoPath + ')\n\n'
      + '[点击封面打开视频](' + rel + up.videoPath + ')\n';
  }

  // GitHub 文章正文 + 可选在线阅读入口 + 可选视频区域
  //   保留用户编辑过的正文原样，只在末尾追加区块。
  function buildGithubArticleBody(body, video, pages) {
    if (!video && !pages) return body;
    var out = String(body || '').replace(/\s+$/, '');
    // Pages 网页链接：真正能在线播放视频的页面
    if (pages && pages.pageUrl) {
      out += '\n\n---\n\n## 在线阅读与播放\n\n'
        + '📄 [打开网页版（可在线播放视频）](' + pages.pageUrl + ')\n';
    }
    if (video) out += videoSectionHtml(video);
    return out;
  }

  if (typeof root.esc !== 'function') {
    root.esc = esc;
  }
  if (typeof root.githubRelPrefix !== 'function') {
    root.githubRelPrefix = githubRelPrefix;
  }
  if (typeof root.videoSectionHtml !== 'function') {
    root.videoSectionHtml = videoSectionHtml;
  }
  if (typeof root.buildGithubArticleBody !== 'function') {
    root.buildGithubArticleBody = buildGithubArticleBody;
  }

  // 主进程（electron/plan-github-executor.js）require 时拿到同一组函数
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      esc: esc,
      githubRelPrefix: githubRelPrefix,
      videoSectionHtml: videoSectionHtml,
      buildGithubArticleBody: buildGithubArticleBody
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
