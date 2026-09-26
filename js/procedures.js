// 점검 절차. 서보 API(HitecServo)와 프로파일만 알고 전송수단·화면은 모른다.
import { REG, CAN_BAUD_KBPS, streamTimeValue } from './protocol.js';
import { Recorder } from './servo.js';
import { commandExtremes, validateProfile } from './profile.js';
import {
  sliceByTime, stepMetrics, slewMetrics, sineFit, bode, crossFreq, bandwidth, parseFreqList, mean,
} from './analysis.js';

const abortError = () => Object.assign(new Error('중지됨'), { name: 'AbortError' });

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(id); reject(abortError()); };
    const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function metric(name, value, unit, limit = null, op = '<=', display) {
  const pass = limit == null || value == null ? null : op === '<=' ? value <= limit + 1e-9 : value >= limit - 1e-9;
  return { name, value, unit, limit, op, pass, display };
}

function verdict(metrics) {
  const judged = metrics.filter((m) => m.pass !== null);
  return judged.length ? judged.every((m) => m.pass) : null;
}

function result(key, title, profile, metrics, extra = {}) {
  return {
    key, title, pass: verdict(metrics), metrics,
    at: new Date().toISOString(),
    params: profile[key] ? JSON.parse(JSON.stringify(profile[key])) : null,
    warnings: [],
    ...extra,
  };
}

// 서보 명령 분해능으로 양자화된 실제 목표각
const target = (servo, deg) => servo.countsToDeg(servo.degToCounts(deg));

export class FeedbackSource {
  constructor(servo, general) {
    this.servo = servo;
    this.mode = general.feedback;
    this.hz = general.streamHz;
    this.polling = false;
  }

  async start() {
    if (this.mode === 'stream') {
      await this.servo.writeAck(REG.STREAM_TIME, streamTimeValue(this.hz), 200);
      await this.servo.writeAck(REG.STREAM_MODE, 1, 200);
    } else {
      this.polling = true;
      this.loop = this._poll();
    }
  }

  async _poll() {
    while (this.polling) {
      try { await this.servo.read(REG.POSITION, 50); } catch { await sleep(5); }
    }
  }

  async stop() {
    this.polling = false;
    await this.loop;
    if (this.mode === 'stream') {
      try { await this.servo.writeAck(REG.STREAM_MODE, 0, 200); } catch { /* 연결이 이미 끊겼을 수 있음 */ }
    }
  }
}

// 6번 항목: MCU 온도·전압·에러 플래그를 상시 조회
export class TempMonitor {
  constructor(servo, pollMs) {
    this.servo = servo;
    this.pollMs = pollMs;
    this.temp = { t: [], y: [] };
    this.volt = { t: [], y: [] };
    this.flags = null;
    this.errors = 0;
    this.busy = false;
  }

  start() {
    this.startedAt = performance.now();
    this.timer = setInterval(() => this._poll(), this.pollMs);
    this._poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  async _poll() {
    if (this.busy) return;
    this.busy = true;
    const read = async (addr) => {
      try { return await this.servo.read(addr, Math.min(500, this.pollMs)); } catch { this.errors++; return null; }
    };
    try {
      const t = await read(REG.MCU_TEMPER);
      if (t) { this.temp.t.push(t.t); this.temp.y.push(t.value); }
      const v = await read(REG.VOLTAGE);
      if (v) { this.volt.t.push(v.t); this.volt.y.push(v.value / 100); }
      const f = await read(REG.EMERGENCY_STOP);
      if (f) this.flags = f.value;
    } finally {
      this.busy = false;
    }
  }

  lastTemp() {
    const n = this.temp.t.length;
    return n ? { t: this.temp.t[n - 1], value: this.temp.y[n - 1] } : null;
  }

  lastVolt() {
    const n = this.volt.t.length;
    return n ? this.volt.y[n - 1] : null;
  }

  evaluate(t0, t1) {
    const ts = this.temp.t, ys = this.temp.y;
    let last = t0, maxGap = 0, n = 0, maxTemp = null;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < t0) { last = ts[i]; continue; }
      if (ts[i] > t1) break;
      maxGap = Math.max(maxGap, ts[i] - last);
      last = ts[i];
      n++;
      maxTemp = maxTemp == null ? ys[i] : Math.max(maxTemp, ys[i]);
    }
    maxGap = Math.max(maxGap, t1 - last);
    const v = sliceByTime(this.volt.t, this.volt.y, t0, t1).y;
    return { n, maxGapS: maxGap / 1000, maxTemp, voltAvg: v.length ? mean(v) : null };
  }
}

