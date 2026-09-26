import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSlcan, SlcanParser, btrFor, slcanOpenCommands, SlcanTransport } from './transport-slcan.js';

// Web Serial 흉내: 명령 줄마다 mode 에 따라 ACK('\r') · BEL · 무응답
class FakeSerial {
  constructor(mode) { this.mode = mode; this.lines = []; }
  async requestPort() { this.port = new FakePort(this); return this.port; }
  onLine(line) {
    this.lines.push(line);
    if (this.mode === 'silent' || /^[tT]/.test(line)) return;
    this.port.push(this.mode === 'rejectS' && line[0] === 's' ? '\x07' : '\r');
  }
}

class FakePort {
  constructor(dev) { this.dev = dev; }
  async open() {
    const dec = new TextDecoder();
    this.readable = new ReadableStream({ start: (c) => { this.ctrl = c; }, cancel: () => { this.cancelled = true; } });
    this.writable = new WritableStream({
      write: (chunk) => { for (const l of dec.decode(chunk).split('\r').filter(Boolean)) this.dev.onLine(l); },
    });
  }
  push(s) { if (!this.cancelled) this.ctrl.enqueue(new TextEncoder().encode(s)); }
  async close() { this.closed = true; }
}

function withSerial(mode) {
  const dev = new FakeSerial(mode);
  Object.defineProperty(globalThis.navigator, 'serial', { value: dev, configurable: true });
  return dev;
}

test('encode: 표준(11비트) / 확장(29비트) 프레임', () => {
  assert.equal(encodeSlcan({ id: 0x12, ext: false, data: Uint8Array.of(0x77, 1, 0x1E, 0x00, 0x20) }), 't012577011E0020\r');
  assert.equal(encodeSlcan({ id: 0x1ABCDE, ext: true, data: Uint8Array.of(0x72, 1, 0x0C) }), 'T001ABCDE372010C\r');
});

test('parse: 청크가 임의로 잘려도 프레임 복원', () => {
  const p = new SlcanParser();
  const a = p.feed('t0105760');
  const b = p.feed('10C0020\rT00000123');
  const c = p.feed('2AABB\r');
  assert.equal(a.frames.length, 0);
  assert.equal(b.frames.length, 1);
  assert.deepEqual(b.frames[0], { id: 0x010, ext: false, data: Uint8Array.of(0x76, 0x01, 0x0C, 0x00, 0x20) });
  assert.deepEqual(c.frames[0], { id: 0x123, ext: true, data: Uint8Array.of(0xAA, 0xBB) });
});

test('parse: BEL(0x07)은 오류, 빈 줄·z/Z 는 ACK 로 집계', () => {
  const p = new SlcanParser();
  const r = p.feed('\r\x07z\rZ\r\x07');
  assert.equal(r.frames.length, 0);
  assert.equal(r.errors, 2);
  assert.equal(r.acks, 3);
});

test('btrFor: 87.5% 는 SJA1000 표준 표와 일치', () => {
  const hex = (t) => [t.btr0, t.btr1].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  assert.equal(hex(btrFor(500, 87.5)), '001C');
  assert.equal(hex(btrFor(250, 87.5)), '011C');
  assert.equal(hex(btrFor(125, 87.5)), '031C');
  assert.equal(btrFor(250, 87.5).samplePct, 87.5);
});

test('btrFor: 1Mbps 는 87.5% 불가(TSEG2 ≥ 2) → 가장 가까운 75%', () => {
  const t = btrFor(1000, 87.5);
  assert.equal(t.samplePct, 75);
  assert.deepEqual([t.btr0, t.btr1], [0x00, 0x14]);
});

test('btrFor: 50% — 같은 오차면 tq 가 많은 쪽', () => {
  const t = btrFor(500, 50);
  assert.equal(t.samplePct, 50);
  assert.equal(t.nTq, 16);
  assert.deepEqual([t.btr0, t.btr1], [0x00, 0x76]);
  assert.equal(btrFor(800, 87.5).samplePct, 80);
});

test('slcanOpenCommands: 기본은 S코드, 샘플 포인트 지정 시 s 명령', () => {
  assert.deepEqual(slcanOpenCommands(500, null).cmds, ['C', 'S6', 'O']);
  const r = slcanOpenCommands(250, 87.5);
  assert.deepEqual(r.cmds, ['C', 's011C', 'O']);
  assert.equal(r.timing.samplePct, 87.5);
  assert.throws(() => slcanOpenCommands(750, null), /750/);
});

test('parse: 타임스탬프 꼬리(4 hex)는 무시', () => {
  const p = new SlcanParser();
  const r = p.feed('t0102AABB1F40\r');
  assert.deepEqual([...r.frames[0].data], [0xAA, 0xBB]);
});

test('parse: 깨진 줄은 오류로 집계', () => {
  const p = new SlcanParser();
  const r = p.feed('t01X2AA\rt0103AA\r');
  assert.equal(r.frames.length, 0);
  assert.equal(r.errors, 2);
});

test('open: 샘플 포인트 지정 → s 명령 전송, ACK 로 적용 확인', async () => {
  const dev = withSerial('ok');
  const tr = new SlcanTransport();
  await tr.open({ bitrateKbps: 250, samplePct: 87.5 });
  assert.deepEqual(dev.lines, ['C', 's011C', 'O']);
  assert.equal(tr.timing.samplePct, 87.5);
  assert.equal(tr.timing.confirmed, true);
  await tr.close();
  assert.equal(dev.port.closed, true);
});

test('open: 어댑터가 s 명령을 거부(BEL)하면 연결 실패와 원인 안내', async () => {
  const dev = withSerial('rejectS');
  const tr = new SlcanTransport();
  await assert.rejects(tr.open({ bitrateKbps: 500, samplePct: 50 }), /샘플 포인트/);
  assert.equal(dev.port.closed, true);
});

test('open: ACK 없는 펌웨어는 연결하되 적용 미확인으로 표시', async () => {
  withSerial('silent');
  const tr = new SlcanTransport();
  await tr.open({ bitrateKbps: 500, samplePct: null });
  assert.equal(tr.timing.confirmed, false);
  await tr.close();
});

test('수신 프레임 전달과 송신 인코딩', async () => {
  const dev = withSerial('ok');
  const tr = new SlcanTransport();
  const got = [];
  tr.onFrame = (f) => got.push(f);
  await tr.open({ bitrateKbps: 500 });
  tr.send({ id: 0, ext: false, data: Uint8Array.of(0x72, 1, 0x0C) });
  dev.port.push('t000576010C0020\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dev.lines.at(-1), 't000372010C');
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0].data], [0x76, 0x01, 0x0C, 0x00, 0x20]);
  assert.equal(tr.errors, 0);
  await tr.close();
});
