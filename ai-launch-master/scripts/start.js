// Rokit · 开发环境启动器（npm start 入口）
// 处理事项：
//   1. 清除外部注入的 NODE_OPTIONS（某些 IDE 会注入 --require shim，导致 Electron 主进程崩溃）
//   2. 默认将数据目录 ROKIT_USER_DATA 指向项目内 .userdata（沙箱/云桌面环境会虚拟化 %APPDATA%，
//      导致 better-sqlite3 无法创建数据库）；已显式设置该变量时尊重外部值
//   3. 附加 --no-sandbox：此类环境中 Chromium 沙箱进程创建会被拦截，主进程直接退出
//   4. 加载 .env.local / .env 中声明的 KEY=VALUE（不依赖 dotenv 依赖；进程已有的变量优先，
//      未填写的 KEY 不会覆盖外部已设置的值）
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

// 轻量 dotenv：按 KEY=VALUE 解析（不带引号 / 双引号；支持 # 注释；不处理转义）
// 优先级：已有进程变量 > .env.local > .env
function loadDotEnv(file) {
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // 去掉首尾成对引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = val;
      }
    }
  } catch (_e) { /* 文件不存在或权限不足时静默 */ }
}

loadDotEnv(path.join(root, '.env.local'));
loadDotEnv(path.join(root, '.env'));

delete process.env.NODE_OPTIONS;
if (!process.env.ROKIT_USER_DATA) {
  process.env.ROKIT_USER_DATA = '.userdata';
}

const electronBin = require('electron'); // 返回 electron.exe 路径
const child = spawn(electronBin, ['.', '--no-sandbox'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