export async function applySetup(servo, p) {
  const s = p.setup;
  // SPEED_ES ≤ SPEED_DN 제약(매뉴얼 2-8.14) 때문에 ES 를 먼저 내린다
  const items = [
    ['SPEED_UP', REG.SPEED_UP, s.speedUp],
    ['SPEED_ES', REG.SPEED_ES, s.speedEs],
    ['SPEED_DN', REG.SPEED_DN, s.speedDn],
    ['DEADBAND', REG.DEADBAND, s.deadband],
    ['POS_LOCK_TORQUE_RATIO', REG.POS_LOCK_TORQUE_RATIO, s.posLockTorqueRatio],
  ];
  const log = [];
  for (const [name, addr, value] of items) {
    try {
      const r = await servo.writeAck(addr, value, 200);
      log.push({ name, value, ok: r.value === value, readBack: r.value });
    } catch (e) {
      log.push({ name, value, ok: false, error: e.message });
    }
  }
  return log;
}

const CONFIG_REGS = [
  ['runMode', REG.RUN_MODE], ['baudReg', REG.CAN_BAUDRATE],
  ['posMinLimit', REG.POSITION_MIN_LIMIT], ['posMaxLimit', REG.POSITION_MAX_LIMIT], ['posMid', REG.POS_MID],
  ['velocityMax', REG.VELOCITY_MAX], ['torqueMax', REG.TORQUE_MAX], ['speedVoltage', REG.SPEED_VOLTAGE],
  ['speedUp', REG.SPEED_UP], ['speedDn', REG.SPEED_DN], ['speedEs', REG.SPEED_ES], ['deadband', REG.DEADBAND],
  ['posLockTime', REG.POS_LOCK_TIME], ['posLockTorqueRatio', REG.POS_LOCK_TORQUE_RATIO], ['inertiaRange', REG.INERTIA_RANGE],
];
const RUN_MODE_NAME = ['멀티턴', '서보', 'CR', '속도'];

// 연결 직후 서보의 실제 설정을 읽는다. 매뉴얼 기본값이 기종마다·표/본문마다 달라 가정하지 않는다.
export async function readServoConfig(servo, timeoutMs = 200) {
  const c = { warnings: [], missing: [] };
  for (const [k, addr] of CONFIG_REGS) {
    try { c[k] = (await servo.read(addr, timeoutMs)).value; } catch { c[k] = null; c.missing.push(k); }
  }
  c.baudKbps = c.baudReg == null ? null : CAN_BAUD_KBPS[c.baudReg] ?? null;
  if (c.posMinLimit != null && c.posMaxLimit != null) {
    const a = servo.countsToDeg(c.posMinLimit), b = servo.countsToDeg(c.posMaxLimit);
    c.limitMinDeg = Math.min(a, b);
    c.limitMaxDeg = Math.max(a, b);
  }
  if (c.runMode != null && c.runMode !== 1) {
    c.warnings.push(`RUN_MODE = ${c.runMode}(${RUN_MODE_NAME[c.runMode] ?? '?'}) — 서보 모드(1)가 아니면 위치 한계·점검 전제가 달라집니다`);
  }
  if (c.posMid != null && c.posMid !== servo.center) {
    c.warnings.push(`서보 POS_MID = ${c.posMid} 가 기준 설정의 중립 위치 ${servo.center} 와 다릅니다`);
  }
  if (c.missing.length) c.warnings.push(`설정 읽기 실패: ${c.missing.join(', ')}`);
  return c;
}

