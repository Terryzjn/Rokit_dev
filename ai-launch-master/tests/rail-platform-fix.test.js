// Rokit · 「打通平台」步骤布局回归测试（v_next）
//
// 验证三件事（页面结构与布局修复后的目标）：
//   1. gotoRailStep(4) 留在首秀向导内（不切换 data-route），
//      把 state.step 设到 11，由 renderStep(s===11) 内联渲染授权与连接 + 平台网格。
//      首秀发射轨道（railBox）始终可见，不应通过 go('channels','platforms') 切到独立页。
//   2. platPageNext 选完平台后推进到 step 12（发布清单），留在 flow 路由内。
//   3. goToPlatformsStage 也走「留在 flow」语义，不切到 channels/platforms。
//
//   4. 独立 platformsView / backFromPlatforms 已彻底移除——「打通平台」不再是独立页面。

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptBlocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
const code = (scriptBlocks[scriptBlocks.length - 1] || '').replace(/<\/?script>/g, '');

function pickFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'm');
  // 函数可能用 window.xxx = function(){} 的形式
  const reWin = new RegExp('window\\.' + name + '\\s*=\\s*function\\s*\\(', 'm');
  let m = code.match(reWin) || code.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  let startIdx = m.index + m[0].indexOf('function');
  let i = code.indexOf('{', startIdx);
  if (i < 0) throw new Error(name + ' 无花括号');
  let depth = 1; i++;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(startIdx, i);
}

describe('rail/platform nav · 图一内嵌布局回归', () => {
  it('gotoRailStep(4) 留在 flow 路由内联渲染（不切到 channels/platforms 独立页）', () => {
    const branchRe = /if\s*\(\s*stageIdx\s*===\s*4\s*\)\s*\{([\s\S]*?)\}\s*else/;
    const branchMatch = code.match(branchRe);
    expect(branchMatch).not.toBeNull();
    const branch = branchMatch ? branchMatch[1] : '';
    // 必须留在 flow：ensureFlow() + state.step=11 + renderFlow()
    expect(branch).toMatch(/ensureFlow\(\)/);
    expect(branch).toMatch(/state\.step\s*=\s*11/);
    expect(branch).toMatch(/renderFlow\(\)/);
    // 不应再调用 go('channels','platforms') 把平台面板切到独立页面
    expect(branch).not.toMatch(/go\(['"]channels['"],\s*['"]platforms['"]\)/);
  });

  it('platPageNext 留在 flow 路由推进到 step 12（发布清单）', () => {
    const platPageNextSrc = pickFn('platPageNext');
    expect(platPageNextSrc).toMatch(/state\.step\s*=\s*12/);
    // 不应再调用 go('flow')，因为本身就在 flow 路由
    expect(platPageNextSrc).not.toMatch(/go\(['"]flow['"]\)/);
    // 防御性：确认不是 step=11（避免重复显示）
    expect(platPageNextSrc).not.toMatch(/state\.step\s*=\s*11\s*;/);
  });

  it('goToPlatformsStage 留在 flow 路由（不切到 channels/platforms 独立页）', () => {
    const gotoPlatformsSrc = pickFn('goToPlatformsStage');
    expect(gotoPlatformsSrc).toMatch(/state\.step\s*=\s*11/);
    expect(gotoPlatformsSrc).toMatch(/renderFlow\(\)/);
    // 不应再调用 go('channels','platforms')
    expect(gotoPlatformsSrc).not.toMatch(/go\(['"]channels['"],\s*['"]platforms['"]\)/);
  });

  it('backFromPlatforms / 独立 platformsView 已彻底移除（打通平台不再是独立页面）', () => {
    // backFromPlatforms 全局函数已删除
    expect(code).not.toMatch(/window\.backFromPlatforms\s*=/);
    // 独立 platformsView div 已删除
    expect(code).not.toMatch(/id\s*=\s*["']platformsView["']/);
    // 不应再有 platGridPage 容器（仅 platGrid 保留在首秀向导内）
    expect(code).not.toMatch(/id\s*=\s*["']platGridPage["']/);
  });

  it('首秀向导内 step 11 渲染授权与连接 + 平台网格（renderStep 内联分支）', () => {
    // renderStep 在 s===11 时直接渲染「打通平台 · 授权与连接」+「选择本次要发布的平台」
    const re = /else if\(s===11\)\s*\{([\s\S]*?)\}\s*else if\(s===12\)/;
    const m = code.match(re);
    expect(m).not.toBeNull();
    const branch = m ? m[1] : '';
    expect(branch).toMatch(/打通平台 · 授权与连接/);
    expect(branch).toMatch(/选择本次要发布的平台/);
    expect(branch).toMatch(/id\s*=\s*["']platGrid["']/);
  });
});

describe('store · 防御性 schema 补全（v_next）', () => {
  it('源代码包含 ensureWorksColumns 方法并把它置于 version 早返之前', () => {
    expect(code).not.toContain('store.js'); // sanity
    // 读 electron/store.js
    const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
    expect(storeSrc).toContain('ensureWorksColumns');
    // migrate 函数内：先调用 ensureWorksColumns() 然后才是 "已是最新版本则跳过"
    const migrateMatch = storeSrc.match(/migrate\s*\(\s*\)\s*\{([\s\S]*?)\n\s{2}\/\/ ---------- /);
    expect(migrateMatch).not.toBeNull();
    const migrateBody = migrateMatch ? migrateMatch[1] : '';
    const idxRepair = migrateBody.indexOf('this.ensureWorksColumns()');
    const idxEarlyReturn = migrateBody.indexOf('if (currentVersion >= CURRENT_VERSION) return');
    expect(idxRepair).toBeGreaterThanOrEqual(0);
    expect(idxEarlyReturn).toBeGreaterThanOrEqual(0);
    expect(idxRepair).toBeLessThan(idxEarlyReturn); // 补列必须在版本检查前
  });

  it('ensureWorksColumns 覆盖 yt_url / yt_views / yt_updated_at 三个 v5 列', () => {
    const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
    expect(storeSrc).toMatch(/yt_url/);
    expect(storeSrc).toMatch(/yt_views/);
    expect(storeSrc).toMatch(/yt_updated_at/);
    // ALTER 都用 try/catch 包住，幂等
    const addLine = storeSrc.match(/ALTER TABLE works ADD COLUMN yt_url/);
    expect(addLine).not.toBeNull();
  });
});
