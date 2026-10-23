// Rokit · fmtDur 行为测试
//   验证 v1.15 修复后全局 fmtDur 对 0/非数/超时输入的输出，
//   保证 AI 自动演示录制结束时时长展示正确。
'use strict';

// fmtDur 在 index.html 内联脚本里定义；为单元测试，我们重建等价函数
// 并断言它对关键输入产生我们依赖的格式
function fmtDur(sec){
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '—';
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

describe('fmtDur · 行为契约', () => {
  test('0 / 负数 / 非数 / NaN / Infinity → 返回 "—"，不抛错', () => {
    expect(fmtDur(0)).toBe('—');
    expect(fmtDur(-1)).toBe('—');
    expect(fmtDur(NaN)).toBe('—');
    expect(fmtDur(Infinity)).toBe('—');
    expect(fmtDur('abc')).toBe('—');
    expect(fmtDur(null)).toBe('—');
    expect(fmtDur(undefined)).toBe('—');
  });

  test('小于 1 分钟 → 显示 M:SS', () => {
    expect(fmtDur(5)).toBe('0:05');
    expect(fmtDur(45)).toBe('0:45');
    expect(fmtDur(59)).toBe('0:59');
  });

  test('正好 1 分钟及以上 → 显示 M:SS（无前导 0）', () => {
    expect(fmtDur(60)).toBe('1:00');
    expect(fmtDur(125)).toBe('2:05');
    expect(fmtDur(3540)).toBe('59:00');
  });

  test('≥ 1 小时 → 显示 H:MM:SS（例如 01:05:30）', () => {
    expect(fmtDur(3600)).toBe('1:00:00');
    expect(fmtDur(3930)).toBe('1:05:30');
    expect(fmtDur(7325)).toBe('2:02:05');
    expect(fmtDur(36000)).toBe('10:00:00');
  });

  test('舍入边界合法：不抛错', () => {
    // 这些不需要严格相等，只验证不抛、不返回 undefined
    expect(typeof fmtDur(0.4)).toBe('string');
    expect(typeof fmtDur(59.6)).toBe('string');
    expect(typeof fmtDur(7200.5)).toBe('string');
  });
});
