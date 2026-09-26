#!/usr/bin/env node
/* 작동기 자동점검 브라우저 E2E — 시스템 Chrome(헤드리스) + 시뮬레이터
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    const arrows = await page.$$eval('.portal-arrow', (as) => as.map((a) => `${a.classList.contains('left') ? 'L' : 'R'}:${a.href}`));
    check('순환 화살표: 왼쪽 brain, 오른쪽 jaegukang.com',
      arrows.join() === 'L:https://brain.jaegukang.com/,R:https://jaegukang.com/', arrows.join());

    await page.evaluate((p) => window.__stb.setProfile(p), SHORT);

    const layout = await page.evaluate(() => {
      const hero = document.querySelector('#ringBtn').getBoundingClientRect();
      return {
        firstTab: document.querySelector('#tabs button').dataset.tab,
        autoVisible: !document.querySelector('[data-panel=auto]').hidden,
        heroH: hero.height, heroW: hero.width,
        folds: document.querySelectorAll('details.fold').length,
        openFolds: document.querySelectorAll('details.fold[open]').length,
        segs: document.querySelectorAll('#autoTrack .seg').length,
        ring: { phase: document.querySelector('#ringBtn').dataset.phase, disabled: document.querySelector('#ringBtn').disabled, label: document.querySelector('#ringLabel').textContent },
      };
    });
    check('자동 시험이 첫 탭·기본 화면, 원형 시작 버튼이 크게', layout.firstTab === 'auto' && layout.autoVisible && layout.heroH >= 150 && layout.heroW >= 150, JSON.stringify(layout));
    check('연결 전 원형 버튼은 비활성 "연결 후 시작"', layout.ring.phase === 'idle' && layout.ring.disabled && layout.ring.label === '연결 후 시작', JSON.stringify(layout.ring));
    check('예전 시작·성적서 버튼은 제거', await page.evaluate(() => !document.querySelector('#autoStartBtn') && !document.querySelector('#autoReportBtn')));
    check('설정 섹션은 모두 접힘', layout.folds >= 11 && layout.openFolds === 0, `${layout.openFolds}/${layout.folds} 열림`);
    check('진행 트랙: 7단계', layout.segs === 7);
    const desc = await page.$eval('.hero-desc', (el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }));
    check('자동 시험 설명은 한 줄(1280px)', desc.h < desc.lh * 1.5, JSON.stringify(desc));
    const side = await page.evaluate(() => {
      const r = document.querySelector('.ring-group').getBoundingClientRect(), m = document.querySelector('.viz-main').getBoundingClientRect();
      return { ringRight: r.right, mainLeft: m.left, sameRow: Math.abs((r.top + r.bottom) / 2 - (m.top + m.bottom) / 2) < 60 };
    });
    check('원형 버튼 옆에 진행 통계·트랙이 가로 배치', side.ringRight <= side.mainLeft && side.sameRow, JSON.stringify(side));
    await shot('00_start');

    await page.click('#connectBtn');
    await page.waitForFunction(() => window.__stb.state.connected && window.__stb.live.fbDeg != null, { timeout: 5000 });
    const info = await page.evaluate(() => window.__stb.state.info);
    check('시뮬레이터 연결·제품번호 응답', info.product === 961, JSON.stringify(info));

    await page.click('[data-tab=manual]');
    await page.$eval('#manDeg', (el) => { el.value = '10'; });
    await page.click('#manSend');
    await new Promise((r) => setTimeout(r, 800));
    const fb = await page.evaluate(() => window.__stb.live.fbDeg);
    check('0. 수동 명령 10° → 피드백 추종', Math.abs(fb - 10) < 0.2, `피드백 ${fb?.toFixed(3)}°`);
    await shot('0_manual');

    await page.click('[data-tab=auto]');
    const ready = await page.evaluate(() => ({ disabled: document.querySelector('#ringBtn').disabled, label: document.querySelector('#ringLabel').textContent, hint: document.querySelector('#autoText').textContent }));
    check('연결 후 원형 버튼이 "자동 시험 시작"으로 활성, 안내 문구 갱신', !ready.disabled && ready.label === '자동 시험 시작' && /원을 눌러/.test(ready.hint), JSON.stringify(ready));
    await shot('00b_ready');
    await page.click('#ringBtn');
    const runUi = await page.evaluate(() => ({
      phase: document.querySelector('#ringBtn').dataset.phase, disabled: document.querySelector('#ringBtn').disabled,
      side: document.querySelector('#ringSideBtn').hidden ? null : document.querySelector('#ringSideBtn').dataset.kind,
      focus: document.activeElement?.id,
    }));
    check('진행 중: 원형은 진행률(비활성), 옆 작은 원은 중지(포커스 이동)', runUi.phase === 'run' && runUi.disabled && runUi.side === 'stop' && runUi.focus === 'ringSideBtn', JSON.stringify(runUi));
    if (SHOT_DIR) { await new Promise((r) => setTimeout(r, 3000)); await shot('6_running'); }
    await page.waitForFunction(() => window.__stb.state.autoReport && !window.__stb.state.batch, { timeout: 120000 });
    const auto = await page.evaluate(() => {
      const r = window.__stb.state.autoReport;
      return { pass: r.pass, aborted: r.aborted, keys: Object.keys(r.results), final: r.steps.filter((s) => s.status !== 'run').map((s) => `${s.key}:${s.status}`) };
    });
    check('자동 시험: 사전 점검 + 6개 항목 수행', auto.keys.join() === 'pre,comm,square,stair,slew,freq,temp', auto.keys.join());
    check('자동 시험: 각 단계 판정', auto.final.every((s) => /:(pass|info)$/.test(s)), auto.final.join(' '));
    check('자동 시험: 종합 PASS', auto.pass === true && !auto.aborted);
    const autoUi = await page.evaluate(() => ({
      phase: document.querySelector('#ringBtn').dataset.phase,
      verdict: document.querySelector('#ringPct').textContent,
      label: document.querySelector('#ringLabel').textContent,
      side: document.querySelector('#ringSideBtn').dataset.kind,
      rows: document.querySelectorAll('#autoSteps tr').length,
    }));
    check('완료: 원형에 PASS·"성적서 보기", 작은 원은 다시 시작', autoUi.phase === 'done' && autoUi.verdict === 'PASS'
      && /성적서 보기/.test(autoUi.label) && autoUi.side === 'restart' && autoUi.rows === 8, JSON.stringify(autoUi));
    const viz = await page.evaluate(() => ({
      ringOffset: parseFloat(document.querySelector('#ringFill').style.strokeDashoffset),
      label: document.querySelector('#ringPct').textContent,
      segs: [...document.querySelectorAll('#autoTrack .seg')].map((s) => s.className.replace('seg', '').trim()),
      chip: document.querySelector('#autoChip').hidden ? null : document.querySelector('#autoChip').textContent,
      pass: document.querySelector('#vizPass').textContent,
    }));
    check('전체 진행 그래프: 링 가득·판정 색 채움·칩', Math.abs(viz.ringOffset) < 0.5 && viz.label === 'PASS'
      && viz.segs.every((c) => c === 'pass' || c === 'info') && /PASS/.test(viz.chip ?? ''), JSON.stringify(viz));
    await new Promise((r) => setTimeout(r, 500));
    await shot('6a_auto');

    await page.click('#ringBtn');
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
    await page.click('[data-tab=auto]');
    const back = await page.evaluate(() => ({
      phase: document.querySelector('#ringBtn').dataset.phase,
      label: document.querySelector('#ringLabel').textContent,
      side: document.querySelector('#ringSideBtn').hidden,
      chip: document.querySelector('#autoChip').hidden,
      track: [...document.querySelectorAll('#autoTrack .seg')].filter((s) => /pass|info/.test(s.className)).length,
    }));
    check('성적서를 보고 나면 원이 다시 "자동 시험 시작"(트랙은 직전 결과 유지)', back.phase === 'idle' && back.label === '자동 시험 시작'
      && back.side && back.chip && back.track === 7, JSON.stringify(back));
    await shot('7_report');

    for (const k of ['square', 'slew', 'freq', 'temp']) {
      await page.click(`[data-tab=${k}]`);
      await new Promise((r) => setTimeout(r, 300));
      const n = await page.$$eval(`[data-panel=${k}] canvas`, (cs) => cs.filter((c) => c.width > 0 && c.height > 0).length);
      check(`${k} 그래프 렌더`, n > 0, `${n}개`);
      if (k === 'square') {
        const colors = await page.evaluate(() => {
          const c = window.Chart.getChart(document.querySelector('[data-panel=square] canvas'));
          return c.data.datasets.map((d) => d.borderColor);
        });
        check('차트 색은 CSS 토큰(--chart-*)에서 읽음', colors[0] === '#0071e3' && colors[1] === '#ff9f0a', JSON.stringify(colors));
      }
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
    const es = await page.evaluate(() => ({ label: document.querySelector('#ringLabel').textContent, disabled: document.querySelector('#ringBtn').disabled, hint: document.querySelector('#autoText').textContent }));
    check('비상정지 중 원형은 "비상정지"로 비활성, 해제 안내', es.label === '비상정지' && es.disabled && /비상정지를 해제/.test(es.hint), JSON.stringify(es));
    await page.click('#estopReleaseBtn');
    await new Promise((r) => setTimeout(r, 100));
    const pc2 = await page.evaluate(() => window.__stb.transport.servo.regs.get(0x46));
    check('비상정지 해제 → 0', pc2 === 0, String(pc2));

    const cfg = await page.evaluate(() => window.__stb.state.servoCfg);
    check('연결 시 서보 설정 읽기(운전모드·위치 한계)', cfg?.runMode === 1 && Math.abs(cfg.limitMaxDeg - 60) < 0.1, JSON.stringify({ runMode: cfg?.runMode, min: cfg?.limitMinDeg, max: cfg?.limitMaxDeg }));

    const setField = (f, v) => page.$eval(`[data-field="${f}"]`, (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await page.click('[data-tab=slew]');
    await setField('slew.up', '70');
    const gate = await page.evaluate(() => ({
      banner: document.querySelector('#profBanner').hidden ? '' : document.querySelector('#profBanner').textContent,
      disabled: document.querySelector('[data-run=slew]').disabled,
    }));
    check('작동기 가동범위(±60°) 밖 명령 → 기준 오류로 실행 버튼 비활성', /±60°/.test(gate.banner) && gate.disabled, JSON.stringify(gate));
    // 시뮬레이터는 연결 시점의 작동기 값(±60°)으로 만들어져 있어, 연결 중 기준만 넓히면 서보 쪽 한계 검사를 따로 시험할 수 있다
    await setField('actuator.travelDeg', '90');
    const before = await page.evaluate(() => window.__stb.results.slew.at);
    await page.click('[data-run=slew]');
    await new Promise((r) => setTimeout(r, 200));
    const blocked = await page.$eval('[data-progtext=slew]', (el) => el.textContent);
    const after = await page.evaluate(() => window.__stb.results.slew.at);
    check('기준을 통과해도 서보 실제 한계(±60°) 밖이면 실행 차단', /실행 불가/.test(blocked) && before === after, blocked);
    await setField('slew.up', '30');
    await setField('actuator.travelDeg', '60');

    await page.click('[data-tab=manual]');
    await page.$eval('#manDeg', (el) => { el.value = '80'; });
    await page.click('#manSend');
    const clamped = await page.$eval('#manDeg', (el) => Number(el.value));
    check('수동 명령은 서보 위치 한계로 제한', Math.abs(clamped - 60) < 0.1, String(clamped));

    await page.click('[data-tab=settings]');
    await page.$eval('[data-field="actuator.model"]', (el) => { el.value = 'TEST-X'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const sub = await page.$eval('#appSub', (el) => el.textContent);
    check('작동기 설정 → 제목 반영', /TEST-X/.test(sub), sub);
    await page.$eval('[data-field="actuator.model"]', (el) => { el.value = 'MDB961WP-CAN 28V'; el.dispatchEvent(new Event('change', { bubbles: true })); });

    await page.click('[data-tab=auto]');
    await page.click('#ringBtn');
    await page.waitForFunction(() => window.__stb.state.batch, { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 400));
    await page.click('#ringSideBtn');
    await page.waitForFunction(() => !window.__stb.state.batch, { timeout: 10000 });
    const stopped = await page.evaluate(() => ({ pct: document.querySelector('#ringPct').textContent, aborted: window.__stb.state.autoReport.aborted }));
    check('원으로 시작 → 작은 원으로 중지 → 원형에 "중단"', stopped.pct === '중단' && stopped.aborted === true, JSON.stringify(stopped));
    await page.click('#ringSideBtn');
    const restarted = await page.evaluate(() => ({ batch: window.__stb.state.batch, report: window.__stb.state.autoReport }));
    check('완료 상태의 작은 원(↻)으로 새 자동 시험 시작', restarted.batch === true && restarted.report === null, JSON.stringify(restarted));
    await page.click('#ringSideBtn');
    await page.waitForFunction(() => !window.__stb.state.batch, { timeout: 10000 });
    await page.click('[data-tab=report]');
    await page.click('[data-tab=auto]');
    const viaTab = await page.evaluate(() => document.querySelector('#ringBtn').dataset.phase);
    check('성적서를 탭으로 열어도 원이 시작 버튼으로 복귀', viaTab === 'idle', viaTab);

    await page.click('[data-tab=log]');
    await new Promise((r) => setTimeout(r, 400));
    const logText = await page.$eval('#logView', (el) => el.textContent);
    check('CAN 로그 표시', /TX/.test(logText) && /RX/.test(logText));

    const leaveGuard = () => page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    check('연결 중 페이지 이탈 시 확인(beforeunload)', await leaveGuard() === true);
    await page.click('#disconnectBtn');
    await page.waitForFunction(() => !window.__stb.state.connected, { timeout: 5000 });
    check('연결 해제', true);
    check('연결 해제 후에는 이탈 확인 없음', await leaveGuard() === false);

    const links = await page.$$eval('a[href="guide.html"]', (as) => as.map((a) => a.target));
    check('실제 화면에서 사용 방법 링크 2곳(새 탭)', links.length === 2 && links.every((t) => t === '_blank'), JSON.stringify(links));

    const guide = await browser.newPage();
    await guide.setViewport({ width: 1280, height: 900 });
    guide.on('pageerror', (e) => errors.push('guide pageerror: ' + e.message));
    guide.on('console', (m) => { if (m.type() === 'error') errors.push('guide console: ' + m.text()); });
    await guide.goto(url.replace('index.html', 'guide.html'), { waitUntil: 'load' });
    const g0 = await guide.evaluate(() => ({
      states: document.querySelectorAll('#states .state').length,
      steps: document.querySelectorAll('.steps li').length,
      ringW: document.querySelector('#ringBtn').getBoundingClientRect().width,
      sameCss: [...document.styleSheets].some((ss) => (ss.href || '').endsWith('css/style.css')),
    }));
    check('사용 방법 페이지: 앱과 같은 스타일, 상태 5가지·사용 순서 5단계', g0.states === 5 && g0.steps === 5 && g0.ringW >= 140 && g0.sameCss, JSON.stringify(g0));
    await guide.click('#ringBtn');
    await new Promise((r) => setTimeout(r, SHOT_DIR ? 3000 : 600));
    if (SHOT_DIR) await guide.screenshot({ path: path.join(SHOT_DIR, 'guide.png'), fullPage: true });
    const gRun = await guide.evaluate(() => ({ phase: document.querySelector('#ringBtn').dataset.phase, side: document.querySelector('#sideBtn').dataset.kind, locked: document.querySelector('#optFail').disabled }));
    await guide.click('#sideBtn');
    // 중지 시점에 따라 앞 단계는 끝났을 수 있다: 완료…, 중단 1개, 건너뜀…
    const abortPattern = (cells) => {
      const i = cells.indexOf('중단');
      return i >= 0 && cells.slice(0, i).every((c) => c === 'PASS' || c === '측정') && cells.slice(i + 1).every((c) => c === '건너뜀');
    };
    const gDone = await guide.evaluate(() => ({ phase: document.querySelector('#ringBtn').dataset.phase, pct: document.querySelector('#ringPct').textContent, side: document.querySelector('#sideBtn').dataset.kind }));
    await guide.click('#ringBtn');
    const gRep = await guide.evaluate(() => ({
      phase: document.querySelector('#ringBtn').dataset.phase, report: !document.querySelector('#report').hidden,
      cells: [...document.querySelectorAll('#repTable tr td:nth-child(2)')].map((td) => td.textContent),
    }));
    check('사용 방법 체험: 시작(예시 잠금) → 중지 → 성적서(중단·건너뜀) → 다시 시작 버튼', gRun.phase === 'run' && gRun.side === 'stop' && gRun.locked
      && gDone.phase === 'done' && gDone.pct === '중단' && gDone.side === 'restart'
      && gRep.phase === 'idle' && gRep.report && abortPattern(gRep.cells), JSON.stringify({ gRun, gDone, gRep }));

    await guide.click('#optFail');
    await guide.click('#ringBtn');
    await guide.waitForFunction(() => document.querySelector('#ringBtn').dataset.phase === 'done', { timeout: 15000 });
    const gFail = await guide.evaluate(() => ({
      pct: document.querySelector('#ringPct').textContent, nFail: document.querySelector('#nFail').textContent, side: document.querySelector('#sideBtn').dataset.kind,
    }));
    await guide.click('#ringBtn');
    const gFailRep = await guide.evaluate(() => ({ badge: document.querySelector('#repBadge').className, cells: [...document.querySelectorAll('#repTable tr td:nth-child(2)')].map((td) => td.textContent) }));
    check('사용 방법 체험(FAIL 예시 완주): 종합 FAIL 과 항목 결과가 일치', gFail.pct === 'FAIL' && gFail.nFail === '1' && gFail.side === 'restart'
      && /fail/.test(gFailRep.badge) && gFailRep.cells.filter((c) => c === 'FAIL').length === 1, JSON.stringify({ gFail, gFailRep }));
    await guide.click('#ringBtn');
    await new Promise((r) => setTimeout(r, 300));
    await guide.click('#sideBtn');
    await guide.click('#sideBtn');
    const gRestart = await guide.evaluate(() => document.querySelector('#ringBtn').dataset.phase);
    check('사용 방법 체험: 완료 후 작은 원(↻)으로 다시 시작', gRestart === 'run', gRestart);
    await guide.close();

    check('페이지 오류 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  const ok = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length}/${results.length} ${ok ? '통과' : '실패'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