// 서보모드에서 위치 한계 밖 POSITION_NEW 는 무시된다(매뉴얼 2-7.4/2-7.6) — 시험 전에 막는다
export function checkCommandRange(p, cfg, key = null) {
  if (!cfg || cfg.limitMinDeg == null) return [];
  return commandExtremes(p)
    .filter((x) => !key || x.key === key)
    .filter((x) => x.min < cfg.limitMinDeg - 1e-6 || x.max > cfg.limitMaxDeg + 1e-6)
    .map((x) => `${x.name}: 명령 ${x.min}~${x.max}° 가 서보 위치 한계 ${cfg.limitMinDeg.toFixed(1)}~${cfg.limitMaxDeg.toFixed(1)}° 밖 — 서보가 움직이지 않습니다`);
}

export async function runComm({ servo, profile: p, signal, onProgress }) {
  const c = p.comm;
  let ok = 0, timeouts = 0, mismatch = 0;
  const rtt = [];
  for (let i = 0; i < c.count; i++) {
    if (signal?.aborted) throw abortError();
    const val = (i * 7919 + 13) & 0xFFFF;
    try {
      const r = await servo.writeAck(c.addr, val, c.timeoutMs);
      if ((r.value & 0xFFFF) === val) { ok++; rtt.push(r.rtt); } else mismatch++;
    } catch (e) {
      if (e.name !== 'TimeoutError') throw e;
      timeouts++;
    }
    onProgress?.((i + 1) / c.count, `${i + 1} / ${c.count}`);
  }
  const errPct = (timeouts + mismatch) / c.count * 100;
  return result('comm', '통신', p, [
    metric('에러율', errPct, '%', c.maxErrPct),
    metric('성공', ok, '회'),
    metric('타임아웃', timeouts, '회'),
    metric('값 불일치', mismatch, '회'),
    metric('왕복시간 평균', rtt.length ? mean(rtt) : null, 'ms'),
    metric('왕복시간 최대', rtt.length ? Math.max(...rtt) : null, 'ms'),
  ]);
}

// 단계 명령열을 실행하고 각 단계의 [t0, t1) 구간을 돌려준다.
async function runLevels(servo, levels, dwellMs, signal, onProgress) {
  const rec = new Recorder(servo);
  const edges = [];
  let prev = target(servo, levels[0]);
  servo.setAngle(levels[0]);
  await sleep(dwellMs, signal);
  rec.start();
  let data;
  try {
    for (let i = 1; i < levels.length; i++) {
      const to = target(servo, levels[i]);
      const { t } = servo.setAngle(levels[i]);
      await sleep(dwellMs, signal);
      edges.push({ t0: t, t1: performance.now(), from: prev, to });
      prev = to;
      onProgress?.(i / (levels.length - 1), `${i} / ${levels.length - 1}`);
    }
  } finally {
    data = rec.stop();
  }
  return { edges, data };
}

function stepResults(edges, data, ssWindowPct) {
  return edges.map((e) => ({ ...e, ...stepMetrics(data.fb.t, data.fb.y, { ...e, ssWindowPct }) }));
}

function sparseWarning(detail) {
  return detail.some((d) => d.nTail < 3) ? ['정상상태 구간의 피드백 샘플이 3개 미만인 단계가 있습니다 — 스트림/폴링 확인'] : [];
}

