// Rokit · ESLint flat config
// 同时覆盖 Electron 主进程（CommonJS）与渲染端 index.html（浏览器脚本）
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'dist/**',
      '_backup/**',
      '.preview/**',
      'assets/**'
    ]
  },
  // 主进程 / 测试文件 / 构建脚本（Node + CommonJS）
  {
    files: [
      'electron/**/*.js',
      'tests/**/*.js',
      'scripts/**/*.js',
      '*.config.js'
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_' // catch (_e) 视为有意忽略
        }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 禁止 alert/confirm/prompt 调试残留（AST 级别检查，不会误判字符串字面量）
      // 之前的 grep 方案在 tests/publishers.test.js 的 XSS fixture（'<script>alert(1)</script>'）上误报
      'no-alert': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },
  // vitest 测试代码
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest }
    },
    rules: {
      'no-undef': 'off', // vitest 全局注入 describe/it/expect
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  }
  // 渲染端 index.html 内嵌脚本暂不纳入 lint（DOM globals 复杂、单文件 HTML 难以独立 lint）
  // 后续如拆分可加 'www/**/*.js' 分组
];
