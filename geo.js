/*
 * Επιλογή του σωστού αποτελέσματος αναζήτησης διεύθυνσης.
 * Το Photon επιστρέφει πολλά υποψήφια (συχνά ίδιο όνομα δρόμου σε άλλη πόλη).
 * Βαθμολογούμε κάθε υποψήφιο με βάση: όνομα δρόμου, αριθμό, ΤΚ, πόλη, απόσταση.
 */
(function (global) {
  'use strict';

  // πεζά, χωρίς τόνους/σημεία στίξης (ΔΕΞΙΘΕΑΣ == Δεξιθέας)
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ς/g, 'σ').replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  // Συχνές συντομογραφίες/λέξεις που δεν βοηθούν στη σύγκριση ονόματος
  const STOP = new Set(['οδοσ', 'οδ', 'λεωφ', 'λεωφοροσ', 'λ', 'leof', 'odos', 'str', 'street', 'avenue', 'av', 'πλ', 'πλατεια', 'αγ', 'αγιου', 'αγιασ', 'και', 'του', 'τησ', 'των']);
  function words(s) { return norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+\p{L}?$/u.test(w)); }

  // Ίδια λέξη σε άλλη πτώση: «ηρακλειο» ~ «ηρακλειου», «ζαχαριας» ~ «ζαχαριου», «ανδρ» ~ «ανδρεα»
  // αλλά όχι «ηρακλη» ~ «ηρακλειδων»
  function wordMatch(a, b) {
    if (a === b) return 1;
    const n = Math.min(a.length, b.length), diff = Math.abs(a.length - b.length);
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    if (n >= 6 && diff <= 2 && k >= n - 2) return 0.85;
    if (n >= 3 && k === n && a.length !== b.length && n <= 4) return 0.7; // συντομογραφία: «ανδρ.»
    return 0;
  }

  // Ελληνικά -> λατινικά (για αγγλικές διευθύνσεις π.χ. "Knossou" vs "Κνωσσού")
  const GR = { α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o' };
  function latin(s) {
    return norm(s).replace(/ου/g, 'ou').replace(/αι/g, 'e').replace(/ει|οι/g, 'i').replace(/[α-ω]/g, (c) => GR[c] || c)
      .replace(/ou/g, 'u').replace(/y/g, 'i').replace(/ch|h/g, 'h').replace(/(.)\1/g, '$1');
  }

  function nameScore(queryWords, candName) {
    if (!queryWords.length || !candName) return 0;
    const cw = words(candName);
    if (!cw.length) return 0;
    const cwl = cw.map(latin);
    let hit = 0;
    for (const q of queryWords) {
      let best = 0;
      const isLatin = /[a-z]/.test(q);
      const ql = isLatin ? latin(q) : null;
      cw.forEach((c, i) => { best = Math.max(best, wordMatch(q, c), isLatin ? wordMatch(ql, cwl[i]) * 0.95 : 0); });
      hit += best;
    }
    // ποσοστό λέξεων του ερωτήματος που βρέθηκαν, με ποινή για επιπλέον λέξεις στο υποψήφιο
    return (hit / queryWords.length) * (0.75 + 0.25 * Math.min(1, queryWords.length / cw.length));
  }

  // Ανάλυση της διεύθυνσης που έγραψε ο χρήστης
  function parseQuery(q) {
    const parts = String(q).split(',').map((x) => x.trim()).filter(Boolean);
    const first = parts[0] || '';
    // ο αριθμός είναι ο τελευταίος στο πρώτο κομμάτι («62 Μαρτύρων 100» -> 100)
    // (αγνοούμε αριθμό στην αρχή, π.χ. «62 Μαρτύρων», «25ης Αυγούστου»)
    const nums = [...first.matchAll(/\s(\d{1,4}\p{L}?)(?=\s|$)/gu)];
    const numM = nums.length ? nums[nums.length - 1] : null;
    const postal = (String(q).match(/(?:^|\D)(\d{3})\s?(\d{2})(?!\d)/) || []).slice(1, 3).join('');
    const rest = parts.slice(1).join(' ').replace(/\d+/g, ' ');
    return {
      street: words(first),
      number: numM ? numM[1].toLowerCase() : '',
      postal,
      area: words(rest)
    };
  }

  function distKm(a, b) {
    const R = 6371, t = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lng - a.lng) * t / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /*
   * feature: Photon GeoJSON feature. Επιστρέφει {score, streetOk, exact}
   */
  function scoreFeature(pq, f, bias) {
    const p = f.properties || {};
    const lat = f.geometry.coordinates[1], lng = f.geometry.coordinates[0];
    const candStreet = p.type === 'street' ? p.name : (p.street || p.name);
    let ns = nameScore(pq.street, candStreet);
    // αν το όνομα είναι σημείο ενδιαφέροντος (π.χ. σχολείο), δοκίμασε και το όνομά του
    if (p.name && p.name !== candStreet) ns = Math.max(ns, nameScore(pq.street, p.name) * 0.8);
    let score = ns * 60;
    const hn = String(p.housenumber || '').toLowerCase();
    const exact = !!(pq.number && hn && hn === pq.number);
    if (exact) score += 25;
    else if (pq.number && hn) score -= 3; // ίδιος δρόμος, άλλος αριθμός
    const pc = String(p.postcode || '').replace(/\s/g, '');
    // ΤΚ: τα 2 πρώτα ψηφία = νομός. Άλλος νομός -> σίγουρα λάθος (π.χ. 71410 Ηράκλειο vs 35133 Λαμία)
    let postalBad = false;
    if (pq.postal && pc) {
      if (pc === pq.postal) score += 20;
      else if (pc.slice(0, 3) === pq.postal.slice(0, 3)) score += 10;
      else if (pc.slice(0, 2) === pq.postal.slice(0, 2)) score += 2;
      else postalBad = true;
    }
    let areaBad = false;
    if (pq.area.length) {
      // πόλη/συνοικία μετράει πολύ, νομός λιγότερο, καμία αντιστοιχία = ποινή
      // αρκεί μία λέξη περιοχής να ταιριάζει (π.χ. «Ακαδημία Ηρακλείου» -> «Ηρακλείου»)
      const anyWord = (txt) => Math.max(0, ...pq.area.map((w) => nameScore([w], txt)));
      const local = anyWord([p.city, p.town, p.village, p.district, p.locality, p.name].filter(Boolean).join(' '));
      const wide = anyWord([p.county, p.state].filter(Boolean).join(' '));
      const latinArea = pq.area.every((w) => /^[a-z]+$/.test(w)); // «Heraklion» δεν συγκρίνεται αξιόπιστα με «Ηράκλειο»
      if (local >= 0.6) score += 20 * local;
      else if (wide >= 0.6) score += 8 * wide;
      else if (!latinArea) { score -= 15; areaBad = true; }
    }
    if (bias) score -= Math.min(distKm(bias, { lat, lng }), 400) / 20; // έως -20
    return { score, streetOk: ns >= 0.6, areaBad: areaBad || postalBad, exact, lat, lng };
  }

  function pickBest(q, features, bias) {
    const pq = parseQuery(q);
    let best = null;
    for (const f of features || []) {
      if (!f.geometry || !f.geometry.coordinates) continue;
      const s = scoreFeature(pq, f, bias);
      if (!s.streetOk && pq.street.length) continue; // λάθος δρόμος -> απορρίπτεται
      if (s.areaBad) continue;                          // σωστός δρόμος σε λάθος πόλη -> απορρίπτεται
      if (!best || s.score > best.s.score) best = { f, s };
    }
    return best;
  }

  const api = { norm, parseQuery, scoreFeature, pickBest, distKm };
  global.RootingGeo = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
