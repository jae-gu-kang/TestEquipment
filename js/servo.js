// 서보 1대와의 요청/응답·이벤트 계층. 전송수단은 { send(frame), onFrame } 만 있으면 된다
// (slcan · 시뮬레이터 · 추후 PEAK/백엔드 WebSocket 브릿지).
import {
  REG, buildWrite, buildRead, parsePayload, decodeValue, COUNTS_PER_DEG, POS_MAX_COUNTS,
} from './protocol.js';

export class TimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; }
}

export class HitecServo {
  constructor(transport, opts = {}) {
    this.transport = transport;
    this.servoId = 0;
    this.canId = 0;
    this.ext = false;
    this.center = 8192;
    this.sign = 1;
    this.configure(opts);
    this.pending = [];
    this.listeners = new Map();
    this.stats = { tx: 0, rx: 0, timeouts: 0, bad: 0 };
    this.lastCmdDeg = null;
    transport.onFrame = (f) => this._rx(f);
  }

  configure({ servoId, canId, ext, center, sign } = {}) {
    if (servoId != null) this.servoId = servoId;
    if (canId != null) this.canId = canId;
    if (ext != null) this.ext = ext;
    if (center != null) this.center = center;
    if (sign != null) this.sign = sign >= 0 ? 1 : -1;
  }

  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev).add(fn);
    return () => this.listeners.get(ev).delete(fn);
  }

  _emit(ev, x) {
    const s = this.listeners.get(ev);
    if (s) for (const fn of s) fn(x);
  }

  degToCounts(deg) {
    const c = Math.round(this.center + this.sign * deg * COUNTS_PER_DEG);
    return Math.min(POS_MAX_COUNTS, Math.max(0, c));
  }

  countsToDeg(c) {
    return this.sign * (c - this.center) / COUNTS_PER_DEG;
  }

  _send(data) {
    const f = { id: this.canId, ext: this.ext, data, t: performance.now() };
    this.transport.send(f);
    this.stats.tx++;
    this._emit('tx', f);
    return f.t;
  }

  write(addr, value) {
    return this._send(buildWrite(this.servoId, addr, value));
  }

  _request(data, addr, timeoutMs) {
    return new Promise((resolve, reject) => {
      const p = { addr, resolve, reject, t0: 0 };
      p.timer = setTimeout(() => {
        this.pending.splice(this.pending.indexOf(p), 1);
        this.stats.timeouts++;
        reject(new TimeoutError(`응답 없음: 0x${addr.toString(16)} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.push(p);
      p.t0 = this._send(data);
    });
  }

  read(addr, timeoutMs = 50) {
    return this._request(buildRead(this.servoId, addr), addr, timeoutMs);
  }

  writeAck(addr, value, timeoutMs = 50) {
    return this._request(buildWrite(this.servoId, addr, value, true), addr, timeoutMs);
  }

  setAngle(deg) {
    const counts = this.degToCounts(deg);
    const t = this.write(REG.POSITION_NEW, counts);
    this.lastCmdDeg = this.countsToDeg(counts);
    this._emit('cmd', { t, deg: this.lastCmdDeg, counts });
    return { t, counts };
  }

  _rx(f) {
    this.stats.rx++;
    this._emit('rx', f);
    const p = parsePayload(f.data);
    if (!p) return;
    if (p.kind === 'bad') { this.stats.bad++; return; }
    if (p.kind !== 'resp') return;
    if (this.servoId !== 0 && p.id !== this.servoId) return;
    for (const [addr, raw] of p.regs) {
      const value = decodeValue(addr, raw);
      const ev = { addr, value, t: f.t, id: p.id };
      this._emit('reg', ev);
      const i = this.pending.findIndex((q) => q.addr === addr);
      if (i >= 0) {
        const [q] = this.pending.splice(i, 1);
        clearTimeout(q.timer);
        q.resolve({ ...ev, rtt: f.t - q.t0 });
      }
    }
  }

  dispose() {
    for (const q of this.pending) { clearTimeout(q.timer); q.reject(new Error('연결 해제')); }
    this.pending = [];
    this.listeners.clear();
  }
}

// 시험 구간 동안 명령각·피드백각(°)을 시간(ms)과 함께 모은다.
export class Recorder {
  constructor(servo, addr = REG.POSITION) {
    this.servo = servo;
    this.addr = addr;
    this.offs = [];
  }

  start() {
    this.stop();
    this.cmd = { t: [], y: [] };
    this.fb = { t: [], y: [] };
    this.offs = [
      this.servo.on('cmd', (e) => { this.cmd.t.push(e.t); this.cmd.y.push(e.deg); }),
      this.servo.on('reg', (e) => {
        if (e.addr === this.addr) { this.fb.t.push(e.t); this.fb.y.push(this.servo.countsToDeg(e.value)); }
      }),
    ];
  }

  stop() {
    for (const off of this.offs) off();
    this.offs = [];
    return { cmd: this.cmd, fb: this.fb };
  }
}
