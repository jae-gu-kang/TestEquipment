// CANable(slcan 펌웨어) ↔ Chrome/Edge Web Serial.
// 수신 시각은 USB 청크 도착 시각이라 ~1ms 지터가 있다(정밀 타이밍은 추후 백엔드 브릿지에서).
import { BITRATES } from './protocol.js';

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');

export function encodeSlcan({ id, ext, data }) {
  let s = ext ? 'T' + hex(id >>> 0, 8) : 't' + hex(id & 0x7FF, 3);
  s += data.length.toString(16);
  for (const b of data) s += hex(b, 2);
  return s + '\r';
}

// Lawicel 's' 명령은 SJA1000(16MHz 크리스털 → CAN 클록 8MHz) 의 BTR0/BTR1 값을 받는다.
const SJA1000_CLK = 8e6;

// 요청 샘플 포인트(%)에 가장 가까운 비트 타이밍. 같은 오차면 tq 가 많은(분해능 높은) 쪽.
// TSEG2 ≥ 2 tq 제약 때문에 1Mbps 에서는 87.5% 가 불가능하다(최대 75%).
export function btrFor(kbps, samplePct) {
  const ticks = SJA1000_CLK / (kbps * 1000);
  if (!Number.isInteger(ticks)) return null;
  let best = null;
  for (let n = 25; n >= 8; n--) {
    if (ticks % n) continue;
    const brp = ticks / n - 1;
    if (brp > 63) continue;
    for (let tseg1 = 1; tseg1 <= 16; tseg1++) {
      const tseg2 = n - 1 - tseg1;
      if (tseg2 < 2 || tseg2 > 8) continue;
      const sp = (1 + tseg1) / n * 100;
      const err = Math.abs(sp - samplePct);
      if (!best || err < best.err - 1e-9) best = { err, n, brp, tseg1, tseg2, sp };
    }
  }
  if (!best) return null;
  return {
    btr0: best.brp,
    btr1: ((best.tseg2 - 1) << 4) | (best.tseg1 - 1),
    brp: best.brp, tseg1: best.tseg1, tseg2: best.tseg2, nTq: best.n,
    samplePct: best.sp, requestedPct: samplePct,
  };
}

// 샘플 포인트 미지정 → 표준 S코드(어댑터 펌웨어 기본 타이밍), 지정 → s 명령
export function slcanOpenCommands(kbps, samplePct) {
  if (samplePct == null) {
    const br = BITRATES.find((b) => b.kbps === kbps);
    if (!br) throw new Error(`slcan 미지원 속도: ${kbps} kbps`);
    return { cmds: ['C', br.slcan, 'O'], timing: null };
  }
  const t = btrFor(kbps, samplePct);
  if (!t) throw new Error(`${kbps} kbps 에 맞는 비트 타이밍이 없습니다`);
  return { cmds: ['C', 's' + hex(t.btr0, 2) + hex(t.btr1, 2), 'O'], timing: t };
}

const HEX_RE = /^[0-9A-Fa-f]+$/;

export class SlcanParser {
  constructor() { this.buf = ''; }

  // events: 명령 응답 순서('ack' | 'err') — 대기 중인 명령에 순서대로 대응시킨다
  feed(chunk) {
    const frames = [], events = [];
    let errors = 0, acks = 0;
    for (const ch of chunk) {
      if (ch === '\x07') { errors++; events.push('err'); this.buf = ''; continue; }
      if (ch !== '\r') { this.buf += ch; continue; }
      const line = this.buf;
      this.buf = '';
      if (!line || line === 'z' || line === 'Z') { acks++; events.push('ack'); continue; }
      const f = parseLine(line);
      if (f) frames.push(f);
      else if (line[0] === 't' || line[0] === 'T') errors++;
    }
    return { frames, errors, acks, events };
  }
}

