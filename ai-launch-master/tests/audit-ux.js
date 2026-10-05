#!/usr/bin/env node
/**
 * tests/audit-ux.js
 *
 * UX 一致性守门脚本：兜住 v0.1.1 修复中明确要"消除 / 对齐"的标记。
 *
 * 触发：
 *   node tests/audit-ux.js
 *   或作为 npm run audit 的一部分
 *
 * 检查范围（4 类）：
 *   1. web 站不能含「假订阅表单」（disabled+提交 success 这类假成功）
 *   2. web 站 Features.astro 的"数据看板"badge 不能是"已上线"
 *   3. web 站 Platforms.astro 不能把任何平台标成 L1（API 直发）
 *   4. 桌面端 index.html：示例作品必须带"示例"角标；数据看板默认值必须是 0 / 空
 *
 * 设计原则：
 *   - DO NOT 依赖任何运行时（无 npm 安装、无 electron）
 *   - 只读源码 / 配置文件；不存在就 fail
 *   - 每条断言独立打 ✓/✗，非零退出码仅在 ✗ 时设置
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.resolve(ROOT, '..', 'web');

function ok(cond, msg) {
  console.log((cond ? '\u2713 ' : '\u2717 ') + msg);
  if (!cond) process.exitCode = 1;
}

function readOrFail(p) {
  if (!fs.existsSync(p)) {
    ok(false, '文件缺失：' + p);
    return null;
  }
  return fs.readFileSync(p, 'utf8');
}

console.log('[UX Audit] v0.1.1 修复守门');
console.log('');

// ============================================================
// 1. web 站不能含"假订阅表单"模式
// ============================================================
console.log('[1] web 站不能含"假订阅表单"模式（fake success）');
const download = readOrFail(path.join(WEB_ROOT, 'src', 'components', 'Download.astro'));
const faq = readOrFail(path.join(WEB_ROOT, 'src', 'components', 'Faq.astro'));

if (download) {
  // 不应再有 <form action="..."> 之类的真表单（即使 disabled）
  ok(!/<form[\s>]/i.test(download), 'Download.astro 不再含 <form> 标签');
  // 不应再有 "已订阅"、"✓ 提交成功" 这类自我陶醉文案
  ok(!/已订阅|订阅成功|提交成功|subscribe.*success/i.test(download), 'Download.astro 无假"订阅成功"文案');
  // 应有 GitHub Watch 引导
  // v0.1.3 起指向真实仓库 MatuX-ai/Rokit（原占位 ProClips/Rokit 已在 v0.1.3 文档中标记为已替换）
  ok(/github\.com\/MatuX-ai\/Rokit/.test(download), 'Download.astro 引导到 GitHub 仓库');
  ok(/Watch/i.test(download) || /Star/i.test(download), 'Download.astro 含 Star/Watch 字样');
}

if (faq) {
  ok(!/页面底部留下邮箱/.test(faq), 'Faq.astro 不再提"页面底部邮箱订阅"');
}

// ============================================================
// 2. Features.astro · 数据看板 badge 与现实对齐
// ============================================================
console.log('\n[2] Features.astro · 数据看板 badge 与现实对齐');
const features = readOrFail(path.join(WEB_ROOT, 'src', 'components', 'Features.astro'));
if (features) {
  // v0.1.4 (2026-09-25) 起数据看板已正式上线（KPI / 时段筛选 / 里程碑 / 发布回填均已交付），
  // 因此"数据看板"项 badge 必须是"已上线"；若误标为"MVP 1.5 / 规划中"则视为 v0.1.1 误标记回归。
  const dashIdx = features.indexOf('数据看板');
  if (dashIdx < 0) {
    ok(false, 'Features.astro 找不到"数据看板"');
  } else {
    const block = features.substr(dashIdx, 600);
    if (/badge\s*:\s*['"]已上线['"]/.test(block)) {
      ok(true, '数据看板 badge 为"已上线"（v0.1.4 起已交付）');
    } else if (/badge\s*:\s*['"](MVP\s*1\.5|规划中|敬请期待)['"]/.test(block)) {
      ok(false, '数据看板 badge 不能是"MVP 1.5 / 规划中"（v0.1.4 已交付，应为"已上线"）');
    } else {
      ok(false, '数据看板 badge 取值不明确，请检查 Features.astro');
    }
  }
}

// ============================================================
// 3. Platforms.astro：仅 GitHub 可标 L1（Release API 已对接），其他 12 平台仍强制 L2
// ============================================================
console.log('\n[3] Platforms.astro · GitHub L1 已对接放行，其余 12 平台仍禁止 L1');
const platforms = readOrFail(path.join(WEB_ROOT, 'src', 'components', 'Platforms.astro'));
if (platforms) {
  // v0.1.4 起 GitHub Release API 直发已上线（见 CHANGELOG），允许标 L1；
  // 其他 12 平台当前仍为 L2（浏览器自动填表），未来 MVP 2.0 才允许标 L1。
  // 注意：Legend 说明、说明性句子、CSS 类名（.plat-l1 / .plat-lvl 等）都允许存在。
  // 只拦截"实际给某个平台打 L1"的赋值（data level: 'L1' / "L1"）。
  const l1Assignments = [];
  // v0.1.5 当前白名单：仅 GitHub
  const L1_WHITELIST = new Set(['GitHub']);

  const dataLines = platforms.split('\n').filter(function (line) {
    // 排除 Astro 模板里的 CSS / 注释 / 渲染段（<style> / <!-- / .plat-xxx）
    return !/^\s*\/\//.test(line)
      && !/^\s*\.plat-/.test(line)
      && !/^\s*<\/style/.test(line)
      && !/^\s*<!--/.test(line)
      && !/^\s*<style/.test(line)
      && !/{\/\*/.test(line)
      && !/<span class="plat-level plat-l1">L1<\/span>/.test(line);  // Legend 里允许出现 L1 字样
  });
  dataLines.forEach(function (line, i) {
    // 仅当明确把 L1 赋给某个 level 字段才算
    // 例：level: 'L1' 或 level:"L1"
    if (/level\s*:\s*['"]L1['"]/.test(line)) {
      // 同一行的前一个 `{ name: 'X',` 块中提取 name
      const nameMatch = line.match(/name\s*:\s*['"]([^'"]+)['"]/);
      const platformName = nameMatch ? nameMatch[1] : null;
      if (!platformName || !L1_WHITELIST.has(platformName)) {
        l1Assignments.push((i + 1) + ': ' + line.trim());
      }
    }
  });
  if (l1Assignments.length === 0) {
    ok(true, 'Platforms.astro 没有把白名单外的平台标记为 L1（API 直发）');
  } else {
    ok(false, 'Platforms.astro 仍有非白名单平台被赋值为 L1（API 直发）：\n  ' + l1Assignments.join('\n  '));
  }

  // Legend 应包含 L2 = 自动填表 + L1 规划中的说明
  if (/L2\s*[=＝].{0,30}自动填表|L2\b.{0,30}自动填表/i.test(platforms)) {
    ok(true, 'Platforms.astro Legend 说明 L2 = 自动填表');
  } else {
    ok(false, 'Platforms.astro Legend 应说明 L2 = 自动填表');
  }
  if (/L1\b.{0,40}(API\s*直发|规划中|1\.5|MVP)/.test(platforms)) {
    ok(true, 'Platforms.astro Legend 说明 L1（API 直发）规划中');
  } else {
    ok(false, 'Platforms.astro Legend 应说明 L1 在规划中');
  }
}

