// Rokit · 数据看板页面模块（第二阶段第一批）
// 归档内容：发布记录归一化 / 时段筛选 / KPI / 渠道状态 / 平台占比 / 发布记录 / 里程碑渲染，
// 以及看板内的渠道、作品跳转入口。
//
// 加载方式：普通 <script>，在 index.html 主 IIFE 之前加载；不引入 ESM / 构建工具。
// 依赖注入：由主 IIFE 调用 create(deps) 传入 state、esc、PLATFORMS 及跨页面函数，
//           不直接读取主 IIFE 的闭包变量。window.openDash* / toggleDashPubList 保持原入口。
(function (root) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var state = deps.state;
    var esc = deps.esc;
    var PLATFORMS = deps.platforms || [];
    var go = deps.go;
    var toast = deps.toast;
    var findWork = deps.findWork;
    var formatRelTime = deps.formatRelTime;
    // openChannelEditor / openWork 在主 IIFE 更晚的位置才挂到 window，调用时再取，避免过早捕获 undefined。
    var openChannelEditor = function (id, opts) { return root.openChannelEditor(id, opts); };
    var openWork = function (id) { return root.openWork(id); };

    /* ===== 数据看板 ===== */

    /* ---------- 数据来源与归一化 ----------
       发布记录有两个来源：
         1) 本机 SQLite 的 pubs 表（listPubs 返回：platform=平台名称、time=HH:MM、created_at=ISO）
         2) 本次运行内实时回填的 state.pubLog（带平台 id 与精确时间戳）
       两者统一成同一结构后再统计，避免「平台名称当 id 用」造成统计与配色错位。 */

    var DASH_RANGE_LABEL = {session:'本次启动', today:'今天', '7d':'近 7 天', all:'全部历史'};

    function platformMetaById(id){
      if(!id) return null;
      for(var i=0;i<PLATFORMS.length;i++){ if(PLATFORMS[i].id===id) return PLATFORMS[i]; }
      return null;
    }
    function platformMetaByName(name){
      if(!name) return null;
      var n=String(name).trim();
      for(var i=0;i<PLATFORMS.length;i++){ if(PLATFORMS[i].name===n) return PLATFORMS[i]; }
      for(var j=0;j<PLATFORMS.length;j++){ if(PLATFORMS[j].name.toLowerCase()===n.toLowerCase()) return PLATFORMS[j]; }
      return null;
    }
    // channels.kind 与 PLATFORMS.id 存在历史别名（ph / xhs），比对前先统一映射
    var DASH_KIND_ALIAS = {ph:'producthunt', xhs:'xiaohongshu'};
    function platformIdOfKind(kind){
      if(!kind) return '';
      var k=String(kind);
      if(DASH_KIND_ALIAS[k]) k=DASH_KIND_ALIAS[k];
      return platformMetaById(k)?k:'';
    }
    function findChannelByPlatform(pid){
      if(!pid) return null;
      var list=state.channels||[];
      for(var i=0;i<list.length;i++){
        if(platformIdOfKind(list[i].kind)===pid) return list[i];
      }
      return null;
    }
    function channelEnabled(c){ return !!(c && (c.enabled===1 || c.enabled===true)); }
    function channelVisual(c){
      var pid=platformIdOfKind(c.kind);
      var pm=pid?platformMetaById(pid):null;
      var name=(c&&c.name)||(pm&&pm.name)||(c&&c.kind)||'?';
      return {pid:pid, name:name, char:String(name).charAt(0)||'?', color:(pm&&pm.color)||'#5A6B72'};
    }
    function pubChar(name){ return String(name||'?').trim().charAt(0)||'?'; }
    function pubMeta(name,id){ return platformMetaById(id)||platformMetaByName(name)||{id:id||'',name:name||'未知平台',color:'#5A6B72'}; }
    // 内联 onclick 的参数转义（esc 不处理单引号）
    function dashArg(s){ return String(s==null?'':s).replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }
    function absTime(ts){
      if(!ts) return '';
      var d=new Date(ts); if(isNaN(d.getTime())) return '';
      var p2=function(n){ return (n<10?'0':'')+n; };
      return (d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    }
    // 把一条发布记录归一化：{id,platform,platform_id,status,title,time,ts,work_id,session,url,error,video_id,pub_key,recId}
    //   平台身份优先用 platform_id（**实际发布目标**）；旧数据没有 platform_id 时才按名称反查，
    //   反查不到就保留原名并标记 platform_known=false —— 绝不猜测成别的平台。
    function normalizePub(r){
      r=r||{};
      var pid=String(r.platform_id||'');
      var m=(pid?platformMetaById(pid):null)||platformMetaById(r.id)||platformMetaByName(r.platform);
      var ts=r.created_at||'';
      if(!ts && r.session && r.time) ts=hmToLocalIso(r.time);
      // 缺失状态**不能**兜底成 'ok'（那会把"没记录状态"洗成"已发布"）。
      // 统一落成 'unknown'，由界面显示"状态未知"。
      var rawStatus=(r.status===null||r.status===undefined)?'':String(r.status).trim();
      var status=rawStatus||'unknown';
      return {
        id:(m&&m.id)||pid||r.id||'',
        platform:(m&&m.name)||r.platform||'',
        platform_id:pid||((m&&m.id)||''),
        platform_known:!!m,
        status:status,
        status_known:!!rawStatus,
        failed:status==='failed',
        title:r.title||'',
        body:r.body||'',
        time:r.time||'',
        ts:ts,
        url:r.url||'',
        error:r.error||'',
        video_id:r.video_id||'',
        pub_key:r.pub_key||'',
        recId:r.recId||'',
        work_id:r.work_id||'',
        session:!!r.session
      };
    }
    // 记录唯一键：优先 DB 幂等键；历史行退化为 db:<id>；会话行退化为 s:<时间>|<平台>
    function pubRecKey(r){
      r=r||{};
      if(r.pub_key) return String(r.pub_key);
      if(r.recId) return 'd:'+r.recId;
      return 's:'+String(r.ts||r.created_at||'')+'|'+(r.id||r.platform||'');
    }
    // 成功口径（唯一，全站共用）：
    //   ok     = 平台任务/接口确认发布成功
    //   manual = 人工完成（用户点「标记已发布」，或半自动平台自动填表后由用户在平台侧点发布）
    //   pending= 仅保存了草稿 / 内容已就绪但平台侧尚未确认发布（例如公众号草稿箱）→ 不计入发布次数
    //   failed = 发布失败（保留真实错误信息）→ 不计入发布次数
    //   unknown= 历史记录没有状态字段 → 显示"状态未知"，**不计入发布次数**（不冒充成功）
    // 只有 ok / manual 计入"发布次数"；pending / failed / unknown 只出现在记录明细里。
    function isPubSuccess(r){ return !!r && (r.status==='ok'||r.status==='manual'); }

    // 一条发布记录是否属于某个平台：
    //   key 可能是平台 id（youtube），也可能是平台显示名（历史记录的平台名）。
    //   两种都要能匹配上，否则「各渠道发布次数」卡片点进去会看到空列表。
    //   注意：这里只做**已存在信息**的等值比较，不做任何推断或猜测。
    function pubRecordMatchesPlatform(r, key){
      if(!r || !key) return false;
      if(r.id===key) return true;
      if(r.platform_id && r.platform_id===key) return true;
      if(r.platform && r.platform===key) return true;
      // key 是平台 id → 与记录的显示名比对；key 是平台名 → 反查平台 id 再比对
      var byId=platformMetaById(key);
      if(byId){
        if(r.platform && r.platform===byId.name) return true;
        if(r.platform_id && r.platform_id===byId.id) return true;
        if(r.id && r.id===byId.id) return true;
      }
      var byName=platformMetaByName(key);
      if(byName){
        if(r.platform_id && r.platform_id===byName.id) return true;
        if(r.id && r.id===byName.id) return true;
      }
      return false;
    }

    // ---------- 发布记录列表页的筛选 / 排序（与看板统计同源同口径） ----------
    // 记录的"可比较日期"（本地 YYYY-MM-DD）。没有真实时间戳的记录返回 ''。
    function pubDateOnly(r){
      var ts=(r&&r.ts)||'';
      if(!ts) return '';
      var d=new Date(ts);
      if(isNaN(d.getTime())) return '';
      var p2=function(n){ return (n<10?'0':'')+n; };
      return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    }
    // 时间戳（毫秒）。没有真实时间的记录排到最后（不假装它是最新的）。
    function pubTsNum(r){
      var ts=(r&&r.ts)||'';
      if(!ts) return -1;
      var d=new Date(ts);
      if(isNaN(d.getTime())) return -1;
      return d.getTime();
    }
    // 关键词：作品标题 / 发布标题（发布记录里的 title）+ 关联作品名
    function pubMatchesKeyword(r, q){
      if(!q) return true;
      var kw=String(q).trim().toLowerCase();
      if(!kw) return true;
      var t=String((r&&r.title)||'').toLowerCase();
      if(t&&t.indexOf(kw)>=0) return true;
      var w=(r&&r.work_id)?findWork(r.work_id):null;
      var n=String((w&&w.name)||'').toLowerCase();
      if(n&&n.indexOf(kw)>=0) return true;
      return false;
    }
    // 状态筛选：''/'all' = 全部；'success' = 成功发布（ok + manual）；否则按状态等值匹配。
    function pubMatchesStatus(r, st){
      if(!st||st==='all') return true;
      if(st==='success') return isPubSuccess(r);
      return String((r&&r.status)||'unknown')===st;
    }
    // 时间范围：from / to 均为 'YYYY-MM-DD'（含端点）。空串 = 不限。
    //   没有真实时间的记录无法参与时间范围筛选（不假装落在区间内）。
    function pubMatchesRange(r, from, to){
      if(!from&&!to) return true;
      var d=pubDateOnly(r);
      if(!d) return false;
      if(from&&d<from) return false;
      if(to&&d>to) return false;
      return true;
    }
    // 列表查询：关键词 / 平台 / 状态 / 时间范围 / 排序
    //   返回的是**归一化后的发布记录**，与看板统计用的是同一份数据、同一个去重键。
    //   sort: 'desc' = 发布时间最新优先（默认）；'asc' = 最早优先。
    function pubListQuery(opts){
      opts=opts||{};
      var rows=normalizedPubLog();
      var out=[];
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        if(!pubMatchesKeyword(r, opts.q)) continue;
        if(opts.platform && opts.platform!=='all' && !pubRecordMatchesPlatform(r, opts.platform)) continue;
        if(!pubMatchesStatus(r, opts.status)) continue;
        if(!pubMatchesRange(r, opts.from, opts.to)) continue;
        out.push(r);
      }
      var desc=(opts.sort||'desc')!=='asc';
      out.sort(function(a,b){
        var ta=pubTsNum(a), tb=pubTsNum(b);
        if(ta===tb) return 0;
        if(ta<0) return 1;   // 无时间的记录始终排在最后
        if(tb<0) return -1;
        return desc? (tb-ta) : (ta-tb);
      });
      return out;
    }
    // 当前筛选结果里的"成功发布"条数（列表页要明确区分"全部记录"与"成功发布次数"）
    function pubListSuccessCount(rows){
      var n=0;
      for(var i=0;i<(rows||[]).length;i++){ if(isPubSuccess(rows[i])) n++; }
      return n;
    }

    // 对外暴露**唯一**发布记录数据源：
    //   看板统计、渠道发布记录列表、作品详情、单次详情、发布记录列表页全部走这里，
    //   保证"统计数量"与"列表内容"同源、同口径、同去重规则。
    root.__pubView = {
      normalize: normalizePub,
      records: normalizedPubLog,
      successRecords: function(){ return normalizedPubLog().filter(isPubSuccess); },
      inRange: pubInRange,
      key: pubRecKey,
      isSuccess: isPubSuccess,
      // 各渠道发布记录列表：与「各渠道发布次数」卡片**完全同源同口径**
      //   （同一份归一化记录 + 同一时段筛选 + 同一成功状态口径 + 同一去重键），
      //   因此列表条数 === 卡片上的次数。
      byChannel: function(key){
        var range = state.dashRange || 'all';
        var filtered = pubInRange(normalizedPubLog(), range).filter(isPubSuccess);
        var out = [];
        for (var i = 0; i < filtered.length; i++) {
          var r = filtered[i];
          if (pubRecordMatchesPlatform(r, key)) out.push(r);
        }
        return out;
      },
      // 按记录键（pub_key / DB 行 id / 会话行键）取单条归一化记录
      byKey: function(key){
        var list = normalizedPubLog();
        for (var i = 0; i < list.length; i++) {
          if (pubRecKey(list[i]) === key) return list[i];
        }
        return null;
      },
      // 某个作品关联的全部发布记录（一个作品可对应多个平台的多条记录）
      byWork: function(workId){
        var list = normalizedPubLog();
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].work_id === workId) out.push(list[i]);
        }
        return out;
      },
      // 发布记录列表页的查询入口（关键词 / 平台 / 状态 / 时间范围 / 排序）
      //   与看板统计共用同一份归一化数据，因此"列表条数"与"看板次数"口径一致。
      list: pubListQuery,
      // 某批记录里的"成功发布"条数（列表页要区分"全部发布记录"与"成功发布次数"）
      successCount: pubListSuccessCount,
      // 记录的可比较日期（YYYY-MM-DD），没有真实时间返回 ''
      dateOnly: pubDateOnly
    };
    function hmToLocalIso(hm){
      var m=/^(\d{1,2}):(\d{2})/.exec(String(hm||''));
      if(!m) return '';
      var d=new Date(); d.setHours(parseInt(m[1],10)||0, parseInt(m[2],10)||0, 0, 0);
      return d.toISOString();
    }
    // 归一化全部发布记录（按时间正序，末条即「最近发布」）
    function normalizedPubLog(){
      var raw=Array.isArray(state.pubLog)?state.pubLog:[];
      return raw.map(normalizePub).filter(function(r){ return !!(r.platform||r.id); });
    }

    /* ---------- 时段筛选 ---------- */
      // session=本次运行新增的发布；today / 7d 按真实时间戳判定；all=全部历史
      function pubInRange(log, range){
        if(!Array.isArray(log)) return [];
        if(range==='all') return log.slice();
        if(range==='session') return log.filter(function(r){ return !!r.session; });
        var n=new Date();
        var start;
        if(range==='today') start=new Date(n.getFullYear(),n.getMonth(),n.getDate());
        else if(range==='7d') start=new Date(n.getFullYear(),n.getMonth(),n.getDate()-6);
        else return log.slice();
        var cut=start.getTime();
        return log.filter(function(r){
          if(!r||!r.ts) return false;
          var t=new Date(r.ts).getTime();
          if(isNaN(t)) return false;
          return t>=cut;
        });
      }
  
      // 生成 N 个自然日的桶 key（Y-M-D），最后一天是今天
      function dayKeys(days){
        var now = new Date();
        var out = [];
        for(var i=days-1;i>=0;i--){
          var d = new Date(now.getFullYear(),now.getMonth(),now.getDate()-i);
          out.push(d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate());
        }
        return out;
      }
  
      // 按自然日聚合（使用归一化后的真实时间戳 ts）
      function bucketByDay(log, days){
        var keys = dayKeys(days);
        var counts = {};
        keys.forEach(function(k){counts[k]=0;});
        (log||[]).forEach(function(r){
          if(!r||!r.ts) return;
          var d = new Date(r.ts);
          if(isNaN(d.getTime())) return;
          var key = d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
          if(counts[key]!==undefined) counts[key]++;
        });
        return keys.map(function(k){return counts[k];});
      }
  
      // 作品按自然日聚合（works.created_at，DB 真实登记时间）
      function bucketWorksByDay(works, days){
        var keys = dayKeys(days);
        var counts = {};
        keys.forEach(function(k){counts[k]=0;});
        (works||[]).forEach(function(w){
          if(!w||!w.created_at) return;
          var d = new Date(w.created_at);
          if(isNaN(d.getTime())) return;
          var key = d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
          if(counts[key]!==undefined) counts[key]++;
        });
        return keys.map(function(k){return counts[k];});
      }
  
      // 内联 SVG sparkline。values: number[], opts.w=120, opts.h=28
      function renderSparkline(values, opts){
        var w = (opts && opts.w) || 120;
        var h = (opts && opts.h) || 28;
        var pad = 3;
        var max = Math.max.apply(null, (values||[]).concat([0]).concat([1]));
        var min = Math.min.apply(null, (values||[]).concat([0]));
        var range = Math.max(1, max - min);
        var n = values.length;
        var step = n > 1 ? (w - pad*2) / (n-1) : 0;
        var pts = values.map(function(v,i){
          var x = pad + step*i;
          var y = h - pad - ((v - min) / range) * (h - pad*2);
          return [x, y];
        });
        var line = pts.map(function(p,i){return (i===0?'':'L')+p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' ');
        var allZero = values.every(function(v){return v===0;});
        var polyline = allZero ? 'M'+pad+','+(h/2)+' L'+(w-pad)+','+(h/2) : 'M'+line;
        var fillPath = '';
        if(!allZero && pts.length){
          fillPath = 'M'+pad+','+(h-pad)+' L'+line+' L'+(w-pad)+','+(h-pad)+' Z';
        }
        var dot = '';
        if(!allZero && pts.length){
          var last = pts[pts.length-1];
          dot = '<circle class="spark-dot" cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="2.4"/>';
        }
        return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true">'+
          '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">'+
            '<stop offset="0%" stop-color="var(--primary)" stop-opacity=".25"/>'+
            '<stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>'+
          '</linearGradient></defs>'+
          '<line class="spark-baseline" x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-pad)+'" y2="'+(h-pad)+'"/>'+
          (fillPath ? '<path class="spark-fill" d="'+fillPath+'"/>' : '')+
          '<path class="spark-line" d="'+polyline+'"/>'+
          dot+
        '</svg>';
      }
  
      function setDashRange(r){
        state.dashRange = r;
        var chips = document.querySelectorAll('#dashRangeFilter .filter-chip');
        chips.forEach(function(c){
          var on = c.getAttribute('data-range') === r;
          c.classList.toggle('on', on);
          c.setAttribute('aria-selected', on ? 'true' : 'false');
          // aria-pressed：AI 演示计划（s_d2_filter_7d）依赖此属性做点击后校验
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        renderDash();
      }
  
      // 初始化 chip 事件（仅绑定一次）
      function bindDashFilter(){
        var row = document.getElementById('dashRangeFilter');
        if(!row || row._bound) return;
        row._bound = true;
        row.addEventListener('click', function(e){
          var btn = e.target.closest('.filter-chip');
          if(!btn) return;
          setDashRange(btn.getAttribute('data-range'));
        });
      }
  
      /* ---------- 各平台发布占比（环形图） ---------- */
      // 品牌色可能彼此接近（如 X=#000 与 GitHub=#24292F），同屏出现时无法区分。
      // 这里在不改变主品牌色的前提下，为「颜色过近」的后续平台做确定性的色相/明度偏移，
      // 保证同一看板内任意两个平台的颜色都可分辨。
      function dashHex2Rgb(h){
        var s=String(h||'').replace('#','').trim();
        if(s.length===3) s=s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
        if(!/^[0-9a-fA-F]{6}$/.test(s)) return {r:90,g:107,b:114};
        var n=parseInt(s,16);
        return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};
      }
      function dashRgb2Hsl(r,g,b){
        r/=255;g/=255;b/=255;
        var mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn, h=0, s=0, l=(mx+mn)/2;
        if(d){
          if(mx===r) h=((g-b)/d)%6;
          else if(mx===g) h=(b-r)/d+2;
          else h=(r-g)/d+4;
          h*=60; if(h<0) h+=360;
          s=d/(1-Math.abs(2*l-1));
        }
        return {h:h,s:s,l:l};
      }
      function dashHsl2Rgb(h,s,l){
        var c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs((h/60)%2-1)), m=l-c/2, r,g,b;
        if(h<60){r=c;g=x;b=0;} else if(h<120){r=x;g=c;b=0;}
        else if(h<180){r=0;g=c;b=x;} else if(h<240){r=0;g=x;b=c;}
        else if(h<300){r=x;g=0;b=c;} else {r=c;g=0;b=x;}
        return {r:Math.round((r+m)*255),g:Math.round((g+m)*255),b:Math.round((b+m)*255)};
      }
      function dashRgb2Css(rgb){
        return 'rgb('+rgb.r+','+rgb.g+','+rgb.b+')';
      }
      function dashColorDist(a,b){
        return Math.abs(a.r-b.r)*0.3+Math.abs(a.g-b.g)*0.59+Math.abs(a.b-b.b)*0.11;
      }
      // 为 entries 分配可区分的颜色，结果写入 e.c2
      function dashAssignColors(entries){
        var assigned=[];
        (entries||[]).forEach(function(e){
          var base=e.c||'#5A6B72';
          var rgb=dashHex2Rgb(base);
          var hsl=dashRgb2Hsl(rgb.r,rgb.g,rgb.b);
          var cand=base, candRgb=rgb;
          var clash=assigned.some(function(a){ return dashColorDist(a,rgb)<70; });
          if(clash){
            for(var step=1; step<=8; step++){
              var h2=(hsl.h+step*17)%360;
              var l2=Math.min(0.82, Math.max(0.24, hsl.l + (step%2?0.18:-0.15)*Math.ceil(step/2)));
              var s2=Math.min(0.95, Math.max(0.32, hsl.s+(step>3?0.22:0)));
              var c2=dashHsl2Rgb(h2,s2,l2);
              var ok=!assigned.some(function(a){ return dashColorDist(a,c2)<70; });
              if(ok){ cand=dashRgb2Css(c2); candRgb=c2; break; }
            }
          }
          e.c2=cand;
          assigned.push(candRgb);
        });
      }

      function renderDashDonut(entries, total){
        var box = document.getElementById('donutBox');
        var sub = document.getElementById('donutSub');
        if(!box) return;
        if(!entries.length || !total){
          if(sub) sub.textContent = '所选时段内暂无发布数据';
          box.innerHTML = '<div class="empty-state" style="padding:14px 8px"><div class="es-icon">◔</div><div class="es-title">暂无占比数据</div><div class="es-sub">所选时段内还没有发布记录</div></div>';
          return;
        }
        if(sub) sub.textContent = '共 ' + total + ' 次发布 · 按平台占比';
        var r = 56, C = 2 * Math.PI * r, acc = 0, segs = '';
        entries.forEach(function(e){
          var len = e.v / total * C;
          segs += '<circle class="dc-seg" cx="70" cy="70" r="'+r+'" stroke="'+esc(e.c2||e.c)+'" stroke-dasharray="'+len.toFixed(2)+' '+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-acc).toFixed(2)+'"></circle>';
          acc += len;
        });
        var legend = '';
        entries.forEach(function(e){
          legend += '<div class="dl-row"><span class="dl-dot" style="background:'+esc(e.c2||e.c)+'"></span>'
            +'<span class="dl-name">'+esc(e.n)+'</span>'
            +'<span class="dl-n">'+e.v+' 次</span>'
            +'<span class="dl-p">'+(e.v/total*100).toFixed(1)+'%</span></div>';
        });
        box.innerHTML = '<div class="donut"><svg viewBox="0 0 140 140" aria-hidden="true">'
          +'<circle class="dc-track" cx="70" cy="70" r="'+r+'"></circle>'+segs+'</svg>'
          +'<div class="donut-center"><div class="dc-t">总计</div><div class="dc-n">'+total+' 次</div></div></div>'
          +'<div class="donut-legend">'+legend+'</div>';
      }
  
      /* ---------- 渠道详情入口（真实可用：打开该渠道的详情弹窗） ---------- */
      // 统计卡点击 → 打开该平台的**真实发布记录列表**（发布历史查询，不是渠道连接管理）。
      // 记录来源与统计完全同源（见 root.__pubView）。
      window.openDashPlatformPubs = function(platId){
        try{
          if(root.openPubPlatformPubs) { root.openPubPlatformPubs(platId); return; }
          go('dashboard');
          toast('该平台的发布记录列表暂不可用');
        }catch(err){ console.warn('openDashPlatformPubs failed', err); }
      };
      window.openDashChannel = function(platId){
        try{
          var pm = platformMetaById(platId);
          var ch = pm ? findChannelByPlatform(pm.id) : null;
          if(ch){ openChannelEditor(ch.id, {view:'detail'}); return; }
          go('channels');
          toast('「'+(pm?pm.name:platId)+'」还没有配置推广渠道，已跳转到推广渠道页');
        }catch(err){ console.warn('openDashChannel failed', err); }
      };
      window.openDashChannelById = function(chId){
        try{
          var c=null;
          var list=state.channels||[];
          for(var i=0;i<list.length;i++){ if(list[i].id===chId){ c=list[i]; break; } }
          if(!c){ toast('该渠道已不存在','warn'); return; }
          openChannelEditor(c.id, {view:'detail'});
        }catch(err){ console.warn('openDashChannelById failed', err); }
      };
      // 作品入口：打开**作品详情**（作品信息 + 该作品关联的全部发布记录）。
      // 注意：不再走 openWork —— openWork 会重置向导状态并跳回首秀首页，
      // 那正是「最近发布记录 → 查看」被用户感知为「跳回首页」的原因。
      window.openDashWork = function(workId){
        try{
          if(root.openWorkDetail){ root.openWorkDetail(workId); return; }
          openWork(workId);
        }catch(err){ console.warn('openDashWork failed', err); }
      };
      window.toggleDashPubList = function(){
        state.dashPubExpanded = !state.dashPubExpanded;
        renderDash();
      };
  
      function renderDash(){
  
      // v2：时段筛选 + sparkline（任务 6）
        bindDashFilter();
        var range = state.dashRange || 'all';
        var allPub = normalizedPubLog();
        var filteredPub = pubInRange(allPub, range);
        // 次数统计口径：只有"确实发布过"的记录（ok / manual）计入；发布失败不计入任何次数。
        var filteredSuccess = filteredPub.filter(isPubSuccess);
        var bucketCount = (range === '7d') ? 7 : (range === 'today' ? 1 : (range === 'all' ? 14 : 7));
        var sparkPub = bucketByDay(filteredPub, bucketCount);
        var rangeLabel = DASH_RANGE_LABEL[range] || '全部历史';

        // ===== KPI 顶部 4 项（全部读自真实状态）=====
      var realWorks = (state.works || []).filter(function(w){return !w.isSample;});
      var allChans = state.channels || [];
      var enabledChans = allChans.filter(channelEnabled);
      state.kpis.works = realWorks.length;
      state.kpis.pub = filteredSuccess.length;
      // 注意：真实「被启用渠道」来自 channels 表的 enabled 字段；
      //       state.platforms 是「本次向导勾选的平台」，恒为 false，不能拿来统计。
      state.kpis.channelsEnabled = enabledChans.length;

      var elKpiPub = document.getElementById('kpiPub');
      if (elKpiPub) elKpiPub.textContent = filteredSuccess.length;
      var elKpiPubSub = document.getElementById('kpiPubSub');
      if (elKpiPubSub) elKpiPubSub.textContent = rangeLabel + ' · 真实发布 ' + filteredSuccess.length + ' 次';
      var elKpiCh = document.getElementById('kpiChannels');
      if (elKpiCh) elKpiCh.textContent = enabledChans.length;
      var elKpiChSub = document.getElementById('kpiChannelsSub');
      if (elKpiChSub) elKpiChSub.textContent = allChans.length
        ? ('已启用 ' + enabledChans.length + ' / 共 ' + allChans.length + ' 个推广渠道')
        : '还没有配置推广渠道';
      var elKpiWk = document.getElementById('kpiWorks');
      if (elKpiWk) elKpiWk.textContent = realWorks.length;
      var elKpiWkSub = document.getElementById('kpiWorksSub');
      if (elKpiWkSub) elKpiWkSub.textContent = realWorks.length
        ? ('本机登记的 ' + realWorks.length + ' 个正式作品')
        : '还没有登记正式作品';
      var elKpiLast = document.getElementById('kpiLastPub');
      var elKpiLastSub = document.getElementById('kpiLastPubSub');
      var lastEntry = filteredSuccess.length ? filteredSuccess[filteredSuccess.length-1] : null;
      if (lastEntry) {
        var rel = formatRelTime(lastEntry.ts);
        if (elKpiLast) elKpiLast.textContent = rel || absTime(lastEntry.ts) || '—';
        if (elKpiLastSub) elKpiLastSub.textContent = lastEntry.platform + (absTime(lastEntry.ts) ? (' · ' + absTime(lastEntry.ts)) : '');
      } else {
        if (elKpiLast) elKpiLast.textContent = '—';
        if (elKpiLastSub) elKpiLastSub.textContent = rangeLabel + ' 暂无发布';
      }

      // v1.5 UX：sparkline 渲染（任务 6 之一）——全部来自真实数据，不做假趋势
      var sparkHosts = {
        kpiPubSpark: sparkPub,
        kpiChannelsSpark: null,   // 渠道卡改用「启用占比」实心条，见下
        kpiWorksSpark: bucketWorksByDay(realWorks, bucketCount),
        kpiLastPubSpark: sparkPub
      };
      Object.keys(sparkHosts).forEach(function(id){
        var el = document.getElementById(id);
        if(!el) return;
        var vals = sparkHosts[id];
        if(!vals){ return; }
        el.innerHTML = renderSparkline(vals);
        el.classList.toggle('empty', !vals.some(function(v){return v>0;}));
      });
      // 渠道卡：没有时间序列，用「已启用 / 总数」的真实占比条代替虚构折线
      var elChSpark = document.getElementById('kpiChannelsSpark');
      if (elChSpark){
        var ratio = allChans.length ? Math.round(enabledChans.length / allChans.length * 100) : 0;
        elChSpark.innerHTML = allChans.length
          ? '<div class="mini-ratio" title="已启用 '+enabledChans.length+' / 共 '+allChans.length+'"><i style="width:'+ratio+'%;background:var(--primary)"></i></div>'
          : '';
        elChSpark.classList.toggle('empty', !allChans.length);
      }

      // ===== 各渠道发布次数（随时段筛选重算；口径 = 真实发布成功，手动标记计入，失败不计）=====
      var barsBox = document.getElementById('barsBox');
      var barsSub = document.getElementById('barsSub');
      var total = filteredSuccess.length;
      var byPlat = {};
      filteredSuccess.forEach(function(r){
        // 归一化后的 id 已是平台 id（历史记录按名称反查过）；反查不到就用原名，
        // 保证「卡片 key」与 byChannel 的匹配规则一致（同名平台不会被拆成两张卡）。
        var key = platformMetaById(r.id) ? r.id : (r.platform || r.id);
        if(!key) return;
        byPlat[key] = (byPlat[key]||0) + 1;
      });
      var entries = Object.keys(byPlat).map(function(k){
        var m = pubMeta(k, platformMetaById(k)?k:'');
        return {id:(m.id||''), n:m.name, v:byPlat[k], c:m.color||'#5A6B72', ch:m.id?findChannelByPlatform(m.id):null};
      }).sort(function(a,b){return b.v-a.v;});
      dashAssignColors(entries);

      if (!entries.length) {
        if (barsSub) barsSub.textContent = rangeLabel + ' · 尚未发布';
        if (barsBox) barsBox.innerHTML = '<div class="empty-state" style="padding:22px 12px"><div class="es-icon">📊</div><div class="es-title">所选时段内还没有发布</div><div class="es-sub">尝试切换上方的时段筛选，或完成一次首秀发射让真实数据回填</div></div>';
      } else {
        if (barsSub) barsSub.textContent = rangeLabel + ' · 按平台统计（总计 ' + total + ' 次）';
        var html = '';
        entries.forEach(function(d){
          var pct = total ? (d.v/total*100) : 0;
          // 点击 → 打开该平台的**真实发布记录列表**（不是渠道授权弹窗）
          html += '<button type="button" class="pstat" onclick="openDashPlatformPubs(\''+dashArg(d.id||d.n)+'\')" title="查看 '+dashArg(d.n)+' 的发布记录">'
            +'<div class="ps-head"><span class="ps-ico" style="background:'+esc(d.c2||d.c)+'">'+esc(pubChar(d.n))+'</span>'
            +'<span class="ps-name">'+esc(d.n)+'</span><span class="ps-go">›</span></div>'
            +'<div class="ps-row"><span class="ps-n">'+d.v+'</span><span class="ps-unit">次</span>'
            +'<span class="ps-pct">'+pct.toFixed(1)+'%</span></div>'
            +'<div class="ps-bar"><i style="width:'+pct.toFixed(1)+'%;background:'+esc(d.c2||d.c)+'"></i></div>'
            +'<div class="ps-ch">'+(d.ch ? ('已配置渠道 · '+esc(d.ch.name)) : '未配置推广渠道')+'</div>'
            +'</button>';
        });
        if (barsBox) barsBox.innerHTML = html;
      }

      // ===== 已启用渠道状态（真实 channels 表）=====
      var csBox = document.getElementById('chStatusBox');
      if (csBox) {
        if (!allChans.length) {
          csBox.innerHTML = '';
        } else {
          var csHead = '<div class="cs-head"><span>推广渠道状态</span>'
            +'<span class="tl-badge '+(enabledChans.length===allChans.length?'done':'live')+'">'+enabledChans.length+' / '+allChans.length+' 已启用</span></div>';
          var csList = '<div class="cs-list">';
          // 渠道 chip 沿用同一套可区分配色，避免同屏出现接近色（如 X 与 GitHub）
          var chipEntries=allChans.map(function(c){
            var v=channelVisual(c);
            return {c:v.color, v:v};
          });
          dashAssignColors(chipEntries);
          allChans.forEach(function(c, ci){
            var v=chipEntries[ci].v;
            var on = channelEnabled(c);
            csList += '<button type="button" class="ch-chip'+(on?'':' off')+'" onclick="openDashChannelById(\''+dashArg(c.id)+'\')" title="查看渠道详情">'
              +'<span class="cs-ico" style="background:'+esc(chipEntries[ci].c2||v.color)+'">'+esc(v.char)+'</span>'
              +esc(v.name)+(on?'':' · 已停用')+'</button>';
          });
          csList += '</div>';
          csBox.innerHTML = csHead + csList;
        }
      }

      // ===== 各平台发布占比 =====
      renderDashDonut(entries, total);

      // ===== 最近发布记录（表格）=====
      var pl = document.getElementById('pubLogBox');
      var plSub = document.getElementById('pubLogSub');
      var plToggle = document.getElementById('pubLogToggle');
      var plFoot = document.getElementById('pubLogFoot');
      if (pl) {
        var rows = filteredPub.slice().sort(function(a,b){
          var ta=new Date(a.ts||0).getTime()||0, tb=new Date(b.ts||0).getTime()||0;
          return tb-ta;
        });
        if (!rows.length) {
          if (plSub) plSub.textContent = rangeLabel + ' · 暂无发布记录';
          if (plToggle) plToggle.style.display = 'none';
          if (plFoot) plFoot.innerHTML = '';
          pl.innerHTML = '<div class="empty-state" style="padding:26px 12px"><div class="es-icon">📊</div><div class="es-title">'+esc(rangeLabel)+' 还没有发布记录</div><div class="es-sub">完成一次首秀发射后，真实的发布数据会出现在这里</div></div>';
        } else {
          if (plSub) plSub.textContent = '真实数据 · 本机登记的发布回填';
          var expanded = !!state.dashPubExpanded;
          var shown = expanded ? rows : rows.slice(0, 6);
          var th = '<table class="ptable"><thead><tr><th>时间</th><th>作品标题</th><th>平台</th><th>状态</th><th class="pt-acts">操作</th></tr></thead><tbody>';
          shown.forEach(function(r){
            var m = pubMeta(r.platform, r.id);
            var w = r.work_id ? findWork(r.work_id) : null;
            var title = r.title || (w ? w.name : '') || '未填写标题';
            // 状态来自真实发布结果：ok=已发布 / manual=手动标记 / pending=草稿待发布 / failed=发布失败
            //   unknown=历史记录没有状态字段 → "状态未知"（不冒充已发布）
            var st = r.status==='failed'
              ? '<span class="tl-badge fail">发布失败</span>'
              : (r.status==='manual'
                  ? '<span class="tl-badge pend">手动标记</span>'
                  : (r.status==='pending'
                      ? '<span class="tl-badge pend">草稿待发布</span>'
                      : (r.status==='ok'
                          ? '<span class="tl-badge done">已发布</span>'
                          : '<span class="tl-badge">状态未知</span>')));
            var platName = r.platform || '未知平台';
            if(!r.platform_known) platName = platName + '（平台无法确认）';
            th += '<tr>'
              +'<td class="pt-time">'+esc(absTime(r.ts)||r.time||'—')+'</td>'
              +'<td class="pt-title" title="'+esc(title)+'">'+esc(title)+'</td>'
              +'<td><span class="pt-plat"><span class="pt-ico" style="background:'+esc(m.color)+'">'+esc(pubChar(platName))+'</span>'+esc(platName)+'</span></td>'
              +'<td class="pt-state">'+st+'</td>'
              +'<td class="pt-acts"><button type="button" class="pt-link" onclick="openPubDetail(\''+dashArg(pubRecKey(r))+'\')">查看</button></td></tr>';
          });
          th += '</tbody></table>';
          pl.innerHTML = th;
          if (plToggle) {
            plToggle.style.display = '';
            plToggle.textContent = expanded ? '收起 ↑' : ('展开全部（'+rows.length+'） →');
          }
          if (plFoot) {
            plFoot.innerHTML = '<span class="pf-count">共 <b>'+rows.length+'</b> 条记录</span>'
              +'<span>点击「查看」打开该次发布的详情</span>';
          }
        }
      }

      // ===== 里程碑报喜（时间线 + 点击已读，任务 10）=====
      var fb = document.getElementById('feedBox');
      var feedSub = document.getElementById('feedSub');
      if (fb) {
        var milestones = state.milestones || [];
        var totalAll = allPub.length;
        if (milestones.length === 0) {
          if (feedSub) feedSub.textContent = '本次运行 · AI 大师会主动汇报关键节点';
          var pending = nextMilestoneHint(totalAll);
          fb.innerHTML = '<div class="empty-state" style="padding:16px 12px"><div class="es-icon">🎉</div><div class="es-title">还没有里程碑报喜</div>'
            +'<div class="es-sub">'+(totalAll>0
                ? '本机累计发布 '+totalAll+' 次，完成关键节点时 AI 大师会主动报喜'
                : '完成首次发射、累计 10 次发布等关键节点，AI 大师会主动报喜')+'</div></div>'
            + (pending ? '<div class="tl-item pending"><div class="tl-ic">🎯</div><div class="tl-body">'
                +'<div class="tl-title">'+esc(pending.title)+'</div>'
                +'<div class="tl-desc">'+esc(pending.desc)+'</div>'
                +'<div class="tl-meta"><span class="tl-badge pend">未达成</span></div></div></div>' : '');
        } else {
          if (feedSub) feedSub.textContent = '本次运行 · AI 大师会主动汇报关键节点 · 点击标记已读';
          var fbHtml = '';
          milestones.forEach(function(m, idx){
            var ts = m.at || m.time || m.readAt || '';
            var relTime = formatRelTime(ts);
            var abs = absTime(ts);
            fbHtml += '<div class="tl-item" onclick="markMilestoneRead('+idx+')" role="button" tabindex="0">'
              +'<div class="tl-ic" style="background:'+esc(m.color || '#0E7C7B')+'">' + esc(m.icon || '·') + '</div>'
              +'<div class="tl-body"><div class="tl-title">' + esc(m.title || '里程碑') + '</div>'
              + (m.detail ? '<div class="tl-desc">' + esc(m.detail) + '</div>' : '')
              +'<div class="tl-meta"><span class="tl-badge '+(m.unread?'live':'done')+'">'+(m.unread?'新进展':'已达成')+'</span>'
              + (relTime ? '<span>'+esc(relTime)+'</span>' : '')
              + (abs ? '<span>'+esc(abs)+'</span>' : '')
              +'</div></div></div>';
          });
          fb.innerHTML = fbHtml;
        }
      }

    }

      // 下一个未达成的里程碑（阈值与 pushMilestoneIfFirst 保持一致，不新增虚构节点）
      function nextMilestoneHint(total){
        var thresholds=[
          {n:1,  title:'完成首次发布', desc:'任意平台完成一次发布即达成'},
          {n:10, title:'累计发布 10 次', desc:'本机累计发布满 10 次即达成'}
        ];
        for(var i=0;i<thresholds.length;i++){
          if(total < thresholds[i].n){
            return {title:thresholds[i].title, desc:'还差 '+(thresholds[i].n-total)+' 次 · '+thresholds[i].desc};
          }
        }
        return null;
      }

    return { render: renderDash };
  }

  root.RokitDashboardView = { create: create };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
