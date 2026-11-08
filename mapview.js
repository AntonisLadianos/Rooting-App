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

  function pinEl(text, cls) {
    const d = document.createElement('div');
    d.className = 'pin ' + (cls || '');
    d.textContent = text;
    return d;
  }
  function meEl() {
    const d = document.createElement('div');
    d.className = 'me-dot';
    return d;
  }

  // ---------------- Google ----------------
  async function createGoogle(el, center, mapId) {
    const { Map, InfoWindow, Polyline, TrafficLayer, RenderingType } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    const map = new Map(el, {
      center, zoom: 12,
      mapId: mapId || 'DEMO_MAP_ID',
      renderingType: RenderingType ? RenderingType.VECTOR : 'VECTOR',
      colorScheme: 'FOLLOW_SYSTEM',
      disableDefaultUI: true,
      gestureHandling: 'greedy',      // ένα δάχτυλο = μετακίνηση, χωρίς «χρησιμοποιήστε δύο δάχτυλα»
      clickableIcons: false,
      headingInteractionEnabled: true, // περιστροφή με δύο δάχτυλα
      tiltInteractionEnabled: true,    // κλίση 3D
      isFractionalZoomEnabled: true
    });
    let markers = [], line = null, me = null, info = null, traffic = null;

    const view = {
      kind: 'google', canRotate: true, canTraffic: true, raw: map,
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
        } : { path, map, strokeColor: '#2563eb', strokeOpacity: 0.85, strokeWeight: 6 });
      },
      setMe(pos) {
        if (!pos) { if (me) me.map = null; me = null; return; }
        if (!me) me = new AdvancedMarkerElement({ map, position: pos, content: meEl(), zIndex: 999 });
        else me.position = pos;
      },
      popup(lat, lng, element) {
        if (info) info.close();
        info = new InfoWindow({ content: element, position: { lat, lng } });
        info.open({ map });
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
    const icon = (text, cls) => L.divIcon({ className: '', html: pinEl(text, cls).outerHTML, iconSize: [30, 30], iconAnchor: [15, 15] });
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
        if (coords && coords.length) line = L.polyline(coords, { color: '#2563eb', weight: 5, opacity: 0.8, dashArray: dashed ? '8 8' : null }).addTo(map);
      },
      setMe(pos) {
        if (!pos) { if (me) map.removeLayer(me); me = null; return; }
        if (!me) me = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
        else me.setLatLng([pos.lat, pos.lng]);
      },
      popup(lat, lng, element) { L.popup().setLatLng([lat, lng]).setContent(element).openOn(map); },
      closePopup() { map.closePopup(); },
      resetNorth() {}, onRotate() {}, setTraffic() {},
      onLongPress(cb) { map.on('contextmenu', (e) => cb(e.latlng.lat, e.latlng.lng)); }
    };
  }

  global.RootingMapView = { createGoogle, createLeaflet };
})(window);
