// scripts/bump-version.js
//
// 板号（版本号）自增规则：
//   · 起始版本号：0.1.0（语义化版本 MAJOR.MINOR.PATCH）
//   · 每次打包：PATCH（尾数）+1
//   · PATCH 上限为两位数；一旦下一步会超过两位数（≥100），
//     立即进位到 MINOR（前一位）并把 PATCH 归零。
//
// 示例：
//   0.1.0 -> 0.1.1 -> ... -> 0.1.98 -> 0.1.99 -> 0.2.0 -> ...
//         ↑ 尾数单步递增                       ↑ 尾数 +1 后超两位数，进前一位
//
// 调用方式：
//   node scripts/bump-version.js          # 自增并写回 package.json
//   node scripts/bump-version.js --check  # 仅打印目标版本，不写文件
//
'use strict';

const fs = require('fs');
const path = require('path');

const PKG_PATH = process.env.ROKIT_PKG_PATH
  ? path.resolve(process.env.ROKIT_PKG_PATH)
  : path.join(__dirname, '..', 'package.json');
// 超过两位数即进位：两位数上限为 99，下一次步进触达 100 时进位。
const PATCH_LIMIT = 100;
const DEFAULT_START = '0.1.0';

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function bump(version) {
  // 未指定 / 空串时使用默认起始版号；其它非空非法输入抛错
  const v = version == null || version === '' ? DEFAULT_START : version;
  const cur = parseVersion(v);
  if (!cur) throw new Error(`无法解析版本号：${v}`);
  let [major, minor, patch] = cur;
  // 尾数 +1，超出两位数则进前一位（递归：MINOR 超过两位数再进 MAJOR）。
  patch += 1;
  if (patch >= PATCH_LIMIT) {
    patch = 0;
    minor += 1;
    if (minor >= PATCH_LIMIT) {
      minor = 0;
      major += 1;
    }
  }
  return [major, minor, patch].join('.');
}

function readPkg() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  return { raw, data: JSON.parse(raw) };
}

function main() {
  const dryRun = process.argv.includes('--check') || process.argv.includes('--dry-run');
  const { raw, data } = readPkg();
  const oldVer = data.version || DEFAULT_START;
  const newVer = bump(oldVer);

  if (dryRun) {
    process.stdout.write(`${oldVer} -> ${newVer}\n`);
    return;
  }

  data.version = newVer;
  const next = JSON.stringify(data, null, 2) + '\n';
  // 仅当版本号实际变化时才落盘，避免无意义写入
  if (next !== raw) {
    fs.writeFileSync(PKG_PATH, next, 'utf8');
  }
  process.stdout.write(`[bump] ${oldVer} -> ${newVer}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[bump] 失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

module.exports = { bump, parseVersion, PATCH_LIMIT, DEFAULT_START };