export async function runSquare({ servo, profile: p, signal, onProgress }) {
  const q = p.square;
  const levels = [q.center - q.amplitude];
  for (let i = 0; i < 2 * q.cycles; i++) levels.push(i % 2 === 0 ? q.center + q.amplitude : q.center - q.amplitude);
  const { edges, data } = await runLevels(servo, levels, q.periodS * 500, signal, onProgress);
  const detail = stepResults(edges, data, q.ssWindowPct);
  const over = Math.max(...detail.map((d) => (q.overshootUnit === 'pct' ? d.overshootPct : d.overshootDeg)));
  const sse = Math.max(...detail.map((d) => d.sse));
  const rise = detail.map((d) => d.riseMs).filter((x) => x != null);
  const r = result('square', '구형파 응답', p, [
    metric('최대 오버슈트', over, q.overshootUnit === 'pct' ? '%' : '°', q.maxOvershoot),
    metric('최대 정상상태 오차', sse, '°', q.maxSse),
    metric('평균 상승시간(10–90%)', rise.length ? mean(rise) : null, 'ms'),
    metric('피드백 샘플', data.fb.t.length, '개'),
  ], { detail, series: data });
  r.warnings.push(...sparseWarning(detail));
  return r;
}

export async function runStair({ servo, profile: p, signal, onProgress }) {
  const s = p.stair;
  const up = Array.from({ length: s.steps + 1 }, (_, i) => s.start + i * s.step);
  const levels = s.returnDown ? [...up, ...up.slice(0, -1).reverse()] : up;
  const { edges, data } = await runLevels(servo, levels, s.dwellS * 1000, signal, onProgress);
  const detail = stepResults(edges, data, s.ssWindowPct);
  const r = result('stair', '계단파 응답', p, [
    metric('최대 정상상태 오차', Math.max(...detail.map((d) => d.sse)), '°', s.maxSse),
    metric('평균 정상상태 오차', mean(detail.map((d) => d.sse)), '°'),
    metric('단계 수', detail.length, '단'),
  ], { detail, series: data });
  r.warnings.push(...sparseWarning(detail));
  return r;
}

export async function runSlew({ servo, profile: p, signal, onProgress }) {
  const s = p.slew;
  const levels = [s.center, s.center - s.down, s.center, s.center + s.up, s.center];
  const { edges, data } = await runLevels(servo, levels, s.holdS * 1000, signal, onProgress);
  const opts = { lowPct: s.lowPct, highPct: s.highPct, smoothMs: s.smoothMs };
  const down = { label: '하향', ...edges[0], ...slewMetrics(data.fb.t, data.fb.y, { ...edges[0], ...opts }) };
  const upE = { label: '상향', ...edges[2], ...slewMetrics(data.fb.t, data.fb.y, { ...edges[2], ...opts }) };
  const pick = (m) => (s.method === 'max' ? m.max : m.avg);
  const other = s.method === 'max' ? '평균' : '최대';
  const lim = s.minSlew > 0 ? s.minSlew : null;
  const r = result('slew', '최대 각속도', p, [
    metric('하향 slew', pick(down), '°/s', lim, '>='),
    metric('상향 slew', pick(upE), '°/s', lim, '>='),
    metric(`하향 ${other} slew`, s.method === 'max' ? down.avg : down.max, '°/s'),
    metric(`상향 ${other} slew`, s.method === 'max' ? upE.avg : upE.max, '°/s'),
    metric('하향 구간 통과시간', down.tHigh != null ? down.tHigh - down.tLow : null, 'ms'),
    metric('상향 구간 통과시간', upE.tHigh != null ? upE.tHigh - upE.tLow : null, 'ms'),
  ], { detail: [down, upE], series: data });
  for (const d of [down, upE]) {
    if (d.avg == null) r.warnings.push(`${d.label}: ${s.lowPct}–${s.highPct}% 구간을 통과하지 못했습니다`);
    else if (d.nWin < 5) r.warnings.push(`${d.label}: 구간 내 샘플 ${d.nWin}개 — 피드백 주기를 높이세요`);
  }
  if (r.metrics.some((m) => m.value == null && m.limit != null)) r.pass = false;
  return r;
}

