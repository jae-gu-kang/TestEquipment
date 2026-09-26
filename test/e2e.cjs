#!/usr/bin/env node
/* 점검장비 브라우저 E2E — 시스템 Chrome(헤드리스) + 시뮬레이터
 * 연결 → 수동 명령 → 전체 점검(1→6) → 기준 변경 시 불합격 전환 → 비상정지 → 해제
 * 실행: node test/e2e.cjs   (SHOT_DIR=경로 를 주면 스크린샷 저장)
 * puppeteer-core 는 상위 Actuator/node_modules 의 것을 쓴다. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = process.env.SHOT_DIR;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const results = [];
function check(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'} ${name}${detail ? '  — ' + detail : ''}`);
}

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const SHORT = {
  general: { tempPollMs: 250 },
  comm: { count: 100 },
  square: { amplitude: 10, periodS: 0.6, cycles: 1 },
  stair: { start: -5, step: 5, steps: 2, dwellS: 0.4 },
  slew: { holdS: 0.3 },
  freq: { freqs: '1, 4, 8, 16', settleCycles: 1, measCycles: 3, minMeasS: 0.3 },
  temp: { durationS: 1, maxGapS: 1 },
};

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
    const shot = (n) => SHOT_DIR && page.screenshot({ path: path.join(SHOT_DIR, n + '.png'), fullPage: true });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__stb?.ready, { timeout: 5000 });
    check('페이지 로드·모듈 초기화', true);
    check('Chart.js 로컬 번들 로드', await page.evaluate(() => !!window.Chart));

    await page.evaluate((p) => window.__stb.setProfile(p), SHORT);

    await page.click('#connectBtn');
    await page.waitForFunction(() => window.__stb.state.connected && window.__stb.live.fbDeg != null, { timeout: 5000 });
    const info = await page.evaluate(() => window.__stb.state.info);
    check('시뮬레이터 연결·제품번호 응답', info.product === 961, JSON.stringify(info));

    await page.$eval('#manDeg', (el) => { el.value = '10'; });
    await page.click('#manSend');
    await new Promise((r) => setTimeout(r, 800));
    const fb = await page.evaluate(() => window.__stb.live.fbDeg);
    check('0. 수동 명령 10° → 피드백 추종', Math.abs(fb - 10) < 0.2, `피드백 ${fb?.toFixed(3)}°`);
    await shot('0_manual');

    await page.click('[data-tab=auto]');
    await page.click('#autoStartBtn');
    await page.waitForFunction(() => window.__stb.state.autoReport && !window.__stb.state.batch, { timeout: 120000 });
    const auto = await page.evaluate(() => {
      const r = window.__stb.state.autoReport;
      return { pass: r.pass, aborted: r.aborted, keys: Object.keys(r.results), final: r.steps.filter((s) => s.status !== 'run').map((s) => `${s.key}:${s.status}`) };
    });
    check('자동 시험: 사전 점검 + 6개 항목 수행', auto.keys.join() === 'pre,comm,square,stair,slew,freq,temp', auto.keys.join());
    check('자동 시험: 각 단계 판정', auto.final.every((s) => /:(pass|info)$/.test(s)), auto.final.join(' '));
    check('자동 시험: 종합 PASS', auto.pass === true && !auto.aborted);
    const autoUi = await page.evaluate(() => ({ verdict: document.querySelector('#autoVerdict').textContent, rows: document.querySelectorAll('#autoSteps tr').length }));
    check('자동 시험 탭: 종합 판정·단계표 표시', autoUi.verdict === 'PASS' && autoUi.rows === 8, JSON.stringify(autoUi));
    await shot('6a_auto');

    await page.click('#autoReportBtn');
    const rep = await page.evaluate(() => ({
      visible: !document.querySelector('[data-panel=report]').hidden,
      text: document.querySelector('#reportView').innerText,
      items: document.querySelectorAll('#repBody .rep-item').length,
      charts: [...document.querySelectorAll('#repBody canvas')].filter((c) => c.width > 0).length,
    }));
    check('성적서: 자동 시험 결과로 종합 PASS', rep.visible && /종합 판정: PASS/.test(rep.text) && /자동 시험 \(소요/.test(rep.text));
    check('성적서: 사전 점검 + 6개 항목 상세', rep.items === 7, `${rep.items}개`);
    check('성적서: 항목별 그래프', rep.charts >= 7, `${rep.charts}개`);
    check('성적서: 자동 시험 실행 내역', /자동 시험 실행 내역/.test(rep.text) && /사전 점검/.test(rep.text));
    await shot('7_report');

    for (const k of ['square', 'slew', 'freq', 'temp']) {
      await page.click(`[data-tab=${k}]`);
      await new Promise((r) => setTimeout(r, 300));
      const n = await page.$$eval(`[data-panel=${k}] canvas`, (cs) => cs.filter((c) => c.width > 0 && c.height > 0).length);
      check(`${k} 그래프 렌더`, n > 0, `${n}개`);
      await shot('tab_' + k);
    }

    // 시뮬 오버슈트는 ~0.3° — 허용치를 0.01° 로 조이면 반드시 불합격이어야 한다
    await page.click('[data-tab=square]');
    await page.$eval('[data-field="square.maxOvershoot"]', (el) => {
      el.value = '0.01';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const stored = await page.evaluate(() => window.__stb.profile.square.maxOvershoot);
    check('기준 변경이 프로파일에 반영', stored === 0.01, String(stored));
    await page.click('[data-run=square]');
    await page.waitForFunction(() => !window.__stb.state.running, { timeout: 20000 });
    const r = await page.evaluate(() => ({ pass: window.__stb.results.square.pass, limit: window.__stb.results.square.params.maxOvershoot }));
    check('엄격한 기준으로 재시험 → FAIL, 결과에 당시 기준 기록', r.pass === false && r.limit === 0.01, JSON.stringify(r));
    await page.click('[data-tab=report]');
    const mixed = await page.$eval('#reportView', (el) => el.innerText);
    check('성적서: 개별 재시험이 섞이면 표시하고 종합 FAIL', /자동 시험 \+ 개별 재시험/.test(mixed) && /종합 판정: FAIL/.test(mixed));

    await page.click('#estopBtn');
    await new Promise((r) => setTimeout(r, 100));
    const pc = await page.evaluate(() => window.__stb.transport.servo.regs.get(0x46));
    check('비상정지 → POWER_CONFIG = 0x0200 (Motor Free)', pc === 0x200, String(pc));
    await page.click('#estopReleaseBtn');
    await new Promise((r) => setTimeout(r, 100));
    const pc2 = await page.evaluate(() => window.__stb.transport.servo.regs.get(0x46));
    check('비상정지 해제 → 0', pc2 === 0, String(pc2));

    const cfg = await page.evaluate(() => window.__stb.state.servoCfg);
    check('연결 시 서보 설정 읽기(운전모드·위치 한계)', cfg?.runMode === 1 && Math.abs(cfg.limitMaxDeg - 60) < 0.1, JSON.stringify({ runMode: cfg?.runMode, min: cfg?.limitMinDeg, max: cfg?.limitMaxDeg }));

    await page.click('[data-tab=slew]');
    await page.$eval('[data-field="slew.up"]', (el) => { el.value = '70'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const before = await page.evaluate(() => window.__stb.results.slew.at);
    await page.click('[data-run=slew]');
    await new Promise((r) => setTimeout(r, 200));
    const blocked = await page.$eval('[data-progtext=slew]', (el) => el.textContent);
    const after = await page.evaluate(() => window.__stb.results.slew.at);
    check('위치 한계(±60°) 밖 명령 시험은 실행 차단', /실행 불가/.test(blocked) && before === after, blocked);
    await page.$eval('[data-field="slew.up"]', (el) => { el.value = '30'; el.dispatchEvent(new Event('change', { bubbles: true })); });

    await page.click('[data-tab=manual]');
    await page.$eval('#manDeg', (el) => { el.value = '80'; });
    await page.click('#manSend');
    const clamped = await page.$eval('#manDeg', (el) => Number(el.value));
    check('수동 명령은 서보 위치 한계로 제한', Math.abs(clamped - 60) < 0.1, String(clamped));

    await page.click('[data-tab=log]');
    await new Promise((r) => setTimeout(r, 400));
    const logText = await page.$eval('#logView', (el) => el.textContent);
    check('CAN 로그 표시', /TX/.test(logText) && /RX/.test(logText));

    await page.click('#disconnectBtn');
    await page.waitForFunction(() => !window.__stb.state.connected, { timeout: 5000 });
    check('연결 해제', true);

    check('페이지 오류 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  const ok = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length}/${results.length} ${ok ? '통과' : '실패'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
