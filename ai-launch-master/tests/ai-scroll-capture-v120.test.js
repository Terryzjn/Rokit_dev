// Rokit · v1.20 录屏捕获（主进程）单元测试
//
// 覆盖（仅保留**共享**的捕获相关断言）：
//   A) capture 路径不再枚举 'screen' 类型源（只有 window）
//   B) 主进程提供 capture:get-rokit-bounds IPC
//   C) index.html 不再包含 fmtMMSS 引用
//   D) 所有 <script> 块 acorn parse 通过
//
// AI 自动录屏（规划器 / 执行器 / 适配层 / 录制预览 banner / 滚动 picker 副本）已删除，
// 对应用例一并移除。
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require(path.join(process.cwd(), 'node_modules', 'acorn'));

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const aiDemo = fs.readFileSync(path.join(process.cwd(), 'electron', 'ai-demo.js'), 'utf8');

// 找到 index.html 里的所有 <script> 块（主逻辑是**最后一个**非空块）
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
let m, scripts = [];
while ((m = re.exec(html)) !== null) {
  scripts.push(m[1]);
}
// 主逻辑块 = 最长的非空块（避免依赖固定下标）
let mainScript = '';
for (let i = 0; i < scripts.length; i++) {
  if (scripts[i].length > mainScript.length) mainScript = scripts[i];
}
if (!mainScript) throw new Error('cannot find main script block');

describe('v1.20 录制源严格只取 Rokit 主窗口', () => {
  test('desktopCapturer 不再请求 screen 类型源（renderer 流程）', () => {
    // ai-demo.js 中 capture:list-sources 只枚举 window
    expect(aiDemo).toMatch(/desktopCapturer\.getSources\(\{[\s\S]*?types:\s*\['window'\][\s\S]*?\}\)/);
    // capture:probe 也只枚举 window
    const probeMatches = aiDemo.match(/desktopCapturer\.getSources\(\{[\s\S]*?\}\)/g) || [];
    expect(probeMatches.length).toBeGreaterThan(0);
    probeMatches.forEach(function (m) {
      expect(m).toMatch(/types:\s*\['window'\]/);
    });
  });

  test('主进程提供 capture:get-rokit-bounds IPC', () => {
    expect(aiDemo).toMatch(/ipcMain\.handle\(['"]capture:get-rokit-bounds['"]/);
  });
});

describe('v1.20 fmtMMSS 已不存在（防止上次阻塞错误）', () => {
  test('index.html 不再包含 fmtMMSS 引用', () => {
    expect(html).not.toMatch(/fmtMMSS/);
  });
});

describe('index.html 语法仍合法', () => {
  test('所有 <script> 块 acorn parse 通过', () => {
    scripts.forEach(function (src, i) {
      try { acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }); }
      catch (e) { throw new Error('script #' + i + ' parse failed: ' + e.message); }
    });
  });
});