export async function runFreq({ servo, profile: p, signal, onProgress }) {
  const f = p.freq;
  const freqs = parseFreqList(f.freqs);
  const period = 1000 / p.general.cmdRateHz;
  const rec = new Recorder(servo);
  const rows = [];
  const warnings = [];
  const series = [];
  servo.setAngle(f.center);
  await sleep(500, signal);
  for (let i = 0; i < freqs.length; i++) {
    const fr = freqs[i];
    const settle = f.settleCycles / fr * 1000;
    const meas = Math.max(f.measCycles / fr * 1000, f.minMeasS * 1000);
    rec.start();
    const t0 = performance.now(), tEnd = t0 + settle + meas;
    let d;
    try {
      // 절대 시각(t0 + k·period)에 맞춰 보내야 처리 지연이 쌓여 주기가 늘어나지 않는다
      for (let k = 0, now = t0; now < tEnd; now = performance.now()) {
        servo.setAngle(f.center + f.amplitude * Math.sin(2 * Math.PI * fr * (now - t0) / 1000));
        k = Math.max(k + 1, Math.floor((now - t0) / period) + 1);
        await sleep(Math.max(0, t0 + k * period - performance.now()), signal);
      }
    } finally {
      d = rec.stop();
      servo.setAngle(f.center);
    }
    const w0 = t0 + settle;
    const c = sliceByTime(d.cmd.t, d.cmd.y, w0, tEnd), y = sliceByTime(d.fb.t, d.fb.y, w0, tEnd);
    const cmdFit = sineFit(c.t, c.y, fr, t0), fbFit = sineFit(y.t, y.y, fr, t0);
    const cmdRate = c.t.length / (meas / 1000);
    rows.push({ f: fr, cmd: cmdFit, fb: fbFit, cmdRate, nFb: y.t.length });
    series.push({ f: fr, t0: w0, cmd: c, fb: y });
    if (fbFit.rms > 0.3 * fbFit.amp) warnings.push(`${fr} Hz: 응답 왜곡 큼(잔차 ${fbFit.rms.toFixed(2)}°) — 속도 포화·백래시 의심`);
    onProgress?.((i + 1) / freqs.length, `${fr} Hz`);
    await sleep(200, signal);
  }
  const b = bode(rows, p.general.latencyCompMs);
  const fs = b.map((r) => r.f);
  const f3 = crossFreq(fs, b.map((r) => r.gainDb), -3);
  const f90 = crossFreq(fs, b.map((r) => r.phaseDeg), -90);
  const fMax = fs.at(-1);
  const bw = bandwidth({ f3, f90, fMax }, f.criterion);
  const show = (x) => (x == null ? `> ${fMax}` : fs.length && x === fs[0] ? `≤ ${fs[0]}` : x.toFixed(2));
  const r = result('freq', '주파수 응답', p, [
    metric('-3dB 대역폭', f3, 'Hz', null, '>=', show(f3)),
    metric('-90° 대역폭', f90, 'Hz', null, '>=', show(f90)),
    metric('판정 대역폭', bw.value, 'Hz', f.minBw, '>=', bw.reached ? bw.value.toFixed(2) : `> ${fMax}`),
  ], { bode: b, series });
  r.warnings.push(...warnings);
  if (f3 === fs[0] || f90 === fs[0]) r.warnings.push('최저 주파수에서 이미 기준 미달 — 주파수 목록 하한을 낮추세요');
  const coarse = rows.filter((x) => x.cmdRate < 10 * x.f).map((x) => x.f);
  if (coarse.length) r.warnings.push(`한 주기 명령 10점 미만: ${coarse.join(', ')} Hz — 명령 갱신율을 높이거나 해당 주파수 결과를 참고로만 보세요`);
  const zoh = 500 / p.general.cmdRateHz;
  r.warnings.push(`명령 ${p.general.cmdRateHz} Hz 유지(ZOH)로 약 ${zoh.toFixed(1)} ms 지연이 위상에 포함됨 (${f.minBw} Hz에서 ≈ ${(360 * f.minBw * zoh / 1000).toFixed(1)}°)`);
  return r;
}

