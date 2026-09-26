// 점검 기준·시험 조건 프로파일. 기준은 수시로 바뀌므로 코드 어디에도 합격값을 하드코딩하지 않는다.
import { parseFreqList } from './analysis.js';

export const DEFAULT_PROFILE = {
  name: 'MDB961WP-CAN 기본',
  general: { centerCounts: 8192, upSign: 1, feedback: 'stream', streamHz: 100, tempPollMs: 1000, cmdRateHz: 100, latencyCompMs: 0 },
  setup: { apply: true, speedUp: 0, speedEs: 0, speedDn: 0, deadband: 0, posLockTorqueRatio: 100 },
  comm: { count: 1000, addr: 0xC6, timeoutMs: 50, maxErrPct: 0 },
  square: { center: 0, amplitude: 10, periodS: 2, cycles: 3, ssWindowPct: 20, overshootUnit: 'deg', maxOvershoot: 0.5, maxSse: 0.5 },
  stair: { start: -10, step: 5, steps: 4, dwellS: 1, returnDown: true, ssWindowPct: 20, maxSse: 0.5 },
  slew: { center: 0, down: 20, up: 30, holdS: 1, lowPct: 10, highPct: 90, method: 'max', smoothMs: 25, minSlew: 0 },
  freq: { center: 0, amplitude: 2, freqs: '0.5, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12', settleCycles: 2, measCycles: 5, minMeasS: 1, criterion: 'both', minBw: 6 },
  temp: { durationS: 30, maxGapS: 3, maxTempC: 80 },
};

