/* Rooting — βελτιστοποίηση δρομολογίων (PWA) */
(function () {
  'use strict';

  const OSRM = 'https://router.project-osrm.org';
  const PHOTON = 'https://photon.komoot.io';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const STORE_KEY = 'rooting.v1';
  const APP_VERSION = '12';
  const MAX_MATRIX = 100; // όριο του δημόσιου OSRM server

  // ---------- Κατάσταση ----------
  const defaults = {
    start: null,          // {label, lat, lng} ή null = τρέχουσα τοποθεσία
    endMode: 'open',      // open | cycle | fixed
    end: null,            // {label, lat, lng} όταν endMode = fixed
    stops: [],            // {id, label, lat, lng, note, phone, done, doneAt}
    route: null,          // {order:[ids], legs:[{duration,distance}], geometry, startedAt, origin, approx}
    settings: { navApp: 'google', serviceMin: 3 }
  };
  let S = load();
  let myPos = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        return Object.assign({}, defaults, o, { settings: Object.assign({}, defaults.settings, o.settings) });
      }
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(defaults));
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  }

  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Χάρτης ----------
  // mv = Google Maps (αν υπάρχει κλειδί) ή δωρεάν χάρτης. Δημιουργείται στην εκκίνηση (startMap).
  let mv = null;
  const DEFAULT_CENTER = { lat: 37.9838, lng: 23.7275 };

  // Παρατεταμένο πάτημα στον χάρτη -> προσθήκη στάσης
  async function onMapLongPress(lat, lng) {
    if (navigator.vibrate) navigator.vibrate(20);
    const div = document.createElement('div');
    div.className = 'map-popup';
    div.textContent = 'Αναζήτηση διεύθυνσης…';
    mv.popup(lat, lng, div);
    const label = await reverseGeocode(lat, lng);
    div.innerHTML = `<div style="margin-bottom:8px">${esc(label)}</div>`;
    const b = document.createElement('button');
    b.className = 'btn btn-primary'; b.textContent = '+ Προσθήκη στάσης';
    b.onclick = () => { addStop({ label, lat, lng }); mv.closePopup(); };
    div.appendChild(b);
  }

  // ---------- Γεωεντοπισμός ----------
  function getPosition(timeout) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Δεν υποστηρίζεται εντοπισμός θέσης'));
      navigator.geolocation.getCurrentPosition(
        (p) => { myPos = { lat: p.coords.latitude, lng: p.coords.longitude }; showMe(); rememberPos(); resolve(myPos); },
        (err) => reject(new Error(err.code === 1 ? 'Δεν δόθηκε άδεια τοποθεσίας' : 'Δεν βρέθηκε η τοποθεσία')),
        { enableHighAccuracy: true, timeout: timeout || 12000, maximumAge: 30000 }
      );
    });
  }
  // Θυμόμαστε την τελευταία θέση για να ανοίγει ο χάρτης κατευθείαν εκεί
  let lastSavedPosAt = 0;
  function rememberPos() {
    if (!myPos || Date.now() - lastSavedPosAt < 60000) return;
    lastSavedPosAt = Date.now();
    S.lastPos = { lat: myPos.lat, lng: myPos.lng };
    save();
  }
  function showMe() {
    if (myPos && mv) mv.setMe(myPos);
  }
  let watchId = null;
  function startWatch() {
    if (!navigator.geolocation || watchId != null) return;
    watchId = navigator.geolocation.watchPosition((p) => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude }; showMe(); rememberPos();
    }, () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
  }

  // ---------- Γεωκωδικοποίηση ----------
  function photonLabel(p) {
    const pr = p.properties || {};
    const street = pr.street ? (pr.street + (pr.housenumber ? ' ' + pr.housenumber : '')) : '';
    const main = pr.name && pr.name !== pr.street ? pr.name : street;
    const parts = [main, pr.name && pr.name !== pr.street ? street : '', pr.postcode, pr.city || pr.town || pr.village || pr.district, pr.country && pr.country !== 'Ελλάς' && pr.country !== 'Greece' ? pr.country : '']
      .filter(Boolean);
    return [...new Set(parts)].join(', ') || pr.name || 'Σημείο';
  }

  // Σημείο αναφοράς για την αναζήτηση: θέση μου -> κέντρο των στάσεων -> αφετηρία -> χάρτης
  function searchBias() {
    if (myPos) return myPos;
    const pts = S.stops.filter((x) => !x.done);
    if (pts.length) return { lat: pts.reduce((a, x) => a + x.lat, 0) / pts.length, lng: pts.reduce((a, x) => a + x.lng, 0) / pts.length };
    if (S.start) return S.start;
    return mv ? mv.getCenter() : DEFAULT_CENTER;
  }

  // Photon με επανάληψη: ο δημόσιος server απαντά συχνά 503 όταν είναι φορτωμένος
  let photonTrouble = 0; // πόσα σφάλματα είδαμε πρόσφατα (για να «χαλαρώνουμε» τον ρυθμό)
  async function photon(q, limit, bias, bbox) {
    const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=${limit}&lat=${bias.lat}&lon=${bias.lng}` + (bbox ? `&bbox=${bbox.join(',')}` : '');
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) { photonTrouble = Math.max(0, photonTrouble - 1); return (await r.json()).features || []; }
        lastErr = new Error('photon ' + r.status);
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) { lastErr = e; }
      photonTrouble++;
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
    throw lastErr || new Error('photon');
  }

  function toResult(f, q, best) {
    return {
      label: photonLabel(f), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      exact: best ? best.s.exact : !!(f.properties && f.properties.housenumber), query: q
    };
  }

  // Λίστα προτάσεων (για την αναζήτηση): ταξινομημένες, οι λάθος δρόμοι στο τέλος
  async function geocode(q, limit) {
    const bias = searchBias();
    try {
      const feats = await photon(q, 10, bias);
      const pq = RootingGeo.parseQuery(q);
      const ranked = feats.filter((f) => f.geometry).map((f) => ({ f, s: RootingGeo.scoreFeature(pq, f, bias) }))
        .sort((a, b) => ((b.s.streetOk && !b.s.areaBad) - (a.s.streetOk && !a.s.areaBad)) || (b.s.score - a.s.score));
      if (ranked.length) return ranked.slice(0, limit || 6).map((x) => toResult(x.f, q, x));
    } catch (e) { /* fallback */ }
    const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=0&accept-language=el&limit=${limit || 6}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Σφάλμα αναζήτησης');
    const j = await r.json();
    return j.map((x) => ({ label: x.display_name.split(',').slice(0, 4).join(','), lat: +x.lat, lng: +x.lon, exact: false, query: q }));
  }

  // Μία διεύθυνση (screenshot / λίστα): διαλέγει το σωστό αποτέλεσμα, αλλιώς δοκιμάζει
  // χωρίς ΤΚ και χωρίς αριθμό. Δεν επιστρέφει δρόμο σε λάθος πόλη.
  // ---------- Google (προαιρετικό, με δικό σου κλειδί) ----------
  // Το κλειδί μένει μόνο σε αυτό το κινητό (localStorage), δεν ανεβαίνει πουθενά.
  const GOOGLE_MONTH_LIMIT = 9500; // λίγο κάτω από τις 10.000 δωρεάν τον μήνα
  let googleP = null, googleKeyLoaded = '', googleBadKeyWarned = false;
  function monthKey() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1); }
  function googleUsage() {
    const u = S.settings.googleUsage || {};
    return u.month === monthKey() ? u.count : 0;
  }
  function countGoogle() {
    S.settings.googleUsage = { month: monthKey(), count: googleUsage() + 1 };
    save();
  }
  function googleEnabled() { return !!S.settings.googleKey && googleUsage() < GOOGLE_MONTH_LIMIT; }

  // Φορτώνει μία φορά τη βιβλιοθήκη Google (χάρτης + αναζήτηση). Αλλαγή κλειδιού -> επαναφόρτωση σελίδας.
  let googleAuthFailed = false;
  function loadGoogleCore() {
    if (googleP) return googleP;
    const key = S.settings.googleKey;
    googleKeyLoaded = key;
    googleP = new Promise((resolve, reject) => {
      window.gm_authFailure = () => {
        googleAuthFailed = true;
        reject(new Error('Το κλειδί Google δεν δέχεται (έλεγξε τους περιορισμούς του)'));
        onGoogleAuthFailure();
      };
      window.__rootingGmReady = () => resolve(true);
      const sc = document.createElement('script');
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=el&region=GR&loading=async&callback=__rootingGmReady`;
      sc.async = true;
      sc.onerror = () => reject(new Error('Δεν φορτώθηκε η Google'));
      document.head.appendChild(sc);
    });
    return googleP;
  }
  let geocoderP = null;
  function loadGoogle() {
    if (googleAuthFailed) return Promise.reject(new Error('Το κλειδί Google δεν δέχεται'));
    if (!geocoderP) {
      geocoderP = loadGoogleCore().then(() => google.maps.importLibrary('geocoding')).then(({ Geocoder }) => new Geocoder());
      geocoderP.catch(() => { geocoderP = null; });
    }
    return geocoderP;
  }

  // Επιστρέφει {label, lat, lng, exact} ή null. exact = βρέθηκε ακριβώς ο αριθμός/κτίριο.
  async function googleGeocode(q, near) {
    const geocoder = await loadGoogle();
    const req = { address: q, region: 'gr', componentRestrictions: { country: 'GR' } };
    if (near) req.bounds = { south: near.lat - 0.3, west: near.lng - 0.4, north: near.lat + 0.3, east: near.lng + 0.4 };
    countGoogle();
    let resp;
    try { resp = await geocoder.geocode(req); }
    catch (e) {
      const code = (e && e.code) || '';
      if (code === 'ZERO_RESULTS') return null;
      if (code === 'REQUEST_DENIED' && !googleBadKeyWarned) { googleBadKeyWarned = true; toast('Η Google αρνήθηκε το κλειδί — έλεγξε τις ρυθμίσεις του'); }
      throw e;
    }
    const r = resp && resp.results && resp.results[0];
    if (!r) return null;
    const exactTypes = ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'];
    const exact = !r.partial_match && r.types.some((t) => exactTypes.includes(t));
    const loc = r.geometry.location;
    return {
      label: r.formatted_address.replace(/,\s*(Ελλάδα|Greece)$/i, ''),
      lat: typeof loc.lat === 'function' ? loc.lat() : loc.lat,
      lng: typeof loc.lng === 'function' ? loc.lng() : loc.lng,
      exact, query: q, google: true
    };
  }

  // region: {lat, lng} -> αναζήτηση μόνο γύρω από εκεί (~35 χλμ), και με σκέτο όνομα δρόμου
  async function geocodeSmart(q, region) {
    // Με κλειδί Google: πρώτα Google (1 αίτημα), και μόνο αν δεν βρει, τα δωρεάν
    if (googleEnabled()) {
      try {
        const g = await googleGeocode(q, region || searchBias());
        // δεχόμαστε αποτέλεσμα που είναι τουλάχιστον σε επίπεδο δρόμου
        if (g && (!region || RootingGeo.distKm(region, g) < 50)) return g;
      } catch (e) { /* συνεχίζουμε με τα δωρεάν */ }
    }
    const noPostal = q.replace(/(^|\D)\d{3}\s?\d{2}(?!\d)/g, '$1').replace(/\s+,/g, ',').replace(/[,\s]+$/, '').trim();
    // αφαιρεί τον αριθμό σπιτιού (τον τελευταίο αριθμό πριν το πρώτο κόμμα)
    const noNumber = noPostal.replace(/\s\d{1,4}\p{L}?(?=\s*(,|$))/u, '').replace(/\s+,/g, ',').trim();
    const streetOnly = noNumber.split(',')[0].trim();
    const variants = [...new Set(region ? [q, noNumber, streetOnly] : [q, noPostal, noNumber])].filter((v) => v.length > 2);
    const bias = region || searchBias();
    const bbox = region ? [region.lng - 0.4, region.lat - 0.3, region.lng + 0.4, region.lat + 0.3] : null;
    let errors = 0;
    for (const v of variants) {
      try {
        const feats = await photon(v, 10, bias, bbox);
        const best = RootingGeo.pickBest(q, feats, bias);
        if (best) return toResult(best.f, q, best);
      } catch (e) { errors++; }
    }
    if (errors === variants.length) {
      // Photon εκτός λειτουργίας: εφεδρικά Nominatim (βρίσκει μόνο δρόμους)
      const r = await geocode(noNumber || q, 1);
      if (r[0]) return Object.assign(r[0], { exact: false, query: q });
      throw new Error('Δεν υπάρχει σύνδεση με την υπηρεσία αναζήτησης');
    }
    return null;
  }

  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lng}&limit=1`);
      const j = await r.json();
      if (j.features && j.features[0]) return photonLabel(j.features[0]);
    } catch (e) { /* ignore */ }
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // ---------- Αναζήτηση UI ----------
  const searchEl = $('search');
  const sugEl = $('suggestions');
  let searchTimer = null, searchSeq = 0, lastResults = [];

  function renderSuggestions(list, onPick) {
    sugEl.innerHTML = '';
    if (!list.length) { sugEl.classList.add('hidden'); return; }
    list.forEach((it) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      li.onmousedown = (e) => e.preventDefault();
      li.onclick = () => onPick(it);
      sugEl.appendChild(li);
    });
    sugEl.classList.remove('hidden');
  }

  function pickSuggestion(it) {
    if (it.google) it = Object.assign({}, it, { label: it.label.replace(/^📍 /, '') });
    // αν ο χάρτης βρήκε μόνο τον δρόμο, κρατάμε αυτό που έγραψες (με τον αριθμό) για την πλοήγηση
    if (!it.exact && /\d/.test(it.query || '')) it = Object.assign({}, it, { orig: it.query });
    addStop(it);
    searchEl.value = '';
    sugEl.classList.add('hidden');
  }

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 3) { sugEl.classList.add('hidden'); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        let res = await geocode(q).catch(() => []);
        if (googleEnabled() && /\d/.test(q) && q.length >= 6) {
          try {
            const g = await googleGeocode(q, searchBias());
            if (g) res = [Object.assign(g, { label: '📍 ' + g.label })].concat(res.slice(0, 4));
          } catch (e) { /* μόνο τα δωρεάν */ }
        }
        if (seq !== searchSeq) return;
        lastResults = res;
        renderSuggestions(res.length ? res : [], pickSuggestion);
        if (!res.length) toast('Δεν βρέθηκε η διεύθυνση');
      } catch (e) { if (seq === searchSeq) toast('Δεν υπάρχει σύνδεση για αναζήτηση'); }
    }, googleEnabled() ? 700 : 350);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastResults[0] && !sugEl.classList.contains('hidden')) { e.preventDefault(); pickSuggestion(lastResults[0]); }
  });
  searchEl.addEventListener('blur', () => setTimeout(() => sugEl.classList.add('hidden'), 200));

  // ---------- Στάσεις ----------
  function addStop(p) {
    S.stops.push({ id: uid(), label: p.label, lat: p.lat, lng: p.lng, note: '', phone: '', orig: p.orig || '', exact: p.exact !== false, done: false });
    invalidateRoute();
    save(); render();
    if (mv) mv.setView(p.lat, p.lng, Math.max(mv.getZoom(), 14));
    toast('Προστέθηκε: ' + p.label.split(',')[0]);
  }

  function invalidateRoute() {
    if (S.route) S.route = null;
  }

  function orderedStops() {
    if (S.route) {
      const byId = new Map(S.stops.map((s) => [s.id, s]));
      const out = S.route.order.map((id) => byId.get(id)).filter(Boolean);
      // στάσεις που προστέθηκαν μετά (δεν θα έπρεπε, αλλά για ασφάλεια)
      S.stops.forEach((s) => { if (!S.route.order.includes(s.id)) out.push(s); });
      return out;
    }
    return S.stops.slice();
  }

  // Τίτλος στάσης: η διεύθυνση όπως τη δώσαμε (με αριθμό), αλλιώς αυτή του χάρτη
  function title(s) { return s.orig || s.label; }

  // ---------- Απόδοση ----------
  function fmtDur(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return m + "'";
    return Math.floor(m / 60) + 'ω ' + String(m % 60).padStart(2, '0') + "'";
  }
  function fmtKm(m) { return m < 950 ? Math.round(m / 10) * 10 + ' μ' : (m / 1000).toFixed(m < 9950 ? 1 : 0) + ' χλμ'; }
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' }); }

  // ETA για κάθε στάση με βάση τα σκέλη της διαδρομής
  function computeEtas(list) {
    const etas = {};
    if (!S.route || !S.route.legs) return etas;
    let t = S.route.startedAt;
    const svc = (S.settings.serviceMin || 0) * 60000;
    const pre = S.route.pre || 0;
    list.forEach((s, i) => {
      const leg = S.route.legs[i];
      if (!leg || i < pre) return;
      t += leg.duration * 1000;
      etas[s.id] = { at: t, leg };
      t += svc;
    });
    return etas;
  }

  function render() {
    const list = orderedStops();
    const etas = computeEtas(list);
    const stopsEl = $('stops'), doneEl = $('doneStops');
    stopsEl.innerHTML = ''; doneEl.innerHTML = '';
    const nextStop = S.route ? list.find((s) => !s.done) : null;

    list.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'stop-row';
      const eta = etas[s.id];
      const meta = [];
      if (eta && !s.done) meta.push(`🕒 ${fmtClock(eta.at)}`, `${fmtKm(eta.leg.distance)} · ${fmtDur(eta.leg.duration)}`);
      if (s.note) meta.push('📝 ' + s.note);
      if (s.phone) meta.push('📞 ' + s.phone);
      li.innerHTML = `
        <div class="sw-bg"><span class="sw-done">${s.done ? '↺ Επαναφορά' : '✓ Παραδόθηκε'}</span><span class="sw-del">🗑 Διαγραφή</span></div>
        <div class="stop${s.done ? ' done' : ''}${nextStop && nextStop.id === s.id ? ' current' : ''}">
          <span class="num">${s.done ? '✓' : (S.route ? i + 1 : '•')}</span>
          <span class="stop-body">
            <span class="stop-title">${esc(title(s))}</span>
            ${meta.length ? `<span class="stop-meta">${meta.map(esc).join('  ·  ')}</span>` : ''}
          </span>
          <span class="chev">›</span>
        </div>`;
      attachSwipe(li, s);
      (s.done ? doneEl : stopsEl).appendChild(li);
    });
    const doneN = list.filter((s) => s.done).length;
    $('doneBox').classList.toggle('hidden', !doneN);
    $('doneSummary').textContent = `✓ Παραδόθηκαν (${doneN})`;
    $('swipeHint').classList.toggle('hidden', !list.some((s) => !s.done));

    $('stopCount').textContent = S.stops.length;
    const done = S.stops.filter((s) => s.done).length;
    $('doneCount').textContent = S.route && S.stops.length ? `✓ ${done}/${S.stops.length}` : '';
    $('emptyHint').classList.toggle('hidden', S.stops.length > 0);

    $('startLabel').textContent = S.start ? S.start.label : '📍 Τρέχουσα τοποθεσία';
    $('endLabel').textContent = S.endMode === 'cycle' ? '↩︎ Επιστροφή στην αφετηρία'
      : S.endMode === 'fixed' && S.end ? S.end.label : 'Όπου τελειώσει η τελευταία στάση';

    // Κουμπί βελτιστοποίησης
    const btn = $('btnOptimize');
    const remaining = S.stops.filter((s) => !s.done).length;
    if (S.route && remaining && done) btn.textContent = '⚡ Νέα βελτιστοποίηση από τη θέση μου';
    else if (S.route) btn.textContent = '⚡ Ξανά βελτιστοποίηση';
    else btn.textContent = '⚡ Βελτιστοποίηση διαδρομής';
    btn.disabled = remaining === 0;

    // Κάρτα επόμενης στάσης
    const card = $('nextCard');
    if (nextStop) {
      card.classList.remove('hidden');
      const idx = list.indexOf(nextStop);
      $('nextIdx').textContent = `${idx + 1}/${list.length}`;
      // πρόοδος + τι απομένει
      const pending = list.filter((x) => !x.done);
      let remSec = 0, remM = 0;
      list.forEach((x, k) => { if (!x.done && S.route.legs && S.route.legs[k]) { remSec += S.route.legs[k].duration + (S.settings.serviceMin || 0) * 60; remM += S.route.legs[k].distance; } });
      $('nextRemain').textContent = `μένουν ${pending.length}` + (S.route.legs ? ` · ~${fmtDur(remSec)} · ${fmtKm(remM)}` : '');
      $('nextProgress').style.width = Math.round((done / list.length) * 100) + '%';
      const call = $('btnCallNext');
      call.classList.toggle('hidden', !nextStop.phone);
      if (nextStop.phone) call.href = 'tel:' + nextStop.phone.replace(/\s/g, '');
      $('nextTitle').textContent = title(nextStop);
      const eta = etas[nextStop.id];
      const sub = [];
      if (eta) sub.push(`Άφιξη ~${fmtClock(eta.at)}`);
      if (nextStop.note) sub.push(nextStop.note);
      $('nextSub').textContent = sub.join(' · ');
      $('btnNavNext').href = navUrl(nextStop);
      if (navUrl(nextStop).startsWith('http')) $('btnNavNext').target = '_blank'; else $('btnNavNext').removeAttribute('target');
      $('btnDoneNext').onclick = () => markDone(nextStop.id, true, true);
      $('btnSkipNext').onclick = () => skipStop(nextStop.id);
      $('btnFullRoute').textContent = '🗺 ' + chunkLabel();
      $('btnFullRoute').href = googleFullRouteUrl();
      $('btnFullRoute').onclick = () => startBatch();
      $('btnReopt').textContent = done ? '⚡ Από εδώ' : '⚡ Νέα σειρά';
      renderBatchBar(list);
    } else card.classList.add('hidden');
    document.body.classList.toggle('has-route', !!nextStop);
    if (typeof sheetState !== 'undefined' && sheetState === 'peek') requestAnimationFrame(() => setSheet('peek'));
    if (driveOpen) renderDrive();

    // Σύνοψη
    const sum = $('summary');
    if (S.route && S.route.legs) {
      const dist = S.route.legs.reduce((a, l) => a + l.distance, 0);
      const dur = S.route.legs.reduce((a, l) => a + l.duration, 0);
      const svc = (S.route.order.length - (S.route.pre || 0)) * (S.settings.serviceMin || 0) * 60;
      const finish = S.route.startedAt + (dur + svc) * 1000;
      sum.innerHTML = `<div><b>${fmtKm(dist)}</b><small>απόσταση</small></div>
        <div><b>${fmtDur(dur)}</b><small>οδήγηση</small></div>
        <div><b>${fmtClock(finish)}</b><small>τέλος περίπου</small></div>`;
      if (!nextStop) sum.innerHTML += `<div class="all-done">🎉 Παραδόθηκαν όλα!</div>`;
      sum.classList.remove('hidden');
    } else sum.classList.add('hidden');

    drawMap(list, nextStop);
  }

  function drawMap(list, nextStop) {
    if (!mv) return;
    const items = [];
    const origin = S.route && S.route.origin ? S.route.origin : S.start;
    if (origin) items.push({ lat: origin.lat, lng: origin.lng, text: '▶', cls: 'pin-start', title: 'Αφετηρία', z: 2 });
    list.forEach((s, i) => {
      const isNext = nextStop && nextStop.id === s.id;
      items.push({
        lat: s.lat, lng: s.lng, text: s.done ? '✓' : (S.route ? String(i + 1) : '•'),
        cls: s.done ? 'pin-done' : (isNext ? 'pin-next' : ''), title: title(s),
        z: isNext ? 50 : (s.done ? 1 : 10), onClick: () => stopPopup(s.id)
      });
    });
    if (S.endMode === 'fixed' && S.end) items.push({ lat: S.end.lat, lng: S.end.lng, text: '■', cls: 'pin-end', title: 'Τέλος', z: 2 });
    mv.setMarkers(items);
    mv.setRoute(S.route && S.route.geometry ? S.route.geometry : null, !!(S.route && S.route.approx));
  }

  function fitAll() {
    if (!mv) return;
    const pts = [];
    const origin = S.route && S.route.origin ? S.route.origin : S.start;
    if (origin) pts.push({ lat: origin.lat, lng: origin.lng });
    S.stops.filter((s) => !s.done).forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
    if (!pts.length) S.stops.forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
    if (S.endMode === 'fixed' && S.end) pts.push({ lat: S.end.lat, lng: S.end.lng });
    if (myPos && !pts.length) pts.push(myPos);
    const top = (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0) + 30;
    mv.fit(pts, { top, bottom: 30, left: 30, right: 70 });
  }

  // ---------- Πλοήγηση ----------
  // Προορισμός για την πλοήγηση: συντεταγμένες αν βρέθηκε ακριβής αριθμός,
  // αλλιώς το κείμενο της διεύθυνσης (το Google Maps ξέρει τους αριθμούς καλύτερα)
  function navTarget(s) {
    if (s.orig && s.exact === false) return { text: s.orig + (/ελλ[αά]δα|greece/i.test(s.orig) ? '' : ', Ελλάδα') };
    return { ll: `${s.lat},${s.lng}` };
  }
  function navUrl(s) {
    const t = navTarget(s);
    if (t.text) {
      const q = encodeURIComponent(t.text);
      switch (S.settings.navApp) {
        case 'google': return `comgooglemaps://?daddr=${q}&directionsmode=driving`;
        case 'waze': return `https://waze.com/ul?q=${q}&navigate=yes`;
        default: return `https://maps.apple.com/?daddr=${q}&dirflg=d`;
      }
    }
    const ll = t.ll;
    switch (S.settings.navApp) {
      case 'google': return `comgooglemaps://?daddr=${ll}&directionsmode=driving`;
      case 'waze': return `https://waze.com/ul?ll=${ll}&navigate=yes`;
      default: return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
    }
  }

  // Όλη η υπόλοιπη διαδρομή στο Google Maps (έως 10 στάσεις: 9 ενδιάμεσες + προορισμός)
  const GM_CHUNK = 10;
  function nextChunk() { return orderedStops().filter((s) => !s.done).slice(0, GM_CHUNK); }
  function googleFullRouteUrl(web) {
    const chunk = nextChunk();
    if (!chunk.length) return null;
    const ll = (s) => { const t = navTarget(s); return t.text ? encodeURIComponent(t.text) : `${s.lat},${s.lng}`; };
    if (!web) return `comgooglemaps://?daddr=${chunk.map(ll).join('+to:')}&directionsmode=driving`;
    const dest = chunk[chunk.length - 1];
    const raw = (s) => { const t = navTarget(s); return t.text || `${s.lat},${s.lng}`; };
    const wps = chunk.slice(0, -1).map(raw).join('|');
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(raw(dest))}` + (wps ? `&waypoints=${encodeURIComponent(wps)}` : '');
  }
  function openUrl(url) { window.location.href = url; }

  // ---------- Ενέργειες στάσεων ----------
  function markDone(id, val, undoable) {
    const s = S.stops.find((x) => x.id === id);
    if (!s) return;
    if (undoable) offerUndo(val ? `✓ Παραδόθηκε: ${title(s).split(',')[0]}` : 'Η στάση επανήλθε');
    s.done = val; s.doneAt = val ? Date.now() : null;
    save(); render();
    if (val) {
      const next = orderedStops().find((x) => !x.done);
      if (next && mv) mv.panTo(next.lat, next.lng);
      if (navigator.vibrate) navigator.vibrate(30);
    }
  }

  function skipStop(id) {
    if (!S.route) return;
    const o = S.route.order;
    const i = o.indexOf(id);
    if (i < 0) return;
    o.splice(i, 1); o.push(id);
    S.route.legs = null; // τα ETA δεν ισχύουν πια
    S.route.geometry = null;
    save(); render();
    toast('Η στάση μετακινήθηκε στο τέλος. Πάτα «Βελτιστοποίηση» για νέους χρόνους.');
  }

  function moveStop(id, dir) {
    if (S.route) {
      const o = S.route.order, i = o.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      S.route.legs = null; S.route.geometry = null;
    } else {
      const a = S.stops, i = a.findIndex((s) => s.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
    }
    save(); render();
  }

  function deleteStop(id, undoable) {
    const st = S.stops.find((x) => x.id === id);
    if (undoable && st) offerUndo(`Διαγράφηκε: ${title(st).split(',')[0]}`);
    S.stops = S.stops.filter((s) => s.id !== id);
    if (S.route) {
      S.route.order = S.route.order.filter((x) => x !== id);
      S.route.legs = null; S.route.geometry = null;
      if (!S.route.order.length) S.route = null;
    }
    save(); render();
  }


  // ---------- Αναίρεση ----------
  let undoSnap = null, undoT = null;
  function offerUndo(msg) {
    undoSnap = JSON.stringify(S);
    const t = $('toast');
    t.innerHTML = '';
    const span = document.createElement('span'); span.textContent = msg;
    const b = document.createElement('button'); b.className = 'toast-btn'; b.textContent = 'Αναίρεση';
    b.onclick = () => {
      if (!undoSnap) return;
      const keepSettings = S.settings;
      S = JSON.parse(undoSnap); S.settings = keepSettings; undoSnap = null;
      save(); render(); t.classList.add('hidden');
    };
    t.appendChild(span); t.appendChild(b);
    t.classList.remove('hidden'); t.classList.add('with-btn');
    clearTimeout(toastT); clearTimeout(undoT);
    undoT = setTimeout(() => { t.classList.add('hidden'); t.classList.remove('with-btn'); undoSnap = null; }, 5000);
  }

  // ---------- Σύρσιμο στη λίστα: δεξιά = Παραδόθηκε, αριστερά = Διαγραφή ----------
  function attachSwipe(li, s) {
    const card = li.querySelector('.stop');
    let x0 = 0, y0 = 0, dx = 0, mode = null;
    card.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; card.style.transition = 'none'; }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      const ddx = e.touches[0].clientX - x0, ddy = e.touches[0].clientY - y0;
      if (!mode) {
        if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.3) mode = 'swipe';
        else if (Math.abs(ddy) > 10) mode = 'no';
        else return;
      }
      if (mode !== 'swipe') return;
      e.preventDefault();
      dx = ddx;
      card.style.transform = `translateX(${dx}px)`;
      li.classList.toggle('sw-r', dx > 0); li.classList.toggle('sw-l', dx < 0);
      li.classList.toggle('sw-armed', Math.abs(dx) > 90);
    }, { passive: false });
    card.addEventListener('touchend', () => {
      card.style.transition = 'transform .2s';
      if (mode === 'swipe' && Math.abs(dx) > 90) {
        card.style.transform = `translateX(${dx > 0 ? '100%' : '-100%'})`;
        if (navigator.vibrate) navigator.vibrate(15);
        setTimeout(() => { if (dx > 0) markDone(s.id, !s.done, true); else deleteStop(s.id, true); }, 160);
      } else { card.style.transform = ''; li.classList.remove('sw-r', 'sw-l', 'sw-armed'); }
      if (mode === 'swipe') card.dataset.swiped = '1';
    });
    card.addEventListener('click', () => {
      if (card.dataset.swiped) { delete card.dataset.swiped; return; }
      openStop(s.id);
    });
  }

  // ---------- Καρτούλα πάνω στην πινέζα ----------
  function stopPopup(id) {
    const s = S.stops.find((x) => x.id === id);
    if (!s || !mv) return;
    const el = document.createElement('div');
    el.className = 'map-popup';
    const url = navUrl(s);
    el.innerHTML = `<div class="mp-title">${esc(title(s))}</div>
      ${s.note ? `<div class="mp-note">📝 ${esc(s.note)}</div>` : ''}
      <div class="mp-btns">
        <a class="btn btn-primary" href="${esc(url)}"${url.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>➤</a>
        <button class="btn ${s.done ? 'btn-ghost' : 'btn-success'}" data-a="done">${s.done ? '↺' : '✓ Παραδόθηκε'}</button>
        ${s.phone ? `<a class="btn btn-ghost" href="tel:${esc(s.phone.replace(/\s/g, ''))}">📞</a>` : ''}
        <button class="btn btn-ghost" data-a="more">⋯</button>
      </div>`;
    el.querySelector('[data-a="done"]').onclick = () => { mv.closePopup(); markDone(s.id, !s.done, true); };
    el.querySelector('[data-a="more"]').onclick = () => { mv.closePopup(); openStop(s.id); };
    mv.popup(s.lat, s.lng, el);
  }

  // ---------- Πακέτα 10 στάσεων για το Google Maps ----------
  function chunkLabel() {
    const list = orderedStops(), ch = nextChunk();
    if (!ch.length) return 'Google Maps';
    const a = list.indexOf(ch[0]) + 1, b = list.indexOf(ch[ch.length - 1]) + 1;
    return ch.length > 1 ? `Στάσεις ${a}–${b}` : `Στάση ${a}`;
  }
  function startBatch() {
    const ch = nextChunk();
    S.batch = { ids: ch.map((x) => x.id), label: chunkLabel() };
    save();
    setTimeout(render, 300);
  }
  function renderBatchBar(list) {
    const bar = $('batchBar');
    const b = S.batch;
    const open = b && b.ids.some((id) => { const x = list.find((y) => y.id === id); return x && !x.done; });
    bar.classList.toggle('hidden', !open);
    if (!open) return;
    const restAfter = list.filter((x) => !x.done && !b.ids.includes(x.id)).slice(0, GM_CHUNK);
    $('batchText').textContent = `Στο Google Maps: ${b.label}`;
    $('btnBatchDone').textContent = restAfter.length ? `✓ Τελείωσα · Επόμενες ${restAfter.length} ➜` : '✓ Τελείωσα αυτές';
    $('btnBatchDone').onclick = () => {
      offerUndo(`✓ ${b.label} παραδόθηκαν`);
      b.ids.forEach((id) => { const x = S.stops.find((y) => y.id === id); if (x && !x.done) { x.done = true; x.doneAt = Date.now(); } });
      S.batch = null; save(); render();
      if (nextChunk().length) { const url = googleFullRouteUrl(); startBatch(); openUrl(url); }
    };
    $('btnBatchCancel').onclick = () => { S.batch = null; save(); render(); };
  }

  // ---------- Δορυφόρος ----------
  $('btnSat').onclick = () => {
    S.settings.satellite = !S.settings.satellite; save();
    mv.setSatellite(S.settings.satellite);
    $('btnSat').classList.toggle('on', !!S.settings.satellite);
  };

  // ---------- Modal ----------
  function openModal(title, html, onMount) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modal').classList.remove('hidden');
    if (onMount) onMount($('modalBody'));
  }
  function closeModal() { $('modal').classList.add('hidden'); $('modalBody').innerHTML = ''; }
  document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));

  function openStop(id) {
    const s = S.stops.find((x) => x.id === id);
    if (!s) return;
    if (mv) mv.setView(s.lat, s.lng, Math.max(mv.getZoom(), 15));
    openModal('Στάση', `
      <p class="stop-full">${esc(title(s))}</p>
      ${s.orig ? `<p class="muted small">Στον χάρτη: ${esc(s.label)}${s.exact === false ? ' (βρέθηκε μόνο ο δρόμος — η πλοήγηση θα ψάξει τον ακριβή αριθμό)' : ''}</p>` : ''}
      <div class="grid2">
        <a class="btn btn-primary" href="${esc(navUrl(s))}"${navUrl(s).startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>➤ Πλοήγηση</a>
        <button class="btn ${s.done ? 'btn-ghost' : 'btn-success'}" id="mDone">${s.done ? '↺ Δεν παραδόθηκε' : '✓ Παραδόθηκε'}</button>
      </div>
      <label class="field"><span>Σημείωση</span><input id="mNote" type="text" value="${esc(s.note)}" placeholder="π.χ. 3ος όροφος, κουδούνι Παπαδόπουλος"></label>
      <label class="field"><span>Τηλέφωνο</span><input id="mPhone" type="tel" value="${esc(s.phone)}" placeholder="69…"></label>
      ${s.phone ? `<a class="btn btn-ghost btn-block" href="tel:${esc(s.phone.replace(/\s/g, ''))}">📞 Κλήση ${esc(s.phone)}</a>` : ''}
      <div class="grid3">
        <button class="btn btn-ghost" id="mUp">↑ Πάνω</button>
        <button class="btn btn-ghost" id="mDown">↓ Κάτω</button>
        <button class="btn btn-danger" id="mDel">Διαγραφή</button>
      </div>`, (b) => {
      const persist = () => { s.note = b.querySelector('#mNote').value.trim(); s.phone = b.querySelector('#mPhone').value.trim(); save(); render(); };
      b.querySelector('#mNote').addEventListener('change', persist);
      b.querySelector('#mPhone').addEventListener('change', persist);
      b.querySelector('#mDone').onclick = () => { persist(); markDone(s.id, !s.done, true); closeModal(); };
      b.querySelector('#mUp').onclick = () => { persist(); moveStop(s.id, -1); };
      b.querySelector('#mDown').onclick = () => { persist(); moveStop(s.id, 1); };
      b.querySelector('#mDel').onclick = () => { deleteStop(s.id, true); closeModal(); };
    });
  }

  // Επιλογή σημείου (για αφετηρία / τέλος)
  function pickPlace(title, extraHtml, onPick, onMount) {
    openModal(title, `${extraHtml || ''}
      <div class="search-wrap"><input id="pSearch" type="search" placeholder="Αναζήτηση διεύθυνσης…" autocomplete="off"></div>
      <ul id="pRes" class="suggestions static"></ul>`, (b) => {
      const inp = b.querySelector('#pSearch'), res = b.querySelector('#pRes');
      let t = null, seq = 0;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        const q = inp.value.trim();
        if (q.length < 3) { res.innerHTML = ''; return; }
        t = setTimeout(async () => {
          const my = ++seq;
          try {
            const r = await geocode(q);
            if (my !== seq) return;
            res.innerHTML = '';
            r.forEach((it) => {
              const li = document.createElement('li');
              li.textContent = it.label;
              li.onclick = () => { onPick(it); closeModal(); };
              res.appendChild(li);
            });
          } catch (e) { toast('Δεν υπάρχει σύνδεση'); }
        }, 350);
      });
      if (onMount) onMount(b);
    });
  }

  $('startRow').onclick = () => pickPlace('Αφετηρία',
    `<button class="btn btn-ghost btn-block" id="useGps">📍 Χρήση τρέχουσας τοποθεσίας</button>`,
    (it) => { S.start = it; invalidateRoute(); save(); render(); fitAll(); },
    (b) => { b.querySelector('#useGps').onclick = () => { S.start = null; invalidateRoute(); save(); render(); closeModal(); }; });

  $('endRow').onclick = () => pickPlace('Τέλος διαδρομής',
    `<button class="btn btn-ghost btn-block" id="endOpen">Όπου τελειώσει η τελευταία στάση</button>
     <button class="btn btn-ghost btn-block" id="endCycle">↩︎ Επιστροφή στην αφετηρία</button>
     <p class="muted small">…ή διάλεξε συγκεκριμένο σημείο τέλους:</p>`,
    (it) => { S.endMode = 'fixed'; S.end = it; invalidateRoute(); save(); render(); fitAll(); },
    (b) => {
      b.querySelector('#endOpen').onclick = () => { S.endMode = 'open'; S.end = null; invalidateRoute(); save(); render(); closeModal(); };
      b.querySelector('#endCycle').onclick = () => { S.endMode = 'cycle'; S.end = null; invalidateRoute(); save(); render(); closeModal(); };
    });

  // ---------- Μαζική εισαγωγή ----------
  $('btnPaste').onclick = () => openModal('Λίστα διευθύνσεων', `
    <p class="muted small">Μία διεύθυνση σε κάθε γραμμή. Μπορείς να κάνεις αντιγραφή από Excel, Σημειώσεις, Viber κ.λπ.<br>Βάλε και περιοχή/πόλη για καλύτερο αποτέλεσμα (π.χ. «Ερμού 10, Αθήνα»).</p>
    <textarea id="bulk" rows="8" placeholder="Ερμού 10, Αθήνα&#10;Πατησίων 76, Αθήνα&#10;Λεωφ. Κηφισίας 120, Μαρούσι"></textarea>
    <button class="btn btn-primary btn-block" id="bulkGo">Προσθήκη</button>
    <div id="bulkLog" class="bulk-log"></div>`, (b) => {
    b.querySelector('#bulkGo').onclick = async () => {
      const lines = b.querySelector('#bulk').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const log = b.querySelector('#bulkLog');
      const btn = b.querySelector('#bulkGo');
      btn.disabled = true;
      if (!myPos) { btn.textContent = 'Εντοπισμός θέσης…'; try { await getPosition(6000); } catch (e) { /* συνεχίζουμε χωρίς */ } }
      const out = await geocodeBatch(lines.map((l) => ({ addr: l })), (t) => { btn.textContent = t; });
      btn.disabled = false; btn.textContent = 'Προσθήκη';
      showBatchResult(log, btn, out);
    };
  });



  // ---------- Μαζικός εντοπισμός (λίστα / screenshot) ----------
  // 1ος γύρος: κανονική αναζήτηση. Μετά βρίσκουμε την περιοχή όπου έπεσαν οι περισσότερες στάσεις
  // και ξαναψάχνουμε εκεί όσες δεν βρέθηκαν ή έπεσαν πολύ μακριά (π.χ. ίδιος δρόμος σε άλλη πόλη).
  function median(a) { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; }
  async function geocodeBatch(entries, progress) {
    const res = new Array(entries.length).fill(null);
    let netErr = 0;
    const pause = () => new Promise((r) => setTimeout(r, photonTrouble > 0 ? 1500 : 350));
    for (let i = 0; i < entries.length; i++) {
      progress(`Εντοπισμός ${i + 1}/${entries.length}…`);
      try { res[i] = await geocodeSmart(entries[i].addr); } catch (e) { res[i] = null; entries[i].err = true; }
      await pause();
    }
    const pts = res.filter(Boolean).concat(S.stops.filter((s) => !s.done));
    if (pts.length >= 2) {
      const center = { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) };
      const redo = entries.map((_, i) => i).filter((i) => !res[i] || RootingGeo.distKm(center, res[i]) > 40);
      for (let n = 0; n < redo.length; n++) {
        const i = redo[n];
        progress(`Δεύτερη προσπάθεια ${n + 1}/${redo.length}…`);
        try {
          const r = await geocodeSmart(entries[i].addr, center);
          if (r) { res[i] = r; entries[i].err = false; }
          else if (res[i]) res[i] = null; // ήταν σε λάθος πόλη
        } catch (e) { entries[i].err = true; }
        await pause();
      }
    }
    const failed = [];
    let added = 0;
    entries.forEach((e, i) => {
      const r = res[i];
      if (!r) { failed.push(e); if (e.err) netErr++; return; }
      S.stops.push({ id: uid(), label: r.label, lat: r.lat, lng: r.lng, note: e.name || '', phone: e.phone || '', orig: e.addr, exact: r.exact, done: false });
      added++;
    });
    if (added) { invalidateRoute(); save(); render(); fitAll(); }
    return { added, failed, netErr };
  }

  // Αποτέλεσμα + κουμπί «Ξαναδοκίμασε» για όσες δεν βρέθηκαν
  function showBatchResult(logEl, btn, out, rerun) {
    const { added, failed, netErr } = out;
    logEl.innerHTML = `<p>✓ Προστέθηκαν ${added} στάσεις.</p>` + (failed.length ? `
      <p class="err">Δεν βρέθηκαν στον χάρτη (${failed.length}):</p>
      <ul>${failed.map((f) => `<li>${esc(f.addr)}</li>`).join('')}</ul>
      ${netErr ? `<p class="muted small">⚠️ Η υπηρεσία αναζήτησης δεν απαντούσε για ${netErr} από αυτές. Περίμενε λίγο και πάτα «Ξαναδοκίμασε».</p>` : ''}
      <button class="btn btn-ghost btn-block" id="retryFailed">↻ Ξαναδοκίμασε όσες δεν βρέθηκαν</button>
      <p class="muted small">Όσες δεν βρίσκονται ούτε έτσι, λείπουν από τον δωρεάν χάρτη. Πρόσθεσέ τες από την αναζήτηση γράφοντας μόνο τον δρόμο ή πάτα παρατεταμένα στο σημείο πάνω στον χάρτη.</p>` : '');
    if (failed.length) {
      logEl.querySelector('#retryFailed').onclick = async () => {
        logEl.querySelector('#retryFailed').disabled = true;
        failed.forEach((f) => { f.err = false; });
        const again = await geocodeBatch(failed, (t) => { btn.textContent = t; });
        btn.textContent = 'Προσθήκη';
        again.added += added;
        showBatchResult(logEl, btn, again, rerun);
      };
    } else setTimeout(closeModal, 900);
  }

  // ---------- Διευθύνσεις από screenshot ----------
  $('btnShot').onclick = () => { $('shotInput').value = ''; $('shotInput').click(); };
  $('shotInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const found = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const label = files.length > 1 ? `Διαβάζω εικόνα ${i + 1}/${files.length}` : 'Διαβάζω την εικόνα';
        busy(true, label + '…');
        const text = await RootingOCR.recognize(files[i], (m) => {
          if (m.status === 'recognizing text') busy(true, `${label}… ${Math.round((m.progress || 0) * 100)}%`);
          else if (/loading|initializ/.test(m.status)) busy(true, 'Προετοιμασία αναγνώρισης κειμένου…\n(μόνο την πρώτη φορά αργεί)');
        });
        found.push(...RootingOCR.extract(text));
      }
    } catch (err) {
      console.error(err);
      busy(false);
      toast('Δεν ήταν δυνατή η ανάγνωση: ' + err.message);
      return;
    }
    busy(false);
    // διπλότυπα (επικαλυπτόμενα screenshots ή ήδη στη λίστα)
    const existing = new Set(S.stops.map((s) => RootingOCR.key(s.orig || '')));
    const seen = new Set();
    const items = [];
    found.forEach((f) => {
      const k = RootingOCR.key(f.address);
      if (seen.has(k)) return;
      seen.add(k);
      items.push(Object.assign({}, f, { dup: existing.has(k) }));
    });
    reviewFound(items);
  });

  function reviewFound(items) {
    if (!items.length) {
      openModal('Δεν βρέθηκαν διευθύνσεις', `<p>Δεν αναγνώρισα διευθύνσεις στην εικόνα.</p>
        <p class="muted small">Βεβαιώσου ότι οι διευθύνσεις φαίνονται καθαρά, ή χρησιμοποίησε «📋 Λίστα διευθύνσεων».</p>`);
      return;
    }
    openModal(`Βρέθηκαν ${items.length} διευθύνσεις`, `
      <p class="muted small">Έλεγξε και διόρθωσε αν χρειάζεται. Ξετσέκαρε όσες δεν θέλεις.</p>
      <ul class="found-list">${items.map((it, i) => `
        <li>
          <input type="checkbox" id="fc${i}" ${it.dup ? '' : 'checked'}>
          <div class="found-body">
            <input type="text" id="fa${i}" value="${esc(it.address)}">
            <small>${[it.name ? '👤 ' + esc(it.name) : '', it.phone ? '📞 ' + esc(it.phone) : '', it.dup ? '<b>υπάρχει ήδη</b>' : ''].filter(Boolean).join(' · ')}</small>
          </div>
        </li>`).join('')}</ul>
      <button class="btn btn-primary btn-block" id="foundGo">Προσθήκη</button>
      <div id="foundLog" class="bulk-log"></div>`, (b) => {
      const btn = b.querySelector('#foundGo');
      const count = () => items.filter((_, i) => b.querySelector('#fc' + i).checked).length;
      const upd = () => { btn.textContent = `Προσθήκη ${count()} στάσεων`; btn.disabled = !count(); };
      items.forEach((_, i) => b.querySelector('#fc' + i).addEventListener('change', upd));
      upd();
      btn.onclick = async () => {
        const chosen = items.map((it, i) => ({ it, on: b.querySelector('#fc' + i).checked, addr: b.querySelector('#fa' + i).value.trim() }))
          .filter((x) => x.on && x.addr);
        btn.disabled = true;
        if (!myPos) { btn.textContent = 'Εντοπισμός θέσης…'; try { await getPosition(6000); } catch (e) { /* συνεχίζουμε χωρίς */ } }
        const out = await geocodeBatch(chosen.map((x) => ({ addr: x.addr, name: x.it.name, phone: x.it.phone })), (t) => { btn.textContent = t; });
        btn.disabled = false; btn.textContent = 'Προσθήκη';
        showBatchResult(b.querySelector('#foundLog'), btn, out);
      };
    });
  }

  $('btnClear').onclick = () => {
    if (!S.stops.length) return;
    openModal('Καθαρισμός', `
      <button class="btn btn-ghost btn-block" id="clrDone">Διαγραφή μόνο των ολοκληρωμένων</button>
      <button class="btn btn-danger btn-block" id="clrAll">Διαγραφή όλων των στάσεων</button>`, (b) => {
      b.querySelector('#clrDone').onclick = () => {
        const ids = new Set(S.stops.filter((s) => s.done).map((s) => s.id));
        S.stops = S.stops.filter((s) => !ids.has(s.id));
        if (S.route) { S.route.order = S.route.order.filter((x) => !ids.has(x)); S.route.legs = null; S.route.geometry = null; if (!S.route.order.length) S.route = null; }
        save(); render(); closeModal();
      };
      b.querySelector('#clrAll').onclick = () => { S.stops = []; S.route = null; save(); render(); closeModal(); };
    });
  };

  // ---------- Ρυθμίσεις ----------
  $('btnSettings').onclick = () => openSettings(false);
  async function testGoogleKey(info) {
    if (!S.settings.googleKey) return;
    info.textContent = 'Δοκιμή κλειδιού…';
    googleBadKeyWarned = true;
    try {
      const r = await googleGeocode('Ερμού 10, Αθήνα', null);
      info.textContent = (r ? `✅ Λειτουργεί! Βρήκε: ${r.label}.` : '⚠️ Το κλειδί δουλεύει αλλά δεν βρέθηκε η δοκιμαστική διεύθυνση.') +
        (mv && mv.kind === 'google' ? ' Χάρτης Google ενεργός.' : '');
    } catch (e) {
      info.textContent = '❌ Δεν δουλεύει: ' + (e.message || e.code || e) + '. Έλεγξε ότι ενεργοποίησες «Maps JavaScript API» και «Geocoding API» και τον περιορισμό ιστότοπου.';
    }
    googleBadKeyWarned = false;
  }
  function openSettings(runTest) {
    const g = googleFullRouteUrl(true);
    openModal('Ρυθμίσεις', `
      <label class="field"><span>Εφαρμογή πλοήγησης</span>
        <select id="sNav">
          <option value="apple">Apple Χάρτες</option>
          <option value="google">Google Maps</option>
          <option value="waze">Waze</option>
        </select></label>
      <label class="field"><span>Χρόνος σε κάθε στάση (λεπτά)</span>
        <input id="sSvc" type="number" min="0" max="120" inputmode="numeric" value="${S.settings.serviceMin}"></label>
      ${g ? `<a class="btn btn-ghost btn-block" href="${esc(g)}" target="_blank" rel="noopener">🌐 Όλη η διαδρομή στο Google Maps (μέσω browser)</a><p class="muted small">Χρησιμοποίησέ το μόνο αν δεν ανοίγει η εφαρμογή Google Maps.</p>` : ''}
      <div class="card google-card">
        <b>Αναζήτηση Google</b> <span class="muted small">${S.settings.googleKey ? (googleEnabled() ? '✅ ενεργή' : '⏸ έφτασε το μηνιαίο όριο') : 'ανενεργή'}</span>
        <p class="muted small">Βρίσκει τις διευθύνσεις με ακριβή αριθμό, όπως το Spoke. Βάλε εδώ το δικό σου κλειδί (Google Maps Platform).</p>
        <input id="sGKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="AIza…" value="${esc(S.settings.googleKey || '')}">
        <div class="grid2" style="margin-top:8px">
          <button class="btn btn-primary" id="sGSave">Αποθήκευση &amp; δοκιμή</button>
          <button class="btn btn-ghost" id="sGDel">Αφαίρεση</button>
        </div>
        <p class="muted small" id="sGInfo"></p>
        <p class="muted small">Αυτόν τον μήνα: <b>${googleUsage()}</b> / 10.000 αναζητήσεις · <b>${mapUsage()}</b> / 10.000 ανοίγματα χάρτη (δωρεάν). Στις 9.500 η εφαρμογή γυρνάει μόνη της στα δωρεάν, για να μη χρεωθείς.</p>
        ${S.settings.googleKey ? `
        <label class="field" style="margin-top:10px"><span>Χάρτης</span>
          <select id="sMapEng"><option value="google">Google (περιστροφή, κίνηση)</option><option value="free">Δωρεάν (OpenStreetMap)</option></select></label>
        <label class="field"><span>Map ID (για περιστροφή/3D — προαιρετικό)</span>
          <input id="sMapId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="π.χ. 8f3a…" value="${esc(S.settings.googleMapId || '')}"></label>
        <button class="btn btn-ghost btn-block" id="sMapSave">Εφαρμογή ρυθμίσεων χάρτη</button>
        <p class="muted small">Τώρα: ${mv && mv.kind === 'google' ? 'χάρτης Google' : 'δωρεάν χάρτης'}.</p>` : ''}
      </div>
      <button class="btn btn-ghost btn-block" id="sExport">⬇︎ Εξαγωγή στάσεων (κείμενο)</button>
      <p class="muted small">Χάρτες: © OpenStreetMap contributors. Δρομολόγηση: OSRM. Αναζήτηση: ${S.settings.googleKey ? 'Google, ' : ''}Photon / Nominatim.<br>Τα δεδομένα σου αποθηκεύονται μόνο σε αυτό το κινητό.<br>Έκδοση ${APP_VERSION}</p>`, (b) => {
      const sel = b.querySelector('#sNav');
      sel.value = S.settings.navApp;
      sel.onchange = () => { S.settings.navApp = sel.value; save(); render(); };
      const svc = b.querySelector('#sSvc');
      svc.onchange = () => { S.settings.serviceMin = Math.max(0, +svc.value || 0); save(); render(); };
      const info = b.querySelector('#sGInfo');
      // αλλαγή κλειδιού/χάρτη -> επαναφόρτωση (η Google φορτώνεται μία φορά ανά σελίδα) και αυτόματη δοκιμή
      const reloadAndTest = () => { try { sessionStorage.setItem('rooting.testGoogle', '1'); } catch (e) { /* ignore */ } location.reload(); };
      b.querySelector('#sGSave').onclick = () => {
        const k = b.querySelector('#sGKey').value.trim();
        if (!k) return;
        S.settings.googleKey = k; save();
        info.textContent = 'Επαναφόρτωση…';
        reloadAndTest();
      };
      b.querySelector('#sGDel').onclick = () => { delete S.settings.googleKey; save(); location.reload(); };
      const eng = b.querySelector('#sMapEng');
      if (eng) {
        eng.value = S.settings.mapEngine === 'free' ? 'free' : 'google';
        b.querySelector('#sMapSave').onclick = () => {
          S.settings.mapEngine = eng.value;
          S.settings.googleMapId = b.querySelector('#sMapId').value.trim();
          save(); reloadAndTest();
        };
      }
      b.querySelector('#sExport').onclick = async () => {
        const txt = orderedStops().map((s, i) => `${i + 1}. ${s.label}${s.note ? ' — ' + s.note : ''}${s.phone ? ' — ' + s.phone : ''}`).join('\n');
        try {
          if (navigator.share) await navigator.share({ title: 'Στάσεις', text: txt });
          else { await navigator.clipboard.writeText(txt); toast('Αντιγράφηκε'); }
        } catch (e) { /* ακυρώθηκε */ }
      };
      if (runTest) testGoogleKey(info);
    });
  }

  $('btnLocate').onclick = async () => {
    try { const p = await getPosition(); if (mv) mv.setView(p.lat, p.lng, 15); startWatch(); }
    catch (e) { toast(e.message); }
  };

  // ---------- Βελτιστοποίηση ----------
  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function fetchJson(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.code && j.code !== 'Ok') throw new Error(j.message || j.code);
      return j;
    } finally { clearTimeout(t); }
  }

  async function getMatrix(points) {
    if (points.length <= MAX_MATRIX) {
      try {
        const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
        const j = await fetchJson(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`);
        // αντικατάσταση null (μη προσβάσιμα) με εκτίμηση
        const D = j.durations.map((row, i) => row.map((v, k) => v == null ? haversine(points[i], points[k]) / 8 : v));
        return { D, approx: false };
      } catch (e) { console.warn('OSRM table', e); }
    }
    // Εκτίμηση με ευθεία απόσταση (~30 χλμ/ώρα αστικά, συντελεστής δρόμου 1.3)
    const D = points.map((a) => points.map((b) => haversine(a, b) * 1.3 / 8.3));
    return { D, approx: true };
  }

  async function getRouteGeometry(seq) {
    const coords = seq.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const j = await fetchJson(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const r = j.routes[0];
    return {
      geometry: r.geometry.coordinates.map((c) => [c[1], c[0]]),
      legs: r.legs.map((l) => ({ duration: l.duration, distance: l.distance }))
    };
  }

  async function optimize() {
    const todo = orderedStops().filter((s) => !s.done);
    const doneList = orderedStops().filter((s) => s.done);
    if (!todo.length) return;
    busy(true, 'Βρίσκω την τοποθεσία σου…');
    try {
      let origin;
      // Αν έχουμε ήδη ξεκινήσει (κάποιες ολοκληρωμένες), ξεκινάμε από την τρέχουσα θέση
      const resumed = doneList.length > 0;
      if (S.start && !resumed) origin = Object.assign({}, S.start);
      else {
        try {
          const p = await getPosition(10000);
          origin = { label: 'Η θέση μου', lat: p.lat, lng: p.lng };
        } catch (e) {
          if (S.start) origin = Object.assign({}, S.start);
          else if (resumed) { const l = doneList[doneList.length - 1]; origin = { label: l.label, lat: l.lat, lng: l.lng }; }
          else { busy(false); toast(e.message + '. Όρισε αφετηρία χειροκίνητα.'); $('startRow').click(); return; }
        }
      }
      const mode = S.endMode === 'cycle' ? 'cycle' : (S.endMode === 'fixed' && S.end ? 'fixed' : 'open');
      const points = [origin, ...todo];
      if (mode === 'fixed') points.push(S.end);
      if (mode === 'cycle' && resumed && S.start) {
        // επιστροφή στην αρχική αφετηρία: τη χειριζόμαστε ως σταθερό τέλος
        points.push(S.start);
      }
      const realMode = (mode === 'cycle' && resumed && S.start) ? 'fixed' : mode;

      busy(true, `Υπολογισμός αποστάσεων για ${todo.length} στάσεις…`);
      const { D, approx } = await getMatrix(points);
      busy(true, 'Βρίσκω την καλύτερη σειρά…');
      await new Promise((r) => setTimeout(r, 30));
      const orderIdx = solveRoute(D, realMode, { timeLimitMs: todo.length > 40 ? 3000 : 1500 });
      const orderedTodo = orderIdx.map((i) => points[i]);

      const seq = [origin, ...orderedTodo];
      if (realMode === 'fixed') seq.push(points[points.length - 1]);
      else if (realMode === 'cycle') seq.push(origin);

      let geometry = null, legs = null, approxGeom = approx;
      busy(true, 'Σχεδιάζω τη διαδρομή…');
      try {
        const g = await getRouteGeometry(seq);
        geometry = g.geometry; legs = g.legs;
      } catch (e) {
        approxGeom = true;
        geometry = seq.map((p) => [p.lat, p.lng]);
        legs = [];
        for (let i = 0; i < seq.length - 1; i++) {
          const d = haversine(seq[i], seq[i + 1]) * 1.3;
          legs.push({ distance: d, duration: d / 8.3 });
        }
      }
      // legs: ένα για κάθε στάση + (προαιρετικά) το τελευταίο προς το τέλος
      const doneIds = doneList.map((s) => s.id);
      S.route = {
        order: [...doneIds, ...orderedTodo.map((s) => s.id)],
        legs: [...doneIds.map(() => ({ duration: 0, distance: 0 })), ...legs],
        geometry,
        startedAt: Date.now(),
        pre: doneIds.length,
        origin,
        approx: approxGeom
      };
      save(); render(); fitAll();
      busy(false);
      toast(approxGeom ? 'Η διαδρομή υπολογίστηκε κατά προσέγγιση (πρόβλημα σύνδεσης με τον server δρομολόγησης).' : 'Η διαδρομή είναι έτοιμη!');
      setSheet('peek'); setTimeout(fitAll, 320);
    } catch (e) {
      console.error(e);
      busy(false);
      toast('Κάτι πήγε στραβά: ' + e.message);
    }
  }
  $('btnOptimize').onclick = optimize;

  // ---------- Βοηθητικά UI ----------
  let toastT = null;
  function toast(msg) {
    const t = $('toast');
    t.classList.remove('with-btn'); undoSnap = null;
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 3200);
  }
  function busy(on, text) {
    $('busy').classList.toggle('hidden', !on);
    if (text) $('busyText').textContent = text;
  }


  // ---------- Λειτουργία οδήγησης ----------
  let driveOpen = false, wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* δεν υποστηρίζεται */ }
  }
  document.addEventListener('visibilitychange', () => { if (driveOpen && document.visibilityState === 'visible') keepAwake(true); });

  function openDrive() {
    if (!S.route) { toast('Κάνε πρώτα βελτιστοποίηση διαδρομής'); return; }
    driveOpen = true; $('drive').classList.remove('hidden'); keepAwake(true); renderDrive();
  }
  function closeDrive() { driveOpen = false; $('drive').classList.add('hidden'); keepAwake(false); }

  function renderDrive() {
    const list = orderedStops();
    const next = list.find((s) => !s.done);
    const etas = computeEtas(list);
    const done = list.filter((s) => s.done).length;
    $('dProgress').textContent = `${done}/${list.length} παραδόθηκαν`;
    if (!next) {
      $('dBody').innerHTML = `<div class="d-finish">🎉<br>Τελείωσες όλες τις στάσεις!</div>`;
      return;
    }
    const idx = list.indexOf(next);
    const after = list.slice(idx + 1).find((s) => !s.done);
    const eta = etas[next.id];
    const n = nextChunk().length;
    $('dBody').innerHTML = `
      <div class="d-label">Στάση ${idx + 1} από ${list.length}${eta ? ' · άφιξη ~' + fmtClock(eta.at) : ''}</div>
      <div class="d-title">${esc(title(next))}</div>
      ${next.note ? `<div class="d-note">📝 ${esc(next.note)}</div>` : ''}
      ${next.phone ? `<a class="btn btn-ghost d-call" href="tel:${esc(next.phone.replace(/\s/g, ''))}">📞 ${esc(next.phone)}</a>` : ''}
      <button class="btn btn-success d-big" id="dDoneGo">✓ Παραδόθηκε<small>${after ? 'και πλοήγηση στην επόμενη' : 'τελευταία στάση'}</small></button>
      <div class="d-row">
        <button class="btn btn-primary d-mid" id="dNav">➤ Πλοήγηση</button>
        <button class="btn btn-ghost d-mid" id="dDoneOnly">✓ Μόνο παραδόθηκε</button>
      </div>
      <button class="btn btn-ghost d-mid d-wide" id="dFull">🗺 ${chunkLabel()} στο Google Maps</button>
      <button class="btn btn-link" id="dSkip">Παράλειψη για αργότερα</button>`;
    $('dNav').onclick = () => openUrl(navUrl(next));
    $('dFull').onclick = () => { const u = googleFullRouteUrl(); startBatch(); openUrl(u); };
    $('dDoneOnly').onclick = () => markDone(next.id, true, true);
    $('dSkip').onclick = () => skipStop(next.id);
    $('dDoneGo').onclick = () => {
      markDone(next.id, true);
      const nn = orderedStops().find((s) => !s.done);
      if (nn) openUrl(navUrl(nn));
    };
  }
  $('btnDrive').onclick = openDrive;
  $('dClose').onclick = closeDrive;

  // ---------- Κάρτα που σέρνεται (κάτω / μέση / πάνω) ----------
  const sheet = $('sheet'), sheetBody = $('sheetBody');
  let sheetState = 'half', sheetY = 0;
  function vh() { return document.getElementById('app').clientHeight; }
  function safeTop() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0; }
  function barH() { const b = $('optimizeBar'); return getComputedStyle(b).display === 'none' ? 0 : b.offsetHeight; }
  // Ύψος «κάτω» θέσης: φαίνεται η επόμενη στάση (με τα κουμπιά της) ή η αναζήτηση
  function peekHeight() {
    const next = $('nextCard');
    const el = !next.classList.contains('hidden') ? $('nextActions') : $('addBlock');
    const bodyTop = sheetBody.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
    const elBottom = el.getBoundingClientRect().bottom - sheetBody.getBoundingClientRect().top + sheetBody.scrollTop;
    const safeB = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0;
    return Math.min(vh() * 0.6, bodyTop + elBottom + 14 + (barH() || safeB));
  }
  function snapY(state) {
    const H = vh();
    if (state === 'full') return safeTop() + 56;
    if (state === 'half') return Math.max(safeTop() + 120, H * 0.48);
    return Math.max(H * 0.4, H - peekHeight());
  }
  function applySheet(y, animate) {
    sheetY = y;
    sheet.classList.toggle('anim', !!animate);
    sheet.style.transform = `translateY(${y}px)`;
    document.documentElement.style.setProperty('--sheet-top', y + 'px');
  }
  function setSheet(state, animate = true) {
    sheetState = state;
    sheet.classList.toggle('full', state === 'full');
    if (state !== 'full') sheetBody.scrollTop = 0;
    applySheet(snapY(state), animate);
    // ο χάρτης «τελειώνει» εκεί που αρχίζει η κάρτα (εκτός από την πάνω θέση)
    const visible = vh() - snapY(state === 'full' ? 'half' : state);
    document.documentElement.style.setProperty('--map-bottom', Math.max(0, visible) + 'px');
  }
  // ο browser μερικές φορές «σπρώχνει» τη σελίδα όταν ανοίγει το πληκτρολόγιο — την επαναφέρουμε
  $('app').addEventListener('scroll', () => { $('app').scrollTop = 0; });
  (function sheetGestures() {
    let y0 = 0, x0s = 0, t0 = 0, startY = 0, mode = null, fromHandle = false, lastY = 0, lastT = 0, vel = 0;
    const order = ['peek', 'half', 'full'];
    sheet.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      y0 = lastY = e.touches[0].clientY; x0s = e.touches[0].clientX; t0 = lastT = Date.now(); startY = sheetY; mode = null; vel = 0;
      fromHandle = !!e.target.closest('.sheet-handle');
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY, dy = y - y0;
      if (!mode) {
        const dxs = e.touches[0].clientX - x0s;
        if (Math.abs(dy) < 6 && Math.abs(dxs) < 6) return;
        if (Math.abs(dxs) > Math.abs(dy) && !fromHandle) { mode = 'h'; return; } // οριζόντιο σύρσιμο στάσης
        if (fromHandle || sheetState !== 'full') mode = 'drag';
        else if (sheetBody.scrollTop <= 0 && dy > 0) mode = 'drag';
        else mode = 'scroll';
      }
      if (mode !== 'drag') return;
      e.preventDefault(); // σταματάει και το «τράβηγμα για ανανέωση»
      const now = Date.now();
      vel = (y - lastY) / Math.max(1, now - lastT); lastY = y; lastT = now;
      const minY = snapY('full'), maxY = vh() - 90;
      applySheet(Math.min(maxY, Math.max(minY, startY + dy)), false);
    }, { passive: false });
    sheet.addEventListener('touchend', () => {
      if (mode !== 'drag') return;
      mode = null;
      let target = nearestState();
      if (Math.abs(vel) > 0.45) {
        // γρήγορο «πέταγμα»: πάει στην επόμενη θέση προς την κατεύθυνση της κίνησης
        const ys = order.map((st) => ({ st, y: snapY(st) }));
        if (vel < 0) { const up = ys.filter((o) => o.y < sheetY - 10).sort((a, b) => b.y - a.y)[0]; target = up ? up.st : 'full'; }
        else { const dn = ys.filter((o) => o.y > sheetY + 10).sort((a, b) => a.y - b.y)[0]; target = dn ? dn.st : 'peek'; }
      }
      setSheet(target);
    });
    function nearestState() {
      let best = 'half', d = Infinity;
      order.forEach((st) => { const dd = Math.abs(snapY(st) - sheetY); if (dd < d) { d = dd; best = st; } });
      return best;
    }
    // πάτημα στο χερούλι: εναλλαγή κάτω <-> μέση/πάνω
    $('sheetHandle').addEventListener('click', () => setSheet(sheetState === 'peek' ? 'half' : (sheetState === 'half' ? 'full' : 'peek')));
    // ποντίκι (υπολογιστής): σύρσιμο από το χερούλι
    $('sheetHandle').addEventListener('mousedown', (e) => {
      const y0m = e.clientY, s0 = sheetY;
      const mm = (ev) => applySheet(Math.min(vh() - 90, Math.max(snapY('full'), s0 + ev.clientY - y0m)), false);
      const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); setSheet(nearestState()); };
      window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
    });
  })();
  window.addEventListener('resize', () => setSheet(sheetState, false));
  // πληκτρολόγιο: η αναζήτηση ανεβαίνει πάνω για να μην κρύβεται
  searchEl.addEventListener('focus', () => setSheet('full'));
  $('btnReopt').onclick = optimize;

  // ---------- Επιλογή χάρτη ----------
  const MAP_MONTH_LIMIT = 9500;
  function mapUsage() { const u = S.settings.mapUsage || {}; return u.month === monthKey() ? u.count : 0; }
  function useGoogleMap() { return !!S.settings.googleKey && S.settings.mapEngine !== 'free' && mapUsage() < MAP_MONTH_LIMIT && !googleAuthFailed; }
  async function startMap() {
    const el = $('map');
    const center = myPos || S.lastPos || (S.stops[0] ? { lat: S.stops[0].lat, lng: S.stops[0].lng } : (S.start || DEFAULT_CENTER));
    if (useGoogleMap()) {
      try {
        await loadGoogleCore();
        mv = await RootingMapView.createGoogle(el, center, S.settings.googleMapId);
        S.settings.mapUsage = { month: monthKey(), count: mapUsage() + 1 }; save();
      } catch (e) { console.warn('Google map', e); mv = null; el.innerHTML = ''; }
    }
    if (!mv) mv = RootingMapView.createLeaflet(el, center);
    mv.onLongPress(onMapLongPress);
    $('btnTraffic').classList.toggle('hidden', !mv.canTraffic);
    $('btnSat').classList.toggle('hidden', !mv.canSatellite);
    if (mv.canSatellite && S.settings.satellite) { mv.setSatellite(true); $('btnSat').classList.add('on'); }
    if (mv.canRotate) mv.onRotate((rot) => $('btnNorth').classList.toggle('hidden', !rot));
    showMe();
  }
  function onGoogleAuthFailure() {
    if (mv && mv.kind === 'google') {
      toast('Ο χάρτης Google δεν δέχτηκε το κλειδί — χρησιμοποιείται ο δωρεάν χάρτης');
      $('map').innerHTML = ''; mv = null;
      const el = $('map').cloneNode(false); $('map').replaceWith(el);
      mv = RootingMapView.createLeaflet(el, DEFAULT_CENTER);
      mv.onLongPress(onMapLongPress);
      $('btnTraffic').classList.add('hidden'); $('btnNorth').classList.add('hidden'); $('btnSat').classList.add('hidden');
      render(); fitAll(); showMe();
    }
  }
  let trafficOn = false;
  $('btnTraffic').onclick = () => { trafficOn = !trafficOn; mv.setTraffic(trafficOn); $('btnTraffic').classList.toggle('on', trafficOn); };
  $('btnNorth').onclick = () => mv.resetNorth();

  // ---------- Εκκίνηση ----------
  render();
  setSheet(S.route ? 'peek' : 'half', false);
  startMap().then(() => {
    render();
    // Άνοιγμα: πρώτα στην τελευταία γνωστή θέση, μετά στη σημερινή μόλις τη βρει το GPS
    if (S.lastPos) mv.setView(S.lastPos.lat, S.lastPos.lng, 15);
    else if (S.stops.length) fitAll();
    getPosition(15000).then((pos) => { mv.setView(pos.lat, pos.lng, 15); startWatch(); })
      .catch(() => { if (!S.lastPos && S.stops.length) fitAll(); });
    // μετά από αλλαγή κλειδιού: δοκιμή και εμφάνιση αποτελέσματος
    try {
      if (sessionStorage.getItem('rooting.testGoogle')) { sessionStorage.removeItem('rooting.testGoogle'); openSettings(true); }
    } catch (e) { /* ignore */ }
  });
  // ---------- Αυτόματη ενημέρωση ----------
  // Η εφαρμογή στην αρχική οθόνη του iPhone κρατάει δικό της αντίγραφο. Ελέγχουμε το version.json
  // (χωρίς cache) στο άνοιγμα και κάθε φορά που επιστρέφεις στην εφαρμογή· αν άλλαξε, ανανεώνουμε.
  async function checkForUpdate() {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = String((await r.json()).version);
      if (v === APP_VERSION) return;
      let tried = null;
      try { tried = sessionStorage.getItem('rooting.updatedTo'); } catch (e) { /* ignore */ }
      if (tried === v) return; // ήδη προσπαθήσαμε σε αυτή τη συνεδρία — όχι ατέρμονες ανανεώσεις
      try { sessionStorage.setItem('rooting.updatedTo', v); } catch (e) { /* ignore */ }
      if (navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update().catch(() => {});
      }
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      toast('Νέα έκδοση — ανανέωση…');
      setTimeout(() => location.reload(), 600);
    } catch (e) { /* χωρίς σύνδεση: συνεχίζουμε με ό,τι έχουμε */ }
  }
  checkForUpdate();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
  }
})();
