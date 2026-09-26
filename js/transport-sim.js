// 가상 MDB961WP-CAN. 하드웨어 없이 점검 로직 전체를 검증하기 위한 것이지 실물 특성의 대체가 아니다.
import { REG, MSG, parsePayload, COUNTS_PER_DEG, POS_MAX_COUNTS, streamPeriodMs } from './protocol.js';

export const SIM_DEFAULTS = {
  id: 1,
  wnHz: 10,
  zeta: 0.8,
  vmaxDegS: 60 / 0.14,
  noiseCounts: 1.5,
  tAmbC: 28,
  voltage: 2800,
};

const RESET_REGS = {
  [REG.POSITION_NEW]: 8192,
  [REG.STREAM_TIME]: 1000,
  [REG.STREAM_MODE]: 0,
  [REG.CAN_BAUDRATE]: 5,
  [REG.RUN_MODE]: 1,
  [REG.POWER_CONFIG]: 0,
  [REG.DEADBAND]: 2,
  [REG.SPEED_UP]: 0,
  [REG.SPEED_DN]: 0,
  [REG.SPEED_ES]: 0,
  [REG.INERTIA_RANGE]: 1,
  [REG.POS_LOCK_TIME]: 3,
  [REG.POS_LOCK_TORQUE_RATIO]: 100,
  // 매뉴얼 기본값은 1366/15018(±150°)이지만 MDB961WP 스펙시트는 서보모드 기본 ±60°
  [REG.POSITION_MAX_LIMIT]: 8192 + 2731,
  [REG.POSITION_MIN_LIMIT]: 8192 - 2731,
  [REG.POS_MID]: 8192,
  [REG.TORQUE_MAX]: 4095,
  [REG.PRODUCT_NO]: 961,
  [REG.VERSION]: 0x0200,
  [REG.ECHO]: 0,
};

export class SimServo {
  constructor(opts = {}) {
    this.o = { ...SIM_DEFAULTS, ...opts };
    this.regs = new Map(Object.entries(RESET_REGS).map(([k, v]) => [Number(k), v]));
    this.regs.set(REG.ID, this.o.id);
    this.p = 8192;
    this.v = 0;
    this.act = 0;
    this.temp = this.o.tAmbC + 3;
    this.seed = 1;
  }

  _noise() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed / 2147483647 - 0.5) * 2 * this.o.noiseCounts;
  }

  get(addr) {
    switch (addr) {
      case REG.POSITION: return Math.min(POS_MAX_COUNTS, Math.max(0, Math.round(this.p + this._noise())));
      case REG.VELOCITY: return Math.round(Math.abs(this.v) * 0.1);
      case REG.VOLTAGE: return this.o.voltage;
      case REG.MCU_TEMPER: return Math.round(this.temp) & 0xFFFF;
      case REG.TORQUE: return Math.min(4095, Math.round(Math.abs(this.v) / (this.o.vmaxDegS * COUNTS_PER_DEG) * 4095));
      case REG.STATUS: return 1;
      case REG.EMERGENCY_STOP: return this._flags();
      default: return this.regs.get(addr) ?? 0;
    }
  }

  _flags() {
    const r = (a) => this.regs.get(a) ?? 0;
    let f = 0;
    if (r(REG.POS_MIN) && this.p < r(REG.POS_MIN)) f |= 1 << 8;
    if (r(REG.POS_MAX) && this.p > r(REG.POS_MAX)) f |= 1 << 9;
    if (r(REG.TEMPER_MAX) && this.temp > r(REG.TEMPER_MAX)) f |= 1 << 11;
    return f;
  }

  set(addr, value) {
    if (addr === REG.POSITION_NEW && this.regs.get(REG.RUN_MODE) === 1) {
      if (value < this.regs.get(REG.POSITION_MIN_LIMIT) || value > this.regs.get(REG.POSITION_MAX_LIMIT)) return;
    }
    this.regs.set(addr, value);
  }

  // 수신 페이로드 처리 → 응답 페이로드 목록
  handle(data) {
    const p = parsePayload(data);
    if (!p || p.kind !== 'cmd') return [];
    if (p.id !== 0 && p.id !== this.regs.get(REG.ID)) return [];
    const id = this.regs.get(REG.ID);
    const resp = (addrs) => {
      const pairs = addrs.flatMap((a) => { const v = this.get(a); return [a, v & 0xFF, (v >> 8) & 0xFF]; });
      return Uint8Array.of(addrs.length === 1 ? MSG.v : MSG.V, id, ...pairs);
    };
    const addrs = p.regs.map(([a]) => a);
    switch (p.msg) {
      case 'w': case 'W':
        for (const [a, v] of p.regs) this.set(a, v);
        return [];
      case 'x': case 'X':
        for (const [a, v] of p.regs) this.set(a, v);
        return [resp(addrs)];
      case 'r': case 'R':
        return [resp(addrs)];
      default:
        return [];
    }
  }

  step(dt) {
    const o = this.o;
    const vmax = o.vmaxDegS * COUNTS_PER_DEG;
    const wn = 2 * Math.PI * o.wnHz;
    const mode = ((this.regs.get(REG.POWER_CONFIG) ?? 0) >> 9) & 3;
    let a;
    if (mode === 1) {
      a = -this.v * 30;
    } else {
      let e = this.regs.get(REG.POSITION_NEW) - this.p;
      if (Math.abs(e) <= (this.regs.get(REG.DEADBAND) ?? 0)) e = 0;
      a = wn * wn * e - 2 * o.zeta * wn * this.v;
      const up = this.regs.get(REG.SPEED_UP) ?? 0;
      if (up > 0) {
        const amax = vmax / (up / 1000);
        a = Math.max(-amax, Math.min(amax, a));
      }
    }
    this.v = Math.max(-vmax, Math.min(vmax, this.v + a * dt));
    this.p = Math.min(POS_MAX_COUNTS, Math.max(0, this.p + this.v * dt));
    this.act += (Math.abs(this.v) / vmax - this.act) * dt / 5;
    this.temp += (o.tAmbC + 6 + 25 * this.act - this.temp) * dt / 120;
  }

  streamPeriodMs() {
    return this.regs.get(REG.STREAM_MODE) ? streamPeriodMs(this.regs.get(REG.STREAM_TIME)) : null;
  }

  streamFrame() {
    const v = this.get(REG.POSITION);
    return Uint8Array.of(MSG.v, this.regs.get(REG.ID), REG.POSITION, v & 0xFF, v >> 8);
  }
}

