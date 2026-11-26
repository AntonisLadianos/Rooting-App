#!/usr/bin/env node
/*
 * Δοκιμές της εφαρμογής μέσα σε browser (Playwright):  node tests/e2e.js
 * Χωρίς internet: χάρτης, αναζήτηση και διαδρομές απαντιούνται από ψεύτικες υπηρεσίες εδώ.
 * Όλα τα στοιχεία είναι ΦΑΝΤΑΣΤΙΚΑ.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

// ---------- ψεύτικες υπηρεσίες ----------
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function osrm(url) {
  const m = url.match(/\/(table|route)\/v1\/driving\/([^?]+)/);
  const pts = m[2].split(';').map((s) => s.split(',').map(Number));
  if (m[1] === 'table') return { code: 'Ok', durations: pts.map((a) => pts.map((b) => hav(a, b) * 1.3 / 8)) };
  const coords = [], legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], d = hav(a, b) * 1.3;
    for (let k = 0; k < 10; k++) coords.push([a[0] + (b[0] - a[0]) * k / 10, a[1] + (b[1] - a[1]) * k / 10]);
    legs.push({ distance: d, duration: d / 8, steps: [
      { maneuver: { type: 'depart', location: a }, name: 'Δοκιμαστική' },
      { maneuver: { type: 'turn', modifier: 'left', location: [a[0] + (b[0] - a[0]) / 2, a[1] + (b[1] - a[1]) / 2] }, name: 'Φανταστική' },
      { maneuver: { type: 'arrive', location: b }, name: '' }] });
  }
  coords.push(pts[pts.length - 1]);
  const total = legs.reduce((s, l) => s + l.distance, 0);
  return { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: coords }, legs, distance: total, duration: total / 8 }] };
}
const photon = () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [25.14, 35.33] },
  properties: { street: 'Δοκιμαστική', housenumber: '10', city: 'Ηράκλειο', postcode: '71409', countrycode: 'GR', osm_key: 'place', type: 'house' } }] });

// ---------- βοηθητικά ----------
const mk = (id, lat, lng, extra) => Object.assign({ id, label: 'Στάση ' + id + ', Ηράκλειο', orig: 'Στάση ' + id + ', Ηράκλειο', lat, lng, note: '', phone: '690000000' + id.length, exact: true, done: false, pkgs: 1, people: [{ name: 'Πελάτης ' + id, phone: '6900000001', pkgs: 1 }] }, extra || {});
const ROUTE = (ids, legs) => ({ order: ids, legs: legs || ids.map(() => ({ duration: 200, distance: 1500 })), geometry: null, startedAt: Date.now(), origin: { lat: 35.3387, lng: 25.1442 } });
const STOPS = () => [mk('a', 35.3315, 25.1338), mk('b', 35.3246, 25.1227), mk('c', 35.3350, 25.1150)];

let base = '', browser = null, passed = 0, failed = 0;
async function page(state, dev) {
  const ctx = await browser.newContext({ ...devices[dev || 'iPhone 13'], geolocation: { latitude: 35.3387, longitude: 25.1442 }, permissions: ['geolocation'], serviceWorkers: 'block' });
  await ctx.route(/tile\.openstreetmap|nominatim|googleapis|gstatic/, (r) => r.abort());
  await ctx.route(/project-osrm/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(osrm(r.request().url())) }));
  await ctx.route(/photon/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(/%CE%91%CE%BD%CF%8D%CF%80%CE%B1%CF%81%CE%BA%CF%84%CE%B7|Ανύπαρκτη/i.test(r.request().url()) ? { type: 'FeatureCollection', features: [] } : photon()) }));
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Δοκιμή' : undefined));
  if (state) await p.addInitScript((s) => { if (!localStorage.getItem('rooting.v1')) localStorage.setItem('rooting.v1', JSON.stringify(s)); }, state);
  await p.goto(base + '/index.html');
  await p.waitForTimeout(900);
  p.ctx = ctx;
  return p;
}
const settings = (x) => Object.assign({ navApp: 'inapp', serviceMin: 3 }, x || {});
const idle = (p) => p.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 20000 });
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('rooting.v1')));

async function test(name, fn) {
  let p = null;
  try {
    p = await fn();
    if (p && p.errs && p.errs.length) throw new Error('σφάλμα στη σελίδα: ' + p.errs[0]);
    passed++; console.log('✓ ' + name);
  } catch (e) {
    failed++; console.log('✗ ' + name + '\n   ' + String(e.message || e).split('\n')[0]);
  } finally { if (p && p.ctx) await p.ctx.close(); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- δοκιμές ----------
(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();

  await test('Αποτυχία: βγαίνει η μπάρα λόγων, ο λόγος αποθηκεύεται και φαίνεται στη λίστα', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.click('#btnFailNext');
    await p.waitForSelector('#reasonBar:not(.hidden)', { timeout: 3000 });
    await p.click('#reasonBar [data-r="Απών"]');
    const s = await stored(p);
    expect(s.stops.find((x) => x.id === 'a').failReason === 'Απών', 'ο λόγος δεν αποθηκεύτηκε');
    expect(/Απών/.test(await p.textContent('#failStops')), 'ο λόγος δεν φαίνεται στα Αποτυχημένα');
    expect(await p.$eval('#reasonBar', (e) => e.classList.contains('hidden')), 'η μπάρα δεν έκλεισε');
    return p;
  });

  await test('Αποτυχία στην πλοήγηση: οι λόγοι δεν κρύβονται και η «Αναίρεση» της μπάρας γυρίζει πίσω', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.click('#btnNavNext'); await p.waitForTimeout(1500);
    await p.click('#navFailMan'); await p.waitForSelector('#reasonBar:not(.hidden)', { timeout: 3000 }); await p.waitForTimeout(300);
    const covered = await p.evaluate(() => { const t = document.getElementById('toast'), b = document.getElementById('reasonBar').getBoundingClientRect();
      if (t.classList.contains('hidden')) return false; const r = t.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom; });
    expect(!covered, 'μήνυμα καλύπτει τους λόγους');
    expect(/Στάση b/.test(await p.textContent('#navDest')), 'δεν πήγε στην επόμενη');
    await p.click('#reasonBar .rb-undo'); await p.waitForTimeout(1500);
    const a = (await stored(p)).stops.find((x) => x.id === 'a');
    expect(!a.failed && !a.done, 'η αναίρεση δεν επανέφερε τη στάση');
    expect(/Στάση a/.test(await p.textContent('#navDest')), 'η πλοήγηση δεν γύρισε στη στάση');
    return p;
  });

  await test('Αποτυχία: αλλαγή λόγου από το παράθυρο της στάσης, «Άλλο» με δικό σου κείμενο', async () => {
    const p = await page({ stops: [mk('a', 35.33, 25.13, { done: true, failed: true, failReason: 'Απών' })], route: null, settings: settings() });
    await p.click('#failStops li');
    await p.waitForSelector('#mReason');
    await p.click('#mReason [data-r="Άλλο"]');
    await p.waitForTimeout(300);
    expect((await stored(p)).stops[0].failReason === 'Δοκιμή', 'το «Άλλο» δεν κράτησε το κείμενο');
    return p;
  });

  await test('Επαναφορά αποτυχημένης στάσης σβήνει τον λόγο', async () => {
    const p = await page({ stops: [mk('a', 35.33, 25.13, { done: true, failed: true, failReason: 'Κλειστό' })], route: null, settings: settings() });
    await p.click('#failStops li'); await p.waitForSelector('#mDone'); await p.click('#mDone'); await p.waitForTimeout(300);
    const st = (await stored(p)).stops[0];
    expect(!st.failed && !st.failReason, 'ο λόγος έμεινε μετά την επαναφορά');
    return p;
  });

  await test('Πλοήγηση: ξεκινά, «Επαναφορά» μετά από σύρσιμο, άφιξη, ✓ πηγαίνει στην επόμενη', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.click('#btnNavNext'); await p.waitForTimeout(2000);
    expect(await p.evaluate(() => RootingNav.active()), 'η πλοήγηση δεν ξεκίνησε');
    const box = await p.$eval('#map', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
    await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 60, box.y + 40, { steps: 5 }); await p.mouse.up();
    await p.waitForTimeout(200);
    expect(!(await p.$eval('#navRecenter', (e) => e.classList.contains('hidden'))), 'δεν εμφανίστηκε η «Επαναφορά»');
    await p.click('#navRecenter');
    await p.ctx.setGeolocation({ latitude: 35.33152, longitude: 25.13382 }); await p.waitForTimeout(2200);
    expect(/Έφτασες/.test(await p.textContent('#navText')), 'δεν αναγνώρισε την άφιξη');
    await p.click('#navDoneMan'); await p.waitForTimeout(1500);
    expect(/Στάση b/.test(await p.textContent('#navDest')), 'δεν πήγε στην επόμενη στάση');
    return p;
  });

  await test('Φωνή πλοήγησης: μιλάει αμέσως με το πάτημα (ξεκλείδωμα iPhone) και λέει τις στροφές', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.evaluate(() => {
      window.__said = []; window.__order = [];
      const ss = { speaking: false, pending: false, paused: false, speak(u) { window.__said.push(u.text); window.__order.push('speak'); }, cancel() {}, resume() {}, getVoices: () => [] };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => ss });
      // ό,τι γίνεται μετά από await χάνει το «πάτημα»: σημειώνουμε τη σειρά
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => ({ request: () => { window.__order.push('await'); return Promise.resolve({ release() {} }); } }) });
    });
    await p.click('#btnNavNext'); await p.waitForTimeout(2500);
    const r = await p.evaluate(() => ({ said: window.__said, order: window.__order }));
    expect(r.order[0] === 'speak', 'η πρώτη φράση δεν ειπώθηκε πριν από το πρώτο await: ' + JSON.stringify(r.order));
    // πλησιάζουμε τη στάση: πρέπει να ακουστεί οδηγία / άφιξη
    await p.ctx.setGeolocation({ latitude: 35.33152, longitude: 25.13382 }); await p.waitForTimeout(2200);
    const said = await p.evaluate(() => window.__said);
    expect(said.length >= 2 && said.some((t) => /Έφτασες|Σε |Τώρα/.test(t)), 'δεν ειπώθηκαν οδηγίες: ' + JSON.stringify(said));
    return p;
  });

  await test('Φωνή: η οδηγία λέγεται νωρίς, ολόκληρη (με την οδό), και η αμέσως επόμενη στροφή μαζί', async () => {
    // διαδρομή: 300 μ βόρεια → δεξιά στην Οδό Άλφα → 50 μ → αριστερά στην Οδό Βήτα → 400 μ → προορισμός
    const lat0 = 35.3387, lng0 = 25.1442, dLat = (m) => m / 111320, dLng = (m) => m / (111320 * Math.cos(lat0 * Math.PI / 180));
    const P = [[lng0, lat0], [lng0, lat0 + dLat(300)], [lng0 + dLng(50), lat0 + dLat(300)], [lng0 + dLng(50), lat0 + dLat(700)]];
    const dest = mk('a', P[3][1], P[3][0]);
    const p = await page({ stops: [dest, mk('b', 35.3246, 25.1227)], route: ROUTE(['a', 'b']), settings: settings() });
    await p.ctx.route(/project-osrm\.org\/route/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'Ok', routes: [{
      geometry: { type: 'LineString', coordinates: P }, distance: 750, duration: 94, legs: [{ distance: 750, duration: 94, steps: [
        { maneuver: { type: 'depart', location: P[0] }, name: 'Αρχική' },
        { maneuver: { type: 'turn', modifier: 'right', location: P[1] }, name: 'Οδός Άλφα' },
        { maneuver: { type: 'turn', modifier: 'left', location: P[2] }, name: 'Οδός Βήτα' },
        { maneuver: { type: 'arrive', location: P[3] }, name: '' }] }] }] }) }));
    await p.evaluate(() => {
      window.__log = [];
      const ss = { speaking: false, pending: false, paused: false, cur: null, q: [], getVoices: () => [], resume() {},
        cancel() { if (ss.cur) window.__log.push({ cut: ss.cur.text }); ss.q = []; ss.cur = null; ss.speaking = false; },
        speak(u) { ss.q.push(u); ss.next(); },
        next() { if (ss.cur || !ss.q.length) return; const u = ss.cur = ss.q.shift(); ss.speaking = true;
          window.__log.push({ said: u.text, at: document.getElementById('navDist').textContent }); if (u.onstart) u.onstart();
          setTimeout(() => { if (ss.cur !== u) return; ss.cur = null; ss.speaking = false; if (u.onend) u.onend(); ss.next(); }, u.text.length * 45); } };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => ss });
    });
    await p.click('#btnNavNext'); await p.waitForTimeout(1500);
    // «οδήγηση» ανά 15 μ
    const path = [];
    for (let m = 0; m <= 300; m += 15) path.push([lat0 + dLat(m), lng0]);
    for (let m = 15; m <= 50; m += 15) path.push([lat0 + dLat(300), lng0 + dLng(m)]);
    for (let m = 15; m <= 200; m += 15) path.push([lat0 + dLat(300 + m), lng0 + dLng(50)]);
    for (const [la, ln] of path) {
      await p.ctx.setGeolocation({ latitude: la, longitude: ln }); await p.waitForTimeout(450);
      // στα 195 μ (ενώ μιλάει): το GPS «πετάει» 70 μ στο πλάι για λίγο (συμβαίνει ανάμεσα σε κτίρια) → επανυπολογισμός διαδρομής
      if (Math.abs(la - (lat0 + dLat(195))) < 1e-7) {
        for (let k = 0; k < 4; k++) { await p.ctx.setGeolocation({ latitude: la, longitude: lng0 + dLng(70) }); await p.waitForTimeout(450); }
        await p.ctx.setGeolocation({ latitude: la + dLat(5), longitude: ln }); await p.waitForTimeout(200);
      }
    }
    await p.waitForTimeout(1500);
    const log = await p.evaluate(() => window.__log);
    const said = log.filter((x) => x.said);
    const first = said.find((x) => /δεξιά/.test(x.said));
    expect(first && /Οδός Άλφα/.test(first.said), 'η πρώτη οδηγία για τη στροφή δεν έχει την οδό: ' + JSON.stringify(said));
    expect(parseInt(first.at, 10) >= 90, 'η οδηγία ειπώθηκε πολύ αργά (στα ' + first.at + ')');
    expect(said.some((x) => /δεξιά.*αμέσως μετά.*αριστερά/.test(x.said)), 'η κοντινή επόμενη στροφή δεν ειπώθηκε μαζί: ' + JSON.stringify(said));
    expect(!log.some((x) => x.cut), 'κόπηκε φράση στη μέση: ' + JSON.stringify(log));
    return p;
  });

  await test('Φωνή: σωπαίνει όσο μιλάς στο τηλέφωνο και μετά λέει την τρέχουσα οδηγία', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.evaluate(() => {
      window.__said = []; window.__cancels = 0;
      const ss = { speaking: false, pending: false, paused: false, getVoices: () => [], resume() {}, cancel() { window.__cancels++; },
        speak(u) { window.__said.push(u.text); setTimeout(() => u.onend && u.onend(), 50); } };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => ss });
      const as = new EventTarget(); as.state = 'active';
      Object.defineProperty(navigator, 'audioSession', { configurable: true, get: () => as });
      window.__call = (on) => { as.state = on ? 'interrupted' : 'active'; as.dispatchEvent(new Event('statechange')); };
      // AudioContext που μένει «interrupted» μετά την κλήση και περνάει σε «running» μόνο με resume()
      class FakeAC extends EventTarget { constructor() { super(); this.state = 'running'; window.__ac = this; }
        resume() { if (navigator.audioSession.state !== 'interrupted') { this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); } return Promise.reject(new Error('x')); }
        createBuffer() { return { getChannelData: () => new Float32Array(10) }; } createBufferSource() { return { connect() {}, start() {}, stop() {} }; } get sampleRate() { return 10; } get destination() { return {}; } }
      window.AudioContext = FakeAC; window.webkitAudioContext = FakeAC;
      window.__callAC = () => { window.__ac.state = 'interrupted'; window.__ac.dispatchEvent(new Event('statechange')); };
    });
    await p.click('#btnNavNext'); await p.waitForTimeout(2000);
    await p.evaluate(() => { window.__call(true); window.__callAC(); });
    const n0 = await p.evaluate(() => window.__said.length);
    await p.ctx.setGeolocation({ latitude: 35.3360, longitude: 25.1400 }); await p.waitForTimeout(1500);
    await p.ctx.setGeolocation({ latitude: 35.3340, longitude: 25.1370 }); await p.waitForTimeout(1500);
    const inCall = await p.evaluate(() => ({ n: window.__said.length, c: window.__cancels }));
    expect(inCall.n === n0, 'μίλησε μέσα στην κλήση: ' + JSON.stringify(await p.evaluate(() => window.__said.slice(-3))));
    expect(inCall.c >= 1, 'δεν σταμάτησε τη φωνή όταν μπήκε η κλήση');
    // όπως στο iPhone: μετά την κλήση ο ήχος μένει «interrupted» ώσπου η σελίδα να τον ξαναζητήσει (resume)
    await p.evaluate(() => { const as = navigator.audioSession; as.state = 'inactive'; });
    await p.evaluate(() => { window.__resumed = false; });
    await p.waitForTimeout(4000); // χωρίς κανένα πάτημα: πρέπει να το καταλάβει μόνο του
    const after = await p.evaluate(() => window.__said.slice(-1)[0] || '');
    expect(/^Σε \d+/.test(after), 'μετά την κλήση δεν είπε την τρέχουσα οδηγία: ' + after);
    return p;
  });

  await test('Πλοήγηση: αν περάσεις τη διεύθυνση χωρίς ✓, το ζουμ φεύγει και σε ακολουθεί, και στην επιστροφή ξαναφτάνεις', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.click('#btnNavNext'); await p.waitForTimeout(2000);
    await p.ctx.setGeolocation({ latitude: 35.33152, longitude: 25.13382 }); await p.waitForTimeout(2200);
    expect(await p.evaluate(() => RootingNav.arrived()), 'δεν έφτασε');
    // πέρασε 150 μ πιο κάτω
    await p.ctx.setGeolocation({ latitude: 35.3302, longitude: 25.1338 }); await p.waitForTimeout(2500);
    expect(!(await p.evaluate(() => RootingNav.arrived())), 'έμεινε «κολλημένο» στην άφιξη');
    expect(!/Έφτασες/.test(await p.textContent('#navText')), 'το πάνω μήνυμα έμεινε «Έφτασες»');
    expect(!(await p.$eval('.nav-btns', (e) => e.classList.contains('arrived'))), 'το ✓ πάλλεται ακόμα');
    expect(/Στάση a/.test(await p.textContent('#navDest')), 'άλλαξε προορισμό');
    // γύρισε πίσω
    await p.ctx.setGeolocation({ latitude: 35.33152, longitude: 25.13382 }); await p.waitForTimeout(2500);
    expect(await p.evaluate(() => RootingNav.arrived()), 'δεν ξαναέφτασε μετά τον κύκλο');
    return p;
  });

  await test('Πλοήγηση: μετά το ✓ η νέα διαδρομή ζητιέται με την κατεύθυνση που κοιτάει το αυτοκίνητο', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    const urls = [];
    p.on('request', (r) => { if (/osrm.*\/route\//.test(r.url())) urls.push(r.url()); });
    await p.click('#btnNavNext'); await p.waitForTimeout(1500);
    await p.evaluate(() => RootingNav._setLastHeading(275)); // οδηγούσες προς τα δυτικά
    await p.click('#navDoneMan'); await p.waitForTimeout(1800);
    const last = urls[urls.length - 1] || '';
    expect(/bearings=275,60/.test(last), 'η διαδρομή ζητήθηκε χωρίς κατεύθυνση: ' + last.slice(-60));
    return p;
  });

  await test('Πλοήγηση στο πλάι: ο χάρτης δεν κρύβεται από τη στήλη και τα κουμπιά χωράνε', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() }, 'iPhone SE landscape');
    await p.click('#btnNavNext'); await p.waitForTimeout(2000);
    const r = await p.evaluate(() => { const q = (s) => document.querySelector(s).getBoundingClientRect(); const m = q('#map'), nb = q('.nav-bottom'), bt = q('.nav-btns'); return { overlap: m.right > nb.left + 1, btns: bt.bottom <= innerHeight + 0.5 }; });
    expect(!r.overlap, 'ο χάρτης είναι κάτω από τη στήλη');
    expect(r.btns, 'τα κουμπιά βγαίνουν εκτός οθόνης');
    return p;
  });

  await test('Παρατεταμένο πάτημα: η καρτέλα μένει ανοιχτή όταν αφήνεις το δάχτυλο', async () => {
    const p = await page({ stops: [], route: null, settings: settings() });
    const box = await p.$eval('#map', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 80, y: r.y + 150 }; });
    await p.mouse.click(box.x, box.y, { button: 'right' }); await p.waitForTimeout(100);
    await p.mouse.click(box.x, box.y); await p.waitForTimeout(300);
    expect(!!(await p.$('.map-popup')), 'η καρτέλα έκλεισε μόλις άφησες το δάχτυλο');
    return p;
  });

  await test('Καρτέλα στάσης στον χάρτη κλείνει όταν ξεκινάς πλοήγηση', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.evaluate(() => document.querySelector('.pin-next').click()); await p.waitForTimeout(300);
    expect(!!(await p.$('.map-popup')), 'η καρτέλα δεν άνοιξε');
    await p.click('#btnNavNext'); await p.waitForTimeout(1500);
    expect(!(await p.$('.map-popup')), 'η καρτέλα έμεινε ανοιχτή');
    return p;
  });

  await test('Βελτιστοποίηση: «Πρώτα» και «Τελευταία» τηρούνται', async () => {
    const st = STOPS(); st[2].prio = 'first'; st[0].prio = 'last';
    const p = await page({ stops: st, route: null, settings: settings() });
    await p.click('#btnOptimize'); await p.waitForTimeout(300); await idle(p); await p.waitForTimeout(300);
    const o = (await stored(p)).route.order;
    expect(o[0] === 'c' && o[o.length - 1] === 'a', 'λάθος σειρά: ' + o.join(','));
    return p;
  });

  await test('Αναζήτηση στα ολοκληρωμένα: τα πρώτα γράμματα φιλτράρουν παραδομένα και αποτυχημένα', async () => {
    const st = [mk('a', 35.33, 25.13, { done: true, label: 'Κνωσού 45', orig: 'Κνωσού 45' }), mk('b', 35.33, 25.13, { done: true, failed: true, label: 'Ικάρου 50', orig: 'Ικάρου 50' }), mk('c', 35.33, 25.13, { done: true, label: 'Λεωφόρος Κνωσού 172', orig: 'Λεωφόρος Κνωσού 172' })];
    const p = await page({ stops: st, route: null, settings: settings() });
    await p.fill('#doneSearch', 'κνω'); await p.waitForTimeout(150);
    const vis = await p.$$eval('#doneStops > li:not(.hidden), #failStops > li:not(.hidden)', (a) => a.length);
    expect(vis === 2, 'βρέθηκαν ' + vis + ' αντί για 2');
    return p;
  });

  await test('Αλλαγή σειράς με σύρσιμο από τη λαβή (με και χωρίς δρομολόγιο), η στάση δεν ανοίγει', async () => {
    const st = [mk('a', 35.33, 25.13), mk('b', 35.331, 25.131), mk('c', 35.332, 25.132), mk('d', 35.333, 25.133)];
    st[0].done = true;
    const p = await page({ stops: st, route: ROUTE(['a', 'b', 'c', 'd']), settings: settings() });
    await p.evaluate(() => { document.getElementById('sheet') && document.getElementById('stops').scrollIntoView(); });
    await p.waitForTimeout(400);
    expect(!(await p.$('#mUp')), 'έμειναν τα κουμπιά Πάνω/Κάτω');
    const h = await p.$$eval('#stops .drag-h', (a) => a.map((x) => { const r = x.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    expect(h.length === 3, 'βρέθηκαν ' + h.length + ' λαβές αντί για 3');
    // σύρε την τελευταία (d) στην κορυφή
    await p.mouse.move(h[2].x, h[2].y); await p.mouse.down();
    for (let k = 1; k <= 12; k++) { await p.mouse.move(h[2].x, h[2].y + (h[0].y - h[2].y - 10) * k / 12); await p.waitForTimeout(30); }
    await p.mouse.up(); await p.waitForTimeout(400);
    const o = (await stored(p)).route.order;
    expect(o.join('') === 'adbc', 'λάθος σειρά: ' + o.join(''));
    expect((await p.$eval('#modal', (e) => e.classList.contains('hidden'))), 'άνοιξε η στάση μετά το σύρσιμο');
    return p;
  });

  await test('Ωράριο: παραλαβή που ανοίγει αργότερα μπαίνει μετά, αν και είναι η πιο κοντινή', async () => {
    const d = new Date(Date.now() + 45 * 60000), e = new Date(Date.now() + 120 * 60000);
    const hm = (x) => String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0');
    const st = [mk('p', 35.3380, 25.1435, { pickup: { name: 'Demo Store', window: hm(d) + '–' + hm(e), pkgs: 3 } }), mk('a', 35.3315, 25.1338), mk('b', 35.3290, 25.1300), mk('c', 35.3260, 25.1250)];
    const p = await page({ stops: st, route: null, settings: settings({ serviceMin: 5 }) });
    await p.click('#btnOptimize'); await p.waitForTimeout(300); await idle(p); await p.waitForTimeout(300);
    const o = (await stored(p)).route.order;
    expect(o[0] !== 'p', 'η παραλαβή μπήκε πρώτη ενώ είναι κλειστή: ' + o.join(','));
    return p;
  });

  await test('Αναφορά ημέρας: μετρά παραδομένα/αποτυχίες με λόγους και κείμενο για κοινοποίηση', async () => {
    const st = [mk('a', 35.33, 25.13, { done: true, doneAt: Date.now() - 3600e3, pkgs: 2 }), mk('b', 35.33, 25.13, { done: true, doneAt: Date.now() }),
      mk('c', 35.33, 25.13, { done: true, failed: true, failReason: 'Απών', doneAt: Date.now() - 600e3 }), mk('d', 35.33, 25.13)];
    const p = await page({ stops: st, route: null, settings: settings() });
    await p.click('#btnMenu'); await p.click('#btnReport'); await p.waitForSelector('.rep-tiles');
    const tiles = await p.$$eval('.rep-tile b', (a) => a.map((x) => x.textContent));
    expect(tiles.join(',') === '2,1,1', 'λάθος σύνολα: ' + tiles.join(','));
    expect(/Απών \(1\)/.test(await p.textContent('#modalBody')), 'λείπει ο λόγος αποτυχίας');
    expect(/3 δέματα/.test(await p.textContent('.rep-tile.ok')), 'λάθος δέματα');
    return p;
  });

  await test('Προσθήκη λίστας: δεύτερο πάτημα δεν προσθέτει ξανά, το «Ξαναδοκίμασε» ψάχνει μόνο όσες δεν βρέθηκαν', async () => {
    const p = await page({ stops: [], route: null, settings: settings() });
    await p.click('#btnPaste'); await p.waitForSelector('#bulk');
    await p.fill('#bulk', 'Δοκιμαστική 10, Ηράκλειο\nΔοκιμαστική 12, Ηράκλειο\nΑνύπαρκτη 99, Ηράκλειο');
    await p.click('#bulkGo'); await p.waitForSelector('#retryFailed', { timeout: 20000 });
    expect((await stored(p)).stops.length === 2, 'μπήκαν ' + (await stored(p)).stops.length + ' αντί για 2');
    expect(!(await p.isVisible('#bulkGo')), 'το κουμπί «Προσθήκη» έμεινε και μπορεί να ξαναπατηθεί');
    const searches = [];
    p.on('request', (r) => { if (/photon/.test(r.url())) searches.push(decodeURIComponent(r.url())); });
    await p.click('#retryFailed'); await p.waitForTimeout(2500);
    expect((await stored(p)).stops.length === 2, 'το «Ξαναδοκίμασε» πρόσθεσε διπλές');
    expect(searches.length > 0 && searches.every((u) => /Ανύπαρκτη/.test(u)), 'το «Ξαναδοκίμασε» έψαξε και άλλες διευθύνσεις');
    return p;
  });

  await test('Αλλαγή διεύθυνσης στάσης: νέα θέση, ίδιος πελάτης/δέματα/σειρά', async () => {
    const st = STOPS(); st[1].pkgs = 3; st[1].note = 'κουδούνι 2';
    const p = await page({ stops: st, route: ROUTE(['a', 'b', 'c']), settings: settings() });
    await p.evaluate(() => document.getElementById('stops').scrollIntoView()); await p.waitForTimeout(300);
    await p.click('#stops li >> nth=1'); await p.waitForSelector('#mAddr'); await p.click('#mAddr');
    await p.waitForSelector('#pSearch'); await p.fill('#pSearch', 'Δοκιμαστική 10, Ηράκλειο');
    await p.waitForSelector('#pRes li', { timeout: 8000 }); await p.click('#pRes li >> nth=0'); await p.waitForTimeout(400);
    const s = await stored(p), b = s.stops.find((x) => x.id === 'b');
    expect(b.orig === 'Δοκιμαστική 10, Ηράκλειο' && Math.abs(b.lat - 35.33) < 1e-6, 'η διεύθυνση δεν άλλαξε: ' + b.orig);
    expect(b.pkgs === 3 && b.note === 'κουδούνι 2' && b.people[0].name === 'Πελάτης b', 'χάθηκαν στοιχεία του πελάτη');
    expect(s.route && s.route.order.join('') === 'abc', 'άλλαξε η σειρά');
    return p;
  });

  await test('Πληκτρολόγιο: το παράθυρο «Αλλαγή διεύθυνσης» ανεβαίνει πάνω από το πληκτρολόγιο', async () => {
    const p = await page({ stops: STOPS(), route: ROUTE(['a', 'b', 'c']), settings: settings() });
    // ψεύτικο πληκτρολόγιο iPhone: το ορατό κομμάτι της οθόνης μικραίνει
    await p.evaluate(() => {
      const fake = new EventTarget(); fake.height = innerHeight; fake.offsetTop = 0;
      Object.defineProperty(window, '__vv', { value: fake });
    });
    await p.evaluate(() => document.getElementById('stops').scrollIntoView()); await p.waitForTimeout(300);
    await p.click('#stops li >> nth=0'); await p.waitForSelector('#mAddr'); await p.click('#mAddr'); await p.waitForSelector('#pSearch');
    const kbTop = await p.evaluate(() => innerHeight - 330);
    await p.evaluate((h) => {
      const vv = window.visualViewport;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
      vv.dispatchEvent(new Event('resize'));
    }, kbTop);
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => { const i = document.getElementById('pSearch').getBoundingClientRect(), m = document.querySelector('.modal-sheet').getBoundingClientRect(), bd = document.querySelector('.modal-backdrop').getBoundingClientRect(); return { inpBottom: i.bottom, sheetBottom: m.bottom, bdTop: bd.top, bdBottom: bd.bottom, vh: innerHeight }; });
    expect(r.sheetBottom <= kbTop + 1 && r.sheetBottom >= kbTop - 30 && r.inpBottom <= kbTop, 'το παράθυρο δεν κάθεται ακριβώς πάνω από το πληκτρολόγιο: ' + JSON.stringify(r) + ' πληκτρολόγιο από ' + kbTop);
    expect(r.bdTop <= 0 && r.bdBottom >= r.vh - 1, 'το σκοτεινό φόντο δεν καλύπτει όλη την οθόνη (φαίνεται ο χάρτης από πίσω)');
    return p;
  });

  await test('Χειροκίνητη στάση: επιλογή είδους (παραλαβή με ωράριο)', async () => {
    const p = await page({ stops: [], route: null, settings: settings() });
    await p.fill('#search', 'Δοκιμαστική 10'); await p.waitForSelector('#suggestions li', { timeout: 8000 }); await p.click('#suggestions li');
    await p.waitForSelector('#stType'); await p.click('#stType [data-k="pickup"]');
    await p.fill('#stName', 'Demo Store'); await p.fill('#stPkgs', '5'); await p.fill('#stWin', '13:45–15:45'); await p.click('#stOk'); await p.waitForTimeout(300);
    const s = (await stored(p)).stops[0];
    expect(s && s.pickup && s.pickup.pkgs === 5 && s.pickup.window === '13:45–15:45', 'η παραλαβή δεν αποθηκεύτηκε σωστά');
    return p;
  });

  await browser.close(); server.close();
  console.log(`\n${passed} πέτυχαν, ${failed} απέτυχαν`);
  process.exit(failed ? 1 : 0);
})();
