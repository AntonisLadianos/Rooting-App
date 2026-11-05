/*
 * Ανάγνωση διευθύνσεων από screenshot (OCR στο κινητό με Tesseract.js)
 * και εξαγωγή διεύθυνσης / ονόματος / τηλεφώνου από το κείμενο.
 */
(function (global) {
  'use strict';

  const BASE = (typeof document !== 'undefined') ? new URL('vendor/tesseract/', document.baseURI).href : '';
  let workerP = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Αποτυχία φόρτωσης OCR'));
      document.head.appendChild(s);
    });
  }

  async function getWorker(onProgress) {
    if (!workerP) {
      workerP = (async () => {
        if (!global.Tesseract) await loadScript(BASE + 'tesseract.min.js');
        return global.Tesseract.createWorker('ell', 1, {
          workerPath: BASE + 'worker.min.js',
          corePath: BASE + 'core',
          langPath: BASE + 'lang',
          logger: (m) => { if (onProgress && m && m.status) onProgress(m); }
        });
      })();
      workerP.catch(() => { workerP = null; });
    }
    return workerP;
  }

  async function recognize(file, onProgress) {
    const w = await getWorker(onProgress);
    const r = await w.recognize(file);
    return r.data.text || '';
  }

  // ---------- Ανάλυση κειμένου ----------
  const RE_PHONE = /(?:\+|00)?\s?30?[\s-]?([26]\d{9})|\b([26]\d{9})\b/;
  const RE_POSTAL = /(?:^|[^\d])(\d{3}\s?\d{2})(?![\d])/;
  const RE_COUNTRY = /(?<![\p{L}])(Ελλ[αά]δα|ΕΛΛ[ΑΆ]ΔΑ|Greece|Hellas)(?![\p{L}])/iu;
  const RE_STREETNUM = /\p{L}{3,}[\p{L}.\s'-]*\s\d{1,4}[\p{L}]?\s*(?:[,-]|$)/u;

  function clean(line) {
    let s = line.replace(/\s+/g, ' ').trim();
    // αφαίρεση «σκουπιδιών» από εικονίδια στην αρχή της γραμμής (π.χ. "ΟΦ ", "ς. ", "'. ")
    for (let k = 0; k < 2; k++) {
      s = s.replace(/^[^\p{L}\d(]+/u, '');
      s = s.replace(/^[\p{L}\d]{1,2}[^\p{L}\d\s(]*\s+(?=[\p{Lu}(\d])/u, '');
    }
    return s.trim();
  }

  function digitsCount(s) { return (s.match(/\d/g) || []).length; }
  function isPhoneLine(s) { return digitsCount(s) >= 10 && RE_PHONE.test(s.replace(/[\s-]/g, '')); }
  function normPhone(s) {
    const d = s.replace(/\D/g, '');
    const m = d.match(/(?:0030|30)?([26]\d{9})$/) || d.match(/([26]\d{9})/);
    return m ? m[1] : '';
  }
  function isCountryOnly(s) { return /^[,.\s]*(Ελλ[αά]δα|ΕΛΛΑΔΑ|Greece)[,.\s]*$/i.test(s); }
  function hasPostal(s) { return !isPhoneLine(s) && RE_POSTAL.test(s); }
  function looksLikeName(s) {
    return s && !/\d/.test(s) && /^\p{L}+(?:[\s.-]+\p{L}+){1,3}$/u.test(s) && !/παράδοση|παραλαβή|πακέτο|ενέργειες|υπολείπονται/i.test(s);
  }
  function isNoise(s) { return /πακέτο|παράδοση σε|παραλαβή|υπολείπονται|ενέργειες/i.test(s); }

  // Μορφή για αναζήτηση: χωρίς χώρα και παρενθέσεις
  function tidyAddress(s) {
    return s.replace(RE_COUNTRY, '').replace(/[()]/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
  }

  function extract(text) {
    const lines = text.split(/\r?\n/).map(clean).filter((l) => l.length > 1);
    const used = new Array(lines.length).fill(false);
    const out = [];

    // Πρώτα γραμμές με ΤΚ, μετά με «Ελλάδα», μετά «Οδός αριθμός,» — με αυτή τη σειρά προτεραιότητας
    const idx = (f) => lines.map((l, i) => f(l) ? i : -1).filter((i) => i >= 0);
    const anchors = [
      ...idx(hasPostal),
      ...idx((l) => RE_COUNTRY.test(l) && !isCountryOnly(l)),
      ...idx((l) => !isPhoneLine(l) && !isNoise(l) && /,/.test(l) && RE_STREETNUM.test(l))
    ];
    const found = [];

    for (const a of anchors) {
      if (used[a]) continue;
      let start = a, end = a;
      // προς τα πάνω: γραμμές που συνεχίζουν τη διεύθυνση
      // μόνο αν η γραμμή-άγκυρα δεν έχει δικό της αριθμό οδού (π.χ. "Ηράκλειο 71305, Ελλάδα")
      const ownNumber = /(?:^|\D)\d{1,4}(?:\D|$)/.test(lines[a].replace(RE_POSTAL, ' '));
      while (!ownNumber && start - 1 >= 0 && a - (start - 1) <= 2 && !used[start - 1]) {
        const p = lines[start - 1];
        if (isPhoneLine(p) || isNoise(p) || hasPostal(p)) break;
        const cont = /,\s*$/.test(p) || /\b\d{1,4}\p{L}?\b/u.test(p) || /^\(/.test(lines[start]);
        if (!cont) break;
        start--;
      }
      // προς τα κάτω: μόνο «Ελλάδα» ή ολοκλήρωση παρένθεσης
      while (end + 1 < lines.length && !used[end + 1] && (isCountryOnly(lines[end + 1]) || (/\($/.test(lines[end]) && !isPhoneLine(lines[end + 1])))) end++;
      for (let k = start; k <= end; k++) used[k] = true;

      const raw = lines.slice(start, end + 1).join(' ').replace(/\s+/g, ' ').trim();
      const address = tidyAddress(raw);
      if (address.length < 5) continue;

      let name = '';
      if (start - 1 >= 0 && looksLikeName(lines[start - 1])) name = lines[start - 1];
      let phone = '';
      for (let k = end + 1; k <= end + 2 && k < lines.length; k++) {
        if (isPhoneLine(lines[k])) { phone = normPhone(lines[k]); break; }
        if (hasPostal(lines[k])) break;
      }
      found.push({ at: start, address, name, phone });
    }
    found.sort((x, y) => x.at - y.at);
    found.forEach((f) => out.push({ address: f.address, name: f.name, phone: f.phone }));
    return out;
  }

  // Κλειδί για εύρεση διπλότυπων (ίδια διεύθυνση σε δύο screenshots)
  function key(addr) {
    return String(addr).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\d]/gu, '');
  }

  const api = { recognize, extract, key, tidyAddress };
  global.RootingOCR = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
