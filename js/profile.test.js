import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, SECTIONS, normalizeProfile, validateProfile, commandExtremes } from './profile.js';

test('기본 프로파일은 유효', () => {
  assert.deepEqual(validateProfile(DEFAULT_PROFILE), []);
});

test('모든 기본값 키가 입력 필드로 노출됨(숨은 기준 없음)', () => {
  for (const [sec, obj] of Object.entries(DEFAULT_PROFILE)) {
    if (typeof obj !== 'object') continue;
    const s = SECTIONS.find((x) => x.key === sec);
    assert.ok(s, `섹션 없음: ${sec}`);
    for (const k of Object.keys(obj)) assert.ok(s.fields.some((f) => f.k === k), `필드 없음: ${sec}.${k}`);
  }
});

test('normalize: 누락 채움, 모르는 키 제거, 타입 변환', () => {
  const p = normalizeProfile({
    name: '시험용',
    comm: { count: '200', addr: '0xC6', junk: 1 },
    square: { overshootUnit: 'pct' },
    general: { upSign: '-1' },
    stair: { returnDown: 'false' },
    extra: {},
  });
  assert.equal(p.name, '시험용');
  assert.equal(p.comm.count, 200);
  assert.equal(p.comm.addr, 0xC6);
  assert.equal(p.comm.timeoutMs, DEFAULT_PROFILE.comm.timeoutMs);
  assert.equal('junk' in p.comm, false);
  assert.equal('extra' in p, false);
  assert.equal(p.square.overshootUnit, 'pct');
  assert.equal(p.general.upSign, -1);
  assert.equal(p.stair.returnDown, false);
});

test('normalize: 숫자로 못 바꾸면 기본값 유지, 원본은 불변', () => {
  const src = { square: { amplitude: 'abc' } };
  const p = normalizeProfile(src);
  assert.equal(p.square.amplitude, DEFAULT_PROFILE.square.amplitude);
  assert.equal(src.square.amplitude, 'abc');
  p.comm.count = 1;
  assert.notEqual(DEFAULT_PROFILE.comm.count, 1);
});

test('validate: 모순된 설정을 잡아냄', () => {
  const bad = normalizeProfile({
    slew: { lowPct: 90, highPct: 10 },
    freq: { freqs: ' , ' },
    square: { amplitude: 0 },
    comm: { count: 0 },
  });
  const errs = validateProfile(bad);
  assert.ok(errs.some((e) => e.includes('10–90')), errs.join('|'));
  assert.ok(errs.some((e) => e.includes('주파수')), errs.join('|'));
  assert.ok(errs.some((e) => e.includes('구형파')), errs.join('|'));
  assert.ok(errs.some((e) => e.includes('통신')), errs.join('|'));
});

test('기본 통신주기: 피드백·명령 모두 100 Hz', () => {
  assert.equal(DEFAULT_PROFILE.general.streamHz, 100);
  assert.equal(DEFAULT_PROFILE.general.cmdRateHz, 100);
});

test('validate: 최대 slew 미분 창은 피드백 주기의 2배 이상', () => {
  const narrow = normalizeProfile({ general: { streamHz: 100 }, slew: { method: 'max', smoothMs: 15 } });
  assert.ok(validateProfile(narrow).some((e) => e.includes('미분 창')), validateProfile(narrow).join('|'));
  const ok = normalizeProfile({ general: { streamHz: 100 }, slew: { method: 'max', smoothMs: 20 } });
  assert.deepEqual(validateProfile(ok), []);
  const avg = normalizeProfile({ general: { streamHz: 100 }, slew: { method: 'avg', smoothMs: 1 } });
  assert.deepEqual(validateProfile(avg), []);
});

test('commandExtremes: 시험별 명령각 최소·최대', () => {
  const ex = commandExtremes(normalizeProfile({ slew: { center: 5, down: 20, up: 30 } }));
  assert.deepEqual(ex.find((x) => x.key === 'slew'), { key: 'slew', name: '최대 각속도', min: -15, max: 35 });
  assert.deepEqual(ex.map((x) => x.key), ['square', 'stair', 'slew', 'freq']);
  const neg = commandExtremes(normalizeProfile({ stair: { start: 10, step: -5, steps: 3 } }));
  assert.deepEqual(neg.find((x) => x.key === 'stair'), { key: 'stair', name: '계단파', min: -5, max: 10 });
});

test('validate: 서보모드 가동범위(±150°) 초과 명령 금지', () => {
  const errs = validateProfile(normalizeProfile({ slew: { up: 200 } }));
  assert.ok(errs.some((e) => e.includes('±150')), errs.join('|'));
});
