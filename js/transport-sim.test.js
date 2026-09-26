import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimServo, SimTransport } from './transport-sim.js';
import { HitecServo } from './servo.js';
import { REG, MSG, buildWrite, buildRead, parsePayload, COUNTS_PER_DEG } from './protocol.js';

const quiet = { noiseCounts: 0 };

function run(sim, sec, dt = 0.00025) {
  const traj = [];
  for (let t = 0; t < sec; t += dt) { sim.step(dt); traj.push(sim.p); }
  return traj;
}

test('SimServo: r 요청에 v 응답, 다른 ID는 무시', () => {
  const s = new SimServo({ ...quiet, id: 1 });
  const [r] = s.handle(buildRead(1, REG.POSITION));
  assert.deepEqual(parsePayload(r).regs, [[REG.POSITION, 8192]]);
  assert.deepEqual(s.handle(buildRead(9, REG.POSITION)), []);
  assert.equal(s.handle(buildRead(0, REG.POSITION)).length, 1);
});

test('SimServo: x 는 쓰고 응답, w 는 응답 없음', () => {
  const s = new SimServo(quiet);
  const [r] = s.handle(buildWrite(1, REG.ECHO, 77, true));
  assert.deepEqual(parsePayload(r).regs, [[REG.ECHO, 77]]);
  assert.deepEqual(s.handle(buildWrite(1, REG.ECHO, 78)), []);
  assert.equal(parsePayload(s.handle(buildRead(1, REG.ECHO))[0]).regs[0][1], 78);
});

test('SimServo: 30° 스텝 — 속도 제한, 작은 오버슈트, 수렴', () => {
  const s = new SimServo(quiet);
  const target = 8192 + 30 * COUNTS_PER_DEG;
  s.handle(buildWrite(1, REG.POSITION_NEW, Math.round(target)));
  const traj = run(s, 1.0);
  const vmax = s.o.vmaxDegS * COUNTS_PER_DEG;
  let maxV = 0;
  for (let i = 1; i < traj.length; i++) maxV = Math.max(maxV, Math.abs(traj[i] - traj[i - 1]) / 0.00025);
  assert.ok(maxV <= vmax * 1.001, `속도 ${maxV} > ${vmax}`);
  const peakDeg = (Math.max(...traj) - target) / COUNTS_PER_DEG;
  assert.ok(peakDeg < 0.5, `오버슈트 ${peakDeg}°`);
  assert.ok(Math.abs(traj.at(-1) - Math.round(target)) / COUNTS_PER_DEG < 0.05);
});

test('SimServo: 서보모드 한계(MDB961WP 스펙 ±60°) 밖 명령은 무시', () => {
  const s = new SimServo(quiet);
  s.handle(buildWrite(1, REG.POSITION_NEW, Math.round(8192 + 70 * COUNTS_PER_DEG)));
  assert.equal(s.regs.get(REG.POSITION_NEW), 8192);
  s.handle(buildWrite(1, REG.POSITION_NEW, Math.round(8192 + 50 * COUNTS_PER_DEG)));
  assert.equal(s.regs.get(REG.POSITION_NEW), Math.round(8192 + 50 * COUNTS_PER_DEG));
});

test('SimServo: 가감속 시간 설정 시 가속 제한', () => {
  const fast = new SimServo(quiet), slow = new SimServo(quiet);
  slow.handle(buildWrite(1, REG.SPEED_UP, 200));
  for (const s of [fast, slow]) s.handle(buildWrite(1, REG.POSITION_NEW, 8192 + 1000));
  run(fast, 0.02); run(slow, 0.02);
  assert.ok(slow.p - 8192 < (fast.p - 8192) * 0.5);
});

test('SimServo: 스트림 주기와 프레임', () => {
  const s = new SimServo(quiet);
  assert.equal(s.streamPeriodMs(), null);
  s.handle(buildWrite(1, REG.STREAM_TIME, 11000));
  s.handle(buildWrite(1, REG.STREAM_MODE, 1));
  assert.equal(s.streamPeriodMs(), 1);
  assert.equal(s.streamFrame()[0], MSG.v);
});

test('SimTransport + HitecServo: 요청/응답과 1kHz 스트림', async () => {
  const tr = new SimTransport(quiet);
  const servo = new HitecServo(tr, { servoId: 1 });
  await tr.open();
  try {
    const v = await servo.read(REG.PRODUCT_NO, 100);
    assert.equal(v.value, 961);
    await servo.writeAck(REG.STREAM_TIME, 11000, 100);
    let n = 0;
    servo.on('reg', (e) => { if (e.addr === REG.POSITION) n++; });
    await servo.writeAck(REG.STREAM_MODE, 1, 100);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(n > 200 && n < 400, `스트림 ${n}개/300ms`);
  } finally {
    await tr.close();
    servo.dispose();
  }
});

test('SimTransport: 손실률 100%면 응답 없음', async () => {
  const tr = new SimTransport(quiet, { lossPct: 100 });
  const servo = new HitecServo(tr, { servoId: 1 });
  await tr.open();
  try {
    await assert.rejects(servo.read(REG.POSITION, 30), { name: 'TimeoutError' });
  } finally {
    await tr.close();
    servo.dispose();
  }
});