// ============================================================
// 4. 桌面端 index.html：示例作品 + 数据看板默认值
// ============================================================
console.log('\n[4] 桌面端 index.html · 示例作品 / 数据看板');
const indexHtml = readOrFail(path.join(ROOT, 'index.html'));
if (indexHtml) {
  // 4.1 示例作品白名单 + 角标
  ok(/SAMPLE_WORK_IDS\s*=/.test(indexHtml), 'index.html 定义了 SAMPLE_WORK_IDS 白名单');
  ok(/function\s+isSampleWork/.test(indexHtml), 'index.html 定义了 isSampleWork 守卫');
  ok(/sample_w[1-4]/.test(indexHtml), 'index.html 含 4 个示例作品 id（sample_w1..4）');
  ok(/\.wsample\b/.test(indexHtml), 'index.html 含 .wsample CSS 类');
  ok(/wsample-tag|示例/.test(indexHtml), 'index.html 含"示例"角标');

  // 4.2 数据看板默认值必须是 0，不应有硬编码 KPI
  // 查找 kpiView/kpiDl/kpiStar/kpiRating 这些旧 id 不应再出现
  const legacyKpiIds = ['kpiView', 'kpiDl', 'kpiStar', 'kpiRating'];
  const hasLegacyKpi = legacyKpiIds.some(function (id) {
    return new RegExp('id=["\']' + id + '["\']').test(indexHtml);
  });
  ok(!hasLegacyKpi, 'index.html 不再含旧假数据 KPI id（kpiView/kpiDl/kpiStar/kpiRating）');

  // state.kpis 应有定义，且默认值是 0（实际写法：state={...,kpis:{pub:0,...}}）
  ok(/kpis\s*:\s*\{/.test(indexHtml), 'index.html 定义 state.kpis 对象字面量');
  ok(/kpis\s*:\s*\{[^}]*pub\s*:\s*0/.test(indexHtml), 'kpis.pub 默认 0');
  ok(/kpis\s*:\s*\{[^}]*channelsEnabled\s*:\s*0/.test(indexHtml), 'kpis.channelsEnabled 默认 0');
  ok(/kpis\s*:\s*\{[^}]*works\s*:\s*0/.test(indexHtml), 'kpis.works 默认 0');

  // 4.3 数据看板状态：v1.5 已正式上线（KPI / 时段筛选 / 里程碑 / 发布回填）。旧版“规划中”提示卡（dashComingNotice）已下线，
  // tabDash 不应再带 data-coming “规划中”标记。
  ok(!/<button[^>]*\bid=["']tabDash["'][^>]*\bdata-coming\b/i.test(indexHtml), 'tabDash 不带 data-coming（v1.5 看板已交付）');

  // 4.4 拆条 / 成片 DEMO 标注
  ok(/DEMO/.test(indexHtml), 'index.html 含 DEMO 标注');
  // 拆条按钮：紧邻的 1000 字符内同时出现 "开始智能拆条" 与 "DEMO" 视为通过
  var shotBtnIdx = indexHtml.indexOf('开始智能拆条');
  if (shotBtnIdx > 0) {
    var ctx = indexHtml.substr(shotBtnIdx, 1000);
    ok(/DEMO/i.test(ctx), '"开始智能拆条"按钮附近 1000 字符内含 DEMO 标注');
  } else {
    ok(false, '未找到"开始智能拆条"按钮');
  }
  // 成片按钮同上
  var renderAllIdx = indexHtml.indexOf('合成全部成片');
  if (renderAllIdx > 0) {
    var ctx2 = indexHtml.substr(renderAllIdx, 1000);
    ok(/DEMO/i.test(ctx2), '"合成全部成片"按钮附近 1000 字符内含 DEMO 标注');
  } else {
    ok(false, '未找到"合成全部成片"按钮');
  }

  // 4.5 平台 auto 标注：应与 publishers.js 对齐（auto:true 仅 github/v2ex/x）
  const pcardSection = indexHtml.match(/var PLATFORMS\s*=\s*\[([\s\S]*?)\];/);
  if (pcardSection) {
    const pl = pcardSection[1];
    // 统计 auto:true 数量
    const autoTrue = (pl.match(/auto:\s*true/g) || []).length;
    const autoFalse = (pl.match(/auto:\s*false/g) || []).length;
    ok(autoTrue === 3, 'PLATFORMS 中 auto:true 数量 = 3（github/v2ex/x），实际 ' + autoTrue);
    ok(autoFalse === 10, 'PLATFORMS 中 auto:false 数量 = 10（其余 10 个平台），实际 ' + autoFalse);
  } else {
    ok(false, '未找到 PLATFORMS 数组');
  }
}

// ============================================================
// 5. 桌面端 publishers.js 与 PLATFORMS 数组对齐
// ============================================================
console.log('\n[5] 桌面端 publishers.js auto 字段一致性');
const publishers = readOrFail(path.join(ROOT, 'electron', 'publishers.js'));
if (publishers) {
  const expectTrue = ['github', 'v2ex', 'x'];
  const expectFalse = ['ph', 'juejin', 'facebook', 'youtube', 'douyin', 'xhs', 'bili', 'jike', 'zhihu', 'wechat'];
  expectTrue.forEach(function (id) {
    // 找 id: { ... auto: ... 这一段
    const re = new RegExp('\\b' + id + '\\s*:\\s*\\{[\\s\\S]*?auto\\s*:\\s*(true|false)');
    const m = publishers.match(re);
    if (!m) {
      ok(false, id + ': 未找到 auto 字段');
      return;
    }
    if (m[1] !== 'true') {
      ok(false, id + ': auto 应为 true，实际 ' + m[1]);
    } else {
      ok(true, id + ': auto=true ✓');
    }
  });
  expectFalse.forEach(function (id) {
    const re = new RegExp('\\b' + id + '\\s*:\\s*\\{[\\s\\S]*?auto\\s*:\\s*(true|false)');
    const m = publishers.match(re);
    if (!m) {
      ok(false, id + ': 未找到 auto 字段');
      return;
    }
    if (m[1] !== 'false') {
      ok(false, id + ': auto 应为 false，实际 ' + m[1]);
    } else {
      ok(true, id + ': auto=false ✓');
    }
  });

  // auto:false 的 4 个必须有 manualReason
  ['ph', 'juejin', 'facebook', 'youtube'].forEach(function (id) {
    const re = new RegExp('\\b' + id + '\\s*:\\s*\\{[\\s\\S]*?manualReason\\s*:\\s*[\'"]');
    ok(re.test(publishers), id + ' 含 manualReason 字段（UI 提示用户）');
  });
}

console.log('');
if (process.exitCode) {
  console.log('[UX Audit] ✗ 有断言失败，请按上方 ✗ 行修复');
  process.exit(1);
} else {
  console.log('[UX Audit] ✓ 全部通过');
}