// 필드 정의: 화면 입력칸과 JSON 정규화가 같은 정의를 쓴다.
// crit: true 는 합격 기준(성적서에 기준값으로 표기)
export const SECTIONS = [
  { key: 'general', title: '공통', fields: [
    { k: 'centerCounts', label: '중립 위치', unit: 'counts', type: 'int', help: '0°에 해당하는 서보 위치값 (4096 = 90°)' },
    { k: 'upSign', label: '상향(+) 방향', type: 'select', options: [[1, '위치값 증가 방향'], [-1, '위치값 감소 방향']] },
    { k: 'feedback', label: '피드백 수집', type: 'select', options: [['stream', '스트림 모드'], ['poll', '요청/응답 폴링']] },
    { k: 'streamHz', label: '스트림 주기', unit: 'Hz', type: 'num', help: '1~1000 Hz (F/W ≥ 1.4(2))' },
    { k: 'tempPollMs', label: '온도·전압 조회 주기', unit: 'ms', type: 'int' },
    { k: 'cmdRateHz', label: '정현파 명령 갱신율', unit: 'Hz', type: 'num', help: '브라우저 타이머 한계로 ~250Hz 이하. 명령 유지(ZOH)로 반주기만큼 위상 지연이 응답에 포함됨' },
    { k: 'latencyCompMs', label: '측정계 지연 보정', unit: 'ms', type: 'num', help: '주파수응답 위상에서 USB·브라우저 지연을 뺌 (0 = 보정 안 함, 보수적)' },
  ] },
  { key: 'setup', title: '시험 전 서보 설정 (휘발성, SAVE 안 함)', fields: [
    { k: 'apply', label: '시험 전 자동 적용', type: 'bool' },
    { k: 'speedUp', label: 'SPEED_UP 가속시간', unit: 'ms', type: 'int' },
    { k: 'speedEs', label: 'SPEED_ES 비상 감속시간', unit: 'ms', type: 'int', help: 'SPEED_DN 이하여야 해서 DN 보다 먼저 씀 (0 = 비상정지 시 즉시 정지)' },
    { k: 'speedDn', label: 'SPEED_DN 감속시간', unit: 'ms', type: 'int' },
    { k: 'deadband', label: 'DEADBAND', unit: 'step', type: 'int' },
    { k: 'posLockTorqueRatio', label: 'OLP 토크 비율', unit: '%', type: 'int', help: '100 = 과부하 보호가 걸려도 토크 유지' },
  ] },
  { key: 'comm', title: '1. 통신', fields: [
    { k: 'count', label: '반복 횟수', unit: '회', type: 'int' },
    { k: 'addr', label: '검증 레지스터', type: 'hex', help: "'x'(쓰고 응답)로 값을 써서 되돌아온 값 비교. 기본 0xC6 REG_ECHO(휘발성)" },
    { k: 'timeoutMs', label: '응답 타임아웃', unit: 'ms', type: 'int' },
    { k: 'maxErrPct', label: '허용 에러율', unit: '%', type: 'num', crit: true },
  ] },
  { key: 'square', title: '2. 구형파 응답', fields: [
    { k: 'center', label: '중심각', unit: '°', type: 'num' },
    { k: 'amplitude', label: '진폭(±)', unit: '°', type: 'num' },
    { k: 'periodS', label: '주기', unit: 's', type: 'num' },
    { k: 'cycles', label: '반복', unit: '주기', type: 'int' },
    { k: 'ssWindowPct', label: '정상상태 판정 구간', unit: '% (각 반주기 끝)', type: 'num' },
    { k: 'overshootUnit', label: '오버슈트 단위', type: 'select', options: [['deg', '°'], ['pct', '% (스텝 크기 대비)']] },
    { k: 'maxOvershoot', label: '오버슈트 허용', type: 'num', crit: true },
    { k: 'maxSse', label: '정상상태 오차 허용', unit: '°', type: 'num', crit: true },
  ] },
  { key: 'stair', title: '3. 계단파 응답', fields: [
    { k: 'start', label: '시작각', unit: '°', type: 'num' },
    { k: 'step', label: '단 높이', unit: '°', type: 'num' },
    { k: 'steps', label: '단 수', unit: '단', type: 'int', help: '1 = 단일 스텝 응답' },
    { k: 'dwellS', label: '단당 유지', unit: 's', type: 'num' },
    { k: 'returnDown', label: '내려오는 계단 포함', type: 'bool' },
    { k: 'ssWindowPct', label: '정상상태 판정 구간', unit: '% (각 단 끝)', type: 'num' },
    { k: 'maxSse', label: '정상상태 오차 허용', unit: '°', type: 'num', crit: true },
  ] },
  { key: 'slew', title: '4. 최대 각속도', fields: [
    { k: 'center', label: '기준각', unit: '°', type: 'num' },
    { k: 'down', label: '하향 구동', unit: '°', type: 'num' },
    { k: 'up', label: '상향 구동', unit: '°', type: 'num' },
    { k: 'holdS', label: '각 자세 유지', unit: 's', type: 'num' },
    { k: 'lowPct', label: '구간 시작', unit: '%', type: 'num' },
    { k: 'highPct', label: '구간 끝', unit: '%', type: 'num' },
    { k: 'method', label: '판정값', type: 'select', options: [['max', '구간 내 최대 slew'], ['avg', '구간 평균 slew']] },
    { k: 'smoothMs', label: '미분 창', unit: 'ms', type: 'num', help: '피드백 주기의 2배 이상(100Hz → 20ms+). 최대 slew 는 미분 최댓값이라 노이즈만큼 높게 치우침 — 넓히면 줄고, 너무 넓으면 피크를 깎음' },
    { k: 'minSlew', label: '최소 각속도', unit: '°/s', type: 'num', crit: true, help: '0 = 판정 안 함(측정만)' },
  ] },
  { key: 'freq', title: '5. 주파수 응답', fields: [
    { k: 'center', label: '중심각', unit: '°', type: 'num' },
    { k: 'amplitude', label: '진폭(±)', unit: '°', type: 'num', help: '속도 포화 방지: 2π·f·A < 최대각속도' },
    { k: 'freqs', label: '주파수 목록', unit: 'Hz', type: 'text' },
    { k: 'settleCycles', label: '안정화', unit: '주기', type: 'num' },
    { k: 'measCycles', label: '측정', unit: '주기', type: 'num' },
    { k: 'minMeasS', label: '최소 측정 시간', unit: 's', type: 'num' },
    { k: 'criterion', label: '대역폭 기준', type: 'select', options: [['both', '-3dB 와 -90° 중 낮은 쪽'], ['3dB', '-3dB 만'], ['phase', '-90° 만']] },
    { k: 'minBw', label: '필요 대역폭', unit: 'Hz', type: 'num', crit: true },
  ] },
  { key: 'temp', title: '6. 온도 피드백', fields: [
    { k: 'durationS', label: '단독 시험 시간', unit: 's', type: 'num', help: '전체 점검 시에는 점검 전 구간을 평가' },
    { k: 'maxGapS', label: '최대 수신 공백', unit: 's', type: 'num', crit: true },
    { k: 'maxTempC', label: 'MCU 온도 상한', unit: '℃', type: 'num', crit: true },
  ] },
];

function coerce(field, v, dflt) {
  switch (field.type) {
    case 'bool': return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : dflt;
    case 'text': return String(v);
    case 'hex': {
      const n = typeof v === 'number' ? v : parseInt(String(v), String(v).trim().toLowerCase().startsWith('0x') ? 16 : 10);
      return Number.isFinite(n) ? n : dflt;
    }
    case 'select': {
      const opt = field.options.find(([o]) => String(o) === String(v));
      return opt ? opt[0] : dflt;
    }
    default: {
      const n = Number(v);
      if (v === '' || v == null || !Number.isFinite(n)) return dflt;
      return field.type === 'int' ? Math.round(n) : n;
    }
  }
}

