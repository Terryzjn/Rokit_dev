#!/usr/bin/env node
/**
 * scripts/prepare-icon.js
 *
 * 从 assets/icon.png 生成 build/icon.ico（electron-builder 默认在 build 目录找图标）。
 *
 * 用法：
 *   node scripts/prepare-icon.js
 *   或 npm run icon:build
 *
 * 依赖：
 *   - png-to-ico（推荐，~30KB，无原生依赖）
 *   - 备选 ImageMagick：`magick convert` / `convert`
 *
 * 行为：
 *   - 若 build/icon.ico 已存在且比 assets/icon.png 新 → 跳过
 *   - 否则读取 assets/icon.png → 生成多尺寸 ICO → 写入 build/icon.ico
 *   - 任一环节失败 → 非零退出码，并提示回退方案
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.png');
const OUT_DIR = path.join(ROOT, 'build');
const OUT = path.join(OUT_DIR, 'icon.ico');

function log(msg) {
  console.log('[icon:build] ' + msg);
}

function fail(msg) {
  console.error('[icon:build] ✗ ' + msg);
  console.error('[icon:build] 手动回退方案：');
  console.error('  1) ImageMagick：magick convert "' + SRC + '" -define icon:auto-resize=256,128,96,64,48,32,16 "' + OUT + '"');
  console.error('  2) 在线工具：https://convertico.com/ → 把生成的 icon.ico 放到 build/ 目录');
  process.exit(1);
}

function shouldSkip(src, out) {
  if (!fs.existsSync(out)) return false;
  const srcStat = fs.statSync(src);
  const outStat = fs.statSync(out);
  // 源文件比产物新 → 重新生成
  return outStat.mtimeMs >= srcStat.mtimeMs;
}

async function buildWithLib(srcBuf) {
  // 优先 png-to-ico：无原生依赖、单文件、产物小
  let pngToIco;
  try {
    pngToIco = require('png-to-ico');
  } catch (_e) {
    return null;
  }
  // png-to-ico 接受 Buffer；按 256/128/64/48/32/16 多尺寸收敛
  const ico = await pngToIco(srcBuf);
  return ico;
}

function buildWithImageMagick() {
  // 备选：调用本机 ImageMagick
  try {
    execSync('magick convert "' + SRC + '" -define icon:auto-resize=256,128,96,64,48,32,16 "' + OUT + '"', {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return true;
  } catch (_e1) {
    try {
      execSync('convert "' + SRC + '" -define icon:auto-resize=256,128,96,64,48,32,16 "' + OUT + '"', {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      return true;
    } catch (_e2) {
      return false;
    }
  }
}

(async () => {
  if (!fs.existsSync(SRC)) {
    fail('源图缺失：' + SRC);
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  if (shouldSkip(SRC, OUT)) {
    log('build/icon.ico 已存在且比源图新，跳过生成');
    return;
  }

  const srcBuf = fs.readFileSync(SRC);
  log('源图 ' + SRC + ' (' + srcBuf.length + ' bytes)');

  // 路径 1：png-to-ico
  const icoBuf = await buildWithLib(srcBuf);
  if (icoBuf) {
    fs.writeFileSync(OUT, icoBuf);
    log('✓ 已生成 ' + OUT + ' (' + icoBuf.length + ' bytes, png-to-ico)');
    return;
  }
  log('png-to-ico 不可用，尝试 ImageMagick 回退');

  // 路径 2：ImageMagick
  if (buildWithImageMagick()) {
    const st = fs.statSync(OUT);
    log('✓ 已生成 ' + OUT + ' (' + st.size + ' bytes, ImageMagick)');
    return;
  }

  fail('所有生成方式均失败（既未安装 png-to-ico 也未安装 ImageMagick）');
})().catch(function (e) {
  fail('脚本异常：' + (e && e.message ? e.message : String(e)));
});
