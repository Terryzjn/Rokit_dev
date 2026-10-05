/**
 * 生成 OG 分享图（1200x630）
 * 运行：node scripts/generate-og.mjs
 * 版本号优先级：CLI --version > 环境变量 ROKIT_VERSION > ai-launch-master/package.json
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../public/og-image.png');

// 解析版本号：CLI 参数 > 环境变量 > package.json 缺省
function resolveVersion() {
  const cliFlag = process.argv.find((a) => a.startsWith('--version='));
  if (cliFlag) return cliFlag.split('=')[1];
  if (process.env.ROKIT_VERSION) return process.env.ROKIT_VERSION;
  // 缺省：读桌面端 package.json（权威源）
  const pkgPath = resolve(__dirname, '../../ai-launch-master/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

const VERSION = resolveVersion();

// 用 SVG 绘制 OG 图，再转 PNG
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0e14"/>
      <stop offset="100%" stop-color="#060a10"/>
    </linearGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#94d4d0"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#94D4D0"/>
      <stop offset="50%" stop-color="#4DD0E1"/>
      <stop offset="100%" stop-color="#8B5CF6"/>
    </linearGradient>
    <linearGradient id="rocketBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#94D4D0"/>
      <stop offset="100%" stop-color="#0E7C7B"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(31, 156, 154, 0.25)"/>
      <stop offset="100%" stop-color="rgba(31, 156, 154, 0)"/>
    </radialGradient>
  </defs>

  <!-- 背景 -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- 光晕 -->
  <circle cx="900" cy="200" r="350" fill="url(#glow)"/>
  <circle cx="150" cy="500" r="280" fill="rgba(233, 75, 140, 0.06)"/>

  <!-- 星星 -->
  <g fill="#fff" opacity="0.6">
    <circle cx="100" cy="80" r="1.5"/>
    <circle cx="250" cy="120" r="1"/>
    <circle cx="420" cy="60" r="1.2"/>
    <circle cx="600" cy="100" r="0.8"/>
    <circle cx="780" cy="70" r="1.5"/>
    <circle cx="1050" cy="110" r="1"/>
    <circle cx="1150" cy="300" r="1.2"/>
    <circle cx="80" cy="350" r="1"/>
    <circle cx="200" cy="450" r="0.8"/>
    <circle cx="1100" cy="500" r="1.5"/>
  </g>

  <!-- 左：文案 -->
  <g transform="translate(80, 160)">
    <!-- 徽章 -->
    <rect x="0" y="0" width="200" height="32" rx="16" fill="rgba(14, 124, 123, 0.15)" stroke="rgba(148, 212, 208, 0.35)" stroke-width="1"/>
    <circle cx="16" cy="16" r="4" fill="#1f9c9a">
      <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/>
    </circle>
    <text x="28" y="21" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="13" font-weight="600" fill="#94d4d0" letter-spacing="1">v${VERSION} · 开源 · MIT</text>

    <!-- 主标题 -->
    <text x="0" y="100" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="64" font-weight="800" fill="url(#title)" letter-spacing="-1">
      作品做完了，
    </text>
    <text x="0" y="175" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="64" font-weight="800" fill="url(#accent)" letter-spacing="-1">
      别让它吃灰
    </text>

    <!-- 副标题 -->
    <text x="0" y="235" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="26" fill="#94a3b8">
      用 AI 把作品一键发到 13 个平台，1 小时搞定
    </text>

    <!-- 卖点标签 -->
    <g transform="translate(0, 280)">
      <rect x="0" y="0" width="130" height="36" rx="8" fill="rgba(255,255,255,0.03)" stroke="rgba(148, 212, 208, 0.18)"/>
      <text x="16" y="23" font-size="14" fill="#94a3b8">💻 Windows 10/11</text>

      <rect x="145" y="0" width="130" height="36" rx="8" fill="rgba(255,255,255,0.03)" stroke="rgba(148, 212, 208, 0.18)"/>
      <text x="161" y="23" font-size="14" fill="#94a3b8">🔒 零账号 · 零遥测</text>

      <rect x="290" y="0" width="140" height="36" rx="8" fill="rgba(255,255,255,0.03)" stroke="rgba(148, 212, 208, 0.18)"/>
      <text x="306" y="23" font-size="14" fill="#94a3b8">🧠 BYOK 自带 Key</text>
    </g>
  </g>

  <!-- 右：火箭 -->
  <g transform="translate(820, 180)">
    <!-- 火箭阴影 -->
    <ellipse cx="110" cy="340" rx="80" ry="12" fill="rgba(14, 124, 123, 0.3)" filter="blur(8px)"/>

    <!-- 火箭主体 -->
    <g transform="translate(30, 0) scale(0.7)">
      <path d="M110 20 C 170 80, 190 140, 190 220 L 190 260 L 30 260 L 30 220 C 30 140, 50 80, 110 20 Z" fill="url(#rocketBody)"/>
      <circle cx="110" cy="130" r="32" fill="#0a0e14"/>
      <circle cx="110" cy="130" r="20" fill="#4DD0E1"/>
      <path d="M70 240 L 90 300 L 110 270 L 130 300 L 150 240 Z" fill="#E94B8C"/>
    </g>
  </g>

  <!-- 底部品牌 -->
  <g transform="translate(80, 575)">
    <rect width="28" height="28" rx="7" fill="rgba(14, 124, 123, 0.2)"/>
    <text x="38" y="20" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="16" font-weight="700" fill="#94d4d0">Rokit · 作品首秀发射台</text>
  </g>
</svg>
`;

const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPath, pngBuffer);
console.log(`✅ OG 图已生成：${outPath} (${(pngBuffer.length / 1024).toFixed(1)} KB · version=${VERSION})`);