export async function runTemp({ profile: p, signal, onProgress }, monitor, windowStart = null) {
  const c = p.temp;
  let t0 = windowStart;
  if (t0 == null) {
    t0 = performance.now();
    const steps = Math.max(1, Math.round(c.durationS));
    for (let i = 0; i < steps; i++) {
      await sleep(c.durationS * 1000 / steps, signal);
      onProgress?.((i + 1) / steps, `${i + 1} / ${steps} s`);
    }
  }
  const t1 = performance.now();
  const ev = monitor.evaluate(t0, t1);
  const series = { temp: sliceByTime(monitor.temp.t, monitor.temp.y, t0, t1 + 1), volt: sliceByTime(monitor.volt.t, monitor.volt.y, t0, t1 + 1) };
  const r = result('temp', '온도 피드백', p, [
    metric('최대 수신 공백', ev.maxGapS, 's', c.maxGapS),
    metric('최고 MCU 온도', ev.maxTemp, '℃', c.maxTempC),
    metric('수신 샘플', ev.n, '개'),
    metric('평균 전압', ev.voltAvg, 'V'),
  ], { window: { t0, t1 }, series });
  if (!ev.n) { r.pass = false; r.warnings.push('평가 구간에 온도 수신이 없습니다'); }
  r.warnings.push('MDB961WP 는 MCU 온도(0x14)만 제공 — 모터 온도·전류는 SG 시리즈 전용 레지스터');
  return r;
}

// ─── 자동 시험 ───────────────────────────────────────────
export const AUTO_STEPS = [
  { key: 'pre', title: '사전 점검' },
  { key: 'comm', title: '1 통신', run: runComm },
  { key: 'square', title: '2 구형파 응답', run: runSquare },
  { key: 'stair', title: '3 계단파 응답', run: runStair },
  { key: 'slew', title: '4 최대 각속도', run: runSlew },
  { key: 'freq', title: '5 주파수 응답', run: runFreq },
  { key: 'temp', title: '6 온도 피드백', run: (ctx, monitor, windowStart) => runTemp(ctx, monitor, windowStart) },
];

// 판정만 있고 수치 기준이 없는 점검 항목(사전 점검용)
const checkItem = (name, ok, display, criterion) => ({ name, value: ok ? 1 : 0, unit: '', limit: null, op: '', pass: ok, display, criterion });

function summarize(r) {
  const judged = r.metrics.filter((m) => m.pass != null);
  return (judged.length ? judged : r.metrics.slice(0, 2))
    .map((m) => `${m.name} ${m.display ?? (typeof m.value === 'number' ? +m.value.toFixed(3) : m.value ?? '—')}${m.unit ? ' ' + m.unit : ''}`)
    .join(' · ');
}

async function preCheck(servo, p) {
  const metrics = [], warnings = [];
  let cfg = null, info = null;
  const errs = validateProfile(p);
  metrics.push(checkItem('기준 프로파일', !errs.length, errs.length ? errs.join(' / ') : `정상 (${p.name})`, '오류 없음'));
  try {
    const pn = await servo.read(REG.PRODUCT_NO, 300);
    const ver = await servo.read(REG.VERSION, 300);
    info = { product: pn.value, version: ver.value, id: pn.id };
    metrics.push(checkItem('서보 응답', true, `제품 ${pn.value} · 버전 0x${ver.value.toString(16).toUpperCase()} · ID ${pn.id}`, '응답 있음'));
  } catch {
    metrics.push(checkItem('서보 응답', false, '응답 없음 — 비트레이트·ID·배선·종단 확인', '응답 있음'));
  }
  if (info) {
    cfg = await readServoConfig(servo);
    warnings.push(...cfg.warnings.filter((w) => !w.startsWith('RUN_MODE')));
    metrics.push(checkItem('운전모드', cfg.runMode === 1, `RUN_MODE = ${cfg.runMode ?? '읽기 실패'}`, '서보 모드(1)'));
    const rangeErr = checkCommandRange(p, cfg);
    const lim = cfg.limitMinDeg != null ? `${cfg.limitMinDeg.toFixed(1)}~${cfg.limitMaxDeg.toFixed(1)}°` : '읽기 실패';
    metrics.push(checkItem('명령 범위', cfg.limitMinDeg != null && !rangeErr.length, rangeErr.length ? rangeErr.join(' / ') : `모든 시험 명령이 위치 한계 ${lim} 이내`, '위치 한계 이내'));
  }
  const fatal = metrics.some((m) => m.pass === false);
  let setupLog = [];
  if (!fatal && p.setup.apply) {
    setupLog = await applySetup(servo, p);
    const bad = setupLog.filter((x) => !x.ok);
    metrics.push({ name: '시험 전 설정', value: setupLog.length - bad.length, unit: '', limit: null, op: '', pass: null, display: `${setupLog.length - bad.length}/${setupLog.length} 적용` });
    for (const x of bad) warnings.push(`시험 전 설정 실패: ${x.name}=${x.value} (${x.error || '되읽기 ' + x.readBack})`);
  }
  const r = result('pre', '사전 점검', p, metrics, { detail: setupLog });
  r.params = { apply: p.setup.apply };
  r.warnings.push(...warnings);
  return { r, fatal, cfg, info };
}

