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
        return global.Tesseract.createWorker(['ell', 'eng'], 1, {
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

  // Δεύτερη «γνώμη» μόνο με λατινικά, για αριθμούς σπιτιών που τελειώνουν σε 8/B («20B» διαβάζεται «208»)
  let engP = null;
  function getEngWorker() {
    if (!engP) {
      engP = global.Tesseract.createWorker('eng', 1, { workerPath: BASE + 'worker.min.js', corePath: BASE + 'core', langPath: BASE + 'lang' })
        .then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: '8' }); return w; });
      engP.catch(() => { engP = null; });
    }
    return engP;
  }
  function cropWord(bmp, b, scale) {
    const pad = Math.round((b.y1 - b.y0) * 0.4);
    const x = Math.max(0, b.x0 - pad), y = Math.max(0, b.y0 - pad);
    const w = Math.min(bmp.width - x, b.x1 - b.x0 + 2 * pad), h = Math.min(bmp.height - y, b.y1 - b.y0 + 2 * pad);
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, x, y, w, h, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) { const v = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) > 150 ? 255 : 0; px[i] = px[i + 1] = px[i + 2] = v; }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  // Επιστρέφει { text, ambig: [{ read: '208', alt: '20B' }] }
  async function recognize(file, onProgress) {
    const w = await getWorker(onProgress);
    const r = await w.recognize(file, {}, { text: true, blocks: true });
    const text = (r.data && r.data.text) || '';
    const ambig = [];
    try {
      const words = [];
      (r.data.blocks || []).forEach((b) => b.paragraphs.forEach((p) => p.lines.forEach((l) => l.words.forEach((x) => words.push(x)))));
      const cands = words.filter((x) => /^\d{1,3}[8BΒ][,.]?$/.test(x.text));
      if (cands.length && global.createImageBitmap) {
        const bmp = await createImageBitmap(file);
        const ew = await getEngWorker();
        for (const c of cands) {
          const t = ((await ew.recognize(cropWord(bmp, c.bbox, 4))).data.text || '').trim();
          const m = t.match(/(\d{1,3}[8BΒ])/);
          const a = c.text.replace(/[,.]$/, '');
          if (m && m[1] !== a && m[1].slice(0, -1) === a.slice(0, -1)) ambig.push({ read: a, alt: m[1].replace('Β', 'B') });
        }
      }
    } catch (e) { /* χωρίς δεύτερη γνώμη */ }
    return { text, ambig };
  }

  // Εφαρμόζει τις αμφιβολίες 8/B στις διευθύνσεις: βάζει την εκδοχή με γράμμα και κρατά την άλλη ως επιλογή
  function applyAmbig(items, ambig) {
    ambig.forEach(({ read, alt }) => {
      const re = new RegExp('(^|[^\\d\\p{L}])' + read + '(?![\\d\\p{L}])', 'u');
      items.forEach((it) => {
        if (!it.ambig && re.test(it.address)) {
          const withAlt = it.address.replace(re, '$1' + alt);
          it.ambig = { a: alt, b: read, addrA: withAlt, addrB: it.address };
          it.address = withAlt;
        }
      });
    });
    return items;
  }

  // «Υαζι» -> «Γαζι» όταν η «Γαζι» εμφανίζεται σε πολλές άλλες διευθύνσεις και διαφέρει κατά ένα γράμμα
  function fixAreas(items) {
    const word = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const freq = new Map();
    items.forEach((it) => it.address.split(',').slice(1).join(' ').split(/\s+/).forEach((w) => { if (/^\p{L}{4,}$/u.test(w)) freq.set(word(w), (freq.get(word(w)) || 0) + 1); }));
    const common = [...freq.entries()].filter(([, n]) => n >= 2).map(([w]) => w);
    const near1 = (a, b) => a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 1;
    items.forEach((it) => {
      // κολλημένο «22Υαζι» -> «22, Υαζι»
      it.address = it.address.replace(/(\d)(\p{Lu}\p{Ll}{3,})/u, '$1, $2');
      const parts = it.address.split(',');
      if (parts.length < 2) return;
      const head = parts.shift();
      it.address = head + ',' + parts.join(',').replace(/\p{L}{4,}/gu, (w) => {
        const lw = word(w);
        if ((freq.get(lw) || 0) >= 2) return w;
        const m = common.find((c) => near1(lw, c));
        if (!m) return w;
        const orig = items.map((x) => x.address.match(new RegExp('\\p{L}{4,}', 'gu')) || []).flat().find((x) => word(x) === m);
        return orig || w;
      });
    });
    return items;
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
      if (/^(Ελ|Αγ|Οδ|Λ\.|Γ\.|Ν\.|Κ\.|Π\.)\s/u.test(s)) break; // συντομογραφίες οδών («Ελ Γκρέκο», «Αγ. Νικολάου»)
      s = s.replace(/^[\p{L}\d]{1,2}[^\p{L}\d\s(]*\s+(?=[\p{Lu}(\d])/u, '');
      s = s.replace(/^[\p{Lu}\d]{1,2}[^\p{L}\d\s(]*\s+(?=\p{Ll}{3,})/u, ''); // «ΟΦ θεοφανους»
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
  function hasPostal(s) { return !isPhoneLine(s) && !isCode(s) && RE_POSTAL.test(s); }
  function looksLikeName(s) {
    return s && !/\d/.test(s) && /^\p{L}+(?:[\s.-]+\p{L}+){1,3}$/u.test(s) && !/παράδοση|παραλαβή|πακέτο|ενέργειες|υπολείπονται/i.test(s);
  }
  function isCode(s) { return /^\S{1,4}\s*-+\s*-?\s*[\p{L}\d]{6,}$/u.test(s); } // κωδικός δέματος
  function isNoise(s) { return isCode(s) || /πακέτο|παράδοση σε|παραλαβή|υπολείπονται|ενέργειες|clever point/i.test(s); }

  // Μορφή για αναζήτηση: χωρίς χώρα και παρενθέσεις
  function tidyAddress(s) {
    // πετάμε κομμάτια μετά από κόμμα που είναι μόνο «σκουπίδια» (π.χ. «, ο, ην D»)
    s = s.split(',').filter((p, i) => i === 0 || /\p{L}{3,}|\d{3}/u.test(p)).join(',');
    return s.replace(RE_COUNTRY, '').replace(/(,[^,]*?)\s\d{3}(?=[,\s]*$)/, '$1').replace(/\b\d{6}\b/g, '').replace(/,\s*[\p{L}\d]{1,2}\s*$/u, '').replace(/[()]/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',')
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
      const continues = (k) => {
        const nx = lines[k];
        if (isCountryOnly(nx)) return true;
        if (isPhoneLine(nx) || isNoise(nx) || hasPostal(nx) && /\d{1,4}\s*,/.test(nx.replace(RE_POSTAL, ''))) return false;
        if (/^\d{2}\b/.test(nx) && /\d{3}\s*$/.test(lines[k - 1])) return true;          // «713» / «05, Ελλάδα»
        return /[,(]\s*$/.test(lines[k - 1]) && end - start < 2 && !looksLikeName(nx);  // συνέχεια μετά από κόμμα
      };
      while (end + 1 < lines.length && !used[end + 1] && continues(end + 1)) end++;
      for (let k = start; k <= end; k++) used[k] = true;

      const raw = lines.slice(start, end + 1).join(' ').replace(/\s+/g, ' ').trim();
      const address = tidyAddress(raw);
      if (address.length < 5) continue;

      let name = '';
      const oneWord = (x) => x && /^\p{L}{3,}$/u.test(x) && !isNoise(x);
      if (start - 1 >= 0 && looksLikeName(lines[start - 1])) name = lines[start - 1];
      else if (start - 2 >= 0 && oneWord(lines[start - 1]) && looksLikeName(lines[start - 2])) name = lines[start - 2] + ' ' + lines[start - 1];
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

  // ---------- Ανάγνωση ανά καρτέλα ----------
  // Στην εφαρμογή courier κάθε καρτέλα ξεκινά με «Παράδοση σε πελάτη» (ή «Παραλαβή…») και
  // τελειώνει με «N πακέτο/πακέτα …» και τον κωδικό αποστολής («AZP - 94GOE7WM4WK6J»).
  const RE_HEADER = /παρ[αά]δοση\s*σε\s*\S+|παραλαβ[ήη]\s*(απ[οό]|σε)|clever\s*point/i;
  const RE_CUSTOMER = /παρ[αά]δοση\s*σε\s*πελ[αά]τη|παραλαβ[ήη]\s*(απ[οό]|σε)\s*πελ[αά]τη/i;
  function isCardEnd(s) { return /πακ[εέ]τ/i.test(s) || /^\S{1,4}\s*-+\s*-?\s*[\p{L}\d]{6,}/u.test(s); }
  function hasStreet(addr) { const first = String(addr).split(',')[0]; return /\p{L}{3,}/u.test(first) && /\d/.test(first.replace(/\b\d{3}\s?\d{2}\b/, '')); }
  function isTailOnly(it) {
    if (it.name) return false;
    const first = it.address.split(',')[0].trim();
    if (/^\d{3}\s?\d{2}$/.test(first)) return true;               // «71303»
    return !hasStreet(it.address) && RE_POSTAL.test(it.address);  // «Γάζι, 71414»
  }

  // Επιστρέφει { cards: [{address, name, phone, closed}], pre: [...] } — pre = ό,τι υπάρχει πάνω από
  // την πρώτη καρτέλα (συνέχεια της τελευταίας καρτέλας του προηγούμενου screenshot).
  // Αν δεν βρεθούν καρτέλες (άλλη εφαρμογή/λίστα), cards = null και ισχύει η παλιά ανάγνωση.
  function extractImage(text) {
    const raw = text.split(/\r?\n/);
    const heads = [];
    raw.forEach((l, i) => { if (RE_HEADER.test(clean(l))) heads.push(i); });
    if (!heads.length) return { cards: null, items: extract(text) };
    const pre = extract(raw.slice(0, heads[0]).join('\n'));
    const preLines = raw.slice(0, heads[0]).map(clean);
    const prePhone = (preLines.find(isPhoneLine) || '');
    const cards = [];
    heads.forEach((h, k) => {
      const seg = raw.slice(h, k + 1 < heads.length ? heads[k + 1] : raw.length);
      if (!RE_CUSTOMER.test(clean(seg[0]))) return; // π.χ. «Παράδοση σε Αποθήκη», Clever Point
      const lines = seg.map(clean).filter((l) => l.length > 1);
      const found = extract(seg.slice(1).join('\n'));
      let nameLine = lines[1] && looksLikeName(lines[1]) ? lines[1] : '';
      let addrStart = nameLine ? 2 : 1;
      // όνομα σε δύο γραμμές («Σταυρουλα Καναβακη» / «Τζώρτζογλου»)
      if (nameLine && lines[2] && /^\p{L}{3,}$/u.test(lines[2]) && !isNoise(lines[2])) { nameLine += ' ' + lines[2]; addrStart = 3; }
      const phoneLine = lines.find(isPhoneLine);
      // Διεύθυνση = ΟΛΕΣ οι γραμμές ανάμεσα στο όνομα και στο τηλέφωνο (ή στο τέλος της καρτέλας)
      const addrLines = [];
      for (let k2 = addrStart; k2 < lines.length; k2++) {
        const l = lines[k2];
        if (isPhoneLine(l) || isCardEnd(l) || isNoise(l)) break;
        const toks = l.split(' ');
        if (toks.filter((t) => t.length <= 1).length * 2 >= toks.length && toks.length > 1) continue; // «& Ρρητης ζ ρ 0» (σκουπίδι εικονιδίου)
        addrLines.push(l.replace(/(\s+[^\p{L}\d\s]+)+$/u, '').trim()); // «… Ηράκλειο  [[]»
      }
      // κομμένη καρτέλα: η τελευταία (μισή) γραμμή χωρίς αριθμό είναι συνήθως σκουπίδι («ΛΠΣΩΞ Ελλ»)
      if (!phoneLine && !lines.some(isCardEnd) && addrLines.length > 1 && !/\d/.test(addrLines[addrLines.length - 1])) addrLines.pop();
      let address = '';
      if (addrLines.length) {
        address = addrLines.reduce((acc, l) => !acc ? l : (/[,\-–]\s*$/.test(acc) ? acc + ' ' + l : acc + ', ' + l), '');
        address = tidyAddress(address.replace(/\s+-\s*,/g, ',').replace(/\s+-\s+/g, ', '));
      }
      if (!address || address.length < 5) { if (!found.length) return; address = found[0].address; }
      const it = found[0] || {};
      cards.push({
        address,
        name: nameLine || it.name || '',
        phone: phoneLine ? normPhone(phoneLine) : (it.phone || ''),
        closed: lines.some(isCardEnd) || !!phoneLine
      });
    });
    return { cards, pre, prePhone: prePhone ? normPhone(prePhone) : '' };
  }

  // Ενώνει τα αποτελέσματα πολλών screenshots (με τη σειρά που τραβήχτηκαν).
  function mergeAcross(perImage) {
    const out = [];
    let lastOpen = null; // τελευταία καρτέλα του προηγούμενου screenshot, αν κόπηκε
    perImage.forEach((img) => {
      if (Array.isArray(img)) img = { cards: null, items: img };
      if (img.cards === null) {
        // χωρίς καρτέλες: παλιά λογική (κομμένη = έχει οδό, όχι ΤΚ, όχι τηλέφωνο, και είναι τελευταία)
        const items = img.items.slice();
        if (lastOpen && items.length && isTailOnly(items[0])) {
          const t = items.shift();
          lastOpen.address = tidyAddress(lastOpen.address.replace(/[,\s]+$/, '') + ', ' + t.address);
          lastOpen.phone = lastOpen.phone || t.phone;
        }
        lastOpen = null;
        items.forEach((it, i) => {
          const x = Object.assign({}, it);
          if (isTailOnly(x)) x.fragment = true;
          out.push(x);
          if (i === items.length - 1 && hasStreet(x.address) && !RE_POSTAL.test(x.address) && !x.phone) lastOpen = x;
        });
        return;
      }
      // με καρτέλες
      img.pre.forEach((p) => {
        if (hasStreet(p.address)) {
          // συνέχεια κομμένης καρτέλας με ολόκληρη τη διεύθυνση, ή καρτέλα που της κόπηκε η αρχή
          if (lastOpen && RootingKey(p.address).startsWith(RootingKey(lastOpen.address.split(',')[0]))) {
            lastOpen.address = p.address; lastOpen.phone = lastOpen.phone || p.phone;
          } else out.push(Object.assign({}, p));
        } else if (lastOpen) {
          lastOpen.address = tidyAddress(lastOpen.address.replace(/[,\s]+$/, '') + ', ' + p.address);
          lastOpen.phone = lastOpen.phone || p.phone;
        }
        // αλλιώς: σκέτοι κωδικοί/κομμάτια ολοκληρωμένης καρτέλας -> αγνοούνται
      });
      if (lastOpen && !lastOpen.phone && img.prePhone) lastOpen.phone = img.prePhone;
      lastOpen = null;
      img.cards.forEach((c, i) => {
        const x = { address: c.address, name: c.name, phone: c.phone };
        out.push(x);
        if (i === img.cards.length - 1 && !c.closed) lastOpen = x;
      });
    });
    return out;
  }
  function RootingKey(s) { return key(s); }

  const api = { recognize, extract, extractImage, key, tidyAddress, mergeAcross, applyAmbig, fixAreas };
  global.RootingOCR = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
