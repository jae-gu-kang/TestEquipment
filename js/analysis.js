// 점검 판정용 순수 계산. 시간은 모두 ms, 각도는 °.

export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export function sliceByTime(ts, ys, t0, t1) {
  const t = [], y = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] >= t0 && ts[i] < t1) { t.push(ts[i]); y.push(ys[i]); }
  }
  return { t, y };
}

// tStart 이후 신호가 level 을 dir(+1 상승 / -1 하강) 방향으로 처음 넘는 시각. 인접 샘플 선형보간.
export function crossTime(ts, ys, level, dir, tStart = -Infinity) {
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < tStart) continue;
    if (dir * (ys[i] - level) < 0) continue;
    if (i === 0 || ts[i - 1] < tStart && dir * (ys[i - 1] - level) >= 0) return ts[i];
    const y0 = ys[i - 1], y1 = ys[i];
    if (y1 === y0) return ts[i];
    return ts[i - 1] + (level - y0) / (y1 - y0) * (ts[i] - ts[i - 1]);
  }
  return null;
}

function linSlope(ts, ys) {
  const n = ts.length;
  if (n < 2) return null;
  const mt = mean(ts), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (ts[i] - mt) * (ys[i] - my); den += (ts[i] - mt) ** 2; }
  return den > 0 ? num / den : null;
}

export function stepMetrics(ts, ys, { t0, t1, from, to, ssWindowPct = 20 }) {
  const seg = sliceByTime(ts, ys, t0, t1);
  const S = to - from, dir = Math.sign(S) || 1;
  let over = 0;
  for (const y of seg.y) over = Math.max(over, dir * (y - to));
  const tw = t1 - (t1 - t0) * ssWindowPct / 100;
  const tail = seg.y.filter((_, i) => seg.t[i] >= tw);
  const finalMean = mean(tail);
  const t10 = crossTime(seg.t, seg.y, from + 0.1 * S, dir, t0);
  const t90 = crossTime(seg.t, seg.y, from + 0.9 * S, dir, t10 ?? t0);
  return {
    overshootDeg: over,
    overshootPct: S !== 0 ? over / Math.abs(S) * 100 : 0,
    sse: Math.abs(finalMean - to),
    finalMean,
    riseMs: t10 != null && t90 != null ? t90 - t10 : null,
    n: seg.t.length,
    nTail: tail.length,
  };
}

// 구동명령 from→to 의 lowPct~highPct 구간 각속도(°/s): 구간 평균과 구간 내 최대(국소 선형회귀 기울기)
export function slewMetrics(ts, ys, { t0, t1, from, to, lowPct = 10, highPct = 90, smoothMs = 6 }) {
  const seg = sliceByTime(ts, ys, t0, t1);
  const S = to - from, dir = Math.sign(S) || 1;
  const loDeg = from + S * lowPct / 100, hiDeg = from + S * highPct / 100;
  const tLow = crossTime(seg.t, seg.y, loDeg, dir, t0);
  const tHigh = tLow == null ? null : crossTime(seg.t, seg.y, hiDeg, dir, tLow);
  if (tLow == null || tHigh == null || tHigh <= tLow) {
    return { loDeg, hiDeg, tLow, tHigh, avg: null, max: null, nWin: 0 };
  }
  const avg = Math.abs(hiDeg - loDeg) / ((tHigh - tLow) / 1000);
  const half = smoothMs / 2;
  let max = null, nWin = 0;
  for (let i = 0; i < seg.t.length; i++) {
    const tc = seg.t[i];
    if (tc < tLow || tc > tHigh) continue;
    nWin++;
    const wt = [], wy = [];
    for (let j = 0; j < seg.t.length; j++) {
      if (Math.abs(seg.t[j] - tc) <= half) { wt.push(seg.t[j]); wy.push(seg.y[j]); }
    }
    const k = linSlope(wt, wy);
    if (k != null) max = Math.max(max ?? 0, Math.abs(k) * 1000);
  }
  return { loDeg, hiDeg, tLow, tHigh, avg, max: max ?? avg, nWin };
}

// y ≈ offset + amp·sin(2πf(t−tRef) + phase) 최소제곱 적합
export function sineFit(ts, ys, freqHz, tRef = 0) {
  const w = 2 * Math.PI * freqHz;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
  const n = ts.length;
  for (let i = 0; i < n; i++) {
    const x = w * (ts[i] - tRef) / 1000;
    const b = [Math.sin(x), Math.cos(x), 1];
    for (let r = 0; r < 3; r++) {
      v[r] += b[r] * ys[i];
      for (let c = 0; c < 3; c++) M[r][c] += b[r] * b[c];
    }
  }
  const [a, bc, c] = solve3(M, v);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const x = w * (ts[i] - tRef) / 1000;
    ss += (ys[i] - (a * Math.sin(x) + bc * Math.cos(x) + c)) ** 2;
  }
  return {
    amp: Math.hypot(a, bc),
    phaseDeg: Math.atan2(bc, a) * 180 / Math.PI,
    offset: c,
    rms: n ? Math.sqrt(ss / n) : NaN,
    n,
  };
}

function solve3(M, v) {
  const A = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < 3; col++) {
    let p = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[p][col])) p = r;
    [A[col], A[p]] = [A[p], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return [NaN, NaN, NaN];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const k = A[r][col] / A[col][col];
      for (let c = col; c < 4; c++) A[r][c] -= k * A[col][c];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

const wrap180 = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };

// rows: [{f, cmd:{amp,phaseDeg}, fb:{amp,phaseDeg}}] (주파수 오름차순).
// latencyMs: 측정계(USB·브라우저) 지연 보정량 — 위상에 +360·f·τ 를 더한다.
export function bode(rows, latencyMs = 0) {
  let prev = null;
  return rows.map((r) => {
    let ph = wrap180(r.fb.phaseDeg - r.cmd.phaseDeg + 360 * r.f * latencyMs / 1000);
    if (prev != null) {
      while (ph - prev > 180) ph -= 360;
      while (ph - prev < -180) ph += 360;
    }
    prev = ph;
    return { ...r, gainDb: 20 * Math.log10(r.fb.amp / r.cmd.amp), phaseDeg: ph };
  });
}

// vals 가 처음 thr 이하로 내려가는 주파수(로그 보간). 시작점부터 미달이면 freqs[0], 끝까지 미도달이면 null.
export function crossFreq(freqs, vals, thr) {
  if (!freqs.length) return null;
  if (vals[0] <= thr) return freqs[0];
  for (let i = 1; i < freqs.length; i++) {
    if (vals[i] <= thr) {
      const frac = (vals[i - 1] - thr) / (vals[i - 1] - vals[i]);
      return Math.exp(Math.log(freqs[i - 1]) + frac * (Math.log(freqs[i]) - Math.log(freqs[i - 1])));
    }
  }
  return null;
}

// criterion: 'both' | '3dB' | 'phase'. 미도달 기준은 측정 상한(fMax) 이상으로 본다.
export function bandwidth({ f3, f90, fMax }, criterion) {
  const c = criterion === '3dB' ? [f3] : criterion === 'phase' ? [f90] : [f3, f90];
  const hit = c.filter((x) => x != null);
  if (!hit.length) return { value: fMax, reached: false };
  return { value: Math.min(...hit), reached: true };
}

export function parseFreqList(s) {
  return String(s).split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
}