// 실시간으로 SimServo 를 적분하며 CAN 프레임을 주고받는 전송수단.
// inDelay/outDelay 는 USB·버스 지연 흉내 — 주파수응답 위상에 그대로 나타난다.
export class SimTransport {
  constructor(simOpts = {}, { inDelayMs = 1, outDelayMs = 1, lossPct = 0, tickMs = 2 } = {}) {
    this.name = '시뮬레이터';
    this.servo = new SimServo(simOpts);
    this.inDelayMs = inDelayMs;
    this.outDelayMs = outDelayMs;
    this.lossPct = lossPct;
    this.tickMs = tickMs;
    this.onFrame = null;
    this.inQ = [];
    this.outQ = [];
    this.timer = null;
  }

  async open() {
    this.lastT = performance.now();
    this.nextStream = null;
    this.timer = setInterval(() => this._tick(), this.tickMs);
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.inQ = [];
    this.outQ = [];
  }

  _lost() {
    return this.lossPct > 0 && Math.random() * 100 < this.lossPct;
  }

  send(f) {
    if (this._lost()) return;
    this.inQ.push({ at: (f.t ?? performance.now()) + this.inDelayMs, data: f.data });
  }

  _emit(data, tSample) {
    if (this._lost()) return;
    this.outQ.push({ at: tSample + this.outDelayMs, data });
  }

  _tick() {
    const now = performance.now();
    const h = 0.25;
    let t = Math.max(this.lastT, now - 200);
    while (t < now) {
      const t2 = Math.min(now, t + h);
      while (this.inQ.length && this.inQ[0].at <= t2) {
        for (const r of this.servo.handle(this.inQ.shift().data)) this._emit(r, t2 + 0.2);
      }
      this.servo.step((t2 - t) / 1000);
      const per = this.servo.streamPeriodMs();
      if (per) {
        if (this.nextStream == null || this.nextStream < t2 - 200) this.nextStream = t2;
        while (this.nextStream <= t2) {
          this._emit(this.servo.streamFrame(), this.nextStream);
          this.nextStream += per;
        }
      } else {
        this.nextStream = null;
      }
      t = t2;
    }
    this.lastT = now;
    if (!this.outQ.length) return;
    this.outQ.sort((a, b) => a.at - b.at);
    let k = 0;
    while (k < this.outQ.length && this.outQ[k].at <= now) k++;
    const out = this.outQ.splice(0, k);
    for (const o of out) this.onFrame?.({ id: 0, ext: false, data: o.data, t: o.at });
  }
}
