/* Rooting — βελτιστοποίηση δρομολογίων (PWA) */
(function () {
  'use strict';

  const OSRM = 'https://router.project-osrm.org';
  const PHOTON = 'https://photon.komoot.io';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const STORE_KEY = 'rooting.v1';
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
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([37.9838, 23.7275], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  const layerMarkers = L.layerGroup().addTo(map);
  let routeLine = null;
  let meMarker = null;

  function numIcon(text, cls) {
    return L.divIcon({ className: '', html: `<div class="pin ${cls || ''}">${esc(text)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  // Παρατεταμένο πάτημα / δεξί κλικ για προσθήκη στάσης
  map.on('contextmenu', async (e) => {
    const { lat, lng } = e.latlng;
    const popup = L.popup().setLatLng(e.latlng).setContent('Αναζήτηση διεύθυνσης…').openOn(map);
    const label = await reverseGeocode(lat, lng);
    const div = document.createElement('div');
    div.innerHTML = `<div style="margin-bottom:8px">${esc(label)}</div>`;
    const b = document.createElement('button');
    b.className = 'btn btn-primary'; b.textContent = '+ Προσθήκη στάσης';
    b.onclick = () => { addStop({ label, lat, lng }); map.closePopup(); };
    div.appendChild(b);
    popup.setContent(div);
  });

  // ---------- Γεωεντοπισμός ----------
  function getPosition(timeout) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Δεν υποστηρίζεται εντοπισμός θέσης'));
      navigator.geolocation.getCurrentPosition(
        (p) => { myPos = { lat: p.coords.latitude, lng: p.coords.longitude }; showMe(); resolve(myPos); },
        (err) => reject(new Error(err.code === 1 ? 'Δεν δόθηκε άδεια τοποθεσίας' : 'Δεν βρέθηκε η τοποθεσία')),
        { enableHighAccuracy: true, timeout: timeout || 12000, maximumAge: 30000 }
      );
    });
  }
  function showMe() {
    if (!myPos) return;
    if (!meMarker) meMarker = L.circleMarker([myPos.lat, myPos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
    else meMarker.setLatLng([myPos.lat, myPos.lng]);
  }
  let watchId = null;
  function startWatch() {
    if (!navigator.geolocation || watchId != null) return;
    watchId = navigator.geolocation.watchPosition((p) => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude }; showMe();
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

  async function geocode(q, limit) {
    const bias = myPos || (S.start ? S.start : null) || { lat: map.getCenter().lat, lng: map.getCenter().lng };
    try {
      const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=${limit || 6}&lat=${bias.lat}&lon=${bias.lng}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('photon ' + r.status);
      const j = await r.json();
      const res = (j.features || []).map((f) => ({ label: photonLabel(f), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
      if (res.length) return res;
    } catch (e) { /* fallback */ }
    const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=0&accept-language=el&limit=${limit || 6}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Σφάλμα αναζήτησης');
    const j = await r.json();
    return j.map((x) => ({ label: x.display_name.split(',').slice(0, 4).join(','), lat: +x.lat, lng: +x.lon }));
  }

  // Δοκιμάζει παραλλαγές (π.χ. χωρίς ΤΚ, χωρίς περιοχή) αν δεν βρεθεί αμέσως
  async function geocodeSmart(q) {
    const variants = [q];
    const noPostal = q.replace(/\b\d{3}\s?\d{2}\b/g, '').replace(/\s+,/g, ',').replace(/[,\s]+$/, '').trim();
    if (noPostal && noPostal !== q) variants.push(noPostal);
    const parts = q.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 2) variants.push(parts[0] + ', ' + parts[parts.length - 1]);
    let lastErr = null;
    for (const v of variants) {
      try {
        const r = await geocode(v, 1);
        if (r[0]) return r[0];
      } catch (e) { lastErr = e; }
    }
    if (lastErr && variants.length === 1) throw lastErr;
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
        const res = await geocode(q);
        if (seq !== searchSeq) return;
        lastResults = res;
        renderSuggestions(res.length ? res : [], pickSuggestion);
        if (!res.length) toast('Δεν βρέθηκε η διεύθυνση');
      } catch (e) { if (seq === searchSeq) toast('Δεν υπάρχει σύνδεση για αναζήτηση'); }
    }, 350);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastResults[0] && !sugEl.classList.contains('hidden')) { e.preventDefault(); pickSuggestion(lastResults[0]); }
  });
  searchEl.addEventListener('blur', () => setTimeout(() => sugEl.classList.add('hidden'), 200));

  // ---------- Στάσεις ----------
  function addStop(p) {
    S.stops.push({ id: uid(), label: p.label, lat: p.lat, lng: p.lng, note: '', phone: '', done: false });
    invalidateRoute();
    save(); render();
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14));
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

  // ---------- Απόδοση ----------
  function fmtDur(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return m + "'";
    return Math.floor(m / 60) + 'ω ' + String(m % 60).padStart(2, '0') + "'";
  }
  function fmtKm(m) { return m < 1000 ? Math.round(m) + ' μ' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' χλμ'; }
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
    const stopsEl = $('stops');
    stopsEl.innerHTML = '';
    const nextStop = S.route ? list.find((s) => !s.done) : null;

    list.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'stop' + (s.done ? ' done' : '') + (nextStop && nextStop.id === s.id ? ' current' : '');
      const eta = etas[s.id];
      const meta = [];
      if (eta) meta.push(`🕒 ${fmtClock(eta.at)}`, `${fmtKm(eta.leg.distance)} · ${fmtDur(eta.leg.duration)}`);
      if (s.note) meta.push('📝 ' + s.note);
      li.innerHTML = `
        <span class="num">${s.done ? '✓' : (S.route ? i + 1 : '•')}</span>
        <span class="stop-body">
          <span class="stop-title">${esc(s.label)}</span>
          ${meta.length ? `<span class="stop-meta">${meta.map(esc).join('  ·  ')}</span>` : ''}
        </span>
        <span class="chev">›</span>`;
      li.onclick = () => openStop(s.id);
      stopsEl.appendChild(li);
    });

    $('stopCount').textContent = S.stops.length;
    const done = S.stops.filter((s) => s.done).length;
    $('doneCount').textContent = S.route && S.stops.length ? `${done}/${S.stops.length} ολοκληρώθηκαν` : '';
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
      $('nextIdx').textContent = `· ${idx + 1} από ${list.length}`;
      $('nextTitle').textContent = nextStop.label;
      const eta = etas[nextStop.id];
      const sub = [];
      if (eta) sub.push(`Άφιξη ~${fmtClock(eta.at)}`);
      if (nextStop.note) sub.push(nextStop.note);
      $('nextSub').textContent = sub.join(' · ');
      $('btnNavNext').href = navUrl(nextStop);
      if (navUrl(nextStop).startsWith('http')) $('btnNavNext').target = '_blank'; else $('btnNavNext').removeAttribute('target');
      $('btnDoneNext').onclick = () => markDone(nextStop.id, true);
      $('btnSkipNext').onclick = () => skipStop(nextStop.id);
      const n = nextChunk().length;
      $('btnFullRoute').textContent = n > 1 ? `🗺 Όλη η διαδρομή στο Google Maps (${n} στάσεις)` : '🗺 Άνοιγμα στο Google Maps';
      $('btnFullRoute').href = googleFullRouteUrl();
    } else card.classList.add('hidden');
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
      if (!nextStop) sum.innerHTML += `<div class="all-done">🎉 Ολοκληρώθηκαν όλες οι στάσεις!</div>`;
      sum.classList.remove('hidden');
    } else sum.classList.add('hidden');

    drawMap(list, nextStop);
  }

  function drawMap(list, nextStop) {
    layerMarkers.clearLayers();
    const pts = [];
    const origin = S.route && S.route.origin ? S.route.origin : S.start;
    if (origin) {
      L.marker([origin.lat, origin.lng], { icon: numIcon('▶', 'pin-start') }).addTo(layerMarkers).bindPopup('Αφετηρία: ' + esc(origin.label || ''));
      pts.push([origin.lat, origin.lng]);
    }
    list.forEach((s, i) => {
      const cls = s.done ? 'pin-done' : (nextStop && nextStop.id === s.id ? 'pin-next' : '');
      const m = L.marker([s.lat, s.lng], { icon: numIcon(s.done ? '✓' : (S.route ? i + 1 : '•'), cls) }).addTo(layerMarkers);
      m.on('click', () => openStop(s.id));
      pts.push([s.lat, s.lng]);
    });
    if (S.endMode === 'fixed' && S.end) {
      L.marker([S.end.lat, S.end.lng], { icon: numIcon('■', 'pin-end') }).addTo(layerMarkers).bindPopup('Τέλος: ' + esc(S.end.label));
      pts.push([S.end.lat, S.end.lng]);
    }
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (S.route && S.route.geometry) {
      routeLine = L.polyline(S.route.geometry, { color: '#2563eb', weight: 5, opacity: 0.8, dashArray: S.route.approx ? '8 8' : null }).addTo(map);
    }
    return pts;
  }

  function fitAll() {
    const pts = [];
    layerMarkers.eachLayer((m) => pts.push(m.getLatLng()));
    if (myPos) pts.push(L.latLng(myPos.lat, myPos.lng));
    if (pts.length === 1) map.setView(pts[0], 15);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  }

  // ---------- Πλοήγηση ----------
  function navUrl(s) {
    const ll = `${s.lat},${s.lng}`;
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
    const ll = (s) => `${s.lat},${s.lng}`;
    if (!web) return `comgooglemaps://?daddr=${chunk.map(ll).join('+to:')}&directionsmode=driving`;
    const dest = chunk[chunk.length - 1];
    const wps = chunk.slice(0, -1).map(ll).join('|');
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${ll(dest)}` + (wps ? `&waypoints=${encodeURIComponent(wps)}` : '');
  }
  function openUrl(url) { window.location.href = url; }

  // ---------- Ενέργειες στάσεων ----------
  function markDone(id, val) {
    const s = S.stops.find((x) => x.id === id);
    if (!s) return;
    s.done = val; s.doneAt = val ? Date.now() : null;
    save(); render();
    if (val) {
      const next = orderedStops().find((x) => !x.done);
      if (next) map.panTo([next.lat, next.lng]);
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

  function deleteStop(id) {
    S.stops = S.stops.filter((s) => s.id !== id);
    if (S.route) {
      S.route.order = S.route.order.filter((x) => x !== id);
      S.route.legs = null; S.route.geometry = null;
      if (!S.route.order.length) S.route = null;
    }
    save(); render();
  }

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
    map.setView([s.lat, s.lng], Math.max(map.getZoom(), 15));
    openModal('Στάση', `
      <p class="stop-full">${esc(s.label)}</p>
      ${s.orig ? `<p class="muted small">Από screenshot: ${esc(s.orig)}</p>` : ''}
      <div class="grid2">
        <a class="btn btn-primary" href="${esc(navUrl(s))}"${navUrl(s).startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>➤ Πλοήγηση</a>
        <button class="btn ${s.done ? 'btn-ghost' : 'btn-success'}" id="mDone">${s.done ? '↺ Αναίρεση' : '✓ Ολοκληρώθηκε'}</button>
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
      b.querySelector('#mDone').onclick = () => { persist(); markDone(s.id, !s.done); closeModal(); };
      b.querySelector('#mUp').onclick = () => { persist(); moveStop(s.id, -1); };
      b.querySelector('#mDown').onclick = () => { persist(); moveStop(s.id, 1); };
      b.querySelector('#mDel').onclick = () => { if (confirm('Διαγραφή στάσης;')) { deleteStop(s.id); closeModal(); } };
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
      let ok = 0; const failed = [];
      for (let i = 0; i < lines.length; i++) {
        btn.textContent = `Αναζήτηση ${i + 1}/${lines.length}…`;
        const line = lines[i];
        try {
          const r = await geocode(line, 1);
          if (r[0]) {
            S.stops.push({ id: uid(), label: r[0].label, lat: r[0].lat, lng: r[0].lng, note: line !== r[0].label ? 'Αρχικό: ' + line : '', phone: '', done: false });
            ok++;
          } else failed.push(line);
        } catch (e) { failed.push(line); }
        await new Promise((res) => setTimeout(res, 250));
      }
      invalidateRoute(); save(); render(); fitAll();
      btn.disabled = false; btn.textContent = 'Προσθήκη';
      log.innerHTML = `<p>✓ Προστέθηκαν ${ok} στάσεις.</p>` + (failed.length ? `<p class="err">Δεν βρέθηκαν (${failed.length}):</p><ul>${failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><p class="muted small">Δοκίμασε να τις γράψεις πιο αναλυτικά από την αναζήτηση.</p>` : '');
      if (!failed.length) setTimeout(closeModal, 900);
    };
  });


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
        let ok = 0; const failed = [];
        for (let i = 0; i < chosen.length; i++) {
          btn.textContent = `Εντοπισμός ${i + 1}/${chosen.length}…`;
          const { it, addr } = chosen[i];
          try {
            const r = await geocodeSmart(addr);
            if (r) {
              S.stops.push({ id: uid(), label: r.label, lat: r.lat, lng: r.lng, note: it.name || '', phone: it.phone || '', orig: addr, done: false });
              ok++;
            } else failed.push(addr);
          } catch (err) { failed.push(addr); }
          await new Promise((res) => setTimeout(res, 250));
        }
        invalidateRoute(); save(); render(); fitAll();
        btn.disabled = false; btn.textContent = 'Προσθήκη';
        b.querySelector('#foundLog').innerHTML = `<p>✓ Προστέθηκαν ${ok} στάσεις.</p>` + (failed.length ? `<p class="err">Δεν βρέθηκαν στον χάρτη (${failed.length}):</p><ul>${failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><p class="muted small">Πρόσθεσέ τες χειροκίνητα από την αναζήτηση.</p>` : '');
        if (!failed.length) setTimeout(closeModal, 900);
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
  $('btnSettings').onclick = () => {
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
      <button class="btn btn-ghost btn-block" id="sExport">⬇︎ Εξαγωγή στάσεων (κείμενο)</button>
      <p class="muted small">Χάρτες: © OpenStreetMap contributors. Δρομολόγηση: OSRM. Αναζήτηση: Photon / Nominatim.<br>Τα δεδομένα σου αποθηκεύονται μόνο σε αυτό το κινητό.</p>`, (b) => {
      const sel = b.querySelector('#sNav');
      sel.value = S.settings.navApp;
      sel.onchange = () => { S.settings.navApp = sel.value; save(); render(); };
      const svc = b.querySelector('#sSvc');
      svc.onchange = () => { S.settings.serviceMin = Math.max(0, +svc.value || 0); save(); render(); };
      b.querySelector('#sExport').onclick = async () => {
        const txt = orderedStops().map((s, i) => `${i + 1}. ${s.label}${s.note ? ' — ' + s.note : ''}${s.phone ? ' — ' + s.phone : ''}`).join('\n');
        try {
          if (navigator.share) await navigator.share({ title: 'Στάσεις', text: txt });
          else { await navigator.clipboard.writeText(txt); toast('Αντιγράφηκε'); }
        } catch (e) { /* ακυρώθηκε */ }
      };
    });
  };

  $('btnLocate').onclick = async () => {
    try { const p = await getPosition(); map.setView([p.lat, p.lng], 15); startWatch(); }
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
      $('panel').scrollTo({ top: 0, behavior: 'smooth' });
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
      <div class="d-title">${esc(next.label)}</div>
      ${next.note ? `<div class="d-note">📝 ${esc(next.note)}</div>` : ''}
      ${next.phone ? `<a class="btn btn-ghost d-call" href="tel:${esc(next.phone.replace(/\s/g, ''))}">📞 ${esc(next.phone)}</a>` : ''}
      <button class="btn btn-success d-big" id="dDoneGo">✓ Παραδόθηκε<small>${after ? 'και πλοήγηση στην επόμενη' : 'τελευταία στάση'}</small></button>
      <div class="d-row">
        <button class="btn btn-primary d-mid" id="dNav">➤ Πλοήγηση</button>
        <button class="btn btn-ghost d-mid" id="dDoneOnly">✓ Μόνο παραδόθηκε</button>
      </div>
      <button class="btn btn-ghost d-mid d-wide" id="dFull">🗺 Όλη η διαδρομή στο Google Maps${n > 1 ? ` (${n} στάσεις)` : ''}</button>
      <button class="btn btn-link" id="dSkip">Παράλειψη για αργότερα</button>`;
    $('dNav').onclick = () => openUrl(navUrl(next));
    $('dFull').onclick = () => openUrl(googleFullRouteUrl());
    $('dDoneOnly').onclick = () => markDone(next.id, true);
    $('dSkip').onclick = () => skipStop(next.id);
    $('dDoneGo').onclick = () => {
      markDone(next.id, true);
      const nn = orderedStops().find((s) => !s.done);
      if (nn) openUrl(navUrl(nn));
    };
  }
  $('btnDrive').onclick = openDrive;
  $('dClose').onclick = closeDrive;

  // ---------- Εκκίνηση ----------
  render();
  if (layerMarkers.getLayers().length) fitAll();
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') getPosition().then((pos) => { if (!S.stops.length) map.setView([pos.lat, pos.lng], 14); startWatch(); }).catch(() => {});
    }).catch(() => {});
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
