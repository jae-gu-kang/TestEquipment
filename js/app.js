// 화면 연결. 점검 로직은 procedures.js, 판정 계산은 analysis.js 에 있다.
import { REG, toHex, describePayload, parsePayload } from './protocol.js';
import { HitecServo } from './servo.js';
import { SimTransport } from './transport-sim.js';
import { SlcanTransport } from './transport-slcan.js';
import { SECTIONS, DEFAULT_PROFILE, normalizeProfile, validateProfile, loadStoredProfile, storeProfile } from './profile.js';
import {
  FeedbackSource, TempMonitor, applySetup, readServoConfig, checkCommandRange, runAuto, AUTO_STEPS,
  runComm, runSquare, runStair, runSlew, runFreq, runTemp,
} from './procedures.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TESTS = [
  { key: 'comm', label: '1 통신', run: runComm },
  { key: 'square', label: '2 구형파', run: runSquare },
  { key: 'stair', label: '3 계단파', run: runStair },
  { key: 'slew', label: '4 최대 각속도', run: runSlew },
  { key: 'freq', label: '5 주파수 응답', run: runFreq },
  { key: 'temp', label: '6 온도', run: (ctx, windowStart) => runTemp(ctx, state.monitor, windowStart) },
];
const TABS = [['manual', '0 수동'], ...TESTS.map((t) => [t.key, t.label]), ['auto', '자동 시험'], ['report', '성적서'], ['settings', '기준 설정'], ['log', 'CAN 로그']];
const COLOR = { cmd: '#0071e3', fb: '#ff9f0a', ref: '#8e8e93', ok: '#28a745', ng: '#ff3b30', teal: '#30b0c7', purple: '#af52de' };

const state = {
  connected: false, connecting: false, running: null, batch: false, estop: false,
  transport: null, servo: null, feedback: null, monitor: null, info: {}, ac: null,
  hiddenDuring: false, tab: 'manual', connectedAt: 0, conn: {}, autoReport: null,
};
const results = {};
const live = { fb: { t: [], y: [] }, cmd: { t: [], y: [] }, fbDeg: null, rate: [] };
const logBuf = [];
const charts = {};
let profile = loadStoredProfile(storage());
let profileErrors = validateProfile(profile);

function storage() {
  try { return window.localStorage; } catch { return null; }
}

function fmt(v, digits) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);
  if (digits != null) return v.toFixed(digits);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 1 : a >= 10 ? 2 : 3);
}

function msg(text, kind = '') {
  const el = $('#connMsg');
  el.textContent = text;
  el.className = 'msg ' + kind;
}

// ─── 탭 · 패널 ───────────────────────────────────────────
function buildTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}">${l}<span class="dot" data-dot="${k}" hidden></span></button>`).join('');
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
}

