// 시뮬레이터에 실제 절차를 실시간으로 돌리는 통합 테스트 (약 15초).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SimTransport } from './transport-sim.js';
import { HitecServo } from './servo.js';
import { normalizeProfile } from './profile.js';
import {
  FeedbackSource, TempMonitor, applySetup, readServoConfig, checkCommandRange, runAuto,
  runComm, runSquare, runStair, runSlew, runFreq, runTemp,
} from './procedures.js';
import { REG } from './protocol.js';

const P = normalizeProfile({
  general: { tempPollMs: 200 },
  comm: { count: 100 },
  square: { amplitude: 10, periodS: 0.6, cycles: 1 },
  stair: { start: -5, step: 5, steps: 2, dwellS: 0.4, returnDown: true },
  slew: { holdS: 0.3, minSlew: 300 },
  freq: { amplitude: 2, freqs: '1, 4, 8, 16', settleCycles: 1, measCycles: 3, minMeasS: 0.3 },
  temp: { durationS: 1, maxGapS: 1 },
});

let tr, servo, fb, mon;

async function connect(simOpts = {}, trOpts = {}) {
  tr = new SimTransport({ noiseCounts: 0.5, ...simOpts }, trOpts);
  servo = new HitecServo(tr, { servoId: 1, center: P.general.centerCounts, sign: P.general.upSign });
  await tr.open();
  fb = new FeedbackSource(servo, P.general);
  await fb.start();
  mon = new TempMonitor(servo, P.general.tempPollMs);
  mon.start();
}

async function disconnect() {
  mon?.stop();
  await fb?.stop();
  await tr?.close();
  servo?.dispose();
}

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const ctx = (extra = {}) => ({ servo, profile: P, signal: new AbortController().signal, onProgress() {}, ...extra });
const metric = (r, name) => r.metrics.find((m) => m.name === name);

before(() => connect());
after(() => disconnect());

test('시험 전 설정: 가감속·데드밴드를 서보에 씀', async () => {
  const log = await applySetup(servo, P);
  assert.ok(log.every((x) => x.ok), JSON.stringify(log));
  assert.equal(tr.servo.regs.get(REG.DEADBAND), 0);
});

test('시험 전 설정: SPEED_ES(≤ SPEED_DN)를 SPEED_DN 보다 먼저 씀', async () => {
  const names = (await applySetup(servo, P)).map((x) => x.name);
  assert.ok(names.indexOf('SPEED_ES') >= 0 && names.indexOf('SPEED_ES') < names.indexOf('SPEED_DN'), names.join(','));
});

test('서보 설정 스냅샷: 운전모드·위치 한계(°)·보레이트 등을 읽음', async () => {
  const c = await readServoConfig(servo);
  assert.equal(c.runMode, 1);
  assert.equal(c.baudKbps, 250);
  near(c.limitMinDeg, -60, 0.05);
  near(c.limitMaxDeg, 60, 0.05);
  assert.deepEqual(c.warnings, []);
});

test('명령 범위 검사: 서보 위치 한계 밖이면 오류', () => {
  const cfg = { limitMinDeg: -60, limitMaxDeg: 60 };
  assert.deepEqual(checkCommandRange(P, cfg), []);
  const wide = normalizeProfile({ ...P, slew: { ...P.slew, up: 70 } });
  const errs = checkCommandRange(wide, cfg);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('최대 각속도'), errs[0]);
  assert.deepEqual(checkCommandRange(wide, null), []);
});

test('1. 통신: 손실 없으면 에러 0% 합격', async () => {
  const r = await runComm(ctx());
  assert.equal(r.pass, true);
  assert.equal(metric(r, '에러율').value, 0);
  assert.equal(metric(r, '성공').value, 100);
});

test('2. 구형파: 오버슈트·정상상태 오차 판정', async () => {
  const r = await runSquare(ctx());
  assert.equal(r.pass, true, JSON.stringify(r.metrics));
  assert.ok(metric(r, '최대 오버슈트').value < 0.5);
  assert.ok(metric(r, '최대 정상상태 오차').value < 0.1);
  assert.equal(r.detail.length, 2);
});

test('3. 계단파: 올라갔다 내려오는 각 단 판정', async () => {
  const r = await runStair(ctx());
  assert.equal(r.pass, true, JSON.stringify(r.metrics));
  assert.equal(r.detail.length, 4);
});

test('4. 최대 각속도: 시뮬 한계(≈428°/s) 근처로 측정', async () => {
  const r = await runSlew(ctx());
  const down = metric(r, '하향 slew').value, up = metric(r, '상향 slew').value;
  // 100 Hz·25ms 창 실측 분포(10회): 최대 415~434, 평균 347~396 (하향 20°는 가속 구간 비중이 커 평균이 낮음)
  for (const v of [down, up]) assert.ok(v > 400 && v < 450, `slew ${v}`);
  const avg = metric(r, '하향 평균 slew').value;
  assert.ok(avg > 320 && avg <= down, `평균 ${avg}, 최대 ${down}`);
  assert.equal(r.pass, true);
});