export function normalizeProfile(src = {}) {
  const out = { name: typeof src.name === 'string' && src.name ? src.name : DEFAULT_PROFILE.name };
  for (const s of SECTIONS) {
    const inSec = src[s.key] && typeof src[s.key] === 'object' ? src[s.key] : {};
    out[s.key] = {};
    for (const f of s.fields) {
      const d = DEFAULT_PROFILE[s.key][f.k];
      out[s.key][f.k] = f.k in inSec ? coerce(f, inSec[f.k], d) : d;
    }
  }
  return out;
}

const SERVO_RANGE_DEG = 150;

export function validateProfile(p) {
  const e = [];
  const g = p.general;
  if (!(g.streamHz > 0 && g.streamHz <= 1000)) e.push('공통: 스트림 주기는 0~1000 Hz');
  if (!(g.cmdRateHz > 0)) e.push('공통: 명령 갱신율은 0보다 커야 함');
  if (!(g.tempPollMs >= 100)) e.push('공통: 온도 조회 주기는 100 ms 이상');
  if (!(p.comm.count >= 1)) e.push('통신: 반복 횟수는 1 이상');
  if (!(p.comm.timeoutMs > 0)) e.push('통신: 타임아웃은 0보다 커야 함');
  if (!(p.square.amplitude > 0 && p.square.periodS > 0 && p.square.cycles >= 1)) e.push('구형파: 진폭·주기·반복은 양수');
  if (!(p.stair.steps >= 1 && p.stair.dwellS > 0 && p.stair.step !== 0)) e.push('계단파: 단 수·유지시간·단 높이 확인');
  if (!(p.slew.lowPct >= 0 && p.slew.highPct <= 100 && p.slew.lowPct < p.slew.highPct)) e.push('최대 각속도: 10–90% 구간은 시작 < 끝, 0~100%');
  if (!(p.slew.down > 0 && p.slew.up > 0 && p.slew.holdS > 0)) e.push('최대 각속도: 하향·상향·유지시간은 양수');
  // 창 안에 샘플이 3개 미만이면 기울기를 못 구해 최대값이 평균으로 대체된다
  const minWin = 2000 / g.streamHz;
  if (p.slew.method === 'max' && g.feedback === 'stream' && p.slew.smoothMs < minWin - 1e-9) {
    e.push(`최대 각속도: 미분 창은 피드백 주기의 2배(${minWin.toFixed(1)} ms) 이상이어야 함`);
  }
  const fl = parseFreqList(p.freq.freqs);
  if (!fl.length) e.push('주파수 응답: 주파수 목록이 비어 있음');
  if (!(p.freq.amplitude > 0 && p.freq.measCycles > 0 && p.freq.settleCycles >= 0)) e.push('주파수 응답: 진폭·측정주기 확인');
  if (!(p.temp.maxGapS > 0 && p.temp.durationS > 0)) e.push('온도: 공백 기준·시험 시간은 양수');
  if (p.setup.speedEs > p.setup.speedDn) e.push('시험 전 설정: SPEED_ES 는 SPEED_DN 이하여야 함 (매뉴얼 2-8.14)');

  for (const x of commandExtremes(p)) {
    if (Math.max(Math.abs(x.min), Math.abs(x.max)) > SERVO_RANGE_DEG) e.push(`${x.name}: 명령각이 서보모드 가동범위(±150°)를 넘음`);
  }
  return e;
}

// 시험별로 서보에 보내게 될 명령각 범위(°). 실제 서보 위치 한계와 비교하는 데 쓴다.
export function commandExtremes(p) {
  const span = (key, name, a, b) => ({ key, name, min: Math.min(a, b), max: Math.max(a, b) });
  return [
    span('square', '구형파', p.square.center - p.square.amplitude, p.square.center + p.square.amplitude),
    span('stair', '계단파', p.stair.start, p.stair.start + p.stair.step * p.stair.steps),
    span('slew', '최대 각속도', p.slew.center - p.slew.down, p.slew.center + p.slew.up),
    span('freq', '주파수 응답', p.freq.center - p.freq.amplitude, p.freq.center + p.freq.amplitude),
  ];
}

const STORE_KEY = 'servoTestBench.profile.v1';

export function loadStoredProfile(storage) {
  try {
    const raw = storage?.getItem(STORE_KEY);
    return normalizeProfile(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeProfile({});
  }
}

export function storeProfile(storage, p) {
  try { storage?.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* 사생활 보호 모드 등 */ }
}