function showTab(k) {
  state.tab = k;
  $$('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== k; });
  if (k === 'report') renderReport();
  if (k === 'settings') renderSettingsExtras();
  if (k === 'log') renderLog();
  if (k === 'temp') updateTempChart();
}

function buildTestPanels() {
  $('#testPanels').innerHTML = TESTS.map((t) => {
    const sec = SECTIONS.find((s) => s.key === t.key);
    return `
<section class="panel" data-panel="${t.key}" hidden>
  <div class="grid">
    <div class="card"><div class="s-title">${esc(sec.title)} — 시험 조건 · 판정 기준</div><div class="form" data-form="${t.key}"></div></div>
    <div class="card">
      <div class="run-row">
        <button class="btn primary" data-run="${t.key}" disabled>실행</button>
        <button class="btn" data-stop disabled>중지</button>
        <span class="verdict" data-verdict="${t.key}" hidden></span>
      </div>
      <div class="progress"><div class="bar" data-bar="${t.key}"></div></div>
      <div class="prog-text" data-progtext="${t.key}">${t.key === 'temp' ? '온도는 연결 중 항상 수집됩니다. 실행하면 설정 시간 동안의 수신 연속성과 온도를 판정합니다.' : ''}</div>
      <table class="metrics" data-metrics="${t.key}"></table>
      <ul class="warnings" data-warn="${t.key}"></ul>
    </div>
  </div>
  <div class="card" data-chartcard="${t.key}" ${t.key === 'comm' ? 'hidden' : ''}></div>
  <div class="card" data-detail="${t.key}" hidden></div>
</section>`;
  }).join('');
  $('[data-chartcard=temp]').innerHTML = '<div class="s-title">MCU 온도 · 전압 (연결 후 전체)</div><div class="chart-box"><canvas id="tempChart"></canvas></div>';
}

// ─── 프로파일 입력 ───────────────────────────────────────
function fieldInput(sec, f, v) {
  const attr = `data-field="${sec}.${f.k}"`;
  if (f.type === 'select') {
    return `<select ${attr}>${f.options.map(([o, l]) => `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  if (f.type === 'bool') return `<select ${attr}><option value="true" ${v ? 'selected' : ''}>예</option><option value="false" ${v ? '' : 'selected'}>아니오</option></select>`;
  if (f.type === 'hex') return `<input type="text" ${attr} value="0x${v.toString(16).toUpperCase()}">`;
  if (f.type === 'text') return `<input type="text" ${attr} value="${esc(v)}">`;
  return `<input type="number" step="any" ${attr} value="${v}">`;
}

function fieldLabel(f) {
  if (f.k === 'maxOvershoot') return `${f.label} (${profile.square.overshootUnit === 'pct' ? '%' : '°'})`;
  return f.unit ? `${f.label} (${f.unit})` : f.label;
}

function renderForm(el) {
  const key = el.dataset.form;
  const sec = SECTIONS.find((s) => s.key === key);
  el.innerHTML = sec.fields.map((f) => `
    <label class="field${f.crit ? ' crit' : ''}${f.type === 'text' ? ' wide' : ''}">
      <span>${esc(fieldLabel(f))}</span>
      ${fieldInput(key, f, profile[key][f.k])}
      ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}
    </label>`).join('');
}

function renderAllForms() {
  $$('[data-form]').forEach(renderForm);
  $('#profName').value = profile.name;
}

function setProfile(p) {
  profile = normalizeProfile(p);
  profileErrors = validateProfile(profile);
  storeProfile(storage(), profile);
  state.servo?.configure({ center: profile.general.centerCounts, sign: profile.general.upSign });
  renderBanner();
  renderSettingsExtras();
  updateButtons();
}

function onFieldChange(el) {
  const [sec, k] = el.dataset.field.split('.');
  const next = JSON.parse(JSON.stringify(profile));
  next[sec][k] = el.value;
  setProfile(next);
  $$(`[data-form="${sec}"]`).forEach(renderForm);
  if (sec === 'general' && state.connected && ['feedback', 'streamHz', 'tempPollMs'].includes(k)) {
    $('#profMsg').textContent = '피드백 방식·주기와 온도 조회 주기는 다시 연결하면 적용됩니다.';
  }
}

function renderBanner() {
  const b = $('#profBanner');
  b.hidden = !profileErrors.length;
  b.innerHTML = profileErrors.length ? `기준 설정 오류 — 수정 전까지 시험을 실행할 수 없습니다.<ul>${profileErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
}

function renderSettingsExtras() {
  const rows = SECTIONS.flatMap((s) => s.fields.filter((f) => f.crit).map((f) => {
    const unit = f.k === 'maxOvershoot' ? (profile.square.overshootUnit === 'pct' ? '%' : '°') : f.unit || '';
    return `<tr><td>${esc(s.title)}</td><td>${esc(f.label)}</td><td class="num">${fmt(profile[s.key][f.k])} ${esc(unit)}</td></tr>`;
  }));
  $('#critTable').innerHTML = `<tr><th>항목</th><th>기준</th><th style="text-align:right">값</th></tr>${rows.join('')}`;
  $('#profJson').textContent = JSON.stringify(profile, null, 2);
}

// ─── 버튼 상태 ───────────────────────────────────────────
function updateButtons() {
  const busy = !!state.running || state.batch;
  const canRun = state.connected && !busy && !state.estop && !profileErrors.length;
  $$('[data-run]').forEach((b) => { b.disabled = !canRun; });
  $('#autoStartBtn').disabled = !canRun;
  $('#autoReportBtn').disabled = !state.autoReport;
  $$('[data-stop]').forEach((b) => { b.disabled = !busy; });
  $('#manSend').disabled = !state.connected || busy || state.estop;
  $('#setupBtn').disabled = !state.connected || busy;
  $('#connectBtn').disabled = state.connected || state.connecting;
  $('#disconnectBtn').disabled = !state.connected;
  $('#estopBtn').disabled = !state.connected;
  $('#estopReleaseBtn').disabled = !state.connected || !state.estop;
  for (const id of ['transport', 'bitrate', 'samplePoint', 'servoId', 'canId', 'canExt', 'simLoss']) $('#' + id).disabled = state.connected || state.connecting;
  const pill = $('#connPill');
  if (!state.connected) { pill.className = 'pill off'; pill.textContent = state.connecting ? '연결 중…' : '연결 안 됨'; }
  else if (state.estop) { pill.className = 'pill warn'; pill.textContent = '비상정지'; }
  else { pill.className = 'pill on'; pill.textContent = `연결됨 · ${state.transport.name}${busy ? ' · 시험 중' : ''}`; }
}

function updateDots() {
  for (const t of TESTS) {
    const d = $(`[data-dot="${t.key}"]`);
    const r = results[t.key];
    d.hidden = !r;
    if (r) d.className = 'dot ' + (r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'info');
  }
}

// ─── 연결 ─────────────────────────────────────────────────
function parseCanId(s, ext) {
  const n = Number(String(s).trim());
  const max = ext ? 0x1FFFFFFF : 0x7FF;
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`CAN ID 범위 오류 (0 ~ 0x${max.toString(16).toUpperCase()})`);
  return n;
}

function adapterMsg(kind, kbps, timing) {
  const el = $('#adapterMsg');
  if (kind !== 'slcan') { el.textContent = ''; return; }
  if (!timing || timing.samplePct == null) {
    el.textContent = `CANable ${kbps} kbps · 샘플 포인트: 어댑터 펌웨어 기본값${timing?.confirmed ? '' : ' (어댑터 ACK 없음 — 설정 적용 미확인)'}`;
    el.className = 'msg';
    return;
  }
  const hex = [timing.btr0, timing.btr1].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const off = Math.abs(timing.samplePct - timing.requestedPct) > 1e-9;
  el.textContent = `CANable ${kbps} kbps · 샘플 포인트 ${timing.samplePct.toFixed(1)}% (BTR ${hex}, ${timing.nTq} tq)`
    + (off ? ` — 요청 ${timing.requestedPct}% 는 이 속도에서 불가, 가장 가까운 값` : '')
    + (timing.confirmed ? ' · 어댑터 적용 확인' : ' · 어댑터 ACK 없음 — 적용 미확인');
  el.className = 'msg ' + (off || !timing.confirmed ? 'err' : 'ok');
}

async function connect() {
  const kind = $('#transport').value;
  const ext = $('#canExt').checked;
  let tr = null;
  state.connecting = true;
  updateButtons();
  msg('연결 중…');
  try {
    const canId = parseCanId($('#canId').value, ext);
    const servoId = Math.max(0, Math.min(254, Math.round(Number($('#servoId').value) || 0)));
    const bitrateKbps = Number($('#bitrate').value);
    tr = kind === 'sim' ? new SimTransport({}, { lossPct: Number($('#simLoss').value) || 0 }) : new SlcanTransport();
    tr.onError = (e) => { logBuf.push({ t: performance.now(), dir: 'ERR', text: e.message }); msg(e.message, 'err'); };
    const spSel = $('#samplePoint').value;
    const samplePct = kind === 'slcan' && spSel ? Number(spSel) : null;
    await tr.open({ bitrateKbps, samplePct });
    const timing = tr.timing ?? null;
    adapterMsg(kind, bitrateKbps, timing);
    const servo = new HitecServo(tr, { servoId, canId, ext, center: profile.general.centerCounts, sign: profile.general.upSign });
    Object.assign(state, {
      transport: tr, servo, connected: true, estop: false, connectedAt: performance.now(),
      conn: { kind, bitrateKbps, servoId, canId, ext, samplePct: timing?.samplePct ?? null, timing },
    });
    wireServo(servo);
    try {
      const pn = await servo.read(REG.PRODUCT_NO, 300);
      const ver = await servo.read(REG.VERSION, 300);
      state.info = { product: pn.value, version: ver.value, id: pn.id };
      const c = state.servoCfg = await readServoConfig(servo);
      const lim = c.limitMinDeg != null ? `위치 한계 ${c.limitMinDeg.toFixed(1)}~${c.limitMaxDeg.toFixed(1)}°` : '위치 한계 ?';
      msg(`서보 응답 확인 — 제품번호 ${pn.value}, 버전 0x${ver.value.toString(16).toUpperCase()}, 서보 ID ${pn.id} · `
        + `운전모드 ${c.runMode ?? '?'} · ${lim} · 보레이트 설정 ${c.baudKbps ?? '?'} kbps`
        + (c.warnings.length ? ` ⚠ ${c.warnings.join(' / ')}` : ''), c.warnings.length ? 'err' : 'ok');
    } catch {
      state.info = {};
      state.servoCfg = null;
      msg('서보 응답 없음 — 비트레이트 · 서보 ID · CAN ID · 배선 · 종단저항을 확인하세요 (연결은 유지).', 'err');
    }
    state.feedback = new FeedbackSource(servo, profile.general);
    try { await state.feedback.start(); } catch { msg($('#connMsg').textContent + ' / 스트림 설정 응답 없음', 'err'); }
    state.monitor = new TempMonitor(servo, profile.general.tempPollMs);
    state.monitor.start();
    try {
      const p = await servo.read(REG.POSITION, 300);
      setManual(servo.countsToDeg(p.value), false);
    } catch { /* 피드백은 스트림으로 곧 들어온다 */ }
  } catch (e) {
    msg(e.name === 'NotFoundError' ? '포트 선택이 취소되었습니다.' : e.message, 'err');
    try { await tr?.close(); } catch { /* 열리기 전 실패 */ }
    Object.assign(state, { transport: null, servo: null, connected: false });
  } finally {
    state.connecting = false;
    updateButtons();
  }
}

async function disconnect() {
  state.ac?.abort();
  state.monitor?.stop();
  try { await state.feedback?.stop(); } catch { /* 이미 끊김 */ }
  try { await state.transport?.close(); } catch { /* 이미 끊김 */ }
  state.servo?.dispose();
  Object.assign(state, { transport: null, servo: null, feedback: null, servoCfg: null, connected: false, estop: false });
  live.fbDeg = null;
  updateButtons();
  msg('연결 해제');
}

function wireServo(servo) {
  servo.on('reg', (e) => {
    if (e.addr !== REG.POSITION) return;
    const d = servo.countsToDeg(e.value);
    live.fbDeg = d;
    live.fb.t.push(e.t); live.fb.y.push(d);
    live.rate.push(e.t);
  });
  servo.on('cmd', (e) => { live.cmd.t.push(e.t); live.cmd.y.push(e.deg); });
  servo.on('tx', (f) => pushLog('TX', f));
  servo.on('rx', (f) => pushLog('RX', f));
}

// ─── 수동 명령 ───────────────────────────────────────────
let lastSliderSend = 0;

function setManual(deg, send = true) {
  const lo = state.servoCfg?.limitMinDeg ?? -150, hi = state.servoCfg?.limitMaxDeg ?? 150;
  const d = Math.round(Math.max(lo, Math.min(hi, deg)) * 100) / 100;
  $('#manDeg').value = d;
  $('#manSlider').value = Math.max(-60, Math.min(60, d));
  if (send && state.connected && !state.running && !state.batch && !state.estop) state.servo.setAngle(d);
}

function wireManual() {
  $('#manSend').addEventListener('click', () => setManual(Number($('#manDeg').value) || 0));
  $('#manDeg').addEventListener('keydown', (e) => { if (e.key === 'Enter') setManual(Number(e.target.value) || 0); });
  $('#manSlider').addEventListener('input', (e) => {
    const d = Number(e.target.value);
    $('#manDeg').value = d;
    const now = performance.now();
    if ($('#manLive').checked && now - lastSliderSend > 50) { lastSliderSend = now; setManual(d); }
  });
  $('#manSlider').addEventListener('change', (e) => { if ($('#manLive').checked) setManual(Number(e.target.value)); });
  $$('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.nudge);
    setManual(n === 0 ? 0 : (Number($('#manDeg').value) || 0) + n);
  }));
}

// ─── 시험 실행 ───────────────────────────────────────────
function setProgress(key, frac, text) {
  const bar = $(`[data-bar="${key}"]`);
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  const t = $(`[data-progtext="${key}"]`);
  if (t && text != null) t.textContent = text;
}

async function runTest(key, windowStart) {
  const t = TESTS.find((x) => x.key === key);
  if (profileErrors.length) { showTab('settings'); return null; }
  const rangeErr = checkCommandRange(profile, state.servoCfg, key);
  if (rangeErr.length) { setProgress(key, 0, `실행 불가 — ${rangeErr.join(' / ')}`); return null; }
  state.running = key;
  state.ac = new AbortController();
  state.hiddenDuring = document.hidden;
  updateButtons();
  setProgress(key, 0, '준비 중…');
  const prof = JSON.parse(JSON.stringify(profile));
  try {
    const setupWarn = [];
    if (prof.setup.apply) {
      for (const x of await applySetup(state.servo, prof)) {
        if (!x.ok) setupWarn.push(`시험 전 설정 실패: ${x.name}=${x.value} (${x.error || '되읽기 ' + x.readBack})`);
      }
    }
    const r = await t.run({
      servo: state.servo, profile: prof, signal: state.ac.signal,
      onProgress: (f, txt) => setProgress(key, f, txt),
    }, windowStart);
    r.warnings.unshift(...setupWarn);
    if (state.hiddenDuring) r.warnings.unshift('측정 중 탭이 백그라운드였음 — 브라우저 타이머 지연으로 결과 신뢰도 낮음');
    r.profileName = prof.name;
    results[key] = r;
    setProgress(key, 1, `완료 · ${new Date(r.at).toLocaleTimeString()}`);
    renderResult(key);
    return r;
  } catch (e) {
    setProgress(key, 0, e.name === 'AbortError' ? '중지됨' : `오류: ${e.message}`);
    return null;
  } finally {
    state.running = null;
    state.ac = null;
    updateButtons();
    updateDots();
  }
}

// ─── 자동 시험 ───────────────────────────────────────────
const STEP_STATUS = {
  wait: ['대기', 'info'], run: ['진행 중', 'run'], pass: ['PASS', 'pass'], fail: ['FAIL', 'fail'], info: ['측정', 'info'],
  error: ['오류', 'fail'], skip: ['건너뜀', 'info'], aborted: ['중단', 'fail'],
};
const stepBadge = (s) => { const [t, c] = STEP_STATUS[s] ?? [s, 'info']; return `<span class="badge ${c}">${t}</span>`; };
let autoView = Object.fromEntries(AUTO_STEPS.map((s) => [s.key, { status: 'wait', text: '' }]));

function renderAutoSteps() {
  $('#autoSteps').innerHTML = '<tr><th>단계</th><th>상태</th><th>결과</th><th style="text-align:right">시각</th></tr>'
    + AUTO_STEPS.map((s) => {
      const v = autoView[s.key];
      const text = v.status === 'run' && v.frac != null ? `${Math.round(v.frac * 100)}% · ${v.text}` : v.text;
      return `<tr><td>${esc(s.title)}</td><td>${stepBadge(v.status)}</td><td>${esc(text || '')}</td><td class="num">${v.at ? new Date(v.at).toLocaleTimeString() : ''}</td></tr>`;
    }).join('');
}

function setAutoProgress(frac, text) {
  $('#autoBar').style.width = `${Math.round(frac * 100)}%`;
  $('#autoText').textContent = text;
}

function onAutoEvent(e) {
  const i = AUTO_STEPS.findIndex((s) => s.key === e.key);
  autoView[e.key] = { status: e.status === 'progress' ? 'run' : e.status, text: e.text ?? '', at: e.at, frac: e.frac };
  const frac = e.status === 'progress' ? e.frac ?? 0 : e.status === 'run' ? 0 : 1;
  setAutoProgress((i + frac) / AUTO_STEPS.length, `${AUTO_STEPS[i].title} — ${e.text ?? ''}`);
  if (TESTS.some((t) => t.key === e.key) && (e.status === 'progress' || e.status === 'run')) setProgress(e.key, e.frac ?? 0, `자동 시험 · ${e.text ?? ''}`);
  renderAutoSteps();
}

async function runAutoUI() {
  if (profileErrors.length) { showTab('settings'); return; }
  state.batch = true;
  state.ac = new AbortController();
  state.hiddenDuring = document.hidden;
  for (const k of Object.keys(results)) delete results[k];
  for (const t of TESTS) { clearResult(t.key); setProgress(t.key, 0, ''); }
  state.autoReport = null;
  autoView = Object.fromEntries(AUTO_STEPS.map((s) => [s.key, { status: 'wait', text: '' }]));
  $('#autoVerdict').hidden = true;
  renderAutoSteps();
  setAutoProgress(0, '사전 점검 중…');
  updateButtons();
  updateDots();
  try {
    const rep = await runAuto({
      servo: state.servo, profile: JSON.parse(JSON.stringify(profile)), signal: state.ac.signal, onEvent: onAutoEvent,
    }, state.monitor);
    if (state.hiddenDuring) {
      for (const r of Object.values(rep.results)) r.warnings.unshift('측정 중 탭이 백그라운드였음 — 브라우저 타이머 지연으로 결과 신뢰도 낮음');
    }
    rep.connection = state.conn;
    state.autoReport = rep;
    Object.assign(results, rep.results);
    for (const t of TESTS) {
      if (results[t.key]) { renderResult(t.key); setProgress(t.key, 1, `자동 시험 · ${new Date(results[t.key].at).toLocaleTimeString()}`); }
    }
    const [txt, cls] = rep.aborted ? ['중단 · FAIL', 'fail'] : verdictText(rep.pass);
    const v = $('#autoVerdict');
    v.hidden = false;
    v.className = 'verdict ' + cls;
    v.textContent = txt;
    setAutoProgress(1, `${rep.aborted ? '중지됨' : '완료'} · 소요 ${rep.durationS.toFixed(1)} s — 성적서에 기록했습니다`);
    renderReport();
  } catch (e) {
    setAutoProgress(0, `오류: ${e.message}`);
  } finally {
    state.batch = false;
    state.ac = null;
    updateButtons();
    updateDots();
  }
}

// ─── 결과 표시 (시험 탭 · 성적서 공용) ─────────────────────
const verdictText = (p) => (p === true ? ['PASS', 'pass'] : p === false ? ['FAIL', 'fail'] : ['측정', 'info']);
const badge = (p) => { const [t, c] = verdictText(p); return `<span class="badge ${c}">${t}</span>`; };
const limitText = (m) => m.criterion ?? (m.limit == null ? '' : `${m.op === '<=' ? '≤' : '≥'} ${fmt(m.limit)} ${m.unit}`);
const valueText = (m) => `${m.display ?? fmt(m.value)}${m.unit ? ' ' + m.unit : ''}`;

function metricsHtml(r) {
  return '<tr><th>지표</th><th style="text-align:right">측정값</th><th style="text-align:right">기준</th><th></th></tr>'
    + r.metrics.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${esc(valueText(m))}</td><td class="num">${esc(limitText(m))}</td><td>${m.pass == null ? '' : badge(m.pass)}</td></tr>`).join('');
}

const warningsHtml = (r) => r.warnings.map((w) => `<li>${esc(w)}</li>`).join('');

function tableHtml(head, rows) {
  return `<table><tr>${head.map((h, i) => `<th${i ? ' style="text-align:right"' : ''}>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</table>`;
}

function detailHtml(r) {
  switch (r.key) {
    case 'square': case 'stair':
      return tableHtml(['#', '명령', '오버슈트 (°)', '오버슈트 (%)', '정상상태 오차 (°)', '최종 평균 (°)', '상승시간 (ms)'],
        r.detail.map((d, i) => [i + 1, `${fmt(d.from)} → ${fmt(d.to)}°`, fmt(d.overshootDeg), fmt(d.overshootPct), fmt(d.sse), fmt(d.finalMean), fmt(d.riseMs)]));
    case 'slew':
      return tableHtml(['구간', '명령', `${r.params.lowPct}% 각`, `${r.params.highPct}% 각`, '통과시간 (ms)', '평균 (°/s)', '최대 (°/s)', '구간 샘플'],
        r.detail.map((d) => [d.label, `${fmt(d.from)} → ${fmt(d.to)}°`, fmt(d.loDeg), fmt(d.hiDeg),
          d.tHigh != null ? fmt(d.tHigh - d.tLow) : '—', fmt(d.avg), fmt(d.max), d.nWin]));
    case 'freq':
      return tableHtml(['주파수 (Hz)', '명령 진폭 (°)', '응답 진폭 (°)', '게인 (dB)', '위상 (°)', '명령 갱신 (Hz)', '피드백 샘플'],
        r.bode.map((b) => [fmt(b.f), fmt(b.cmd.amp), fmt(b.fb.amp), fmt(b.gainDb), fmt(b.phaseDeg), fmt(b.cmdRate, 0), b.nFb]));
    case 'pre':
      return r.detail?.length ? tableHtml(['시험 전 설정', '값', '되읽기', '결과'],
        r.detail.map((x) => [x.name, x.value, x.readBack ?? '—', x.ok ? '적용' : esc(x.error || '불일치')])) : '';
    default:
      return '';
  }
}

function renderResult(key) {
  const r = results[key];
  const v = $(`[data-verdict="${key}"]`);
  const [vt, vc] = verdictText(r.pass);
  v.hidden = false;
  v.className = 'verdict ' + vc;
  v.textContent = vt;
  $(`[data-metrics="${key}"]`).innerHTML = metricsHtml(r);
  $(`[data-warn="${key}"]`).innerHTML = warningsHtml(r);
  if (key !== 'temp') {
    const card = $(`[data-chartcard="${key}"]`);
    card.hidden = !renderCharts(r, card, key);
  }
  const det = $(`[data-detail="${key}"]`);
  const html = detailHtml(r);
  det.hidden = !html;
  det.innerHTML = html ? `<div class="s-title">상세</div>${html}` : '';
}

function clearResult(key) {
  $(`[data-verdict="${key}"]`).hidden = true;
  $(`[data-metrics="${key}"]`).innerHTML = '';
  $(`[data-warn="${key}"]`).innerHTML = '';
  $(`[data-detail="${key}"]`).hidden = true;
  if (key !== 'temp') $(`[data-chartcard="${key}"]`).hidden = true;
}

// ─── 그래프 ─────────────────────────────────────────────
function makeChart(id, canvas, config) {
  if (!window.Chart || !canvas) return null;
  charts[id]?.destroy();
  charts[id] = new window.Chart(canvas, config);
  return charts[id];
}

function chartOpts({ xTitle, yTitle, logX = false, y2 = null }) {
  const scales = {
    x: { type: logX ? 'logarithmic' : 'linear', title: { display: true, text: xTitle } },
    y: { title: { display: true, text: yTitle } },
  };
  if (y2) scales.y2 = { position: 'right', title: { display: true, text: y2 }, grid: { drawOnChartArea: false } };
  return {
    animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      decimation: { enabled: true, algorithm: 'lttb', samples: 1000 },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } },
    },
    scales,
  };
}

const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, ...extra });
// Chart.js 의 'before' 가 "이전 값을 다음 점까지 유지" (이름과 달리 'after' 는 다음 값을 앞당겨 그림)
const HOLD = { stepped: 'before' };
const refLine = (label, pts, color) => line(label, pts, color, { borderDash: [5, 4], borderWidth: 1 });
const xy = (s, t0, scale = 1000) => s.t.map((t, i) => ({ x: (t - t0) / scale, y: s.y[i] }));

function cmdSteps(series, t0, tEnd) {
  const pts = xy(series.cmd, t0);
  if (pts.length) pts.push({ x: (tEnd - t0) / 1000, y: pts.at(-1).y });
  return pts;
}

function stepChartConfig(series, t0, tEnd) {
  return {
    type: 'line',
    data: { datasets: [
      line('명령', cmdSteps(series, t0, tEnd), COLOR.cmd, HOLD),
      line('피드백', xy(series.fb, t0), COLOR.fb),
    ] },
    options: chartOpts({ xTitle: '시간 (s)', yTitle: '각도 (°)' }),
  };
}

// 결과 r 의 그래프를 box 안에 그린다. 그릴 게 없으면 false.
function renderCharts(r, box, prefix) {
  if (r.key === 'square' || r.key === 'stair') {
    box.innerHTML = '<div class="chart-box"><canvas></canvas></div>';
    makeChart(prefix, $('canvas', box), stepChartConfig(r.series, r.detail[0].t0 - 200, r.detail.at(-1).t1));
    return true;
  }
  if (r.key === 'slew') {
    box.innerHTML = '<div class="chart-box"><canvas data-c="all"></canvas></div><div class="chart-grid"><div class="chart-box small"><canvas data-c="0"></canvas></div><div class="chart-box small"><canvas data-c="1"></canvas></div></div>';
    const t0 = r.series.cmd.t[0] - 200;
    makeChart(prefix, $('[data-c=all]', box), stepChartConfig(r.series, t0, r.series.fb.t.at(-1) ?? t0));
    r.detail.forEach((d, i) => {
      if (d.tLow == null || d.tHigh == null) return;
      const a = d.tLow - 40, b = d.tHigh + 40;
      const pts = [];
      r.series.fb.t.forEach((t, j) => { if (t >= a && t <= b) pts.push({ x: t - d.t0, y: r.series.fb.y[j] }); });
      const x0 = a - d.t0, x1 = b - d.t0;
      const o = chartOpts({ xTitle: `명령 후 시간 (ms) — ${d.label}`, yTitle: '각도 (°)' });
      o.plugins.decimation.enabled = false;
      makeChart(`${prefix}-${i}`, $(`[data-c="${i}"]`, box), {
        type: 'line',
        data: { datasets: [
          line('피드백', pts, COLOR.fb, { pointRadius: 1.5 }),
          refLine(`${r.params.lowPct}%`, [{ x: x0, y: d.loDeg }, { x: x1, y: d.loDeg }], COLOR.ref),
          refLine(`${r.params.highPct}%`, [{ x: x0, y: d.hiDeg }, { x: x1, y: d.hiDeg }], COLOR.purple),
        ] },
        options: o,
      });
    });
    return true;
  }
  if (r.key === 'freq') {
    box.innerHTML = '<div class="chart-grid" style="margin-top:0"><div class="chart-box"><canvas data-c="g"></canvas></div><div class="chart-box"><canvas data-c="p"></canvas></div></div>';
    const fs = r.bode.map((b) => b.f);
    const fMin = fs[0], fMax = fs.at(-1);
    const g = r.bode.map((b) => ({ x: b.f, y: b.gainDb }));
    const p = r.bode.map((b) => ({ x: b.f, y: b.phaseDeg }));
    const vline = (ys) => [{ x: r.params.minBw, y: Math.min(...ys) }, { x: r.params.minBw, y: Math.max(...ys) }];
    const opt = (yTitle) => { const o = chartOpts({ xTitle: '주파수 (Hz)', yTitle, logX: true }); o.plugins.decimation.enabled = false; return o; };
    makeChart(`${prefix}-g`, $('[data-c=g]', box), {
      type: 'line',
      data: { datasets: [
        line('게인', g, COLOR.teal, { pointRadius: 3 }),
        refLine('-3 dB', [{ x: fMin, y: -3 }, { x: fMax, y: -3 }], COLOR.ng),
        refLine('필요 대역폭', vline([...g.map((q) => q.y), -3, 1]), COLOR.ref),
      ] },
      options: opt('게인 (dB)'),
    });
    makeChart(`${prefix}-p`, $('[data-c=p]', box), {
      type: 'line',
      data: { datasets: [
        line('위상', p, COLOR.purple, { pointRadius: 3 }),
        refLine('-90°', [{ x: fMin, y: -90 }, { x: fMax, y: -90 }], COLOR.ng),
        refLine('필요 대역폭', vline([...p.map((q) => q.y), -90, 0]), COLOR.ref),
      ] },
      options: opt('위상 (°)'),
    });
    return true;
  }
  if (r.key === 'temp' && r.series?.temp.t.length) {
    box.innerHTML = '<div class="chart-box small"><canvas></canvas></div>';
    makeChart(prefix, $('canvas', box), {
      type: 'line',
      data: { datasets: [
        line('MCU 온도 (℃)', xy(r.series.temp, r.window.t0), COLOR.ng, { pointRadius: 2 }),
        line('전압 (V)', xy(r.series.volt, r.window.t0), COLOR.cmd, { yAxisID: 'y2', pointRadius: 2 }),
      ] },
      options: chartOpts({ xTitle: '평가 구간 시간 (s)', yTitle: '온도 (℃)', y2: '전압 (V)' }),
    });
    return true;
  }
  box.innerHTML = '';
  return false;
}

function initLiveCharts() {
  makeChart('manual', $('#manChart'), {
    type: 'line',
    data: { datasets: [line('명령', [], COLOR.cmd, HOLD), line('피드백', [], COLOR.fb)] },
    options: (() => { const o = chartOpts({ xTitle: '시간 (s, 현재 = 0)', yTitle: '각도 (°)' }); o.scales.x.min = -10; o.scales.x.max = 0; return o; })(),
  });
  makeChart('temp', $('#tempChart'), {
    type: 'line',
    data: { datasets: [line('MCU 온도 (℃)', [], COLOR.ng), line('전압 (V)', [], COLOR.cmd, { yAxisID: 'y2' })] },
    options: chartOpts({ xTitle: '연결 후 시간 (s)', yTitle: '온도 (℃)', y2: '전압 (V)' }),
  });
}

function updateManualChart(now) {
  const c = charts.manual;
  if (!c) return;
  const cmd = xy(live.cmd, now);
  if (cmd.length) cmd.push({ x: 0, y: cmd.at(-1).y });
  c.data.datasets[0].data = cmd;
  c.data.datasets[1].data = xy(live.fb, now);
  c.update('none');
}

function updateTempChart() {
  const c = charts.temp, m = state.monitor;
  if (!c || !m) return;
  c.data.datasets[0].data = xy(m.temp, state.connectedAt);
  c.data.datasets[1].data = xy(m.volt, state.connectedAt);
  c.update('none');
}

// ─── 실시간 표시 ─────────────────────────────────────────
const FLAG_BITS = [[8, '위치↓'], [9, '위치↑'], [10, '온도↓'], [11, '온도↑'], [13, '전압↓'], [14, '전압↑']];

function trim(s, cut, keepLast = false) {
  let k = 0;
  while (k < s.t.length && s.t[k] < cut) k++;
  if (keepLast) k = Math.min(k, s.t.length - 1);
  if (k > 0) { s.t.splice(0, k); s.y.splice(0, k); }
}

let tick = 0;
function liveTick() {
  tick++;
  const now = performance.now();
  trim(live.fb, now - 12000);
  // 명령은 드물게 바뀌므로 마지막 한 점은 창 밖이어도 남겨 현재 명령선을 그린다
  trim(live.cmd, now - 12000, true);
  while (live.rate.length && live.rate[0] < now - 1000) live.rate.shift();
  const cmd = state.servo?.lastCmdDeg, fb = live.fbDeg;
  const deg = (v) => (v == null ? '—' : `${v.toFixed(2)}<small>°</small>`);
  $('#lvCmd').innerHTML = deg(cmd);
  $('#lvFb').innerHTML = deg(fb);
  $('#lvErr').innerHTML = cmd != null && fb != null ? deg(cmd - fb) : '—';
  $('#manFb').textContent = fb == null ? '—' : `${fb.toFixed(2)}°`;
  $('#manErr').textContent = cmd != null && fb != null ? `${(cmd - fb).toFixed(2)}°` : '—';
  $('#lvRate').innerHTML = state.connected ? `${live.rate.length}<small>Hz</small>` : '—';
  const m = state.monitor;
  const lt = state.connected ? m?.lastTemp() : null;
  $('#lvTemp').innerHTML = lt ? `${lt.value}<small>℃</small>` : '—';
  const stale = state.connected && m && now - (lt?.t ?? m.startedAt) > profile.temp.maxGapS * 1000;
  $('#lvTempTile').classList.toggle('alarm', !!stale || (lt && lt.value > profile.temp.maxTempC));
  const lv = state.connected ? m?.lastVolt() : null;
  $('#lvVolt').innerHTML = lv == null ? '—' : `${lv.toFixed(2)}<small>V</small>`;
  const flags = state.connected ? m?.flags : null;
  const fl = flags == null ? '—' : FLAG_BITS.filter(([b]) => flags & (1 << b)).map(([, n]) => n).join(' ') || 'OK';
  $('#lvFlags').textContent = fl;
  $('#lvFlagsTile').classList.toggle('alarm', flags != null && fl !== 'OK');
  if (state.tab === 'manual') updateManualChart(now);
  if (state.tab === 'temp' && tick % 10 === 0) updateTempChart();
  if (state.tab === 'log' && tick % 3 === 0) renderLog();
}

// ─── CAN 로그 ────────────────────────────────────────────
function pushLog(dir, f) {
  if ($('#logPause').checked) return;
  logBuf.push({ t: f.t, dir, id: f.id, ext: f.ext, data: f.data });
  if (logBuf.length > 6000) logBuf.splice(0, logBuf.length - 3000);
}

function isPositionResp(data) {
  const p = parsePayload(data);
  return p && p.kind === 'resp' && p.regs.length === 1 && p.regs[0][0] === REG.POSITION;
}

function renderLog() {
  const hide = $('#logHideStream').checked;
  const lines = [];
  for (let i = logBuf.length - 1; i >= 0 && lines.length < 400; i--) {
    const e = logBuf[i];
    if (e.dir === 'ERR') { lines.push(`${(e.t / 1000).toFixed(3).padStart(10)}  ERR  ${e.text}`); continue; }
    if (hide && e.dir === 'RX' && isPositionResp(e.data)) continue;
    const id = e.ext ? e.id.toString(16).toUpperCase().padStart(8, '0') : e.id.toString(16).toUpperCase().padStart(3, '0');
    lines.push(`${(e.t / 1000).toFixed(3).padStart(10)}  ${e.dir}  ${id.padEnd(8)}  [${e.data.length}] ${toHex(e.data).padEnd(24)}  ${describePayload(e.data)}`);
  }
  const view = $('#logView');
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
  view.textContent = lines.reverse().join('\n');
  if (atBottom) view.scrollTop = view.scrollHeight;
  const st = state.servo?.stats;
  $('#logStats').textContent = st ? `송신 ${st.tx} · 수신 ${st.rx} · 타임아웃 ${st.timeouts}${state.transport?.errors ? ` · slcan 오류 ${state.transport.errors}` : ''}` : '';
}

// ─── 성적서 ─────────────────────────────────────────────
function reportItems() {
  return [...(results.pre ? [{ key: 'pre', label: '사전 점검' }] : []), ...TESTS.map((t) => ({ key: t.key, label: t.label }))];
}

// 지금 결과가 전부 마지막 자동 시험의 것인지, 개별 재시험이 섞였는지
function reportSource() {
  const rep = state.autoReport;
  const keys = Object.keys(results);
  const same = keys.filter((k) => rep && results[k] === rep.results[k]).length;
  return { rep, fromAuto: !!rep && keys.length > 0 && same === keys.length, mixed: !!rep && same > 0 && same < keys.length };
}

function overallVerdict() {
  const { rep, fromAuto } = reportSource();
  if (fromAuto) return rep.aborted ? ['FAIL (중단)', 'fail'] : rep.pass ? ['PASS', 'pass'] : ['FAIL', 'fail'];
  const done = TESTS.filter((t) => results[t.key]);
  if (done.some((t) => results[t.key].pass === false) || results.pre?.pass === false) return ['FAIL', 'fail'];
  return done.length === TESTS.length ? ['PASS', 'pass'] : [`미완료 (${done.length}/${TESTS.length})`, ''];
}

function connText(c) {
  if (!c?.kind) return '—';
  const sp = c.kind === 'slcan' ? ` · 샘플 포인트 ${c.samplePct != null ? c.samplePct.toFixed(1) + '%' : '어댑터 기본'}` : '';
  return `${c.kind === 'sim' ? '시뮬레이터' : 'CANable slcan'} · ${c.bitrateKbps} kbps${sp} · CAN ID 0x${c.canId.toString(16).toUpperCase()}${c.ext ? ' (29bit)' : ''}`;
}

function renderReportHead() {
  const [ov, oc] = overallVerdict();
  const { rep, fromAuto, mixed } = reportSource();
  const info = (fromAuto ? rep.servoInfo : state.info) || {};
  const cfg = fromAuto ? rep.servoConfig : state.servoCfg;
  const method = fromAuto ? `자동 시험 (소요 ${rep.durationS.toFixed(1)} s)` : mixed ? '자동 시험 + 개별 재시험' : Object.keys(results).length ? '개별 실행' : '—';
  const when = fromAuto ? `${new Date(rep.startedAt).toLocaleString()} ~ ${new Date(rep.endedAt).toLocaleTimeString()}` : new Date().toLocaleString();
  const head = [
    ['일시', when],
    ['시험 방식', method],
    ['시리얼 번호', $('#repSerial').value || '—'],
    ['작업자', $('#repOperator').value || '—'],
    ['대상', 'Hitec MDB961WP-CAN 28V'],
    ['서보', info.product != null ? `제품 ${info.product} · 버전 0x${info.version.toString(16).toUpperCase()} · ID ${info.id}` : '—'],
    ['서보 설정', cfg ? servoCfgText(cfg) : '—'],
    ['통신', connText(fromAuto ? rep.connection : state.conn)],
    ['기준 프로파일', fromAuto ? rep.profile.name : profile.name],
    ['비고', $('#repNote').value || '—'],
  ];
  $('#repHead').innerHTML = `<div class="overall ${oc}">종합 판정: ${ov}</div>
    <div class="report-head">${head.map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join('')}</div>`;
}

function renderReport() {
  renderReportHead();
  const items = reportItems();
  const summary = items.map(({ key, label }) => {
    const r = results[key];
    if (!r) return `<tr><td>${label}</td><td><span class="badge info">미실시</span></td><td></td><td></td><td></td></tr>`;
    const judged = r.metrics.filter((m) => m.pass != null);
    const shown = judged.length ? judged : r.metrics.slice(0, 2);
    return `<tr><td>${label}</td><td>${badge(r.pass)}</td>
      <td>${shown.map((m) => `${esc(m.name)} ${esc(valueText(m))}`).join('<br>')}</td>
      <td>${shown.map((m) => esc(limitText(m)) || '측정만').join('<br>')}</td>
      <td>${new Date(r.at).toLocaleTimeString()}${r.warnings.length ? `<br><span class="prog-text">경고 ${r.warnings.length}건</span>` : ''}</td></tr>`;
  }).join('');
  const details = items.filter(({ key }) => results[key]).map(({ key, label }) => {
    const r = results[key];
    const det = detailHtml(r);
    return `<section class="rep-item">
      <h3>${label} ${badge(r.pass)}</h3>
      <table class="metrics">${metricsHtml(r)}</table>
      ${r.warnings.length ? `<ul class="warnings">${warningsHtml(r)}</ul>` : ''}
      <div class="rep-charts" data-repchart="${key}"></div>
      ${det ? `<div class="rep-detail">${det}</div>` : ''}
    </section>`;
  }).join('');
  const { rep, fromAuto } = reportSource();
  const log = fromAuto ? `<h2 class="rep-h2">자동 시험 실행 내역</h2>
    <table><tr><th>시각</th><th>단계</th><th>상태</th><th>내용</th></tr>${rep.steps.map((s) => `<tr><td class="num" style="text-align:left">${new Date(s.at).toLocaleTimeString()}</td><td>${esc(s.title)}</td><td>${stepBadge(s.status)}</td><td>${esc(s.text || '')}</td></tr>`).join('')}</table>` : '';
  $('#repBody').innerHTML = `
    <h2 class="rep-h2">요약</h2>
    <table><tr><th>항목</th><th>판정</th><th>측정값</th><th>기준</th><th>시각</th></tr>${summary}</table>
    ${details ? `<h2 class="rep-h2">항목별 상세</h2>${details}` : ''}
    ${log}`;
  for (const { key } of items) {
    const box = $(`[data-repchart="${key}"]`);
    if (box && !renderCharts(results[key], box, 'rep-' + key)) box.remove();
  }
}

function servoCfgText(c) {
  const lim = c.limitMinDeg != null ? `${c.limitMinDeg.toFixed(1)}~${c.limitMaxDeg.toFixed(1)}°` : '?';
  return `운전모드 ${c.runMode ?? '?'} · 한계 ${lim} · VELOCITY_MAX ${c.velocityMax ?? '?'} · TORQUE_MAX ${c.torqueMax ?? '?'} · INERTIA ${c.inertiaRange ?? '?'}`;
}

function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const fileBase = () => `점검_${($('#repSerial').value || 'NA').replace(/[^\w가-힣-]/g, '_')}_${stamp()}`;

function exportJson() {
  const { rep, fromAuto, mixed } = reportSource();
  const [overall] = overallVerdict();
  const out = {
    app: '작동기 점검장비', format: 2, exportedAt: new Date().toISOString(), overall,
    meta: {
      serial: $('#repSerial').value, operator: $('#repOperator').value, note: $('#repNote').value,
      connection: state.conn, servo: state.info, servoConfig: state.servoCfg,
    },
    auto: rep && (fromAuto || mixed) ? {
      startedAt: rep.startedAt, endedAt: rep.endedAt, durationS: rep.durationS, pass: rep.pass, aborted: rep.aborted,
      steps: rep.steps, profile: rep.profile, servoConfig: rep.servoConfig,
    } : null,
    profile, results,
  };
  download(fileBase() + '.json', JSON.stringify(out), 'application/json');
}

function exportCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['항목', '지표', '측정값', '단위', '기준', '판정', '시각'].map(q).join(',')];
  for (const { key, label } of reportItems()) {
    const r = results[key];
    if (!r) continue;
    for (const m of r.metrics) {
      rows.push([label, m.name, m.display ?? (m.value ?? ''), m.unit, limitText(m), m.pass == null ? '' : m.pass ? 'PASS' : 'FAIL', r.at].map(q).join(','));
    }
  }
  rows.push(['종합', '', overallVerdict()[0], '', '', '', new Date().toISOString()].map(q).join(','));
  download(fileBase() + '.csv', '﻿' + rows.join('\n'), 'text/csv');
}

// ─── 프로파일 관리 ───────────────────────────────────────
function wireSettings() {
  $('#profName').addEventListener('change', (e) => setProfile({ ...profile, name: e.target.value }));
  $('#profExport').addEventListener('click', () => download(`점검기준_${profile.name.replace(/[^\w가-힣-]/g, '_')}.json`, JSON.stringify(profile, null, 2), 'application/json'));
  $('#profImport').addEventListener('click', () => $('#profFile').click());
  $('#profFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      setProfile(JSON.parse(await f.text()));
      renderAllForms();
      $('#profMsg').textContent = `불러옴: ${f.name}${profileErrors.length ? ' — 오류가 있어 확인 필요' : ''}`;
    } catch (err) {
      $('#profMsg').textContent = `불러오기 실패: ${err.message}`;
    }
  });
  let armed = 0;
  $('#profReset').addEventListener('click', (e) => {
    if (performance.now() - armed > 3000) {
      armed = performance.now();
      e.target.textContent = '한 번 더 누르면 초기화';
      setTimeout(() => { e.target.textContent = '기본값으로'; }, 3000);
      return;
    }
    armed = 0;
    e.target.textContent = '기본값으로';
    setProfile(DEFAULT_PROFILE);
    renderAllForms();
    $('#profMsg').textContent = '기본값으로 초기화했습니다.';
  });
}

// ─── 초기화 ─────────────────────────────────────────────
function init() {
  buildTabs();
  buildTestPanels();
  renderAllForms();
  renderBanner();
  initLiveCharts();
  wireManual();
  wireSettings();

  if (!SlcanTransport.supported()) {
    const o = $('#transport option[value=slcan]');
    o.disabled = true;
    o.textContent += ' — 이 브라우저 미지원';
  }
  const syncSim = () => { $('#simLossField').hidden = $('#transport').value !== 'sim'; };
  $('#transport').addEventListener('change', syncSim);
  syncSim();

  document.addEventListener('change', (e) => { const el = e.target.closest('[data-field]'); if (el) onFieldChange(el); });
  document.addEventListener('click', (e) => {
    const run = e.target.closest('[data-run]');
    if (run) runTest(run.dataset.run);
    if (e.target.closest('[data-stop]')) state.ac?.abort();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (state.running || state.batch)) state.hiddenDuring = true; });

  $('#connectBtn').addEventListener('click', connect);
  $('#disconnectBtn').addEventListener('click', disconnect);
  $('#setupBtn').addEventListener('click', async () => {
    const log = await applySetup(state.servo, profile);
    const bad = log.filter((x) => !x.ok);
    msg(bad.length ? `설정 실패: ${bad.map((x) => x.name).join(', ')}` : `적용됨: ${log.map((x) => `${x.name}=${x.value}`).join(', ')}`, bad.length ? 'err' : 'ok');
  });
  $('#estopBtn').addEventListener('click', () => {
    if (!state.servo) return;
    state.ac?.abort();
    state.servo.write(REG.POWER_CONFIG, 1 << 9);
    state.estop = true;
    updateButtons();
    msg('비상정지: POWER_CONFIG = 0x0200 (Motor Free) 전송', 'err');
  });
  $('#estopReleaseBtn').addEventListener('click', () => {
    if (!state.servo) return;
    if (live.fbDeg != null) state.servo.setAngle(live.fbDeg);
    state.servo.write(REG.POWER_CONFIG, 0);
    state.estop = false;
    setManual(live.fbDeg ?? 0, false);
    updateButtons();
    msg('비상정지 해제 — 현재 위치를 명령으로 유지', 'ok');
  });
  $('#autoStartBtn').addEventListener('click', runAutoUI);
  $('#autoReportBtn').addEventListener('click', () => showTab('report'));
  renderAutoSteps();
  $('#exportJsonBtn').addEventListener('click', exportJson);
  $('#exportCsvBtn').addEventListener('click', exportCsv);
  $('#printBtn').addEventListener('click', () => { renderReport(); window.print(); });
  for (const id of ['repSerial', 'repOperator', 'repNote']) $('#' + id).addEventListener('input', renderReportHead);
  $('#logClear').addEventListener('click', () => { logBuf.length = 0; renderLog(); });
  $('#logHideStream').addEventListener('change', renderLog);

  showTab('manual');
  updateButtons();
  setInterval(liveTick, 100);

  window.__stb = {
    ready: true, state, results, live,
    get profile() { return profile; },
    get transport() { return state.transport; },
    setProfile: (p) => { setProfile(p); renderAllForms(); },
  };
}

init();
