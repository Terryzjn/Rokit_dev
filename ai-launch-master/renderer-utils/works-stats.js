// Rokit · 「我的作品」GitHub / YouTube 统计刷新（第二阶段）
// 归档内容：refreshWorksGithubStats 的缓存、并发、PATCH 保存与局部 DOM 刷新。
//
// 加载方式：普通 <script>，在 index.html 主 IIFE 之前加载；不引入 ESM / 构建工具。
// 依赖注入：由主 IIFE 调用 create(deps) 传入 state、findWork、ytViewsText、toast；
//           api/document 默认取 window，测试可显式注入。
// 入口：index.html 保留 window.refreshWorksGithubStats 与 window.__ghs 兼容桥。
(function (root) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var state = deps.state;
    var findWork = deps.findWork;
    var ytViewsText = deps.ytViewsText;
    var toast = deps.toast;
    var doc = deps.document || root.document;
    // 主 IIFE 的 window.api 在调用时仍可用；测试可注入 deps.api。
    function getApi() { return deps.api || root.api; }

    var __ghs = { isRefreshing:false, worksFirstLoaded:false, lastRefreshAt:0 };

    async function refreshWorksGithubStats(opts){

    if(__ghs.isRefreshing){
      try{ console.log('[GitHubStats] refresh already in progress, skip'); }catch(_e){}
      return;
    }
    var force = !!(opts && opts.force); // 手动点「↻ 刷新」= true；首次进入自动触发 = false（用缓存）
    var real = (state.works||[]).filter(function(w){return w && !w.isSample;});
    if(!real.length){
      try{ toast('还没有真实作品，先点「+ 登记新作品」', 'warn'); }catch(_e){}
      return;
    }
    __ghs.isRefreshing = true;
    var btn = doc.getElementById('refreshWorksBtn');
    if(btn){ btn.disabled = true; btn.textContent = '↻ 刷新中...'; }
    // 卡片 loading 视觉（淡灰 + 不响应点击）；数字不清空
    doc.querySelectorAll('.wcard:not(.wsample)').forEach(function(c){ c.classList.add('ghs-loading'); });
    try{
      // YouTube 播放量缓存策略：6 小时内视为新鲜；无缓存 / 过期 / 手动刷新时才重新请求
      var YT_CACHE_TTL = 6*3600*1000;
      var nowTs = Date.now();
      var payload = real.map(function(w){
        var hasYtLink = !!(w.yt_url && String(w.yt_url).trim()) || /(?:youtube\.com|youtu\.be)/i.test(String(w.url||''));
        var wantYt = false;
        if (hasYtLink) {
          if (force) wantYt = true;
          else if (w.yt_views == null) wantYt = true;
          else {
            var ts = w.yt_updated_at ? new Date(w.yt_updated_at).getTime() : 0;
            if (!ts || (nowTs - ts) > YT_CACHE_TTL) wantYt = true;
          }
        }
        return { id:w.id, url:w.url||'', yt_url:w.yt_url||'', name:w.name||'', wantYt:wantYt };
      });
      var res = await getApi().refreshGithubStats(payload);
      if(!res || !res.ok){
        var em = (res && res.error) || 'IPC 调用失败';
        try{ console.warn('[GitHubStats] IPC failed:', em); }catch(_e){}
        try{ toast('GitHub 刷新失败：'+em, 'warn', 3000); }catch(_e){}
        return;
      }
      var updates = res.updates || [];
      var updated = 0, failed = 0;
      // 收集首个真实错误（用于 toast 显示，避免统一"刷新失败"）
      var firstFailDetail = null;
      var ytNoKey = false, ytOkCount = 0, ytFailCount = 0;
      updates.forEach(function(u){
        var w = findWork(u.id);
        if(!w) return;
        // v5：YouTube 播放量（与 GitHub 字段完全独立；失败保留旧缓存，绝不显示 0）
        if (typeof u.yt_views === 'number') {
          w.yt_views = u.yt_views;
          w.yt_updated_at = u.yt_updated_at || new Date().toISOString();
          ytOkCount++;
          try{ getApi().saveWork({ id: w.id, yt_views: w.yt_views, yt_updated_at: w.yt_updated_at }).catch(function(){}); }catch(_e){}
        } else if (u.yt_views_error) {
          ytFailCount++;
          try{ console.warn('[YouTubeStats]', w.name||w.id, 'views failed:', u.yt_views_error, 'reason=' + (u.yt_reason||'?'), 'http=' + (u.yt_http_status==null?'-':u.yt_http_status)); }catch(_e){}
          if (u.yt_reason === 'no-auth') ytNoKey = true;
        }
        if (u.ytOnly) return; // 仅 YouTube 更新的条目不参与 GitHub 成败计数
        if(u.ok){
          // 成功：按字段回写（null 表示该指标本次失败 → 保留旧值，不清零）
          var changed = false;
          if (typeof u.stars === 'number') { w.star = u.stars; changed = true; }
          if (typeof u.downloads === 'number') { w.dl = u.downloads; changed = true; }
          if (typeof u.visitors === 'number') { w.visitors = u.visitors; changed = true; }
          if (u.full_name) w.githubFullName = u.full_name;
          w.githubUpdatedAt = Date.now();
          // 三列至少一列成功就算"更新"，前端按字段 saveWork 双保险
          var persist = { id: w.id };
          if (typeof u.stars === 'number') persist.star = u.stars;
          if (typeof u.downloads === 'number') persist.dl = u.downloads;
          if (typeof u.visitors === 'number') persist.visitors = u.visitors;
          try{ getApi().saveWork(persist).catch(function(){}); }catch(_e){}
          if (changed) updated++; else failed++;
          // 单字段失败提示（不刷 toast；只在 console 留痕）
          if (u.stars_error)    try{ console.warn('[GitHubStats]', w.name||w.id, 'stars failed:', u.stars_error); }catch(_e){}
          if (u.downloads_error) try{ console.warn('[GitHubStats]', w.name||w.id, 'downloads failed:', u.downloads_error); }catch(_e){}
          if (u.visitors_error)  try{ console.warn('[GitHubStats]', w.name||w.id, 'visitors failed:', u.visitors_error); }catch(_e){}
        } else {
          // 全部失败：保留旧数据；按需求七不显示 0，仅 console 留痕
          failed++;
          try{ console.warn('[GitHubStats]', w.name||w.id, 'Star 拉取失败：', u.error, 'kind=' + (u.kind||'?'), 'code=' + (u.code||'-'), 'http=' + (u.status==null?'-':u.status)); }catch(_e){}
          if (!firstFailDetail) {
            // 把细分错误组装成人话，方便 toast 显示
            var kindLabel = {
              'http': 'HTTP 状态异常',
              'network': '网络/连接错误',
              'timeout': '请求超时（9s）',
              'parse': '响应解析失败',
              'no-field': 'GitHub 响应缺字段'
            }[u.kind] || ('未知 (' + (u.kind || '?') + ')');
            firstFailDetail = {
              workName: w.name || w.id || '',
              kind: kindLabel,
              http: u.status,
              code: u.code,
              gh_message: u.gh_message,
              errorName: u.errorName,
              raw: u.error
            };
          }
        }
      });
      __ghs.lastRefreshAt = Date.now();
      // 局部刷新每个真实作品卡片上的 Star / 下载 / 播放 三栏（其它字段保留）
      real.forEach(function(w){
        var card = doc.querySelector('[data-work-id="'+w.id+'"]');
        if(!card) return;
        var boxes = card.querySelectorAll('.wm .wv b');
        if (boxes[0]) boxes[0].textContent = (w.star || 0).toLocaleString();
        if (boxes[1]) boxes[1].textContent = (w.dl   || 0).toLocaleString();
        if (boxes[2]) boxes[2].textContent = ytViewsText(w);
      });
      // YouTube 播放量结果提示（独立于 GitHub 提示；失败已保留旧缓存）
      if (ytNoKey) {
        try{ toast('YouTube 未授权，播放量未更新；请到「推广渠道」完成 YouTube 授权', 'warn', 4200); }catch(_e){}
      } else if (ytFailCount && !ytOkCount && !updated && !failed) {
        // 仅 YouTube 刷新且全部失败时才单独提示（GitHub 提示逻辑在下方）
        try{ toast('YouTube 播放量获取失败，已保留上次数据', 'warn', 3000); }catch(_e){}
      }
      if(updated && !failed)      try{ toast('GitHub 数据刷新完成', 'ok', 1800); }catch(_e){}
      else if(updated && failed)  try{ toast('部分 GitHub 数据刷新失败（'+failed+' 个保留旧数据）', 'warn', 2600); }catch(_e){}
      else if(firstFailDetail){
        // v1.10：显示真实错误原因，而不是统一"刷新失败"
        try{
          var parts = [];
          parts.push('GitHub Star 失败');
          if (firstFailDetail.workName) parts.push('（' + firstFailDetail.workName + '）');
          parts.push('：');
          parts.push(firstFailDetail.kind || '未知原因');
          if (firstFailDetail.http != null) parts.push('· HTTP ' + firstFailDetail.http);
          if (firstFailDetail.code) parts.push('· ' + firstFailDetail.code);
          if (firstFailDetail.gh_message) parts.push('· GitHub: ' + firstFailDetail.gh_message);
          else if (firstFailDetail.raw) parts.push('· ' + firstFailDetail.raw);
          toast(parts.join(' '), true, 4500);
        }catch(_e){}
      }
      else                        try{ toast('GitHub 刷新失败，已保留旧数据', 'warn', 2600); }catch(_e){}
    }catch(e){
      var msg = String((e && e.message) || e);
      try{ console.warn('[GitHubStats] unexpected error:', msg); }catch(_e){}
      try{ toast('GitHub 刷新异常：'+msg, 'warn', 3000); }catch(_e){}
    }finally{
      __ghs.isRefreshing = false;
      if(btn){ btn.disabled = false; btn.textContent = '↻ 刷新'; }
      doc.querySelectorAll('.wcard.ghs-loading').forEach(function(c){ c.classList.remove('ghs-loading'); });
    }
    }

    return { refresh: refreshWorksGithubStats, ghs: __ghs };
  }

  root.RokitWorksStats = { create: create };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
