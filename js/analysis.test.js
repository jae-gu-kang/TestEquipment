import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sliceByTime, crossTime, stepMetrics, slewMetrics, sineFit, bode, crossFreq, bandwidth,
} from './analysis.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≉ ${b} (±${tol})`);

// 지터 있는 타임스탬프(ms): 평균 1ms, 0.6~1.4ms
function jitterTimes(t0, t1) {
  const ts = [];
  let s = 12345;
  for (let t = t0; t < t1; ) {
    ts.push(t);
    s = (s * 1103515245 + 12345) % 2147483648;
    t += 0.6 + 0.8 * (s / 2147483648);
  }
  return ts;
}

test('sliceByTime: 구간 [t0, t1)', () => {
  const r = sliceByTime([0, 1, 2, 3], [10, 11, 12, 13], 1, 3);
  assert.deepEqual(r, { t: [1, 2], y: [11, 12] });
});

test('crossTime: 선형 보간, 방향 구분', () => {
  near(crossTime([0, 10], [0, 10], 2.5, +1), 2.5, 1e-9);
  near(crossTime([0, 10, 20], [0, -10, -20], -15, -1), 15, 1e-9);
  assert.equal(crossTime([0, 10], [0, 1], 5, +1), null);
  near(crossTime([0, 10, 20, 30], [0, 10, 0, 10], 5, +1, 12), 25, 1e-9);
});

test('stepMetrics: 오버슈트(°, %)와 정상상태 오차', () => {
  // 0→20° 스텝: 20.3° 까지 넘었다가 20.1° 로 수렴
  const ts = [], ys = [];
  for (let t = 0; t < 1000; t += 1) {
    ts.push(t);
    ys.push(t < 50 ? 20 * t / 50 : t < 100 ? 20 + 0.3 * Math.sin(Math.PI * (t - 50) / 50) : 20.1);
  }
  const m = stepMetrics(ts, ys, { t0: 0, t1: 1000, from: 0, to: 20, ssWindowPct: 20 });
  near(m.overshootDeg, 0.3, 1e-3);
  near(m.overshootPct, 1.5, 1e-2);
  near(m.sse, 0.1, 1e-9);
  near(m.riseMs, 40, 1);
});

test('stepMetrics: 하향 스텝은 아래로 넘은 양이 오버슈트', () => {
  const ts = [0, 10, 20, 30, 40], ys = [0, -10, -10.4, -10, -10];
  const m = stepMetrics(ts, ys, { t0: 0, t1: 50, from: 0, to: -10, ssWindowPct: 40 });
  near(m.overshootDeg, 0.4, 1e-9);
  near(m.sse, 0, 1e-9);
});

test('stepMetrics: 목표 미도달이면 오버슈트 0', () => {
  const m = stepMetrics([0, 10, 20], [0, 9, 9.5], { t0: 0, t1: 30, from: 0, to: 10, ssWindowPct: 50 });
  assert.equal(m.overshootDeg, 0);
  near(m.sse, 0.5, 1e-9);
});

test('slewMetrics: 등속 램프면 평균 = 최대', () => {
  // 400°/s 로 0 → -20°
  const ts = jitterTimes(0, 200);
  const ys = ts.map((t) => Math.max(-20, -0.4 * t));
  const m = slewMetrics(ts, ys, { t0: 0, t1: 200, from: 0, to: -20, lowPct: 10, highPct: 90, smoothMs: 6 });
  near(m.loDeg, -2, 1e-9);
  near(m.hiDeg, -18, 1e-9);
  near(m.avg, 400, 2);
  near(m.max, 400, 5);
});

test('slewMetrics: 가속 구간이 있으면 최대 > 평균', () => {
  // 0→30°: 구간 중간에서 속도가 가장 큰 S 커브
  const ts = [], ys = [];
  for (let t = 0; t <= 200; t += 1) { ts.push(t); ys.push(t < 100 ? 15 * (1 - Math.cos(Math.PI * t / 100)) : 30); }
  const m = slewMetrics(ts, ys, { t0: 0, t1: 200, from: 0, to: 30, lowPct: 10, highPct: 90, smoothMs: 4 });
  assert.ok(m.max > m.avg, `max ${m.max} avg ${m.avg}`);
  near(m.max, 15 * Math.PI / 100 * 1000, 10); // 피크 471°/s
});

test('sineFit: 불규칙 샘플에서 진폭·위상·오프셋 복원', () => {
  const f = 6, ts = jitterTimes(0, 1500);
  const ys = ts.map((t) => 1.5 + 2 * Math.sin(2 * Math.PI * f * t / 1000 - Math.PI / 3));
  const r = sineFit(ts, ys, f, 0);
  near(r.amp, 2, 1e-9);
  near(r.phaseDeg, -60, 1e-6);
  near(r.offset, 1.5, 1e-9);
  near(r.rms, 0, 1e-9);
});

test('bode: 게인 dB, 위상차, 지연보정, 위상 언랩', () => {
  const rows = [
    { f: 1, cmd: { amp: 2, phaseDeg: 10 }, fb: { amp: 2, phaseDeg: 0 } },
    { f: 5, cmd: { amp: 2, phaseDeg: 170 }, fb: { amp: 1, phaseDeg: 20 } },
    { f: 10, cmd: { amp: 2, phaseDeg: 0 }, fb: { amp: 0.5, phaseDeg: 160 } },
  ];
  const b = bode(rows, 0);
  near(b[0].gainDb, 0, 1e-9);
  near(b[0].phaseDeg, -10, 1e-9);
  near(b[1].gainDb, -6.0206, 1e-3);
  near(b[1].phaseDeg, -150, 1e-9);
  near(b[2].phaseDeg, -200, 1e-9); // 주값은 +160 이지만 연속성으로 언랩
  const c = bode([{ f: 5, cmd: { amp: 1, phaseDeg: 0 }, fb: { amp: 1, phaseDeg: -30 } }], 2);
  near(c[0].phaseDeg, -30 + 360 * 5 * 0.002, 1e-9);
});

test('crossFreq: 로그 보간, 미도달, 시작점부터 미달', () => {
  near(crossFreq([1, 10], [0, -6], -3), Math.sqrt(10), 1e-9);
  assert.equal(crossFreq([1, 2, 4], [0, -1, -2], -3), null);
  assert.equal(crossFreq([1, 2], [-4, -5], -3), 1);
});

test('bandwidth: 기준별 대역폭, 미도달은 측정 상한 이상', () => {
  assert.deepEqual(bandwidth({ f3: 8, f90: 7, fMax: 12 }, 'both'), { value: 7, reached: true });
  assert.deepEqual(bandwidth({ f3: 8, f90: 7, fMax: 12 }, '3dB'), { value: 8, reached: true });
  assert.deepEqual(bandwidth({ f3: null, f90: 9, fMax: 12 }, 'both'), { value: 9, reached: true });
  assert.deepEqual(bandwidth({ f3: null, f90: null, fMax: 12 }, 'both'), { value: 12, reached: false });
});