function parseLine(line) {
  const ext = line[0] === 'T';
  if (!ext && line[0] !== 't') return null;
  const idLen = ext ? 8 : 3;
  const idStr = line.slice(1, 1 + idLen);
  const dlcStr = line[1 + idLen];
  if (!HEX_RE.test(idStr) || !dlcStr || !/^[0-8]$/.test(dlcStr)) return null;
  const dlc = Number(dlcStr);
  const dataStr = line.slice(2 + idLen, 2 + idLen + 2 * dlc);
  if (dataStr.length !== 2 * dlc || (dlc && !HEX_RE.test(dataStr))) return null;
  const data = new Uint8Array(dlc);
  for (let i = 0; i < dlc; i++) data[i] = parseInt(dataStr.slice(2 * i, 2 * i + 2), 16);
  return { id: parseInt(idStr, 16), ext, data };
}

export class SlcanTransport {
  constructor() {
    this.name = 'CANable (slcan)';
    this.onFrame = null;
    this.onError = null;
    this.errors = 0;
    this.port = null;
    this.pendingCmds = [];
    this.timing = null;
    this.openLog = [];
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async open({ bitrateKbps = 500, samplePct = null } = {}) {
    if (!SlcanTransport.supported()) throw new Error('이 브라우저는 Web Serial 을 지원하지 않습니다 (Chrome/Edge 사용, https 또는 localhost).');
    const { cmds, timing } = slcanOpenCommands(bitrateKbps, samplePct);
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.parser = new SlcanParser();
    this.enc = new TextEncoder();
    this.loop = this._readLoop();
    this.openLog = [];
    for (const c of cmds) {
      const r = await this._cmdAck(c);
      this.openLog.push({ cmd: c, result: r });
      if (c !== 'C' && r === 'error') {
        await this.close();
        throw new Error(c.startsWith('s')
          ? `어댑터가 샘플 포인트 설정('${c}')을 거부했습니다 — 펌웨어가 s 명령을 지원하지 않는 것 같습니다. 샘플 포인트를 "어댑터 기본"으로 두고 연결하세요.`
          : `어댑터가 '${c}' 명령을 거부했습니다`);
      }
    }
    // ACK 를 안 보내는 펌웨어도 있어 timeout 은 실패로 보지 않되 '미확인'으로 남긴다
    const setCmd = this.openLog[1];
    this.timing = timing
      ? { ...timing, confirmed: setCmd.result === 'ok' }
      : { samplePct: null, confirmed: setCmd.result === 'ok' };
  }

  _cmd(s) {
    return this.writer.write(this.enc.encode(s + '\r'));
  }

  _cmdAck(s, timeoutMs = 300) {
    return new Promise((resolve) => {
      const p = { resolve };
      p.timer = setTimeout(() => {
        const i = this.pendingCmds.indexOf(p);
        if (i >= 0) this.pendingCmds.splice(i, 1);
        resolve('timeout');
      }, timeoutMs);
      this.pendingCmds.push(p);
      this._cmd(s).catch(() => { clearTimeout(p.timer); resolve('error'); });
    });
  }

  send(f) {
    this.writer.write(this.enc.encode(encodeSlcan(f))).catch((e) => this.onError?.(e));
  }

  async _readLoop() {
    const dec = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const t = performance.now();
        const { frames, errors, events } = this.parser.feed(dec.decode(value, { stream: true }));
        let stray = errors;
        for (const ev of events) {
          const p = this.pendingCmds.shift();
          if (!p) continue;
          clearTimeout(p.timer);
          p.resolve(ev === 'ack' ? 'ok' : 'error');
          if (ev === 'err') stray--;
        }
        if (stray > 0) { this.errors += stray; this.onError?.(new Error(`slcan 오류 응답 ${stray}건`)); }
        for (const f of frames) this.onFrame?.({ ...f, t });
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      this.reader.releaseLock();
    }
  }

  async close() {
    if (!this.port) return;
    try { await this._cmd('C'); } catch { /* 이미 끊긴 포트 */ }
    try { await this.reader?.cancel(); } catch { /* 이미 끊긴 포트 */ }
    await this.loop;
    try { this.writer?.releaseLock(); } catch { /* 이미 해제됨 */ }
    try { await this.port.close(); } catch { /* 이미 닫힘 */ }
    this.port = null;
  }
}
