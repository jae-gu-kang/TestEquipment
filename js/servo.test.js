import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HitecServo, Recorder } from './servo.js';
import { REG, MSG } from './protocol.js';

class FakeTransport {
  constructor() { this.sent = []; this.onFrame = null; }
  send(f) { this.sent.push(f); }
  reply(id, addr, value, t = performance.now(), canId = 0x10) {
    const v = value & 0xFFFF;
    this.onFrame({ id: canId, ext: false, data: Uint8Array.of(MSG.v, id, addr, v & 0xFF, v >> 8), t });
  }
}

test('write: 설정한 CAN ID/확장 여부로 w 프레임 송신', () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 2, canId: 0x123, ext: true });
  s.write(REG.ECHO, 7);
  assert.equal(tr.sent.length, 1);
  assert.equal(tr.sent[0].id, 0x123);
  assert.equal(tr.sent[0].ext, true);
  assert.deepEqual([...tr.sent[0].data], [MSG.w, 2, REG.ECHO, 7, 0]);
});

test('read: 같은 주소의 v 응답으로 해결, 부호 있는 레지스터 해석', async () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 1 });
  const p = s.read(REG.MCU_TEMPER, 100);
  tr.reply(1, REG.POSITION, 100);
  tr.reply(1, REG.MCU_TEMPER, -5);
  const r = await p;
  assert.equal(r.value, -5);
  assert.equal(r.addr, REG.MCU_TEMPER);
});

test('read: 응답 없으면 TimeoutError, 통계 증가', async () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 1 });
  await assert.rejects(s.read(REG.POSITION, 10), { name: 'TimeoutError' });
  assert.equal(s.stats.timeouts, 1);
});

test('ID 필터: 지정 ID면 다른 서보 응답 무시, 0(브로드캐스트)이면 모두 수용', async () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 3 });
  const p = s.read(REG.POSITION, 30);
  tr.reply(5, REG.POSITION, 1);
  await assert.rejects(p, { name: 'TimeoutError' });

  const b = new HitecServo(tr, { servoId: 0 });
  const q = b.read(REG.POSITION, 30);
  tr.reply(5, REG.POSITION, 2);
  assert.equal((await q).value, 2);
});

test('writeAck: x 로 보내고 응답값 반환', async () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 1 });
  const p = s.writeAck(REG.ECHO, 42, 50);
  assert.equal(tr.sent[0].data[0], MSG.x);
  tr.reply(1, REG.ECHO, 42);
  assert.equal((await p).value, 42);
});

test('각도 변환: 중립·방향 부호·범위 제한', () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { center: 8192, sign: 1 });
  assert.equal(s.degToCounts(90), 8192 + 4096);
  assert.equal(s.countsToDeg(8192 - 4096), -90);
  s.configure({ sign: -1 });
  assert.equal(s.degToCounts(90), 8192 - 4096);
  assert.equal(s.degToCounts(1000), 0);
  const { counts } = s.setAngle(10);
  assert.equal(counts, Math.round(8192 - 10 * 4096 / 90));
  assert.deepEqual([...tr.sent.at(-1).data.slice(0, 3)], [MSG.w, 0, REG.POSITION_NEW]);
});

test('Recorder: 명령과 위치 피드백을 각도로 기록', () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, { servoId: 1 });
  const rec = new Recorder(s);
  rec.start();
  s.setAngle(5);
  tr.reply(1, REG.POSITION, 8192 + 4096, 123);
  tr.reply(1, REG.MCU_TEMPER, 30, 124);
  const d = rec.stop();
  s.setAngle(6);
  assert.deepEqual(d.cmd.y, [s.countsToDeg(s.degToCounts(5))]);
  assert.deepEqual(d.fb.t, [123]);
  assert.deepEqual(d.fb.y, [90]);
});

test('dispose: 대기 중 요청 정리', async () => {
  const tr = new FakeTransport();
  const s = new HitecServo(tr, {});
  const p = s.read(REG.POSITION, 1000);
  s.dispose();
  await assert.rejects(p);
});