test('5. 주파수 응답: 대역폭 6Hz 이상 합격', async () => {
  const r = await runFreq(ctx());
  const bw = metric(r, '판정 대역폭');
  assert.ok(bw.value >= 6 && bw.value < 16, JSON.stringify(r.metrics));
  assert.equal(r.pass, true);
  assert.equal(r.bode.length, 4);
  assert.ok(Math.abs(r.bode[0].gainDb) < 0.5);
  // 기본 통신주기 100 Hz: 명령은 절대시각 예약으로 누적 지연 없이, 피드백은 스트림 100 Hz
  for (const b of r.bode) {
    assert.ok(b.cmdRate > 95 && b.cmdRate < 105, `명령 ${b.cmdRate} Hz @ ${b.f} Hz`);
    const fbRate = b.nFb / (Math.max(P.freq.measCycles / b.f, P.freq.minMeasS));
    assert.ok(fbRate > 90 && fbRate < 110, `피드백 ${fbRate} Hz @ ${b.f} Hz`);
  }
});

test('6. 온도: 공백 없이 수신되면 합격', async () => {
  const r = await runTemp(ctx(), mon);
  assert.equal(r.pass, true, JSON.stringify(r.metrics));
  assert.ok(metric(r, '수신 샘플').value >= 4);
});

test('중지: 시험 중 abort 하면 AbortError', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(runSquare(ctx({ signal: ac.signal })), { name: 'AbortError' });
});

test('1. 통신: 패킷 손실이 있으면 불합격', async () => {
  tr.lossPct = 20;
  const r = await runComm(ctx({ profile: normalizeProfile({ ...P, comm: { count: 50, timeoutMs: 20 } }) }));
  assert.equal(r.pass, false);
  assert.ok(metric(r, '타임아웃').value > 0);
});

const AUTO = normalizeProfile({ ...P, freq: { ...P.freq, freqs: '2, 8', measCycles: 2 } });
const autoCtx = (profile, extra = {}) => ({ servo, profile, signal: new AbortController().signal, ...extra });
const ORDER = ['pre', 'comm', 'square', 'stair', 'slew', 'freq', 'temp'];

test('자동 시험: 사전 점검 → 1~6 전부 수행, 종합 PASS', async () => {
  tr.lossPct = 0;
  const events = [];
  const rep = await runAuto(autoCtx(AUTO, { onEvent: (e) => events.push(e) }), mon);
  assert.equal(rep.pass, true, JSON.stringify(rep.steps));
  assert.equal(rep.aborted, false);
  assert.deepEqual(Object.keys(rep.results), ORDER);
  assert.equal(rep.results.pre.pass, true);
  assert.equal(rep.servoConfig.runMode, 1);
  assert.ok(events.some((e) => e.key === 'freq' && e.status === 'progress'));
  assert.ok(rep.steps.every((s) => s.status !== 'progress'));
  assert.deepEqual(rep.steps.filter((s) => s.status !== 'run').map((s) => s.key), ORDER);
  assert.ok(rep.durationS > 1);
});

test('자동 시험: 한 항목이 FAIL 이어도 나머지 수행, 종합 FAIL', async () => {
  const strict = normalizeProfile({ ...AUTO, square: { ...AUTO.square, maxOvershoot: 0.01 } });
  const rep = await runAuto(autoCtx(strict), mon);
  assert.equal(rep.pass, false);
  assert.equal(rep.results.square.pass, false);
  assert.deepEqual(Object.keys(rep.results), ORDER);
  assert.equal(rep.steps.find((s) => s.key === 'square' && s.status !== 'run').status, 'fail');
});

test('자동 시험: 사전 점검 실패(위치 한계 밖 명령)면 시험을 건너뛰고 FAIL', async () => {
  const wide = normalizeProfile({ ...AUTO, slew: { ...AUTO.slew, up: 70 } });
  const rep = await runAuto(autoCtx(wide), mon);
  assert.equal(rep.pass, false);
  assert.equal(rep.results.pre.pass, false);
  assert.deepEqual(Object.keys(rep.results), ['pre']);
  assert.deepEqual(rep.steps.filter((s) => s.status === 'skip').map((s) => s.key), ORDER.slice(1));
});

test('자동 시험: 중지하면 진행 중 항목은 중단, 남은 항목은 건너뜀', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const rep = await runAuto(autoCtx(AUTO, { signal: ac.signal }), mon);
  assert.equal(rep.aborted, true);
  assert.equal(rep.pass, false);
  assert.ok(rep.steps.some((s) => s.status === 'aborted'));
  assert.equal(rep.steps.at(-1).status, 'skip');
});
