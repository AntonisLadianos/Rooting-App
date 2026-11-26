/*
 * Πλοήγηση μέσα στην εφαρμογή (στροφή-στροφή, με φωνή στα ελληνικά).
 * Διαδρομή: OSRM (δωρεάν, με ελληνικά ονόματα δρόμων από OpenStreetMap).
 *
 *   RootingNav.start({ dest: {lat,lng,title,phone}, mv, osrm, getPos, onArrive, onExit, onReroute })
 *   RootingNav.stop()
 */
(function (global) {
  'use strict';

  // ---------- Γεωμετρία ----------
  const R = 6371000, rad = Math.PI / 180;
  function dist(a, b) {
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad), y = (b.lat - a.lat) * rad;
    return Math.sqrt(x * x + y * y) * R;
  }
  function bearing(a, b) {
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  // απόσταση σημείου p από τμήμα a-b και θέση t (0..1) πάνω του
  function project(p, a, b) {
    const kx = Math.cos(p.lat * rad) * R * rad, ky = R * rad;
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? -(ax * dx + ay * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { d: Math.sqrt(qx * qx + qy * qy), t };
  }

  // ---------- Οδηγίες στα ελληνικά ----------
  const MOD = {
    left: 'αριστερά', right: 'δεξιά', 'slight left': 'ελαφρώς αριστερά', 'slight right': 'ελαφρώς δεξιά',
    'sharp left': 'απότομα αριστερά', 'sharp right': 'απότομα δεξιά', straight: 'ευθεία', uturn: 'κάνε αναστροφή'
  };
  const ARROW = {
    left: '↰', right: '↱', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↲', 'sharp right': '↳', straight: '↑', uturn: '↶'
  };
  const ORD = ['', 'πρώτη', 'δεύτερη', 'τρίτη', 'τέταρτη', 'πέμπτη', 'έκτη', 'έβδομη', 'όγδοη'];
  function onto(name) { return name ? ` στην ${name}` : ''; }
  function instruction(step, isLast) {
    const m = step.maneuver || {}, type = m.type, mod = m.modifier || 'straight', name = step.name || step.ref || '';
    const turn = MOD[mod] || 'ευθεία';
    let text, arrow = ARROW[mod] || '↑';
    switch (type) {
      case 'depart': text = `Ξεκίνα${name ? ' στην ' + name : ''}`; arrow = '↑'; break;
      case 'arrive': text = isLast !== false ? 'Έφτασες στον προορισμό' : 'Ενδιάμεση στάση'; arrow = '🏁'; break;
      case 'roundabout': case 'rotary': case 'roundabout turn':
        text = m.exit ? `Στον κυκλικό κόμβο, πάρε την ${ORD[m.exit] || m.exit + 'η'} έξοδο${onto(name)}` : `Στον κυκλικό κόμβο, ${turn}${onto(name)}`;
        arrow = '⟳'; break;
      case 'exit roundabout': case 'exit rotary': text = `Βγες από τον κυκλικό κόμβο${onto(name)}`; break;
      case 'fork': text = `Κράτα ${mod.includes('left') ? 'αριστερά' : 'δεξιά'}${onto(name)}`; break;
      case 'end of road': text = `Στο τέλος του δρόμου, στρίψε ${turn}${onto(name)}`; break;
      case 'merge': text = `Συνέχισε${onto(name)}`; break;
      case 'on ramp': text = `Πάρε τη ράμπα ${mod.includes('left') ? 'αριστερά' : 'δεξιά'}${onto(name)}`; break;
      case 'off ramp': text = `Πάρε την έξοδο ${mod.includes('left') ? 'αριστερά' : 'δεξιά'}${onto(name)}`; break;
      case 'continue': case 'new name':
        text = mod === 'straight' ? `Συνέχισε ευθεία${onto(name)}` : (mod === 'uturn' ? 'Κάνε αναστροφή' : `Συνέχισε ${turn}${onto(name)}`); break;
      default: // turn και ό,τι άλλο
        text = mod === 'uturn' ? `Κάνε αναστροφή${onto(name)}` : (mod === 'straight' ? `Συνέχισε ευθεία${onto(name)}` : `Στρίψε ${turn}${onto(name)}`);
    }
    return { text, arrow };
  }
  function fmtDist(m) {
    if (m >= 950) return (m / 1000).toFixed(m < 9950 ? 1 : 0).replace('.', ',') + ' χλμ';
    if (m >= 100) return Math.round(m / 50) * 50 + ' μ';
    return Math.max(10, Math.round(m / 10) * 10) + ' μ';
  }
  function spokenDist(m) {
    if (m >= 950) { const k = Math.round(m / 100) / 10; return (k === 1 ? '1 χιλιόμετρο' : String(k).replace('.', ',') + ' χιλιόμετρα'); }
    return (m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10) + ' μέτρα';
  }

  // ---------- Διαδρομή ----------
  // geometry: [[lng,lat],...] από OSRM -> σημεία + αθροιστικές αποστάσεις + θέση κάθε κίνησης πάνω στη γραμμή
  function buildRoute(osrmRoute) {
    const pts = osrmRoute.geometry.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const steps = [];
    osrmRoute.legs.forEach((leg, li) => leg.steps.forEach((st) => {
      const loc = { lat: st.maneuver.location[1], lng: st.maneuver.location[0] };
      let best = 0, bd = Infinity;
      const from = steps.length ? steps[steps.length - 1].idx : 0;
      for (let i = from; i < pts.length; i++) { const d = dist(loc, pts[i]); if (d < bd) { bd = d; best = i; } if (bd < 2 && d > 200) break; }
      const t = st.maneuver.type, mod = st.maneuver.modifier || 'straight';
      const prev = steps[steps.length - 1];
      // περιττά: «βγες από τον κυκλικό κόμβο» αμέσως μετά το «πάρε την Χ έξοδο», και «συνέχισε ευθεία» στον ίδιο δρόμο
      if ((t === 'exit roundabout' || t === 'exit rotary') && prev && /roundabout|rotary/.test(prev.step.maneuver.type)) return;
      if ((t === 'new name' || t === 'continue') && mod === 'straight' && prev && (st.name || '') === (prev.step.name || '')) return;
      const silent = (t === 'new name' || t === 'continue') && mod === 'straight'; // εμφανίζεται, αλλά δεν λέγεται
      steps.push({ step: st, idx: best, at: cum[best], leg: li, silent, ...instruction(st, li === osrmRoute.legs.length - 1) });
    }));
    return { pts, cum, steps, total: cum[cum.length - 1], duration: osrmRoute.duration };
  }

  // Θέση πάνω στη διαδρομή (κοντινότερο τμήμα, ψάχνοντας κοντά στο προηγούμενο)
  function locate(route, p, hint) {
    let best = { d: Infinity, i: 0, t: 0 };
    const from = Math.max(0, (hint || 0) - 30), to = Math.min(route.pts.length - 1, (hint || 0) + 300);
    for (let i = from; i < to; i++) {
      const r = project(p, route.pts[i], route.pts[i + 1]);
      if (r.d < best.d) best = { d: r.d, i, t: r.t };
    }
    if (best.d > 60 && (from > 0 || to < route.pts.length - 1)) { // ψάχνουμε σε όλη τη διαδρομή
      for (let i = 0; i < route.pts.length - 1; i++) {
        const r = project(p, route.pts[i], route.pts[i + 1]);
        if (r.d < best.d) best = { d: r.d, i, t: r.t };
      }
    }
    const seg = route.cum[best.i + 1] - route.cum[best.i];
    return { off: best.d, idx: best.i, along: route.cum[best.i] + seg * best.t };
  }

  // ---------- Φωνή ----------
  let voice = null, muted = false, routeGen = 0, carAudio = false;
  function pickVoice() {
    if (!global.speechSynthesis) return;
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /^el/i.test(v.lang) && /melina|μελ/i.test(v.name)) || vs.find((v) => /^el/i.test(v.lang)) || null;
  }
  if (global.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  // iPhone: (1) η φωνή «ξεκλειδώνει» μόνο αν μιλήσει ΑΜΕΣΩΣ μέσα στο πάτημα, πριν από οποιοδήποτε await·
  // (2) cancel() και αμέσως speak() → το Safari συχνά πετάει σιωπηλά τη νέα φράση· (3) μετά από παύση/κλείδωμα
  // οθόνης η φωνή μένει «σε παύση» — resume() πριν από κάθε φράση· (4) κρατάμε αναφορά στη φράση ώσπου να τελειώσει.
  const live = new Set();
  function utter(text) {
    const u = new SpeechSynthesisUtterance(text);
    if (!voice) pickVoice();
    u.lang = 'el-GR'; if (voice) u.voice = voice; u.rate = 1.0; u.volume = 1; // 1.0: στο iPhone πιο γρήγορα ακούγεται «σπαστά»
    live.add(u); u.onend = u.onerror = () => live.delete(u);
    return u;
  }
  // ΔΙΚΗ ΜΑΣ ΟΥΡΑ: η εφαρμογή δεν κόβει ΠΟΤΕ φράση στη μέση (cancel() μόνο στο κλείσιμο/σίγαση).
  // Μιλάει μία φράση τη φορά· η επόμενη περιμένει να τελειώσει η προηγούμενη και, πριν ειπωθεί,
  // ελέγχεται αν ισχύει ακόμα (π.χ. η στροφή δεν έχει περάσει) — αλλιώς πετιέται.
  let queue = [], talking = null, guard = null; // talking = { key } της φράσης που λέγεται τώρα
  try { localStorage.removeItem('rooting.voicelog'); } catch (e) { /* ignore */ } // παλιό αρχείο φωνής
  // Κείμενο για τη φωνή: οι οδηγίες της Google γράφουν «Στροφή αριστερά στη(ν) …» — η φωνή διάβαζε το «(ν)»
  // κομμένο/σπαστό. Και τα ΚΕΦΑΛΑΙΑ (από τις κάρτες) τα διαβάζει άσχημα.
  function speakable(t) {
    return String(t || '')
      .replace(/([A-Za-zΑ-Ωα-ωά-ώΆ-Ώϊϋΐΰ]+)\(([A-Za-zα-ωά-ώ]{1,3})\)/g, '$1$2') // στη(ν) → στην
      .replace(/\(([^)]*)\)/g, ', $1,')
      .replace(/(^|[,.]\s*|και (?:αμέσως )?μετά\s+)στροφή (αριστερά|δεξιά|ελαφρώς|απότομα)/gi, (m, pre, dir) => pre + (pre ? 'στρίψε ' : 'Στρίψε ') + dir)
      .replace(/(^|\s)Λεωφ\.\s*/g, '$1Λεωφόρος ').replace(/(^|\s)Αγ\.\s*/g, '$1Αγίου ').replace(/(^|\s)Οδ\.\s*/g, '$1Οδός ')
      .replace(/[A-ZΑ-ΩΆ-Ώ]{3,}(?:\s+[A-ZΑ-ΩΆ-Ώ0-9]{2,})*/g, (w) => w.toLowerCase())
      .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  }
  // CarPlay/Bluetooth, τρόπος «αθόρυβα»: όσο μιλάει η φωνή (και ~2″ μετά) παίζουμε έναν ήχο που δεν ακούγεται
  // (θόρυβος -80 dB), ώστε το αυτοκίνητο να μην κλείσει τον ήχο πριν ακουστεί το τέλος της φράσης.
  function carMode(v) { return v ? 'silent' : ''; } // true/'silent' (και το παλιό 'repeat') → αθόρυβη λύση
  let actx = null, keepSrc = null, keepUntil = 0;
  function audioUnlock() { // ΣΥΓΧΡΟΝΑ μέσα σε πάτημα
    if (carAudio !== 'silent') return;
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state !== 'running') actx.resume();
    } catch (e) { /* ignore */ }
  }
  function keepAlive(ms) {
    if (carAudio !== 'silent' || !actx) return;
    keepUntil = Math.max(keepUntil, Date.now() + ms);
    try { if (actx.state !== 'running') actx.resume(); } catch (e) { /* ignore */ }
    if (keepSrc) return;
    try {
      const n = actx.sampleRate, buf = actx.createBuffer(1, n, n), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() - 0.5) * 2e-4;
      const src = actx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(actx.destination); src.start();
      keepSrc = src;
      const chk = () => { if (keepSrc !== src) return; if (Date.now() >= keepUntil) { try { src.stop(); } catch (e) { /* ignore */ } keepSrc = null; } else setTimeout(chk, 250); };
      setTimeout(chk, 250);
    } catch (e) { keepSrc = null; }
  }
  function pump() {
    if (talking || muted || !global.speechSynthesis) return;
    while (queue.length) {
      const it = queue.shift();
      if (it.valid && !it.valid()) continue;
      const ss = speechSynthesis;
      try {
        if (ss.paused) ss.resume();
        const text = (speakable(typeof it.text === 'function' ? it.text() : it.text));
        const u = utter(text), me = { key: it.key };
        talking = me;
        const done = () => { live.delete(u); if (talking !== me) return; talking = null; clearTimeout(guard); setTimeout(pump, 60); };
        u.onstart = () => { keepAlive(1500 + text.length * 110); };
        u.onend = () => { keepAlive(2200); done(); };
        u.onerror = done;
        if (typeof u.onboundary !== 'undefined') { /* ignore */ }
        // αν το iPhone «ξεχάσει» να πει ότι τελείωσε, δεν κολλάμε (χωρίς να κόψουμε τίποτα)
        clearTimeout(guard); guard = setTimeout(done, 2500 + text.length * 110);
        keepAlive(1500 + text.length * 110); // ανοίγει τον ήχο του αυτοκινήτου λίγο πριν από τη φωνή
        ss.speak(u);
      } catch (e) { talking = null; continue; }
      return;
    }
  }
  function enqueue(it, front) {
    if (muted || !global.speechSynthesis) return false;
    // μια νεότερη φράση για την ίδια στροφή αντικαθιστά όποια περιμένει ακόμα στην ουρά
    if (it.key != null) queue = queue.filter((q) => q.key !== it.key);
    if (front) queue.unshift(it); else queue.push(it);
    pump();
    return true;
  }
  function say(text, front) { return enqueue({ text }, front); }
  function sayNav(text, key, valid) {
    if (talking && talking.key === key) return false; // λέει ήδη αυτή τη στροφή — δεν τη διακόπτουμε, ούτε την ξαναλέμε
    return enqueue({ text, key, valid });
  }
  function hush() { keepUntil = 0; queue = []; talking = null; clearTimeout(guard); try { if (global.speechSynthesis) speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  const lc = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  // η οδηγία χωρίς όνομα οδού, π.χ. «Στρίψε δεξιά»
  function shortText(st) {
    const m = st.step && st.step.maneuver;
    if (!m || !m.type) return st.text;
    return instruction(Object.assign({}, st.step, { name: '', ref: '' }), true).text;
  }

  // καλείται ΣΥΓΧΡΟΝΑ μέσα στο πάτημα του χρήστη
  function unlockVoice(text) {
    if (muted || !global.speechSynthesis) return;
    try { if (!voice) pickVoice(); speechSynthesis.resume(); } catch (e) { /* ignore */ }
    audioUnlock();
    say(text); // αν δεν μιλάει, λέγεται ΣΥΓΧΡΟΝΑ (μέσα στο πάτημα)· αλλιώς μπαίνει στη σειρά
  }

  // ---------- Κατάσταση πλοήγησης ----------
  let cur = null;
  // Τελευταία κατεύθυνση κίνησης (από το GPS). Κρατιέται από στάση σε στάση: όταν πατάς ✓ και ξεκινά η επόμενη
  // διαδρομή είσαι σταματημένος και το GPS δεν ξέρει προς τα πού κοιτάει το αυτοκίνητο.
  let lastHead = null; // { deg, at }
  function knownHeading() { return lastHead && Date.now() - lastHead.at < 15 * 60000 ? lastHead.deg : null; }

  // ---------- Διαδρομή από Google (Routes API) — σωστοί μονόδρομοι/απαγορεύσεις ----------
  function decodePolyline(str) {
    const out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lng += d;
      }
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }
  const G_MOD = {
    TURN_LEFT: 'left', TURN_RIGHT: 'right', TURN_SLIGHT_LEFT: 'slight left', TURN_SLIGHT_RIGHT: 'slight right',
    TURN_SHARP_LEFT: 'sharp left', TURN_SHARP_RIGHT: 'sharp right', UTURN_LEFT: 'uturn', UTURN_RIGHT: 'uturn',
    RAMP_LEFT: 'slight left', RAMP_RIGHT: 'slight right', FORK_LEFT: 'slight left', FORK_RIGHT: 'slight right',
    STRAIGHT: 'straight', MERGE: 'straight', NAME_CHANGE: 'straight', DEPART: 'straight'
  };
  // Απάντηση Google -> ίδια μορφή με το buildRoute (pts, cum, steps[{at, text, arrow, step, silent}], total, duration)
  function buildGoogleRoute(gr) {
    const pts = decodePolyline(gr.polyline.encodedPolyline);
    if (pts.length < 2) throw new Error('κενή διαδρομή');
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const steps = [];
    let from = 0;
    (gr.legs || []).forEach((leg) => (leg.steps || []).forEach((st) => {
      const ni = st.navigationInstruction || {};
      const man = ni.maneuver || (steps.length ? '' : 'DEPART');
      const txt = String(ni.instructions || '').split('\n')[0].trim();
      const sp = st.polyline && st.polyline.encodedPolyline ? decodePolyline(st.polyline.encodedPolyline) : [];
      let best = from, bd = Infinity;
      if (sp.length) for (let i = from; i < pts.length; i++) { const d = dist(sp[0], pts[i]); if (d < bd) { bd = d; best = i; } if (bd < 3 && d > 200) break; }
      from = best;
      if (!steps.length) { steps.push({ step: { maneuver: { type: 'depart' }, name: '' }, idx: 0, at: 0, leg: 0, silent: true, text: txt || 'Ξεκίνα', arrow: '↑' }); return; }
      if (!txt && !man) return; // τμήμα χωρίς οδηγία
      const round = /ROUNDABOUT/.test(man);
      const mod = G_MOD[man] || 'straight';
      steps.push({ step: { maneuver: { type: round ? 'roundabout' : 'turn', modifier: mod }, name: '' }, idx: best, at: cum[best], leg: 0,
        silent: man === 'NAME_CHANGE' || man === 'STRAIGHT', text: txt || instruction({ maneuver: { type: 'turn', modifier: mod } }).text, arrow: round ? '⟳' : (ARROW[mod] || '↑') });
    }));
    if (!steps.length) steps.push({ step: { maneuver: { type: 'depart' }, name: '' }, idx: 0, at: 0, leg: 0, silent: true, text: 'Ξεκίνα', arrow: '↑' });
    const last = pts.length - 1;
    steps.push(Object.assign({ step: { maneuver: { type: 'arrive' }, name: '' }, idx: last, at: cum[last], leg: 0, silent: false }, instruction({ maneuver: { type: 'arrive' } }, true)));
    return { pts, cum, steps, total: cum[last], duration: parseFloat(gr.duration) || (cum[last] / 8), via: 'google' };
  }
  const G_FIELDS = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.polyline.encodedPolyline';
  async function googleRoute(from, to, key, heading) {
    const ll = (p, h) => ({ location: Object.assign({ latLng: { latitude: p.lat, longitude: p.lng } }, h != null ? { heading: Math.round(((h % 360) + 360) % 360) } : {}) });
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes?key=' + encodeURIComponent(key) + '&fields=' + encodeURIComponent(G_FIELDS), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ll(from, heading), destination: ll(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', languageCode: 'el', units: 'METRIC' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    if (!j.routes || !j.routes[0]) throw new Error('Δεν βρέθηκε διαδρομή');
    return buildGoogleRoute(j.routes[0]);
  }

  async function fetchRoute(from, to, heading) {
    // πρώτα Google (αν είναι ανοιχτό στις Ρυθμίσεις και επιτρέπεται)· σε αποτυχία, η δωρεάν υπηρεσία όπως πριν
    const key = cur.googleKey && cur.googleKey();
    if (key && !cur.googleDown) {
      try { const g = await googleRoute(from, to, key, heading); if (cur && cur.onGoogleRoute) cur.onGoogleRoute(); return g; }
      catch (e) { if (cur) { cur.googleDown = true; if (cur.onGoogleFail) cur.onGoogleFail(e.message || String(e)); } }
    }
    const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
    const base = `${cur.osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
    const withBear = heading != null ? base + `&bearings=${Math.round(((heading % 360) + 360) % 360)},60;` : null;
    let lastErr, useBear = !!withBear;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(useBear ? withBear : base);
        const j = await r.json();
        if (j.code === 'Ok' && j.routes && j.routes[0]) return buildRoute(j.routes[0]);
        lastErr = new Error(j.message || j.code);
        // δεν βγαίνει διαδρομή προς αυτή την κατεύθυνση (π.χ. μονόδρομος ανάποδα): αμέσως χωρίς κατεύθυνση
        if (useBear) { useBear = false; a--; continue; }
      } catch (e) { lastErr = e; }
      await new Promise((res) => setTimeout(res, 800 * (a + 1)));
    }
    throw lastErr || new Error('Δεν βρέθηκε διαδρομή');
  }

  function el(id) { return document.getElementById(id); }

  async function start(opts) {
    stop(true);
    cur = Object.assign({ osrm: 'https://router.project-osrm.org' }, opts, {
      route: null, hint: 0, stepIdx: 1, spoken: {}, offCount: 0, lastReroute: 0, arrived: false, heading: knownHeading(), watch: null, free: false, freeAt: 0
    });
    el('navRecenter').classList.add('hidden');
    muted = !!opts.muted; carAudio = carMode(opts.carAudio);
    unlockVoice('Ξεκινάμε'); // πρώτο πράγμα, πριν από κάθε await
    document.body.classList.add('navigating');
    if (opts.mv && opts.mv.dimRoute) opts.mv.dimRoute(true); // η γραμμή όλου του δρομολογίου γίνεται αχνή
    el('nav').classList.remove('hidden');
    el('navArrive').classList.add('hidden');
    el('navText').textContent = 'Υπολογισμός διαδρομής…';
    el('navArrow').textContent = '…'; el('navDist').textContent = ''; el('navThen').textContent = '';
    el('navDest').textContent = opts.dest.title || '';
    el('navMute').innerHTML = global.ic ? global.ic(muted ? 'mute' : 'vol') : (muted ? '🔇' : '🔊');
    try { if (navigator.wakeLock) cur.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }

    const here = (await opts.getPos().catch(() => null)) || opts.from;
    if (!here) { el('navText').textContent = 'Δεν βρέθηκε η θέση σου'; return; }
    await reroute(here, true);
    if (!cur) return;
    cur.watch = navigator.geolocation.watchPosition(onPos, () => {}, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    onPos({ coords: { latitude: here.lat, longitude: here.lng, accuracy: 10, heading: null, speed: 0 } });
  }

  async function reroute(p, first) {
    const me = cur;
    if (!me) return;
    me.lastReroute = first ? 0 : Date.now();
    if (!first) { el('navText').textContent = 'Επανυπολογισμός διαδρομής…'; if (!talking) say('Επανυπολογισμός διαδρομής'); }
    try {
      const route = await fetchRoute(p, me.dest, me.heading);
      if (cur !== me) return;
      const old = me.route, oldSp = me.spoken || {};
      me.route = route; routeGen++; me.hint = 0; me.stepIdx = 1; me.spoken = {};
      // ίδια στροφή και στη νέα διαδρομή (π.χ. το GPS «πέταξε» για λίγο): δεν την ξαναλέμε από την αρχή
      if (old) Object.keys(oldSp).forEach((k) => {
        const os = old.steps[k]; if (!os) return;
        const op = old.pts[os.idx];
        route.steps.forEach((ns, ni) => { if (ns.text === os.text && dist(route.pts[ns.idx], op) < 25) me.spoken[ni] = Object.assign({}, oldSp[k]); });
      }); me.offCount = 0;
      me.mv.setNavRoute(route.pts.map((x) => [x.lat, x.lng]));
      if (me.onReroute) me.onReroute(route);
      update(p);
    } catch (e) {
      if (cur === me) el('navText').textContent = 'Δεν υπάρχει σύνδεση για διαδρομή — ξαναδοκιμάζω…';
      setTimeout(() => { if (cur === me && !me.route) reroute(p, first); }, 5000);
    }
  }

  function onPos(pos) {
    if (!cur) return;
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const sp = pos.coords.speed;
    if (pos.coords.heading != null && !isNaN(pos.coords.heading) && sp != null && sp > 1.5) { cur.heading = pos.coords.heading; lastHead = { deg: pos.coords.heading, at: Date.now() }; }
    cur.speed = sp || 0;
    cur.last = p;
    if (cur.onPos) cur.onPos(p);
    update(p, pos.coords.accuracy);
  }

  function update(p, acc) {
    const c = cur;
    if (!c || !c.route) return;
    const r = c.route;
    const loc = locate(r, p, c.hint);
    c.hint = loc.idx;
    // κατεύθυνση χάρτη: GPS όταν κινούμαστε, αλλιώς η κατεύθυνση του δρόμου
    const roadBearing = bearing(r.pts[loc.idx], r.pts[Math.min(loc.idx + 1, r.pts.length - 1)]);
    const head = c.heading != null ? c.heading : roadBearing;
    c.head = head;
    // ο χρήστης κουνάει τον χάρτη: δεν τον ακολουθούμε· μετά από 20″ χωρίς άγγιγμα επιστρέφουμε μόνοι μας
    if (c.free && Date.now() - c.freeAt > 20000) recenter();
    // ομαλή κίνηση: το στίγμα «κουμπώνει» πάνω στη γραμμή της διαδρομής όταν είμαστε πάνω της, και γλιστράει ως εκεί
    let target = p;
    if (loc.off < 25) {
      const a = r.pts[loc.idx], b = r.pts[Math.min(loc.idx + 1, r.pts.length - 1)];
      const seg = r.cum[Math.min(loc.idx + 1, r.cum.length - 1)] - r.cum[loc.idx];
      const t = seg > 0 ? Math.max(0, Math.min(1, (loc.along - r.cum[loc.idx]) / seg)) : 0;
      target = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    // Πέρασες τη διεύθυνση χωρίς να πατήσεις ✓ (π.χ. δεν βρήκες να παρκάρεις): μόλις απομακρυνθείς,
    // ο χάρτης φεύγει από το ζουμ, σε ακολουθεί ξανά και η διαδρομή ξαναβγαίνει (κύκλος και επιστροφή)
    if (c.arrived && dist(p, c.dest) > DEPART_M && !(acc > 60)) { depart(); reroute(p); return; }
    glideTo(target, head);
    if (c.arrived) return; // μετά την άφιξη η οθόνη μένει στο «Έφτασες» (ζουμ στον προορισμό)

    // εκτός διαδρομής -> επανυπολογισμός
    if (loc.off > Math.max(40, (acc || 0) * 1.5)) c.offCount++; else c.offCount = 0;
    if (c.offCount >= 3 && Date.now() - c.lastReroute > 10000 && !c.arrived) { reroute(p); return; }

    // ποια είναι η επόμενη κίνηση
    while (c.stepIdx < r.steps.length - 1 && r.steps[c.stepIdx].at < loc.along - 15) c.stepIdx++;
    const st = r.steps[c.stepIdx], nx = r.steps[c.stepIdx + 1];
    const toMan = Math.max(0, st.at - loc.along);
    const remain = Math.max(0, r.total - loc.along);
    if (st.step.maneuver.type === 'arrive' && global.ic) el('navArrow').innerHTML = global.ic('flag', 'nav-flag'); else el('navArrow').textContent = st.arrow;
    el('navDist').textContent = fmtDist(toMan);
    el('navText').textContent = st.text;
    el('navThen').textContent = nx && nx.step.maneuver.type !== 'arrive' && nx.at - st.at < 400 ? `Μετά: ${nx.arrow} ${nx.text}` : '';
    const remSec = r.duration * (remain / Math.max(1, r.total));
    el('navEta').textContent = new Date(Date.now() + remSec * 1000).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
    el('navRemain').textContent = `${Math.max(1, Math.round(remSec / 60))}' · ${fmtDist(remain)}`;

    // φωνητικές οδηγίες: (μακριά) → «Σε Χ μέτρα, στρίψε … στην …» → λίγο πριν: «Στρίψε δεξιά»
    // Τα όρια είναι σε ΧΡΟΝΟ (ανάλογα με την ταχύτητα): η φράση θέλει 2–3″ και το GPS αργεί ~1″,
    // οπότε λέμε την οδηγία νωρίτερα, όχι πάνω στη στροφή.
    const key = routeGen * 1000 + c.stepIdx;
    const sp = c.spoken[c.stepIdx] || (c.spoken[c.stepIdx] = st.silent ? { far: true, near: true, now: true } : {});
    const v = Math.max(c.speed || 0, 6); // m/s — τουλάχιστον ~22 χλμ/ώρα
    const isArr = st.step.maneuver.type === 'arrive';
    const NEAR = Math.max(110, v * 13), NOW = Math.max(35, v * 5);
    // κοντινή επόμενη στροφή (π.χ. δεξιά και αμέσως αριστερά): λέγεται στην ίδια φράση, γιατί μετά δεν προλαβαίνει
    const gap = nx ? nx.at - st.at : Infinity;
    const chain = !isArr && nx && !nx.silent && gap < Math.max(90, v * 9);
    const then = chain ? (nx.step.maneuver.type === 'arrive' ? ', και αμέσως μετά ο προορισμός σου' : `, και αμέσως μετά ${lc(shortText(nx))}`) : '';
    const markNext = () => { if (chain) { const n = c.spoken[c.stepIdx + 1] || (c.spoken[c.stepIdx + 1] = {}); n.far = n.near = true; } };
    c.toMan = toMan;
    const stillValid = () => cur === c && routeGen * 1000 + c.stepIdx === key;
    const notTooLate = () => stillValid() && c.toMan > 8; // η σύντομη υπενθύμιση δεν λέγεται αφού έχεις ήδη στρίψει
    const fast = v > 13; // > ~47 χλμ/ώρα
    if (!sp.far && !isArr && toMan > NEAR + 120 && toMan > (fast ? 600 : 250) && toMan < (fast ? 1100 : 450)) {
      if (sayNav(`Σε ${spokenDist(toMan)}, ${lc(st.text)}`, key, stillValid)) sp.far = true;
    }
    if (!sp.near && toMan <= NEAR && toMan > NOW) {
      sp.near = sp.far = true; markNext();
      sayNav(() => (isArr ? `Σε ${spokenDist(c.toMan)}, ο προορισμός σου` : `Σε ${spokenDist(c.toMan)}, ${lc(st.text)}${then}`), key, stillValid); // η απόσταση υπολογίζεται τη στιγμή που λέγεται
    }
    if (!sp.now && toMan <= NOW && !isArr) {
      sp.now = sp.near = sp.far = true; markNext();
      // σύντομη φράση (χωρίς όνομα οδού) για να προλαβαίνει· αν λέει ακόμα την ίδια οδηγία, δεν την κόβουμε
      sayNav(shortText(st) + then, key, notTooLate);
    }

    // άφιξη
    const toDest = dist(p, c.dest);
    if (!c.arrived && (toDest < 35 || (remain < 30 && toDest < 80))) arrive();
  }

  // ---------- Ομαλή κίνηση στίγματος/κάμερας ανάμεσα στα στίγματα του GPS (1 ανά δευτερόλεπτο) ----------
  function glideTo(p, head) {
    const c = cur;
    if (!c) return;
    const to = { lat: p.lat, lng: p.lng, head: head || 0 };
    // πρώτο στίγμα ή μεγάλο άλμα (π.χ. νέα διαδρομή): κατευθείαν εκεί
    if (!c.disp || dist(c.disp, to) > 120 || !global.requestAnimationFrame) { c.disp = to; c.glide = null; paint(); return; }
    // σταματημένος (φανάρι, παράδοση): καμία σχεδίαση
    const dh0 = Math.abs(((to.head - c.disp.head + 540) % 360) - 180);
    if (dist(c.disp, to) < 1.5 && dh0 < 3) return;
    c.glide = { from: c.disp, to, t0: performance.now(), dur: 1000 };
    if (!c.raf) c.raf = requestAnimationFrame(glideFrame);
  }
  function glideFrame(now) {
    const c = cur;
    if (!c) return;
    c.raf = null;
    const g = c.glide;
    if (!g) return;
    // ~30 καρέ το δευτερόλεπτο αρκούν (μισή δουλειά για την κάρτα γραφικών από τα 60)
    if (c.lastPaint && now - c.lastPaint < 30 && now - g.t0 < g.dur) { c.raf = requestAnimationFrame(glideFrame); return; }
    c.lastPaint = now;
    const k = Math.min(1, (now - g.t0) / g.dur);
    const dh = ((g.to.head - g.from.head + 540) % 360) - 180;
    c.disp = { lat: g.from.lat + (g.to.lat - g.from.lat) * k, lng: g.from.lng + (g.to.lng - g.from.lng) * k, head: (g.from.head + dh * k + 360) % 360 };
    paint();
    if (k < 1) c.raf = requestAnimationFrame(glideFrame); else c.glide = null;
  }
  function paint() {
    const c = cur;
    if (!c || !c.disp) return;
    if (c.mv.setMe) c.mv.setMe({ lat: c.disp.lat, lng: c.disp.lng }, c.disp.head);
    if (!c.free && !c.arrived) c.mv.follow(c.disp, c.disp.head, c.flat);
  }

  const DEPART_M = 70; // άφιξη στα 35 μ, «έφυγες» στα 70 μ (για να μην τρεμοπαίζει)
  function depart() {
    const c = cur;
    if (!c || !c.arrived) return;
    c.arrived = false;
    c.offCount = 0; c.spoken = {};
    if (c.onDepart) c.onDepart();
    if (!c.free && c.disp) c.mv.follow(c.disp, c.disp.head, c.flat); // πίσω στο κανονικό ζουμ πλοήγησης
  }

  function arrive() {
    const c = cur;
    c.arrived = true;
    queue = queue.filter((q) => q.key == null); say('Έφτασες. ' + (c.dest.speak || (c.dest.title ? c.dest.title.split(',')[0] : '')), true);
    if (navigator.vibrate) navigator.vibrate([60, 80, 60]);
    el('navText').textContent = 'Έφτασες στον προορισμό';
    el('navArrow').innerHTML = global.ic ? global.ic('flag', 'nav-flag') : '🏁'; el('navDist').textContent = ''; el('navThen').textContent = '';
    if (!c.free) focusDest();
    if (c.onArrive) c.onArrive();
  }

  // ---------- Ελεύθερος χάρτης / επαναφορά / ζουμ στον προορισμό ----------
  function focusDest() {
    const c = cur;
    if (!c || !c.mv.focusOn) return;
    c.mv.focusOn(c.dest, c.head, 19.8, c.flat);
  }
  function goFree() {
    if (!cur || !cur.route) return;
    cur.freeAt = Date.now();
    if (!cur.free) { cur.free = true; el('navRecenter').classList.remove('hidden'); }
  }
  function recenter() {
    const c = cur;
    if (!c) return;
    c.free = false;
    el('navRecenter').classList.add('hidden');
    if (c.arrived) focusDest();
    else if (c.disp) c.mv.follow(c.disp, c.disp.head, c.flat);
    else if (c.last) c.mv.follow(c.last, c.head, c.flat);
  }
  let touchOnMap = false, mouseOnMap = false;
  const onMap = (e) => !!(e.target && e.target.closest && e.target.closest('#map'));
  document.addEventListener('touchstart', (e) => { touchOnMap = onMap(e); }, { passive: true });
  document.addEventListener('touchmove', () => { if (cur && touchOnMap) goFree(); }, { passive: true });
  document.addEventListener('mousedown', (e) => { mouseOnMap = onMap(e); });
  document.addEventListener('mousemove', (e) => { if (cur && mouseOnMap && e.buttons) goFree(); });
  document.addEventListener('mouseup', () => { mouseOnMap = false; });
  document.addEventListener('wheel', (e) => { if (cur && onMap(e)) goFree(); }, { passive: true });
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#navRecenter')) recenter(); });

  function stop(silent) {
    if (!cur) return;
    try { if (cur.watch != null) navigator.geolocation.clearWatch(cur.watch); } catch (e) { /* ignore */ }
    try { if (cur.raf) cancelAnimationFrame(cur.raf); } catch (e) { /* ignore */ }
    try { if (cur.wake) cur.wake.release(); } catch (e) { /* ignore */ }
    if (!silent) hush(); else queue = []; // στο silent (νέα στάση) δεν κόβουμε ό,τι λέγεται
    if (cur.mv) { cur.mv.setNavRoute(null); cur.mv.unfollow(); if (cur.mv.dimRoute) cur.mv.dimRoute(false); }
    const onExit = cur.onExit;
    cur = null;
    document.body.classList.remove('navigating');
    el('nav').classList.add('hidden');
    if (!silent && onExit) onExit();
  }

  function toggleMute() {
    muted = !muted;
    if (muted) hush();
    if (!muted) unlockVoice('Φωνή ενεργή');
    el('navMute').innerHTML = global.ic ? global.ic(muted ? 'mute' : 'vol') : (muted ? '🔇' : '🔊');
    return muted;
  }
  document.addEventListener('visibilitychange', () => {
    if (cur && document.visibilityState === 'visible' && navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { if (cur) cur.wake = w; }).catch(() => {});
  });

  global.RootingNav = {
    start, stop, toggleMute, active: () => !!cur, arrived: () => !!(cur && cur.arrived),
    _setLastHeading: (deg) => { lastHead = deg == null ? null : { deg, at: Date.now() }; },
    googleRoute, _buildGoogleRoute: buildGoogleRoute, _decodePolyline: decodePolyline,
    // για δοκιμές
    setCarAudio: (v) => { carAudio = carMode(v); audioUnlock(); },
    _speakable: speakable,
    _instruction: instruction, _buildRoute: buildRoute, _locate: locate, _fmtDist: fmtDist, _spokenDist: spokenDist
  };
})(window);
