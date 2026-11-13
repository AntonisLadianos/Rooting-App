/*
 * Ενιαίο «κομμάτι χάρτη»: Google Maps (με κλειδί) ή Leaflet/OpenStreetMap (δωρεάν).
 * Η υπόλοιπη εφαρμογή μιλάει μόνο με αυτές τις συναρτήσεις.
 *
 *   view.kind                         'google' | 'leaflet'
 *   view.setView(lat, lng, zoom)      view.panTo(lat, lng)      view.getZoom()   view.getCenter()
 *   view.fit(points, pad)             pad = {top, bottom, left, right} σε pixels
 *   view.setMarkers([{lat, lng, text, cls, onClick, title}])
 *   view.setRoute([[lat, lng], ...], dashed)     view.setMe({lat, lng} | null)
 *   view.onLongPress(cb(lat, lng))    view.popup(lat, lng, element)   view.closePopup()
 *   view.canRotate                    view.resetNorth()   view.onRotate(cb(rotated))
 *   view.canTraffic                   view.setTraffic(on)
 */
(function (global) {
  'use strict';

  // σημείο λίγο μπροστά (προς την κατεύθυνση), ώστε ο οδηγός να φαίνεται στο κάτω μέρος της οθόνης
  function ahead(p, heading, meters) {
    const r = Math.PI / 180, d = meters / 6371000;
    const lat = p.lat * r, lng = p.lng * r, h = (heading || 0) * r;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(h));
    const lng2 = lng + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    return { lat: lat2 / r, lng: lng2 / r };
  }

  function pinEl(text, cls) {
    const d = document.createElement('div');
    d.className = 'pin ' + (cls || '');
    d.textContent = text;
    return d;
  }
  // Περιτύλιγμα για τις καρτέλες πάνω στον χάρτη: δικό μας κουμπί ✕ (φαίνεται σε ανοιχτό και σκούρο θέμα)
  function popupWrap(element, onClose) {
    const w = document.createElement('div');
    w.className = 'map-popup-wrap';
    const x = document.createElement('button');
    x.className = 'mp-close'; x.type = 'button'; x.setAttribute('aria-label', 'Κλείσιμο'); x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); onClose(); };
    w.appendChild(x); w.appendChild(element);
    return w;
  }
  function meEl() {
    const d = document.createElement('div');
    d.className = 'me-dot';
    return d;
  }

  // ---------------- Google ----------------
  async function createGoogle(el, center, mapId, scheme) {
    const { Map, InfoWindow, Polyline, TrafficLayer, RenderingType } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    const map = new Map(el, {
      center, zoom: 12,
      mapId: mapId || 'DEMO_MAP_ID',
      renderingType: RenderingType ? RenderingType.VECTOR : 'VECTOR',
      colorScheme: scheme || 'FOLLOW_SYSTEM',
      disableDefaultUI: true,
      gestureHandling: 'greedy',      // ένα δάχτυλο = μετακίνηση, χωρίς «χρησιμοποιήστε δύο δάχτυλα»
      clickableIcons: false,
      headingInteractionEnabled: true, // περιστροφή με δύο δάχτυλα
      tiltInteractionEnabled: true,    // κλίση 3D
      isFractionalZoomEnabled: true
    });
    let markers = [], line = null, me = null, info = null, traffic = null, navLine = null, navCase = null, dim = false, anim = 0;
    const routeStyle = () => (dim ? { strokeColor: '#9ca3af', strokeOpacity: 0.55, strokeWeight: 4 } : { strokeColor: '#2563eb', strokeOpacity: 0.85, strokeWeight: 6 });

    const view = {
      kind: 'google', scheme: scheme || 'FOLLOW_SYSTEM', canRotate: true, canTraffic: true, canSatellite: true, raw: map,
      setSatellite(on) { map.setMapTypeId(on ? 'hybrid' : 'roadmap'); },
      follow(p, heading) { anim++; map.moveCamera({ center: ahead(p, heading, 70), heading: heading || 0, tilt: 50, zoom: 17.5 }); },
      // ομαλό ζουμ πάνω σε ένα σημείο (π.χ. άφιξη στον προορισμό)
      focusOn(p, heading, zoom) {
        const my = ++anim, ms = 1400, t0 = performance.now();
        const c0 = map.getCenter(), z0 = map.getZoom() || 17, ti0 = map.getTilt() || 0, h0 = map.getHeading() || 0;
        const h1 = heading == null ? h0 : heading;
        const dh = ((h1 - h0 + 540) % 360) - 180;
        const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
        const step = (now) => {
          if (my !== anim) return;
          const k = ease(Math.min(1, (now - t0) / ms));
          map.moveCamera({ center: { lat: c0.lat() + (p.lat - c0.lat()) * k, lng: c0.lng() + (p.lng - c0.lng()) * k },
            zoom: z0 + ((zoom || 19.8) - z0) * k, tilt: ti0 + (45 - ti0) * k, heading: h0 + dh * k });
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      unfollow() { anim++; map.moveCamera({ heading: 0, tilt: 0, zoom: 14 }); },
      setNavRoute(coords) {
        if (navLine) { navLine.setMap(null); navLine = null; }
        if (navCase) { navCase.setMap(null); navCase = null; }
        if (!coords || !coords.length) return;
        const path = coords.map((c) => ({ lat: c[0], lng: c[1] }));
        // διαδρομή πλοήγησης: έντονο μπλε με λευκό περίγραμμα, πάνω από όλα
        navCase = new Polyline({ path, map, strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 14, zIndex: 50 });
        navLine = new Polyline({ path, map, strokeColor: '#0a66ff', strokeOpacity: 1, strokeWeight: 8, zIndex: 51 });
      },
      setView(lat, lng, zoom) { map.moveCamera({ center: { lat, lng }, zoom: zoom || map.getZoom() }); },
      panTo(lat, lng) { map.panTo({ lat, lng }); },
      getZoom() { return map.getZoom() || 12; },
      getCenter() { const c = map.getCenter(); return c ? { lat: c.lat(), lng: c.lng() } : center; },
      fit(points, pad) {
        if (!points.length) return;
        if (points.length === 1) { map.moveCamera({ center: points[0], zoom: 15 }); return; }
        const b = new google.maps.LatLngBounds();
        points.forEach((p) => b.extend(p));
        map.fitBounds(b, pad || 40);
      },
      setMarkers(items) {
        markers.forEach((m) => { m.map = null; });
        markers = items.map((it) => {
          const wrap = document.createElement('div');
          wrap.className = 'pin-wrap';
          wrap.appendChild(pinEl(it.text, it.cls));
          const m = new AdvancedMarkerElement({ map, position: { lat: it.lat, lng: it.lng }, content: wrap, title: it.title || '', zIndex: it.z || 1 });
          if (it.onClick) m.addListener('click', it.onClick);
          return m;
        });
      },
      setRoute(coords, dashed) {
        if (line) { line.setMap(null); line = null; }
        if (!coords || !coords.length) return;
        const path = coords.map((c) => ({ lat: c[0], lng: c[1] }));
        line = new Polyline(dashed ? {
          path, map, strokeOpacity: 0,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: '#2563eb', scale: 3 }, offset: '0', repeat: '14px' }]
        } : Object.assign({ path, map }, routeStyle()));
      },
      dimRoute(on) { dim = !!on; if (line && line.get('strokeOpacity') !== 0) line.setOptions(routeStyle()); },
      setMe(pos) {
        if (!pos) { if (me) me.map = null; me = null; return; }
        if (!me) me = new AdvancedMarkerElement({ map, position: pos, content: meEl(), zIndex: 999 });
        else me.position = pos;
      },
      popup(lat, lng, element) {
        if (info) info.close();
        // headerDisabled: χωρίς τη λευκή κεφαλίδα/✕ της Google (βάζουμε δικό μας ✕)
        info = new InfoWindow({ content: popupWrap(element, () => view.closePopup()), position: { lat, lng }, headerDisabled: true, maxWidth: 320 });
        info.open({ map });
        view._popupAt = Date.now();
        // πάτημα έξω = κλείσιμο (όχι το «άφημα» του δαχτύλου αμέσως μετά από παρατεταμένο πάτημα που την άνοιξε)
        if (!view._popupClick) view._popupClick = map.addListener('click', () => { if (Date.now() - view._popupAt > 900) view.closePopup(); });
      },
      closePopup() { if (info) info.close(); },
      resetNorth() { map.moveCamera({ heading: 0, tilt: 0 }); },
      onRotate(cb) {
        const f = () => cb(Math.abs(map.getHeading() || 0) > 1 || (map.getTilt() || 0) > 1);
        map.addListener('heading_changed', f); map.addListener('tilt_changed', f);
      },
      setTraffic(on) {
        if (!traffic) traffic = new TrafficLayer();
        traffic.setMap(on ? map : null);
      },
      onTap(cb) { map.addListener('click', (e) => { if (e.latLng) cb(e.latLng.lat(), e.latLng.lng()); }); },
      onLongPress(cb) {
        let t = null, last = 0;
        const fire = (e) => { if (Date.now() - last < 800) return; last = Date.now(); cb(e.latLng.lat(), e.latLng.lng()); };
        const cancel = () => { clearTimeout(t); t = null; };
        map.addListener('mousedown', (e) => { cancel(); t = setTimeout(() => fire(e), 650); });
        ['mouseup', 'dragstart', 'zoom_changed', 'heading_changed', 'tilt_changed'].forEach((ev) => map.addListener(ev, cancel));
        map.addListener('contextmenu', (e) => { cancel(); fire(e); });
      }
    };
    return view;
  }

  // ---------------- Leaflet (δωρεάν) ----------------
  function createLeaflet(el, center) {
    const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const group = L.layerGroup().addTo(map);
    let line = null, me = null;
    const icon = (text, cls) => { const w = String(text).length > 2 ? 16 + String(text).length * 8 : 30; return L.divIcon({ className: '', html: pinEl(text, cls).outerHTML, iconSize: [w, 30], iconAnchor: [w / 2, 15] }); };
    return {
      kind: 'leaflet', canRotate: false, canTraffic: false, raw: map,
      setView(lat, lng, zoom) { map.setView([lat, lng], zoom || map.getZoom()); },
      panTo(lat, lng) { map.panTo([lat, lng]); },
      getZoom() { return map.getZoom(); },
      getCenter() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      fit(points, pad) {
        if (!points.length) return;
        if (points.length === 1) { map.setView([points[0].lat, points[0].lng], 15); return; }
        const p = pad || {};
        map.fitBounds(L.latLngBounds(points.map((x) => [x.lat, x.lng])), {
          paddingTopLeft: [p.left || 30, p.top || 30], paddingBottomRight: [p.right || 30, p.bottom || 30]
        });
      },
      setMarkers(items) {
        group.clearLayers();
        items.forEach((it) => {
          const m = L.marker([it.lat, it.lng], { icon: icon(it.text, it.cls), zIndexOffset: (it.z || 1) * 100 }).addTo(group);
          if (it.onClick) m.on('click', it.onClick);
        });
      },
      setRoute(coords, dashed) {
        if (line) { map.removeLayer(line); line = null; }
        if (coords && coords.length) line = L.polyline(coords, Object.assign({ dashArray: dashed ? '8 8' : null }, this._dim ? { color: '#9ca3af', weight: 4, opacity: 0.55 } : { color: '#2563eb', weight: 5, opacity: 0.8 })).addTo(map);
      },
      dimRoute(on) { this._dim = !!on; if (line) line.setStyle(on ? { color: '#9ca3af', weight: 4, opacity: 0.55 } : { color: '#2563eb', weight: 5, opacity: 0.8 }); },
      setMe(pos) {
        if (!pos) { if (me) map.removeLayer(me); me = null; return; }
        if (!me) me = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
        else me.setLatLng([pos.lat, pos.lng]);
      },
      popup(lat, lng, element) {
        L.popup({ closeButton: false, maxWidth: 320, closeOnClick: false }).setLatLng([lat, lng]).setContent(popupWrap(element, () => map.closePopup())).openOn(map);
        this._popupAt = Date.now();
        if (!this._popupClick) { this._popupClick = true; map.on('click', () => { if (Date.now() - this._popupAt > 900) map.closePopup(); }); }
      },
      closePopup() { map.closePopup(); },
      resetNorth() {}, onRotate() {}, setTraffic() {}, canSatellite: false, setSatellite() {},
      follow(p, heading) { const a = ahead(p, heading, 60); map.setView([a.lat, a.lng], 17, { animate: false }); }, // η ομαλή κίνηση γίνεται στο navigate.js
      unfollow() { map.setZoom(14); },
      focusOn(p, heading, zoom) { map.flyTo([p.lat, p.lng], Math.min(19, zoom || 19), { duration: 1.2 }); },
      setNavRoute(coords) {
        if (this._nav) { map.removeLayer(this._nav); this._nav = null; }
        if (this._navCase) { map.removeLayer(this._navCase); this._navCase = null; }
        if (coords && coords.length) {
          this._navCase = L.polyline(coords, { color: '#ffffff', weight: 13, opacity: 1 }).addTo(map);
          this._nav = L.polyline(coords, { color: '#0a66ff', weight: 7, opacity: 1 }).addTo(map);
        }
      },
      onTap(cb) { map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)); },
      onLongPress(cb) { map.on('contextmenu', (e) => cb(e.latlng.lat, e.latlng.lng)); }
    };
  }

  global.RootingMapView = { createGoogle, createLeaflet };
})(window);
