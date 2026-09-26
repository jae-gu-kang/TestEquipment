// Hitec CAN 서보 프로토콜 (docs/HitecServo_CAN_Protocol.pdf Rev 2.02, New Packet Format)
// 전송수단(slcan/PEAK/시뮬레이터)과 무관한 순수 함수만 둔다.

export const REG = {
  STATUS: 0x06,
  POSITION: 0x0C,
  VELOCITY: 0x0E,
  TORQUE: 0x10,
  VOLTAGE: 0x12,
  MCU_TEMPER: 0x14,
  CURRENT: 0x16,
  TURN_COUNT: 0x18,
  POSITION_NEW: 0x1E,
  TURN_NEW: 0x24,
  STREAM_TIME: 0x2E,
  STREAM_MODE: 0x30,
  ID: 0x32,
  CAN_BAUDRATE: 0x38,
  RUN_MODE: 0x44,
  POWER_CONFIG: 0x46,
  EMERGENCY_STOP: 0x48,
  DEADBAND: 0x4E,
  POS_MAX: 0x50,
  POS_MIN: 0x52,
  VELOCITY_MAX: 0x54,
  TORQUE_MAX: 0x56,
  INERTIA_RANGE: 0x64,
  TEMPER_MAX: 0x5C,
  TEMPER_MIN: 0x6C,
  PRODUCT_NO: 0x74,
  POS_LOCK_TIME: 0x9A,
  POS_LOCK_TORQUE_RATIO: 0x9C,
  POSITION_MAX_LIMIT: 0xB0,
  POSITION_MIN_LIMIT: 0xB2,
  POS_MID: 0xC2,
  ECHO: 0xC6,
  SPEED_VOLTAGE: 0xDA,
  SPEED_UP: 0xDC,
  SPEED_DN: 0xDE,
  SPEED_ES: 0xE0,
  VERSION: 0xFC,
};

export const REG_NAME = Object.fromEntries(Object.entries(REG).map(([k, v]) => [v, k]));

const SIGNED = new Set([REG.MCU_TEMPER, REG.TURN_COUNT, REG.TURN_NEW, REG.TEMPER_MAX, REG.TEMPER_MIN]);

export const MSG = { w: 0x77, W: 0x57, x: 0x78, X: 0x58, r: 0x72, R: 0x52, v: 0x76, V: 0x56 };
const OLD_RX = 0x69;

// 4096 = 90°
export const COUNTS_PER_DEG = 4096 / 90;
export const POS_MAX_COUNTS = 16383;

// REG_CAN_BAUDRATE(0x38) 값 → kbps
export const CAN_BAUD_KBPS = [1000, 800, 750, 500, 400, 250, 200, 150, 125];

// slcan 표준 S코드가 있는 속도만. 서보의 750/400/200/150k 는 slcan 으로 설정 불가.
export const BITRATES = [
  { kbps: 1000, slcan: 'S8', reg: 0 },
  { kbps: 800, slcan: 'S7', reg: 1 },
  { kbps: 500, slcan: 'S6', reg: 3 },
  { kbps: 250, slcan: 'S5', reg: 5 },
  { kbps: 125, slcan: 'S4', reg: 8 },
];

export const s16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);
export const decodeValue = (addr, raw) => (SIGNED.has(addr) ? s16(raw) : raw);

export function buildWrite(id, addr, value, withReply = false) {
  const v = value & 0xFFFF;
  return Uint8Array.of(withReply ? MSG.x : MSG.w, id & 0xFF, addr & 0xFF, v & 0xFF, v >> 8);
}

export function buildRead(id, addr) {
  return Uint8Array.of(MSG.r, id & 0xFF, addr & 0xFF);
}

export function buildRead2(id, a, b) {
  return Uint8Array.of(MSG.R, id & 0xFF, a & 0xFF, b & 0xFF);
}

// 서보→호스트 응답/스트림: 'v'(1주소), 'V'(2주소), 구형 0x69 헤더.
// 호스트→서보 명령도 해석한다(시뮬레이터·로그용).
export function parsePayload(d) {
  if (!d || d.length < 3) return null;
  const m = d[0];
  const pair = (i) => [d[i], d[i + 1] | (d[i + 2] << 8)];
  if (m === MSG.v && d.length >= 5) return { kind: 'resp', msg: 'v', id: d[1], regs: [pair(2)] };
  if (m === MSG.V && d.length >= 8) return { kind: 'resp', msg: 'V', id: d[1], regs: [pair(2), pair(5)] };
  if (m === OLD_RX && d.length >= 7 && d[3] === 2) {
    const cs = (d[1] + d[2] + d[3] + d[4] + d[5]) & 0xFF;
    if (cs !== d[6]) return { kind: 'bad', msg: 'old', id: d[1], regs: [] };
    return { kind: 'resp', msg: 'old', id: d[1], regs: [[d[2], d[4] | (d[5] << 8)]] };
  }
  if ((m === MSG.w || m === MSG.x) && d.length >= 5)
    return { kind: 'cmd', msg: String.fromCharCode(m), id: d[1], regs: [pair(2)] };
  if ((m === MSG.W || m === MSG.X) && d.length >= 8)
    return { kind: 'cmd', msg: String.fromCharCode(m), id: d[1], regs: [pair(2), pair(5)] };
  if (m === MSG.r) return { kind: 'cmd', msg: 'r', id: d[1], regs: [[d[2], null]] };
  if (m === MSG.R && d.length >= 4) return { kind: 'cmd', msg: 'R', id: d[1], regs: [[d[2], null], [d[3], null]] };
  return null;
}

export function describePayload(d) {
  const p = parsePayload(d);
  if (!p) return '';
  const regs = p.regs
    .map(([a, v]) => `${REG_NAME[a] || '0x' + a.toString(16).toUpperCase()}${v == null ? '' : '=' + decodeValue(a, v)}`)
    .join(', ');
  return `'${p.msg}' id${p.id} ${regs}`;
}

// F/W >= 1.4(2): 10001~11000 → (값-10000) Hz. 그 외에는 주기(ms).
export function streamTimeValue(hz) {
  if (hz >= 1 && hz <= 1000) return 10000 + Math.round(hz);
  return Math.max(1, Math.round(1000 / hz));
}

export function streamPeriodMs(regValue) {
  if (regValue > 10000) return 1000 / Math.max(1, regValue - 10000);
  return Math.max(1, regValue);
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
