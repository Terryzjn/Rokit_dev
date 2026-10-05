// Rokit · vitest 配置
// 跑 Node 环境即可（不启动 Electron）
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    globals: true, // describe/it/expect/vi 等全局可用，避免 CommonJS require 问题
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['electron/**/*.js'],
      exclude: ['electron/main.js', 'electron/preload.js'] // 由 Electron 集成测试覆盖
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
