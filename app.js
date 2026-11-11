/* Rooting — βελτιστοποίηση δρομολογίων (PWA) */
(function () {
  'use strict';

  const OSRM = 'https://router.project-osrm.org';
  const PHOTON = 'https://photon.komoot.io';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const STORE_KEY = 'rooting.v1';
  const APP_VERSION = '43';
  const MAX_MATRIX = 100; // όριο του δημόσιου OSRM server

  // iOS (εφαρμογή αρχικής οθόνης): μερικές φορές η σελίδα δεν φτάνει ως το κάτω άκρο της οθόνης.
  // Τότε η γραμμή του iPhone δεν πέφτει πάνω μας, άρα δεν χρειάζεται επιπλέον κενό από κάτω.
  function fixViewport() {
    const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    const portrait = innerHeight > innerWidth;
    const screenLong = Math.max(screen.width, screen.height);
    // πόσο ψηλή βγήκε στην πράξη η εφαρμογή (με την παράκαμψη vh μπορεί να γεμίζει όλη την οθόνη)
    const appEl = document.getElementById('app');
    const h = Math.max(innerHeight, appEl ? appEl.getBoundingClientRect().height : 0);
    const short = standalone && portrait && screenLong - h > 20;
    document.documentElement.style.setProperty('--safe-bottom', short ? '0px' : 'env(safe-area-inset-bottom, 0px)');
  }
  fixViewport();
  window.addEventListener('load', fixViewport);
  window.addEventListener('resize', fixViewport);
  window.addEventListener('orientationchange', () => setTimeout(fixViewport, 300));

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
  // παλιές στάσεις: καθάρισμα σκουπιδιών ανάγνωσης από το εικονίδιο αντιγραφής («Παπανδρέου 71, ἴνι, Γαζι»)
  (S.stops || []).forEach((st) => {
    if (st.orig && /[\u1F00-\u1FFF]/.test(st.orig)) st.orig = st.orig.replace(/\S*[\u1F00-\u1FFF]\S*/g, ' ').replace(/\s+,/g, ',').replace(/(,\s*)+,/g, ',').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  });
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
  async function googleGeocode(q, near, restrict) {
    const geocoder = await loadGoogle();
    const req = { address: q, region: 'gr', componentRestrictions: Object.assign({ country: 'GR' }, restrict || {}) };
    if (near) req.bounds = { south: near.lat - 0.3, west: near.lng - 0.4, north: near.lat + 0.3, east: near.lng + 0.4 };
    let resp;
    for (let attempt = 0; ; attempt++) {
      countGoogle();
      try { resp = await geocoder.geocode(req); break; }
      catch (e) {
        const code = (e && e.code) || '';
        if (code === 'ZERO_RESULTS') return null;
        // «πολλές αναζητήσεις μαζί»: περιμένουμε λίγο και ξαναρωτάμε τη Google (όχι δωρεάν αναζήτηση)
        if (code === 'OVER_QUERY_LIMIT' && attempt < 4) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1) + Math.random() * 400)); continue; }
        if (code === 'REQUEST_DENIED' && !googleBadKeyWarned) { googleBadKeyWarned = true; toast('Η Google αρνήθηκε το κλειδί — έλεγξε τις ρυθμίσεις του'); }
        throw e;
      }
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
      exact, query: q, google: true, comps: r.address_components, types: r.types || []
    };
  }

  const rejected = new Map(); // διεύθυνση -> πρόταση Google που απορρίφθηκε
  function stopsCenter() {
    const pts = S.stops.filter((x) => !x.done);
    if (!pts.length) return null;
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    return { lat: med(pts.map((p) => p.lat)), lng: med(pts.map((p) => p.lng)) };
  }

  // region: {lat, lng} -> αναζήτηση μόνο γύρω από εκεί (~35 χλμ), και με σκέτο όνομα δρόμου
  // Αποτέλεσμα Google που είναι μόνο περιοχή/ΤΚ (π.χ. «71601», «Νέα Αλικαρνασσός»): το σημείο είναι
  // το κέντρο της περιοχής, όχι η διεύθυνση — ΔΕΝ το δεχόμαστε για διεύθυνση με οδό
  const STREET_TYPES = ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'route', 'intersection', 'street_number'];
  function coarse(g) { return !!(g && g.google && !(g.types || []).some((t) => STREET_TYPES.includes(t))); }
  function hasStreetNo(q) { const f = String(q).split(',')[0]; return /\p{L}{3,}/u.test(f) && /\d/.test(f.replace(/\b\d{3}\s?\d{2}\b/, '')); }
  // καθάρισμα σκουπιδιών από την ανάγνωση: «ΑΝΑΠΑΥΎΣΕΩΣ 31 ΝΕΑ ΑΛΙΚΑΡΝΑΣΣΟΣ I» -> «ΑΝΑΠΑΥΣΕΩΣ 31, ΝΕΑ ΑΛΙΚΑΡΝΑΣΣΟΣ»
  function cleanQuery(q) {
    return String(q)
      .replace(/[\p{Lu}]+/gu, (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')) // τόνοι σε ΚΕΦΑΛΑΙΑ
      .replace(/ΥΥ/g, 'Υ')                                     // «ΑΝΑΠΑΥΎΣΕΩΣ»
      .replace(/(^|,|(?<!\d)\s)[\p{L}](?=[\s,]|$)/gu, '$1')  // μονά γράμματα «I», «ο» (όχι «20 Β»)
      .replace(/(^|,)\s*0\s*(?=,|$)/g, '$1').replace(/\s0(?=\s*,)/g, '') // «Νεα αλικαρνασσος 0,»
      .replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  }
  async function geocodeSmart(qIn, region) {
    const q = cleanQuery(qIn) || qIn;
    const r = await geocodeSmart0(q, region);
    if (r) r.query = qIn;
    if (rejected.has(q) && q !== qIn) { rejected.set(qIn, rejected.get(q)); rejected.delete(q); }
    return r;
  }
  async function geocodeSmart0(q, region) {
    // Με κλειδί Google: πρώτα Google (1 αίτημα), και μόνο αν δεν βρει, τα δωρεάν
    if (googleEnabled()) {
      try {
        const near = region || searchBias();
        // σημεία αναφοράς: η περιοχή του γύρου, η θέση μου, το κέντρο των στάσεων
        const refs = [region, myPos, stopsCenter()].filter(Boolean);
        const dist = (g) => Math.min(...refs.map((r) => RootingGeo.distKm(r, g)), refs.length ? Infinity : 0);
        const needStreet = hasStreetNo(q);
        const ok = (g) => g && !(needStreet && coarse(g)) && RootingGeo.googleMatches(q, g.comps, dist(g) < 60, g.label) && (!region || RootingGeo.distKm(region, g) < 50);
        let g = await googleGeocode(q, near);
        if (ok(g)) return g;
        const first = g;
        if (g) {
          // λάθος περιοχή (π.χ. ίδια οδός σε άλλη πόλη): ψάχνουμε ΜΕΣΑ στην περιοχή που γράφει η διεύθυνση,
          // χωρίς τον ΤΚ (μπορεί να είναι αυτός λάθος)
          const area = RootingGeo.areaText(q);
          const noPostal = q.replace(/(^|\D)\d{3}\s?\d{2}(?!\d)/g, '$1').replace(/\s+,/g, ',').replace(/[,\s]+$/, '').trim();
          if (area) {
            g = await googleGeocode(noPostal, near, { locality: area }).catch(() => null);
            if (ok(g)) return g;
          }
          // αλλιώς με υποχρεωτικό ΤΚ
          const postal = RootingGeo.parseQuery(q).postal;
          if (postal) {
            g = await googleGeocode(q, near, { postalCode: postal }).catch(() => null);
            if (ok(g)) return g;
          }
          // πολύ κοντά στις άλλες στάσεις (<12 χλμ): σχεδόν σίγουρα σωστό
          if (refs.length && dist(first) < 12 && !(needStreet && coarse(first))) return first;
          if (!coarse(first)) rejected.set(q, first); // κρατάμε την πρόταση της Google για να τη δει ο χρήστης
        }
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
            if (g && RootingGeo.googleMatches(q, g.comps, RootingGeo.distKm(searchBias(), g) < 60, g.label)) res = [Object.assign(g, { label: '📍 ' + g.label })].concat(res.slice(0, 4));
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
  // Χρόνοι/αποστάσεις για την ΤΡΕΧΟΥΣΑ σειρά (χωρίς νέα βελτιστοποίηση), από τη θέση μου
  let legsTimer = null;
  function scheduleLegs() { clearTimeout(legsTimer); legsTimer = setTimeout(refreshLegs, 500); }
  async function refreshLegs() {
    if (!S.route) return;
    const list = orderedStops(), pending = list.filter((x) => !x.done);
    if (!pending.length) return;
    const origin = myPos || S.route.origin || S.start || pending[0];
    const seq = [origin, ...pending];
    if (S.endMode === 'fixed' && S.end) seq.push(S.end);
    else if (S.endMode === 'cycle' && (S.start || S.route.origin)) seq.push(S.start || S.route.origin);
    let geometry, legs, approx = false;
    try { const g = await getRouteGeometry(seq); geometry = g.geometry; legs = g.legs; }
    catch (e) {
      approx = true; geometry = seq.map((p) => [p.lat, p.lng]); legs = [];
      for (let i = 0; i < seq.length - 1; i++) { const d = haversine(seq[i], seq[i + 1]) * 1.3; legs.push({ distance: d, duration: d / 8.3 }); }
    }
    if (!S.route) return;
    let k = 0;
    const aligned = list.map((x) => (x.done ? { duration: 0, distance: 0 } : legs[k++]));
    while (k < legs.length) aligned.push(legs[k++]); // σκέλος προς το τέλος/επιστροφή
    Object.assign(S.route, { legs: aligned, geometry, approx, startedAt: Date.now(), pre: 0 });
    save(); render();
  }

  // Τι απομένει σε όλο το δρομολόγιο: στάσεις, χρόνος (οδήγηση + χρόνος ανά στάση), χλμ
  function remainingStats() {
    const list = orderedStops();
    const pending = list.filter((x) => !x.done);
    let sec = 0, m = 0;
    list.forEach((x, k) => { if (!x.done && S.route && S.route.legs && S.route.legs[k]) { sec += S.route.legs[k].duration + (S.settings.serviceMin || 0) * 60; m += S.route.legs[k].distance; } });
    return { list, pending, sec, m, hasLegs: !!(S.route && S.route.legs), failed: list.filter((x) => x.failed).length };
  }
  // Γραμμή προόδου στην πλοήγηση
  function updateNavProgress() {
    if (!S.route) return;
    const r = remainingStats(), total = r.list.length, handled = total - r.pending.length;
    const curIdx = navStop ? r.list.findIndex((x) => x.id === navStop.id) + 1 : handled + 1;
    $('navProgCount').textContent = `Στάση ${Math.min(curIdx || handled + 1, total)}/${total}`;
    $('navProgRest').innerHTML = ` · μένουν ${r.pending.length}` + (r.hasLegs ? ` · τέλος ~${fmtClock(Date.now() + r.sec * 1000)}` : '') +
      (r.failed ? ` · <span class="fail-txt">${ic('x')} ${r.failed}</span>` : '');
    $('navProgBar').style.width = Math.round((handled / Math.max(1, total)) * 100) + '%';
  }
  setInterval(() => { if (window.RootingNav && RootingNav.active()) updateNavProgress(); }, 30000);

  function computeEtas(list) {
    const etas = {};
    if (!S.route || !S.route.legs) return etas;
    let t = S.route.startedAt;
    const svc = (S.settings.serviceMin || 0) * 60000;
    const pre = S.route.pre || 0;
    list.forEach((s, i) => {
      const leg = S.route.legs[i];
      if (!leg || i < pre || s.done) return;
      t += leg.duration * 1000;
      etas[s.id] = { at: t, leg };
      t += svc;
    });
    return etas;
  }

  function render() {
    const list = orderedStops();
    const etas = computeEtas(list);
    const stopsEl = $('stops'), doneEl = $('doneStops'), failEl = $('failStops');
    stopsEl.innerHTML = ''; doneEl.innerHTML = ''; failEl.innerHTML = '';
    const nextStop = S.route ? list.find((s) => !s.done) : null;

    list.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'stop-row';
      const eta = etas[s.id];
      const meta = [];
      if (eta && !s.done) meta.push(`${ic('clock')} ${fmtClock(eta.at)}`, `${fmtKm(eta.leg.distance)} · ${fmtDur(eta.leg.duration)}`);
      if (s.exact === false && !s.done) meta.push(`<b class="approx">${ic('alert')} κατά προσέγγιση</b>`);
      if (s.pkgs > 1) meta.push(`<b class="pkg-inline">${ic('package')} ${pkgsText(s.pkgs)}</b>`);
      if (whoText(s)) meta.push(`${ic(s.hub ? 'home' : 'user')} ${esc(whoText(s))}`);
      if (s.note) meta.push(`${ic('note')} ${esc(s.note)}`);
      if (s.phone) meta.push(`${ic('phone')} ${esc(s.phone)}`);
      li.innerHTML = `
        <div class="sw-bg"><span class="sw-done">${s.done ? ic('restore') + ' Επαναφορά' : ic('check') + ' Παραδόθηκε'}</span><span class="sw-del">${ic('trash')} Διαγραφή</span></div>
        <div class="stop${s.done ? ' done' : ''}${s.failed ? ' failed' : ''}${nextStop && nextStop.id === s.id ? ' current' : ''}">
          <span class="num${s.hub && !s.done ? ' num-' + s.hub.kind : ''}">${s.failed ? '✗' : (s.done ? '✓' : (S.route ? i + 1 : '•'))}</span>
          <span class="stop-body">
            <span class="stop-title">${esc(title(s))}</span>
            ${meta.length ? `<span class="stop-meta">${meta.join('<span class="sep">·</span>')}</span>` : ''}
          </span>
          <span class="chev">›</span>
        </div>`;
      attachSwipe(li, s);
      (s.failed ? failEl : (s.done ? doneEl : stopsEl)).appendChild(li);
    });
    const doneN = list.filter((s) => s.done && !s.failed).length, failN = list.filter((s) => s.failed).length;
    $('doneBox').classList.toggle('hidden', !doneN);
    $('doneSummary').innerHTML = `${ic('check')} Παραδόθηκαν (${doneN})`;
    $('failBox').classList.toggle('hidden', !failN);
    $('failSummary').innerHTML = `${ic('x')} Αποτυχημένα (${failN})`;
    $('swipeHint').classList.toggle('hidden', !list.some((s) => !s.done));

    $('stopCount').textContent = S.stops.length;
    const done = S.stops.filter((s) => s.done).length;
    const failedN = S.stops.filter((s) => s.failed).length;
    $('doneCount').textContent = S.route && S.stops.length ? `✓ ${done - failedN}/${S.stops.length}` + (failedN ? ` · ✗ ${failedN}` : '') : '';
    $('emptyHint').classList.toggle('hidden', S.stops.length > 0);

    $('startLabel').textContent = S.start ? S.start.label : 'Τρέχουσα τοποθεσία';
    $('endLabel').textContent = S.endMode === 'cycle' ? 'Επιστροφή στην αφετηρία'
      : S.endMode === 'fixed' && S.end ? S.end.label : 'Όπου τελειώσει η τελευταία στάση';

    // Κουμπί βελτιστοποίησης
    const btn = $('btnOptimize');
    const remaining = S.stops.filter((s) => !s.done).length;
    btn.innerHTML = ic('zap') + ' ' + (S.route && remaining && done ? 'Νέα βελτιστοποίηση από τη θέση μου' : (S.route ? 'Ξανά βελτιστοποίηση' : 'Βελτιστοποίηση διαδρομής'));
    btn.disabled = remaining === 0;

    // Κάρτα επόμενης στάσης
    const card = $('nextCard');
    if (nextStop) {
      card.classList.remove('hidden');
      const idx = list.indexOf(nextStop);
      $('nextIdx').textContent = `${idx + 1}/${list.length}`;
      // πρόοδος + τι απομένει
      const { pending, sec: remSec } = remainingStats();
      $('nextRemain').textContent = `μένουν ${pending.length}` + (S.route.legs ? ` · ~${fmtDur(remSec)} · τέλος ~${fmtClock(Date.now() + remSec * 1000)}` : ' · υπολογισμός…');
      $('nextProgress').style.width = Math.round((done / list.length) * 100) + '%';
      const call = $('btnCallNext');
      call.classList.toggle('hidden', !nextStop.phone);
      if (nextStop.phone) call.href = 'tel:' + nextStop.phone.replace(/\s/g, '');
      $('nextTitle').textContent = title(nextStop);
      $('nextPkgs').innerHTML = nextStop.pkgs ? ic('package') + ' ' + pkgsText(nextStop.pkgs) : '';
      $('nextPkgs').classList.toggle('multi', nextStop.pkgs > 1);
      const eta = etas[nextStop.id];
      const sub = [];
      if (eta) sub.push(`Άφιξη ~${fmtClock(eta.at)}`);
      if (whoText(nextStop)) sub.push(whoText(nextStop));
      if (nextStop.note) sub.push(nextStop.note);
      $('nextSub').textContent = sub.join(' · ');
      bindNavLink($('btnNavNext'), nextStop);
      $('btnDoneNext').onclick = () => markDone(nextStop.id, true, true);
      $('btnFailNext').onclick = () => markFailed(nextStop.id);
      $('btnFullRoute').innerHTML = ic('map') + ' ' + chunkLabel();
      $('btnFullRoute').href = googleFullRouteUrl();
      $('btnFullRoute').onclick = () => startBatch();
      $('btnReopt').innerHTML = ic('zap') + (done ? ' Από εδώ' : ' Νέα σειρά');
      renderBatchBar(list);
      $('undoLast').innerHTML = undoLastHtml('undo-last');
      bindUndoLast($('undoLast'));
    } else card.classList.add('hidden');
    document.body.classList.toggle('has-route', !!nextStop);
    if (window.RootingNav && RootingNav.active()) updateNavProgress();
    if (typeof sheetState !== 'undefined' && sheetState === 'peek') requestAnimationFrame(() => setSheet('peek'));
    if (driveOpen) renderDrive();

    // Σύνοψη
    const sum = $('summary');
    if (S.route && S.route.legs) {
      // ό,τι απομένει: σκέλη των στάσεων που δεν έχουν παραδοθεί (+ σκέλος προς το τέλος)
      let dist = 0, dur = 0, left = 0;
      S.route.legs.forEach((l, k) => { const st = list[k]; if (!l || (st && st.done)) return; dist += l.distance; dur += l.duration; if (st) left++; });
      const finish = Date.now() + (dur + left * (S.settings.serviceMin || 0) * 60) * 1000;
      sum.innerHTML = `<div><b>${fmtKm(dist)}</b><small>απομένουν</small></div>
        <div><b>${fmtDur(dur)}</b><small>οδήγηση</small></div>
        <div><b>${fmtClock(finish)}</b><small>τέλος περίπου</small></div>`;
      if (!nextStop) sum.innerHTML += `<div class="all-done">🎉 Τελείωσες! ✓ ${S.stops.filter((x) => x.done && !x.failed).length} παραδόθηκαν${S.stops.some((x) => x.failed) ? ` · <span class="fail-txt">✗ ${S.stops.filter((x) => x.failed).length} αποτυχημένα</span>` : ''}</div>`;
      sum.classList.remove('hidden');
    } else sum.classList.add('hidden');

    drawMap(list, nextStop);
  }

  function drawMap(list, nextStop) {
    if (!mv) return;
    const items = [];
    const origin = S.route && S.route.origin ? S.route.origin : S.start;
    if (origin) items.push({ lat: origin.lat, lng: origin.lng, text: '▶', cls: 'pin-start', title: 'Αφετηρία', z: 2 });
    const pend = [];
    list.forEach((s, i) => {
      const isNext = nextStop && nextStop.id === s.id;
      const it = {
        lat: s.lat, lng: s.lng, text: s.failed ? '✗' : (s.done ? '✓' : (S.route ? String(i + 1) : '•')),
        cls: s.failed ? 'pin-failed' : (s.done ? 'pin-done' : (isNext ? 'pin-next' : (s.hub ? 'pin-hub pin-' + s.hub.kind : ''))), title: title(s),
        z: isNext ? 50 : (s.done ? 1 : 10), onClick: () => stopPopup(s.id)
      };
      if (s.done) items.push(it); else pend.push({ it, s, i, isNext });
    });
    // στάσεις στο ίδιο σημείο (<15 μ): μία πινέζα «5–7» αντί για πινέζες η μία πάνω στην άλλη
    const groups = [];
    pend.forEach((p) => { const g = groups.find((x) => RootingGeo.distKm(x[0].s, p.s) < 0.015); if (g) g.push(p); else groups.push([p]); });
    groups.forEach((g) => {
      if (g.length === 1) { items.push(g[0].it); return; }
      const nums = g.map((p) => p.i + 1);
      const seq = nums.every((n, k) => !k || n === nums[k - 1] + 1);
      const nx = g.find((p) => p.isNext);
      items.push({
        lat: g[0].s.lat, lng: g[0].s.lng, text: S.route ? (seq && nums.length > 2 ? nums[0] + '–' + nums[nums.length - 1] : nums.join('·')) : '×' + g.length,
        cls: (nx ? 'pin-next ' : '') + 'pin-multi', title: g.map((p) => title(p.s)).join(' / '), z: nx ? 50 : 10,
        onClick: () => groupPopup(g.map((p) => p.s.id))
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

  // ---------- Πλοήγηση: μέσα στην εφαρμογή ή εξωτερική εφαρμογή ----------
  function inApp() { return S.settings.navApp === 'inapp'; }
  function navigateTo(s) {
    if (!s) return;
    if (inApp()) startInAppNav(s);
    else openUrl(navUrl(s));
  }
  // συνδέει ένα κουμπί/σύνδεσμο «Πλοήγηση» με τη σωστή συμπεριφορά
  function bindNavLink(a, s) {
    if (!a) return;
    if (inApp()) { a.removeAttribute('href'); a.removeAttribute('target'); a.onclick = (e) => { e.preventDefault(); navigateTo(s); }; }
    else { const u = navUrl(s); a.href = u; if (u.startsWith('http')) a.target = '_blank'; else a.removeAttribute('target'); a.onclick = null; }
  }
  let navStop = null;
  // τηλέφωνα της στάσης (όλοι οι πελάτες, χωρίς διπλά)
  function stopPhones(s) {
    const list = [];
    (s.people || []).forEach((p) => { if (p.phone && !list.some((x) => x.phone === p.phone)) list.push({ name: p.name || '', phone: p.phone }); });
    if (s.phone && !list.some((x) => x.phone === s.phone)) list.unshift({ name: whoText(s) || s.note || '', phone: s.phone });
    return list;
  }
  function setupNavCall(s) {
    const b = $('navCallBar'), phones = stopPhones(s);
    b.classList.toggle('hidden', !phones.length);
    document.querySelector('.nav-btns').classList.toggle('with-call', phones.length > 0);
    if (phones.length === 1) { b.href = 'tel:' + phones[0].phone.replace(/\s/g, ''); b.onclick = null; }
    else if (phones.length > 1) {
      b.removeAttribute('href');
      b.onclick = (e) => {
        e.preventDefault();
        openModal('Κλήση', `<ul class="people">${phones.map((p) => `<li><span>${ic('user')} ${esc(p.name || '—')}</span><a class="btn btn-primary" href="tel:${esc(p.phone.replace(/\s/g, ''))}">${ic('phone')} ${esc(p.phone)}</a></li>`).join('')}</ul>`);
      };
    }
  }

  function startInAppNav(s) {
    if (driveOpen) closeDrive();
    closeModal();
    navStop = s;
    $('navArrive').classList.add('hidden');
    document.querySelector('.nav-btns').classList.remove('arrived');
    renderNavUndo();
    setupNavCall(s);
    updateNavProgress();
    // πελάτης(ες) και δέματα κάτω από τη διεύθυνση
    const who = (s.people || []).map((p) => p.name).filter(Boolean).join(' · ') || s.note || '';
    $('navWho').innerHTML = [who ? `<span class="who">${ic('user')} ${esc(who)}</span>` : '', s.pkgs ? `<b class="pkg-badge${s.pkgs > 1 ? ' multi' : ''}">${ic('package')} ${pkgsText(s.pkgs)}</b>` : ''].filter(Boolean).join('');
    RootingNav.start({
      dest: { lat: s.lat, lng: s.lng, title: title(s) },
      from: myPos, mv, osrm: OSRM, muted: !!S.settings.navMuted,
      getPos: () => getPosition(8000),
      onPos: (p) => { myPos = p; showMe(); rememberPos(); },
      onArrive: () => showArrive(s),
      onExit: () => { navStop = null; render(); setSheet('peek'); setTimeout(fitAll, 300); }
    });
  }
  // Άφιξη: χωρίς αναδυόμενο παράθυρο (κρύβει τον χάρτη). Το ✓ της κάτω μπάρας γίνεται πράσινο
  // και πάλλεται, και από εδώ και πέρα δεν ζητάει επιβεβαίωση.
  function showArrive() {
    document.querySelector('.nav-btns').classList.add('arrived');
  }
  function navFinishStop(failed) {
    const s = navStop;
    if (!s) return;
    if (failed) markFailed(s.id); else markDone(s.id, true);
    const next = orderedStops().find((x) => !x.done);
    if (next) startInAppNav(next);
    else { RootingNav.stop(); toast('🎉 Τελείωσες όλες τις στάσεις!'); }
  }
  function renderNavUndo() {
    $('navUndo').innerHTML = undoLastHtml('undo-last');
    $('navUndo').querySelectorAll('[data-undo-last]').forEach((b) => {
      b.onclick = () => { const s = lastDoneStop(); if (!s) return; S.lastDone = null; markDone(s.id, false); toast('Η στάση επανήλθε'); startInAppNav(s); };
    });
  }
  $('navExit').onclick = () => RootingNav.stop();
  $('navMute').onclick = () => { S.settings.navMuted = RootingNav.toggleMute(); save(); };
  $('navDone').onclick = () => navFinishStop(false);
  $('navFail').onclick = () => navFinishStop(true);
  $('navDoneMan').onclick = () => {
    if (!navStop) return;
    if (RootingNav.arrived() || confirm(`Παραδόθηκε: ${title(navStop).split(',')[0]};`)) navFinishStop(false);
  };
  $('navFailMan').onclick = () => { if (navStop && confirm(`Αποτυχία παράδοσης: ${title(navStop).split(',')[0]};`)) navFinishStop(true); };

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
    if (undoable) offerUndo(val ? `✓ Παραδόθηκε: ${title(s).split(',')[0]}` : 'Η στάση επανήλθε στο δρομολόγιο');
    const wasFailed = !!s.failed;
    s.done = val; s.doneAt = val ? Date.now() : null; s.failed = false;
    S.lastDone = val ? { id: s.id, at: Date.now(), failed: false } : null;
    save(); render();
    if (wasFailed && !val) scheduleLegs();
    if (val) {
      const next = orderedStops().find((x) => !x.done);
      if (next && mv) mv.panTo(next.lat, next.lng);
      if (navigator.vibrate) navigator.vibrate(30);
    }
  }

  // Αποτυχία παράδοσης: βγαίνει από το δρομολόγιο (χωρίς να αλλάξει η σειρά των υπολοίπων),
  // κόκκινη πινέζα στον χάρτη, ενότητα «Αποτυχημένα»
  function markFailed(id) {
    const s = S.stops.find((x) => x.id === id);
    if (!s) return;
    offerUndo(`✗ Αποτυχία: ${title(s).split(',')[0]}`);
    s.done = true; s.failed = true; s.doneAt = Date.now();
    S.lastDone = { id: s.id, at: Date.now(), failed: true };
    save(); render();
    scheduleLegs();
    const next = orderedStops().find((x) => !x.done);
    if (next && mv) mv.panTo(next.lat, next.lng);
    if (navigator.vibrate) navigator.vibrate([20, 60, 20]);
  }



  function moveStop(id, dir) {
    if (S.route) {
      const o = S.route.order, i = o.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      S.route.legs = null; S.route.geometry = null; scheduleLegs();
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
      S.route.legs = null; S.route.geometry = null; scheduleLegs();
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
      ${s.pkgs > 1 ? `<div class="mp-note"><b>${ic('package')} ${pkgsText(s.pkgs)}</b></div>` : ''}
      ${whoText(s) ? `<div class="mp-note">${ic('user')} ${esc(whoText(s))}</div>` : ''}
      ${s.note ? `<div class="mp-note">${ic('note')} ${esc(s.note)}</div>` : ''}
      <div class="mp-btns">
        <a class="btn btn-primary" data-a="nav" href="${esc(url)}"${url.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${ic('nav')}</a>
        <button class="btn ${s.done ? 'btn-ghost' : 'btn-success'}" data-a="done">${s.done ? ic('restore') : ic('check') + ' Παραδόθηκε'}</button>
        ${!s.done ? `<button class="btn btn-fail" data-a="fail">${ic('x')}</button>` : ''}
        ${s.phone ? `<a class="btn btn-ghost" href="tel:${esc(s.phone.replace(/\s/g, ''))}">${ic('phone')}</a>` : ''}
        <button class="btn btn-ghost" data-a="more">${ic('more')}</button>
      </div>`;
    el.querySelector('[data-a="done"]').onclick = () => { mv.closePopup(); markDone(s.id, !s.done, true); };
    el.querySelector('[data-a="more"]').onclick = () => { mv.closePopup(); openStop(s.id); };
    if (inApp()) bindNavLink(el.querySelector('[data-a="nav"]'), s);
    const pf = el.querySelector('[data-a="fail"]');
    if (pf) pf.onclick = () => { mv.closePopup(); markFailed(s.id); };
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
    $('btnBatchDone').innerHTML = ic('check') + (restAfter.length ? ` Τελείωσα · Επόμενες ${restAfter.length}` : ' Τελείωσα αυτές');
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
      ${s.pkgs ? `<p class="pkg-line"><b class="pkg-badge${s.pkgs > 1 ? ' multi' : ''}">${ic('package')} ${pkgsText(s.pkgs)}</b></p>` : ''}
      ${(s.people || []).length ? `<ul class="people">${s.people.map((p) => `<li><span>${ic('user')} ${esc(p.name || '—')}${(p.pkgs || 1) > 1 || s.people.length > 1 ? ` <b>· ${pkgsText(p.pkgs || 1)}</b>` : ''}</span>${p.phone ? `<a class="btn btn-ghost" href="tel:${esc(p.phone.replace(/\s/g, ''))}">${ic('phone')} ${esc(p.phone)}</a>` : ''}</li>`).join('')}</ul>` : ''}
      ${s.orig ? `<p class="muted small">Στον χάρτη: ${esc(s.label)}${s.exact === false ? ' <b class="approx">(κατά προσέγγιση — δεν βρέθηκε ο ακριβής αριθμός)</b>' : ''}</p>` : ''}
      <button class="btn btn-ghost btn-block" id="mFix">${ic('locate')} Λάθος θέση; Διόρθωση</button>
      <div class="grid2">
        <a class="btn btn-primary" id="mNav" href="${esc(navUrl(s))}"${navUrl(s).startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${ic('nav')} Πλοήγηση</a>
        <button class="btn ${s.done ? 'btn-ghost' : 'btn-success'}" id="mDone">${s.failed ? ic('restore') + ' Επαναφορά' : (s.done ? ic('restore') + ' Δεν παραδόθηκε' : ic('check') + ' Παραδόθηκε')}</button>
      </div>
      ${!s.done ? `<button class="btn btn-fail btn-block" id="mFail">${ic('x')} Αποτυχία παράδοσης</button>` : ''}
      ${s.failed ? '<p class="fail-txt small">✗ Αποτυχημένη παράδοση — εκτός δρομολογίου. Πάτα «Επαναφορά» για να μπει ξανά.</p>' : ''}
      <label class="field"><span>Σημείωση</span><input id="mNote" type="text" value="${esc(s.note)}" placeholder="π.χ. 3ος όροφος, κουδούνι Παπαδόπουλος"></label>
      <label class="field"><span>Τηλέφωνο</span><input id="mPhone" type="tel" value="${esc(s.phone)}" placeholder="69…"></label>
      ${s.phone ? `<a class="btn btn-ghost btn-block" href="tel:${esc(s.phone.replace(/\s/g, ''))}">${ic('phone')} Κλήση ${esc(s.phone)}</a>` : ''}
      <div class="grid3">
        <button class="btn btn-ghost" id="mUp">${ic('up')} Πάνω</button>
        <button class="btn btn-ghost" id="mDown">${ic('down')} Κάτω</button>
        <button class="btn btn-danger" id="mDel">${ic('trash')} Διαγραφή</button>
      </div>`, (b) => {
      const persist = () => { s.note = b.querySelector('#mNote').value.trim(); s.phone = b.querySelector('#mPhone').value.trim(); save(); render(); };
      b.querySelector('#mNote').addEventListener('change', persist);
      b.querySelector('#mPhone').addEventListener('change', persist);
      b.querySelector('#mDone').onclick = () => { persist(); markDone(s.id, !s.done, true); closeModal(); };
      bindNavLink(b.querySelector('#mNav'), s);
      const mf = b.querySelector('#mFail');
      if (mf) mf.onclick = () => { persist(); markFailed(s.id); closeModal(); };
      b.querySelector('#mUp').onclick = () => { persist(); moveStop(s.id, -1); };
      b.querySelector('#mDown').onclick = () => { persist(); moveStop(s.id, 1); };
      b.querySelector('#mDel').onclick = () => { deleteStop(s.id, true); closeModal(); };
      b.querySelector('#mFix').onclick = () => { persist(); fixStopPlace(s.id); };
    });
  }

  // Πολλές στάσεις στο ίδιο σημείο
  function groupPopup(ids) {
    const list = orderedStops();
    const ss = ids.map((id) => S.stops.find((x) => x.id === id)).filter(Boolean);
    openModal(`${ss.length} στάσεις στο ίδιο σημείο`, `
      <ul class="group-list">${ss.map((s) => `<li><button class="btn btn-ghost btn-block grp-item" data-id="${s.id}">
        <span class="num">${S.route ? list.findIndex((x) => x.id === s.id) + 1 : '•'}</span>
        <span class="grp-txt"><b>${esc(title(s))}</b>${whoText(s) ? `<small>${esc(whoText(s))}</small>` : ''}${s.exact === false ? `<small class="approx">${ic('alert')} κατά προσέγγιση</small>` : ''}</span></button></li>`).join('')}</ul>
      <p class="muted small">Αν είναι διαφορετικές διευθύνσεις, κάποια μπήκε σε λάθος θέση: πάτα τη και «Λάθος θέση; Διόρθωση».</p>`, (b) => {
      b.querySelectorAll('.grp-item').forEach((bt) => { bt.onclick = () => openStop(bt.dataset.id); });
    });
  }

  // Διόρθωση θέσης στάσης: νέα αναζήτηση (προσυμπληρωμένη) ή «πάτα στον χάρτη»
  function fixStopPlace(id) {
    const s = S.stops.find((x) => x.id === id);
    if (!s) return;
    const apply = (lat, lng, label) => {
      s.lat = lat; s.lng = lng; s.label = label || s.label; s.exact = true;
      if (S.route) { S.route.legs = null; S.route.geometry = null; scheduleLegs(); }
      save(); render();
      if (mv) mv.setView(lat, lng, Math.max(mv.getZoom(), 16));
      toast('Η θέση διορθώθηκε');
    };
    pickPlace('Διόρθωση θέσης', `<p class="small"><b>${esc(title(s))}</b></p>
      <p class="muted small">Γράψε τη διεύθυνση πιο απλά (π.χ. μόνο «Αναπαύσεως 31, Νέα Αλικαρνασσός») και διάλεξε το σωστό αποτέλεσμα —
      ή πάτα το κουμπί και μετά πάτα στο σωστό σημείο πάνω στον χάρτη.</p>
      <button class="btn btn-ghost btn-block" id="fixOnMap">${ic('map')} Θα το δείξω στον χάρτη</button>`,
    (it) => apply(it.lat, it.lng, it.label),
    (b) => {
      const inp = b.querySelector('#pSearch');
      inp.value = cleanQuery(title(s)).replace(/\s*\b\d{3}\s?\d{2}\b/, '').replace(/[,\s]+$/, '');
      inp.dispatchEvent(new Event('input'));
      b.querySelector('#fixOnMap').onclick = () => {
        closeModal(); setSheet('peek');
        if (mv) mv.setView(s.lat, s.lng, Math.max(mv.getZoom(), 16));
        toast('Πάτα στο σωστό σημείο στον χάρτη');
        pendingFix = (lat, lng) => apply(lat, lng);
      };
    });
  }
  let pendingFix = null;

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
    `<button class="btn btn-ghost btn-block" id="useGps">${ic('locate')} Χρήση τρέχουσας τοποθεσίας</button>`,
    (it) => { S.start = it; invalidateRoute(); save(); render(); fitAll(); },
    (b) => { b.querySelector('#useGps').onclick = () => { S.start = null; invalidateRoute(); save(); render(); closeModal(); }; });

  $('endRow').onclick = () => pickPlace('Τέλος διαδρομής',
    `<button class="btn btn-ghost btn-block" id="endOpen">Όπου τελειώσει η τελευταία στάση</button>
     <button class="btn btn-ghost btn-block" id="endCycle">${ic('home')} Επιστροφή στην αφετηρία</button>
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
    // Με Google: 5 αναζητήσεις ταυτόχρονα χωρίς παύση. Χωρίς Google: μία-μία (η δωρεάν υπηρεσία μπλοκάρει)
    const par = googleEnabled() ? 5 : 1;
    let next = 0, doneN = 0;
    const lane = async () => {
      while (next < entries.length) {
        const i = next++;
        try { res[i] = await geocodeSmart(entries[i].addr); } catch (e) { res[i] = null; entries[i].err = true; }
        doneN++; progress(`Εντοπισμός ${doneN}/${entries.length}…`);
        if (par === 1) await pause();
      }
    };
    progress(`Εντοπισμός 0/${entries.length}…`);
    await Promise.all(Array.from({ length: Math.min(par, entries.length) }, lane));
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
      if (e.hub) { S.stops.push(hubStop(e.hub, e.addr, r)); rememberHub(e.hub, e.addr, r); added++; return; }
      const people = (e.people || []).map((p) => ({ name: p.name, phone: p.phone, pkgs: p.pkgs || 1 }));
      S.stops.push({ id: uid(), label: r.label, lat: r.lat, lng: r.lng, note: people.length ? '' : (e.name || ''), phone: e.phone || '', orig: e.addr, exact: r.exact, done: false,
        pkgs: e.pkgs || (people.length ? people.reduce((a, p) => a + p.pkgs, 0) : undefined), people: people.length ? people : undefined, codes: e.codes || undefined });
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
      <ul class="failed-list">${failed.map((f, i) => {
        const r = rejected.get(f.addr);
        return `<li>${esc(f.addr)}${r ? `<div class="sugg">Google: ${esc(r.label)} <button class="btn btn-ghost sugg-btn" data-i="${i}">${ic('check')} Αυτό είναι</button></div>` : ''}</li>`;
      }).join('')}</ul>
      ${netErr ? `<p class="muted small">⚠️ Η υπηρεσία αναζήτησης δεν απαντούσε για ${netErr} από αυτές. Περίμενε λίγο και πάτα «Ξαναδοκίμασε».</p>` : ''}
      <button class="btn btn-ghost btn-block" id="retryFailed">${ic('repeat')} Ξαναδοκίμασε όσες δεν βρέθηκαν</button>
      <p class="muted small">Όσες δεν βρίσκονται ούτε έτσι, λείπουν από τον δωρεάν χάρτη. Πρόσθεσέ τες από την αναζήτηση γράφοντας μόνο τον δρόμο ή πάτα παρατεταμένα στο σημείο πάνω στον χάρτη.</p>` : '');
    logEl.querySelectorAll('.sugg-btn').forEach((bt) => {
      bt.onclick = () => {
        const f = failed[+bt.dataset.i], r = rejected.get(f.addr);
        if (!r) return;
        S.stops.push({ id: uid(), label: r.label, lat: r.lat, lng: r.lng, note: f.name || '', phone: f.phone || '', orig: f.addr, exact: r.exact, done: false });
        rejected.delete(f.addr);
        invalidateRoute(); save(); render();
        bt.closest('li').remove();
        toast('Προστέθηκε: ' + f.addr.split(',')[0]);
      };
    });
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
    const found = [], perImage = [], allAmbig = [];
    try {
      // 2 screenshots ταυτόχρονα (όταν είναι 3+), η σειρά διατηρείται για την ένωση κομμένων καρτελών
      const results = new Array(files.length);
      let nextIdx = 0, doneN = 0;
      const lanes = files.length >= 3 ? 2 : 1;
      busy(true, files.length > 1 ? `Διαβάζω ${files.length} εικόνες…` : 'Διαβάζω την εικόνα…');
      const lane = async (slot) => {
        while (nextIdx < files.length) {
          const i = nextIdx++;
          results[i] = await RootingOCR.recognize(files[i], (m) => {
            if (/loading|initializ/.test(m.status) && !doneN) busy(true, 'Προετοιμασία αναγνώρισης κειμένου…\n(μόνο την πρώτη φορά αργεί)');
            else if (files.length === 1 && m.status === 'recognizing text') busy(true, `Διαβάζω την εικόνα… ${Math.round((m.progress || 0) * 100)}%`);
          }, slot);
          doneN++;
          if (files.length > 1) busy(true, `Διαβάζω εικόνες… ${doneN}/${files.length}`);
        }
      };
      await Promise.all(Array.from({ length: lanes }, (_, k) => lane(k)));
      results.forEach(({ text, ambig }) => { perImage.push(RootingOCR.extractImage(text)); allAmbig.push(...ambig); });
    } catch (err) {
      console.error(err);
      busy(false);
      toast('Δεν ήταν δυνατή η ανάγνωση: ' + err.message);
      return;
    }
    busy(false);
    // ίδια διεύθυνση = μία στάση (με όλους τους πελάτες/δέματα), επικαλύψεις screenshots μετράνε μία φορά
    found.push(...RootingOCR.groupCards(RootingOCR.fixAreas(RootingOCR.applyAmbig(RootingOCR.mergeAcross(perImage), allAmbig))));
    const items = found.map((g) => {
      const m = matchExisting(g);
      return Object.assign({}, g, { dup: !!(m && m.dup), mergeInto: m && !m.dup ? m.stop.id : null });
    });
    reviewFound(items);
  });

  // Υπάρχει ήδη στάση στην ίδια διεύθυνση; dup = ίδια δέματα (κωδικοί/ονόματα), αλλιώς θα προστεθούν σε αυτήν
  function matchExisting(g) {
    if (g.hub) {
      const st = S.stops.find((x) => !x.failed && !x.done && x.hub && hubKey(x.hub) === hubKey(g.hub));
      return st ? { stop: st, dup: true } : null;
    }
    const k = RootingOCR.addrKey(g.address);
    if (k.length < 4) return null;
    const st = S.stops.find((x) => !x.failed && RootingOCR.addrKey(x.orig || x.label) === k);
    if (!st) return null;
    const stCodes = st.codes || [];
    const names = (st.people || []).map((p) => RootingOCR.key(p.name)).concat([RootingOCR.key(st.note || '')]);
    const dup = (stCodes.length && (g.codes || []).length) ? RootingOCR.codesOverlap(stCodes, g.codes)
      : (g.people || []).every((p) => names.includes(RootingOCR.key(p.name)));
    return { stop: st, dup };
  }
  function pkgsText(n) { return n === 1 ? '1 δέμα' : `${n} δέματα`; }
  // ---------- Locker / Clever Point ----------
  // Η καρτέλα τους δεν έχει διεύθυνση: τη γράφει ο χρήστης μία φορά και τη θυμόμαστε ανά όνομα σημείου.
  function hubKind(h) { return h.kind === 'locker' ? 'Locker' : 'Clever Point'; }
  function hubKey(h) { return h.kind + ':' + RootingOCR.key(h.name || ''); }
  function hubMem(h) { return (S.hubs || {})[hubKey(h)] || null; }
  function rememberHub(h, addr, r) {
    S.hubs = S.hubs || {};
    S.hubs[hubKey(h)] = { addr, lat: r.lat, lng: r.lng, label: r.label, exact: r.exact !== false };
    save();
  }
  function hubNote(h) { return [h.pickup ? 'Παραλαβή: ' + h.pickup : '', h.ret ? 'Επιστροφή: ' + h.ret : ''].filter(Boolean).join(' · '); }
  function hubStop(h, addr, r) {
    return { id: uid(), label: r.label, lat: r.lat, lng: r.lng, note: hubNote(h), phone: '', orig: addr, exact: r.exact !== false, done: false,
      hub: { kind: h.kind, name: h.name || '' }, pkgs: h.deliver || undefined, people: [{ name: h.name || hubKind(h), phone: '', pkgs: h.deliver || 1 }] };
  }
  // «Μαρία (2) · Νίκος (1)» ή η σημείωση για παλιές στάσεις
  function whoText(s) {
    if (s.hub) return hubKind(s.hub) + (s.hub.name ? ' · ' + s.hub.name : '');
    const pp = (s.people || []).filter((p) => p.name);
    if (!pp.length) return '';
    const showN = pp.length > 1 || pp.some((p) => (p.pkgs || 1) > 1);
    return pp.map((p) => p.name + (showN ? ` (${p.pkgs || 1})` : '')).join(' · ');
  }

  function reviewFound(items) {
    if (!items.length) {
      openModal('Δεν βρέθηκαν διευθύνσεις', `<p>Δεν αναγνώρισα διευθύνσεις στην εικόνα.</p>
        <p class="muted small">Βεβαιώσου ότι οι διευθύνσεις φαίνονται καθαρά, ή χρησιμοποίησε «📋 Λίστα διευθύνσεων».</p>`);
      return;
    }
    openModal(`Βρέθηκαν ${items.length} διευθύνσεις`, `
      <div class="tally">
        <div id="tallyTxt" class="tally-txt"></div>
        <label class="tally-in">Η εφαρμογή courier λέει: <input id="tallyN" type="number" inputmode="numeric" min="0" placeholder="π.χ. 45"></label>
        <div id="tallyRes" class="tally-res"></div>
      </div>
      <p class="muted small">Έλεγξε και διόρθωσε αν χρειάζεται. Ξετσέκαρε όσες δεν θέλεις.${items.some((x) => x.check) ? ` <b class="approx">${ic('alert')} Κοίτα πρώτα τις πορτοκαλί γραμμές.</b>` : ''}</p>
      <ul class="found-list">${items.map((it, i) => `
        <li${it.check ? ' class="needs-check"' : ''}>
          <input type="checkbox" id="fc${i}" ${it.dup || it.fragment ? '' : 'checked'}>
          <div class="found-body">
            ${it.hub ? `<div class="hub-head"><b class="hub-badge hub-${it.hub.kind}">${ic('home')} ${hubKind(it.hub)}</b> <b>${esc(it.hub.name || '')}</b></div>` : ''}
            <input type="text" id="fa${i}" value="${esc(it.hub ? ((hubMem(it.hub) || {}).addr || '') : it.address)}"${it.hub ? ` placeholder="Γράψε τη διεύθυνση του ${hubKind(it.hub)}"` : ''}>
            <small id="fs${i}">${it.hub ? [it.hub.deliver ? `<b class="pkg-badge">${ic('package')} ${pkgsText(it.hub.deliver)}</b>` : '', esc(hubNote(it.hub)),
              it.dup ? '<b>υπάρχει ήδη</b>' : '', hubMem(it.hub) ? `<span class="hub-mem">${ic('check')} τη θυμάμαι από άλλη μέρα</span>` : `<span class="hub-ask">${ic('alert')} γράψε τη διεύθυνση μία φορά — θα τη θυμάμαι</span>`].filter(Boolean).join(' · ') : [it.pkgs > 1 ? `<b class="pkg-badge">${ic('package')} ${pkgsText(it.pkgs)}</b>` : '', (it.people || []).length ? ic('user') + ' ' + esc(whoText(it)) : (it.name ? ic('user') + ' ' + esc(it.name) : ''), it.phone ? ic('phone') + ' ' + esc(it.phone) : '', it.dup ? '<b>υπάρχει ήδη</b>' : '', it.mergeInto ? `<b class="merge-note">${ic('plus')} θα μπει στη στάση που υπάρχει ήδη σε αυτή τη διεύθυνση</b>` : '', it.ambig ? `<span class="ambig">${ic('alert')} Αριθμός: <button class="chip-sm on" data-i="${i}" data-v="a">${esc(it.ambig.a)}</button> ή <button class="chip-sm" data-i="${i}" data-v="b">${esc(it.ambig.b)}</button>;</span>` : '', it.fragment ? `<b>${ic('alert')} κομμάτι διεύθυνσης — συμπλήρωσε την οδό</b>` : ''].filter(Boolean).join(' · ')}</small>
            ${it.check ? `<div class="check-row">${ic('alert')} Ίσως η ίδια καρτέλα του <b>${esc(it.check.name || 'πελάτη')}</b> πιάστηκε σε δύο screenshots. Πόσα δέματα;
              <button class="chip-sm" data-ck="${i}" data-v="${it.pkgs - it.check.minus}">${pkgsText(it.pkgs - it.check.minus)}</button>
              <button class="chip-sm" data-ck="${i}" data-v="${it.pkgs}">${pkgsText(it.pkgs)}</button></div>` : ''}
          </div>
        </li>`).join('')}</ul>
      <button class="btn btn-primary btn-block" id="foundGo">Προσθήκη</button>
      <div id="foundLog" class="bulk-log"></div>`, (b) => {
      const btn = b.querySelector('#foundGo');
      const count = () => items.filter((_, i) => b.querySelector('#fc' + i).checked && b.querySelector('#fa' + i).value.trim()).length;
      // σύνολα για σύγκριση με την εφαρμογή courier
      const tally = () => {
        const on = items.filter((_, i) => b.querySelector('#fc' + i).checked || items[i].dup);
        const cust = on.filter((x) => !x.hub), hubs = on.filter((x) => x.hub);
        const cards = cust.reduce((a, x) => a + (x.cards || 1), 0);
        const pk = cust.reduce((a, x) => a + (x.pkgs || 1), 0);
        b.querySelector('#tallyTxt').innerHTML = `Βρήκα <b>${cards}</b> καρτέλες πελατών · <b>${pk}</b> δέματα` + (hubs.length ? ` · <b>${hubs.length}</b> Locker/Clever Point` : '');
        const n = parseInt(b.querySelector('#tallyN').value, 10), res = b.querySelector('#tallyRes');
        if (!(n > 0)) { res.innerHTML = ''; return; }
        const okN = [cards, cards + hubs.length, pk, pk + hubs.length];
        if (okN.includes(n)) res.innerHTML = `<span class="ok-txt">${ic('check')} Ταιριάζει</span>`;
        else {
          const d = n - (cards + hubs.length);
          res.innerHTML = `<span class="fail-txt">${ic('alert')} Δεν ταιριάζει: ${d > 0 ? `λείπουν ~${d}` : `περισσεύουν ~${-d}`}. ${d > 0 ? 'Μήπως λείπει κάποιο screenshot ή κομμάτι λίστας;' : 'Μήπως κάποια καρτέλα μετρήθηκε δύο φορές (δες τις πορτοκαλί);'}</span>`;
        }
      };
      b.querySelector('#tallyN').addEventListener('input', tally);
      b.querySelectorAll('[data-ck]').forEach((ch) => {
        ch.onclick = () => {
          const it = items[+ch.dataset.ck], v = +ch.dataset.v;
          const diff = it.pkgs - v;
          it.pkgs = v;
          const pp = (it.people || []).find((p) => p.name === it.check.name) || (it.people || [])[0];
          if (pp) pp.pkgs = Math.max(1, (pp.pkgs || 1) - diff);
          it.cards = Math.max(1, (it.cards || 1) - diff);
          it.check.minus = 0;
          ch.parentNode.querySelectorAll('.chip-sm').forEach((x) => x.classList.toggle('on', x === ch));
          tally();
        };
      });
      const upd0 = () => { btn.textContent = `Προσθήκη ${count()} στάσεων`; btn.disabled = !count(); };
      const upd = () => { upd0(); tally(); };
      items.forEach((_, i) => { b.querySelector('#fc' + i).addEventListener('change', upd); b.querySelector('#fa' + i).addEventListener('input', upd); });
      // Locker/Clever Point που δεν έχουμε ξαναδεί: δοκιμάζουμε να τα βρει η Google από το όνομα (ο χρήστης ελέγχει)
      if (googleEnabled()) items.forEach((it, i) => {
        if (!it.hub || !it.hub.name || hubMem(it.hub)) return;
        const ref = myPos || stopsCenter() || S.lastPos;
        const q = it.hub.name.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
        googleGeocode(q, ref).then((g) => {
          const inp = b.querySelector('#fa' + i);
          if (!g || !inp || inp.value.trim() || (ref && RootingGeo.distKm(ref, g) > 25)) return;
          inp.value = g.label; upd();
          const note = b.querySelector('#fs' + i + ' .hub-ask');
          if (note) note.innerHTML = `${ic('search')} βρέθηκε από τη Google — έλεγξε ότι είναι σωστό`;
        }).catch(() => {});
      });
      b.querySelectorAll('.chip-sm').forEach((ch) => {
        ch.onclick = () => {
          const it = items[+ch.dataset.i];
          b.querySelector('#fa' + ch.dataset.i).value = ch.dataset.v === 'a' ? it.ambig.addrA : it.ambig.addrB;
          ch.parentNode.querySelectorAll('.chip-sm').forEach((x) => x.classList.toggle('on', x === ch));
        };
      });
      upd();
      btn.onclick = async () => {
        const chosen = items.map((it, i) => ({ it, on: b.querySelector('#fc' + i).checked, addr: b.querySelector('#fa' + i).value.trim() }))
          .filter((x) => x.on && x.addr);
        btn.disabled = true;
        if (!myPos) { btn.textContent = 'Εντοπισμός θέσης…'; try { await getPosition(6000); } catch (e) { /* συνεχίζουμε χωρίς */ } }
        // στάσεις που υπάρχουν ήδη στην ίδια διεύθυνση: προσθέτουμε πελάτες/δέματα, χωρίς νέα αναζήτηση
        let merged = 0;
        chosen.filter((x) => x.it.mergeInto).forEach((x) => {
          const st = S.stops.find((y) => y.id === x.it.mergeInto);
          if (!st) return;
          if (!st.people) st.people = st.note ? [{ name: st.note, phone: st.phone || '', pkgs: st.pkgs || 1 }] : [];
          (x.it.people || []).forEach((p) => st.people.push({ name: p.name, phone: p.phone, pkgs: p.pkgs || 1 }));
          st.pkgs = (st.pkgs || 1) + (x.it.pkgs || 1);
          st.codes = (st.codes || []).concat(x.it.codes || []);
          if (!st.phone) st.phone = x.it.phone || '';
          if (st.done && !st.failed) { st.done = false; st.doneAt = null; } // νέο δέμα σε παραδομένη διεύθυνση -> ξανά στη λίστα
          merged++;
        });
        let hubsKnown = 0;
        // Locker/Clever Point με γνωστή διεύθυνση (ίδια με την αποθηκευμένη): χωρίς νέα αναζήτηση
        chosen.filter((x) => x.it.hub).forEach((x) => {
          const m = hubMem(x.it.hub);
          if (m && m.addr === x.addr) { S.stops.push(hubStop(x.it.hub, x.addr, m)); x.known = true; hubsKnown++; }
        });
        if (hubsKnown) invalidateRoute();
        merged += hubsKnown;
        if (merged) { save(); render(); }
        const out = await geocodeBatch(chosen.filter((x) => !x.it.mergeInto && !x.known).map((x) => ({ addr: x.addr, name: x.it.name, phone: x.it.phone, pkgs: x.it.pkgs, people: x.it.people, codes: x.it.codes, hub: x.it.hub })), (t) => { btn.textContent = t; });
        out.added += merged;
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
        if (S.route) { S.route.order = S.route.order.filter((x) => !ids.has(x)); S.route.legs = null; S.route.geometry = null; if (!S.route.order.length) S.route = null; else scheduleLegs(); }
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
      <label class="field"><span>Πλοήγηση με</span>
        <select id="sNav">
          <option value="apple">Apple Χάρτες</option>
          <option value="google">Google Maps</option>
          <option value="waze">Waze</option>
          <option value="inapp">Μέσα στην εφαρμογή (με φωνή)</option>
        </select></label>
      <label class="field"><span>Χρόνος σε κάθε στάση (λεπτά)</span>
        <input id="sSvc" type="number" min="0" max="120" inputmode="numeric" value="${S.settings.serviceMin}"></label>
      ${g ? `<a class="btn btn-ghost btn-block" href="${esc(g)}" target="_blank" rel="noopener">${ic('globe')} Όλη η διαδρομή στο Google Maps (μέσω browser)</a><p class="muted small">Χρησιμοποίησέ το μόνο αν δεν ανοίγει η εφαρμογή Google Maps.</p>` : ''}
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
      <button class="btn btn-ghost btn-block" id="sExport">${ic('download')} Εξαγωγή στάσεων (κείμενο)</button>
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
        const txt = orderedStops().map((s, i) => `${i + 1}. ${s.failed ? '✗ ' : (s.done ? '✓ ' : '')}${s.label}${s.note ? ' — ' + s.note : ''}${s.phone ? ' — ' + s.phone : ''}`).join('\n');
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

  // «↶ Αναίρεση» της τελευταίας στάσης (μένει 15 λεπτά, ακόμα κι αφού γυρίσεις από το Google Maps)
  function lastDoneStop() {
    const l = S.lastDone;
    if (!l || Date.now() - l.at > 15 * 60000) return null;
    const s = S.stops.find((x) => x.id === l.id);
    return s && s.done ? s : null;
  }
  function undoLastHtml(cls) {
    const s = lastDoneStop();
    return s ? `<button class="btn ${cls}" data-undo-last>${ic('undo')} Αναίρεση: ${esc(title(s).split(',')[0])} <small>(${s.failed ? 'αποτυχία' : 'παραδόθηκε'})</small></button>` : '';
  }
  function bindUndoLast(root) {
    root.querySelectorAll('[data-undo-last]').forEach((b) => {
      b.onclick = () => { const s = lastDoneStop(); if (!s) return; S.lastDone = null; markDone(s.id, false); toast('Η στάση επανήλθε ως επόμενη'); };
    });
  }

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
      ${undoLastHtml('d-undo')}
      <div class="d-label">Στάση ${idx + 1} από ${list.length}${eta ? ' · άφιξη ~' + fmtClock(eta.at) : ''}</div>
      <div class="d-title">${esc(title(next))}</div>
      ${next.pkgs ? `<div class="d-note"><b class="pkg-badge${next.pkgs > 1 ? ' multi' : ''}">${ic('package')} ${pkgsText(next.pkgs)}</b></div>` : ''}
      ${whoText(next) ? `<div class="d-note">${ic('user')} ${esc(whoText(next))}</div>` : ''}
      ${next.note ? `<div class="d-note">${ic('note')} ${esc(next.note)}</div>` : ''}
      ${next.phone ? `<a class="btn btn-ghost d-call" href="tel:${esc(next.phone.replace(/\s/g, ''))}">${ic('phone')} ${esc(next.phone)}</a>` : ''}
      <button class="btn btn-success d-big" id="dDoneGo"><span>${ic('check')} Παραδόθηκε</span><small>${after ? 'και πλοήγηση στην επόμενη' : 'τελευταία στάση'}</small></button>
      <div class="d-row">
        <button class="btn btn-primary d-mid" id="dNav">${ic('nav')} Πλοήγηση</button>
        <button class="btn btn-ghost d-mid" id="dDoneOnly">${ic('check')} Μόνο παραδόθηκε</button>
      </div>
      <button class="btn btn-ghost d-mid d-wide" id="dFull">${ic('map')} ${chunkLabel()} στο Google Maps</button>
      <button class="btn btn-fail d-mid d-wide" id="dFail">${ic('x')} Αποτυχία παράδοσης</button>`;
    $('dNav').onclick = () => navigateTo(next);
    $('dFull').onclick = () => { const u = googleFullRouteUrl(); startBatch(); openUrl(u); };
    $('dDoneOnly').onclick = () => markDone(next.id, true, true);
    $('dFail').onclick = () => markFailed(next.id);
    bindUndoLast($('dBody'));
    $('dDoneGo').onclick = () => {
      markDone(next.id, true);
      const nn = orderedStops().find((s) => !s.done);
      if (nn) navigateTo(nn);
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
  // Οριζόντια οθόνη (κινητό στη βάση): η λίστα γίνεται στήλη αριστερά, ο χάρτης δεξιά
  function isLand() { return window.innerWidth > window.innerHeight && window.innerHeight < 560; }
  function setSheet(state, animate = true) {
    sheetState = state;
    document.body.classList.toggle('land', isLand());
    if (isLand()) {
      sheet.classList.add('full');
      sheet.style.transform = 'none';
      document.documentElement.style.setProperty('--sheet-top', '0px');
      document.documentElement.style.setProperty('--map-bottom', '0px');
      return;
    }
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
      if (e.touches.length !== 1 || isLand()) { mode = 'scroll'; return; }
      y0 = lastY = e.touches[0].clientY; x0s = e.touches[0].clientX; t0 = lastT = Date.now(); startY = sheetY; mode = null; vel = 0;
      fromHandle = !!e.target.closest('.sheet-handle');
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1 || isLand()) return;
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
  window.addEventListener('orientationchange', () => setTimeout(() => { setSheet(sheetState, false); if (!RootingNav.active()) fitAll(); }, 350));
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
        mv = await RootingMapView.createGoogle(el, center, S.settings.googleMapId, googleScheme());
        S.settings.mapUsage = { month: monthKey(), count: mapUsage() + 1 }; save();
      } catch (e) { console.warn('Google map', e); mv = null; el.innerHTML = ''; }
    }
    if (!mv) mv = RootingMapView.createLeaflet(el, center);
    mv.onLongPress(onMapLongPress);
    if (mv.onTap) mv.onTap((lat, lng) => { if (pendingFix) { const f = pendingFix; pendingFix = null; f(lat, lng); } });
    $('btnTraffic').classList.toggle('hidden', !mv.canTraffic);
    $('btnSat').classList.toggle('hidden', !mv.canSatellite);
    if (mv.canSatellite && S.settings.satellite) { mv.setSatellite(true); $('btnSat').classList.add('on'); }
    if (mv.canRotate) mv.onRotate((rot) => $('btnNorth').classList.toggle('hidden', !rot));
    applyTheme();
    showMe();
  }
  function onGoogleAuthFailure() {
    if (mv && mv.kind === 'google') {
      toast('Ο χάρτης Google δεν δέχτηκε το κλειδί — χρησιμοποιείται ο δωρεάν χάρτης');
      $('map').innerHTML = ''; mv = null;
      const el = $('map').cloneNode(false); $('map').replaceWith(el);
      mv = RootingMapView.createLeaflet(el, DEFAULT_CENTER);
      mv.onLongPress(onMapLongPress);
      if (mv.onTap) mv.onTap((lat, lng) => { if (pendingFix) { const f = pendingFix; pendingFix = null; f(lat, lng); } });
      $('btnTraffic').classList.add('hidden'); $('btnNorth').classList.add('hidden'); $('btnSat').classList.add('hidden');
      applyTheme(); render(); fitAll(); showMe();
    }
  }
  let trafficOn = false;
  $('btnTraffic').onclick = () => { trafficOn = !trafficOn; mv.setTraffic(trafficOn); $('btnTraffic').classList.toggle('on', trafficOn); };
  $('btnNorth').onclick = () => mv.resetNorth();

  // ---------- Εμφάνιση: Αυτόματο / Ανοιχτό / Σκούρο ----------
  const sysDark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  function themeSetting() { return S.settings.theme || 'auto'; }
  function wantDark() { const t = themeSetting(); return t === 'dark' || (t === 'auto' && sysDark.matches); }
  function googleScheme() { const t = themeSetting(); return t === 'dark' ? 'DARK' : t === 'light' ? 'LIGHT' : 'FOLLOW_SYSTEM'; }
  function applyTheme() {
    const t = themeSetting(), dark = wantDark();
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0f17' : '#2563eb');
    $('map').classList.toggle('dark-tiles', !!(mv && mv.kind === 'leaflet' && dark));
    document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
  }
  // ο χάρτης Google δεν αλλάζει χρώμα αφού φορτώσει: τον ξαναφορτώνουμε στην ίδια θέση
  async function restartMapForTheme() {
    if (!mv || mv.kind !== 'google') return;
    const rendered = mv.scheme === 'FOLLOW_SYSTEM' ? sysDark.matches : mv.scheme === 'DARK';
    if (rendered === wantDark() && (mv.scheme === 'FOLLOW_SYSTEM') === (themeSetting() === 'auto')) return;
    if (window.RootingNav && RootingNav.active()) return; // όχι στη μέση της πλοήγησης
    const c = mv.getCenter(), z = mv.getZoom();
    const el = $('map').cloneNode(false); $('map').replaceWith(el);
    mv = null; trafficOn = false; $('btnTraffic').classList.remove('on');
    await startMap();
    mv.setView(c.lat, c.lng, z);
    render();
  }
  function setTheme(t) { S.settings.theme = t; save(); applyTheme(); restartMapForTheme(); }
  document.querySelectorAll('#themeSeg button').forEach((b) => { b.onclick = () => setTheme(b.dataset.theme); });
  if (sysDark.addEventListener) sysDark.addEventListener('change', () => { if (themeSetting() === 'auto') applyTheme(); });
  applyTheme();

  // ---------- Μενού χάρτη (☰) ----------
  function setMenu(open) {
    $('mapMenu').classList.toggle('hidden', !open);
    $('btnMenu').classList.toggle('open', open);
    $('btnMenu').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  $('btnMenu').onclick = (e) => { e.stopPropagation(); setMenu($('mapMenu').classList.contains('hidden')); };
  $('mapMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', (e) => { if (!$('mapMenu').classList.contains('hidden') && !e.target.closest('.map-ctrls')) setMenu(false); }, true);
  $('btnSettings').addEventListener('click', () => setMenu(false));

  // ---------- Εκκίνηση ----------
  render();
  setSheet(S.route ? 'peek' : 'half', false);
  startMap().then(() => {
    render();
    if (S.route && !S.route.legs) scheduleLegs(); // στατιστικά που χάθηκαν παλιότερα
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