// 사전 점검 → 1~6 순서대로 전부 수행. 한 항목이 FAIL 이어도 계속하고, 사전 점검 FAIL·중지 시에만 멈춘다.
export async function runAuto({ servo, profile: p, signal, onEvent }, monitor) {
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const steps = [], results = {};
  let aborted = false;
  const ev = (e) => {
    const x = { at: new Date().toISOString(), ...e };
    if (e.status !== 'progress') steps.push(x);
    onEvent?.(x);
  };
  const skipFrom = (i) => { for (const s of AUTO_STEPS.slice(i)) ev({ key: s.key, title: s.title, status: 'skip', text: '건너뜀' }); };

  ev({ key: 'pre', title: '사전 점검', status: 'run', text: '서보 응답·설정·기준 확인' });
  const pre = await preCheck(servo, p);
  results.pre = pre.r;
  ev({ key: 'pre', title: '사전 점검', status: pre.fatal ? 'fail' : 'pass', text: summarize(pre.r) });

  if (pre.fatal) {
    skipFrom(1);
  } else {
    const windowStart = performance.now();
    for (let i = 1; i < AUTO_STEPS.length; i++) {
      const s = AUTO_STEPS[i];
      if (signal?.aborted) { aborted = true; skipFrom(i); break; }
      ev({ key: s.key, title: s.title, status: 'run', text: '실행 중' });
      try {
        const r = await s.run({
          servo, profile: p, signal,
          onProgress: (frac, text) => ev({ key: s.key, title: s.title, status: 'progress', frac, text }),
        }, monitor, windowStart);
        results[s.key] = r;
        ev({ key: s.key, title: s.title, status: r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'info', text: summarize(r) });
      } catch (e) {
        if (e.name === 'AbortError') {
          aborted = true;
          ev({ key: s.key, title: s.title, status: 'aborted', text: '중지됨' });
          skipFrom(i + 1);
          break;
        }
        const r = result(s.key, s.title, p, [{ name: '실행 오류', value: null, unit: '', limit: null, op: '', pass: false, display: e.message }]);
        r.pass = false;
        r.error = e.message;
        results[s.key] = r;
        ev({ key: s.key, title: s.title, status: 'error', text: e.message });
      }
    }
  }
  const all = Object.values(results);
  return {
    mode: 'auto', startedAt, endedAt: new Date().toISOString(), durationS: (performance.now() - t0) / 1000,
    pass: !aborted && !pre.fatal && all.length === AUTO_STEPS.length && all.every((r) => r.pass !== false),
    aborted, steps, results, servoConfig: pre.cfg, servoInfo: pre.info, profile: JSON.parse(JSON.stringify(p)),
  };
}
