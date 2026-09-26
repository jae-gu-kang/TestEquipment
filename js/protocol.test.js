import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REG, MSG, buildWrite, buildRead, buildRead2, parsePayload, decodeValue,
  streamTimeValue, streamPeriodMs, describePayload, COUNTS_PER_DEG,
} from './protocol.js';

test('write: w/x 메시지ID, 리틀엔디안 데이터', () => {
  assert.deepEqual([...buildWrite(1, REG.POSITION_NEW, 8192)], [0x77, 1, 0x1E, 0x00, 0x20]);
  assert.deepEqual([...buildWrite(3, REG.ECHO, 0x1234, true)], [0x78, 3, 0xC6, 0x34, 0x12]);
});

test('write: 음수 값은 16비트 2의 보수로', () => {
  assert.deepEqual([...buildWrite(1, REG.TURN_NEW, -1)], [0x77, 1, 0x24, 0xFF, 0xFF]);
});

test('read: r / R 요청', () => {
  assert.deepEqual([...buildRead(2, REG.POSITION)], [0x72, 2, 0x0C]);
  assert.deepEqual([...buildRead2(2, REG.POSITION, REG.MCU_TEMPER)], [0x52, 2, 0x0C, 0x14]);
});

test('parse: v 응답', () => {
  const p = parsePayload(Uint8Array.of(MSG.v, 5, 0x0C, 0x00, 0x20));
  assert.equal(p.kind, 'resp');
  assert.equal(p.id, 5);
  assert.deepEqual(p.regs, [[0x0C, 8192]]);
});

test('parse: V 응답(2주소)', () => {
  const p = parsePayload(Uint8Array.of(MSG.V, 1, 0x0C, 0x01, 0x00, 0x14, 0x1E, 0x00));
  assert.deepEqual(p.regs, [[0x0C, 1], [0x14, 30]]);
});

test('parse: 구형 0x69 응답은 체크섬 검증', () => {
  const ok = Uint8Array.of(0x69, 1, 0x0C, 2, 0x00, 0x20, (1 + 0x0C + 2 + 0x00 + 0x20) & 0xFF);
  assert.deepEqual(parsePayload(ok).regs, [[0x0C, 8192]]);
  const bad = Uint8Array.of(0x69, 1, 0x0C, 2, 0x00, 0x20, 0x00);
  assert.equal(parsePayload(bad).kind, 'bad');
});

test('parse: 호스트 명령도 해석(시뮬레이터용)', () => {
  assert.deepEqual(parsePayload(buildWrite(1, 0x1E, 100, true)), { kind: 'cmd', msg: 'x', id: 1, regs: [[0x1E, 100]] });
  assert.deepEqual(parsePayload(buildRead(1, 0x14)).regs, [[0x14, null]]);
  assert.equal(parsePayload(Uint8Array.of(0x00, 1)), null);
});

test('decodeValue: 온도·턴카운트는 부호 있음', () => {
  assert.equal(decodeValue(REG.MCU_TEMPER, 0xFFF6), -10);
  assert.equal(decodeValue(REG.POSITION, 0xFFF6), 0xFFF6);
});

test('stream time: Hz 형식(10000+Hz), 범위 밖은 ms 주기', () => {
  assert.equal(streamTimeValue(1000), 11000);
  assert.equal(streamTimeValue(100), 10100);
  assert.equal(streamPeriodMs(11000), 1);
  assert.equal(streamPeriodMs(10100), 10);
  assert.equal(streamPeriodMs(20), 20);
});

test('각도 분해능: 4096 = 90°', () => {
  assert.equal(COUNTS_PER_DEG * 90, 4096);
});

test('describePayload: 로그용 문자열', () => {
  assert.equal(describePayload(Uint8Array.of(MSG.v, 1, 0x14, 0x1E, 0x00)), "'v' id1 MCU_TEMPER=30");
});
