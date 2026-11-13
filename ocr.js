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

  // Μέχρι 2 «αναγνώστες» ταυτόχρονα (slot 0/1) για να διαβάζονται 2 screenshots μαζί
  const workerPs = [];
  async function getWorker(onProgress, slot) {
    slot = slot || 0;
    let workerP = workerPs[slot];
    if (!workerP) {
      workerP = workerPs[slot] = (async () => {
        if (!global.Tesseract) await loadScript(BASE + 'tesseract.min.js');
        return global.Tesseract.createWorker(['ell', 'eng'], 1, {
          workerPath: BASE + 'worker.min.js',
          corePath: BASE + 'core',
          langPath: BASE + 'lang',
          logger: (m) => { if (onProgress && m && m.status) onProgress(m); }
        });
      })();
      workerP.catch(() => { workerPs[slot] = null; });
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

  // Ξαναφτιάχνει το κείμενο από τις λέξεις, πετώντας τα «γράμματα» που βγαίνουν από εικονίδια:
  // το εικονίδιο αντιγραφής δεξιά από τη διεύθυνση και το πορτοκαλί κουμπί φωτογραφίας δίπλα στον κωδικό
  // (απομονωμένα στο τέλος της γραμμής, λίγα σύμβολα, χωρίς αριθμούς, συνήθως με χαμηλή βεβαιότητα).
  function isIconWord(x, prev, h) {
    const t = x.text || '';
    if (/[\u1F00-\u1FFF]/.test(t)) return true;                       // «ἴνι», «{[᾿}»
    if (/^[^\p{L}\d]+$/u.test(t)) return true;                         // «[[]», «©»
    if (/\d{2,}/.test(t) || t.length > 4) return false;               // αριθμοί / κανονικές λέξεις μένουν
    const gap = prev ? x.bbox.x0 - prev.bbox.x1 : 0;
    return (gap > 1.2 * h && x.confidence < 75) || (x.confidence < 35 && /[^\p{L}\d,.]/u.test(t));
  }
  function cleanText(data) {
    const out = [];
    (data.blocks || []).forEach((b) => { b.paragraphs.forEach((p) => { p.lines.forEach((l) => {
      const ws = l.words.slice().sort((a, c) => a.bbox.x0 - c.bbox.x0);
      const h = Math.max(8, l.bbox.y1 - l.bbox.y0);
      while (ws.length > 1 && isIconWord(ws[ws.length - 1], ws[ws.length - 2], h)) ws.pop(); // από το τέλος της γραμμής
      out.push(ws.map((x) => x.text).join(' '));
    }); }); out.push(''); });
    return out.join('\n');
  }

  // ---------- Ανάγνωση με Google Cloud Vision (προαιρετικά, με το κλειδί του χρήστη) ----------
  // Ξαναχτίζει τις γραμμές από τις θέσεις των λέξεων (η σειρά των «παραγράφων» της Google δεν είναι πάντα πάνω->κάτω).
  function visionLines(resp) {
    const words = [];
    const pages = (resp.fullTextAnnotation && resp.fullTextAnnotation.pages) || [];
    pages.forEach((pg) => (pg.blocks || []).forEach((bl) => (bl.paragraphs || []).forEach((pa) => (pa.words || []).forEach((w) => {
      const v = (w.boundingBox && w.boundingBox.vertices) || [];
      if (v.length < 4) return;
      const xs = v.map((q) => q.x || 0), ys = v.map((q) => q.y || 0);
      const syms = w.symbols || [];
      const last = syms[syms.length - 1];
      const br = last && last.property && last.property.detectedBreak && last.property.detectedBreak.type;
      words.push({ text: syms.map((x) => x.text).join(''), x0: Math.min(...xs), x1: Math.max(...xs), yc: (Math.min(...ys) + Math.max(...ys)) / 2, h: Math.max(4, Math.max(...ys) - Math.min(...ys)), sp: !!br });
    }))));
    words.sort((a, b) => a.yc - b.yc);
    const lines = [];
    words.forEach((w) => {
      const l = lines.length ? lines[lines.length - 1] : null;
      if (l && Math.abs(w.yc - l.yc) < 0.55 * Math.min(w.h, l.h)) { l.words.push(w); l.yc = (l.yc * (l.words.length - 1) + w.yc) / l.words.length; l.h = Math.max(l.h, w.h); }
      else lines.push({ yc: w.yc, h: w.h, words: [w] });
    });
    return lines.map((l) => {
      l.words.sort((a, b) => a.x0 - b.x0);
      return l.words.map((w, i) => { const nx = l.words[i + 1]; return w.text + (nx && (w.sp || nx.x0 - w.x1 > 0.3 * l.h) ? ' ' : ''); }).join('');
    }).join('\n');
  }
  // μικρότερο αρχείο για γρήγορο ανέβασμα (JPEG), αλλιώς το αρχικό
  async function toBase64(file) {
    try {
      if (global.createImageBitmap && typeof document !== 'undefined') {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      }
    } catch (e) { /* πέφτουμε στο αρχικό αρχείο */ }
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function visionRecognize(file, key) {
    const content = typeof file === 'string' ? file : await toBase64(file);
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: { languageHints: ['el', 'en'] } }] })
    });
    const j = await r.json().catch(() => ({}));
    const err = (j.error && j.error.message) || (j.responses && j.responses[0] && j.responses[0].error && j.responses[0].error.message);
    if (!r.ok || err) throw new Error(err || ('HTTP ' + r.status));
    const resp = (j.responses && j.responses[0]) || {};
    return visionLines(resp) || (resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '';
  }

  // Επιστρέφει { text, ambig: [{ read: '208', alt: '20B' }], via: 'google' | 'device', visionError }
  //   vision = { key } -> πρώτα Google· αν αποτύχει, ανάγνωση στο κινητό όπως πριν
  async function recognize(file, onProgress, slot, vision) {
    let visionError = null;
    if (vision && vision.key) {
      try { return { text: await visionRecognize(file, vision.key), ambig: [], via: 'google' }; }
      catch (e) { visionError = e.message || String(e); }
    }
    const res = await recognizeDevice(file, onProgress, slot);
    res.via = 'device'; res.visionError = visionError;
    return res;
  }
  async function recognizeDevice(file, onProgress, slot) {
    const w = await getWorker(onProgress, slot);
    const r = await w.recognize(file, {}, { text: true, blocks: true });
    let text = (r.data && r.data.text) || '';
    try { if (r.data.blocks && r.data.blocks.length) text = cleanText(r.data); } catch (e) { /* κρατάμε το αρχικό */ }
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
    let s = line.replace(/µ/g, 'μ').replace(/\S*[\u1F00-\u1FFF]\S*/g, ' ').replace(/\s+/g, ' ').trim(); // «ἴνι», «{[᾿}» = σκουπίδια εικονιδίων
    // «⚠ 2 πακέτα παράδοση»: κρατάμε τον αριθμό (αλλιώς το καθάρισμα παρακάτω τον πετάει μαζί με τα εικονίδια)
    const pk = s.match(/([0-9ΊIl|]{1,2})\s*(πακ[εέ]τ.*)$/i);
    if (pk) return pk[1] + ' ' + pk[2];
    // αφαίρεση «σκουπιδιών» από εικονίδια στην αρχή της γραμμής (π.χ. "ΟΦ ", "ς. ", "'. ")
    for (let k = 0; k < 2; k++) {
      s = s.replace(/^[^\p{L}\d(]+/u, '');
      if (/^(Ελ|Αγ|Οδ|Λ\.|Γ\.|Ν\.|Κ\.|Π\.)\s/u.test(s)) break; // συντομογραφίες οδών («Ελ Γκρέκο», «Αγ. Νικολάου»)
      s = s.replace(/^[\p{L}\d]{1,2}[^\p{L}\d\s(]*\s+(?=[^\p{L}\d\s]*[\p{Lu}(\d])/u, ''); // «Αν "ΙΩΑΝΝΗΣ …»
      s = s.replace(/^[\p{L}\d]{1,2}[^\p{L}\d\s(]+\s+(?=\p{Ll}{3,})/u, '');                     // «ζ2} πάτμου 6»
      s = s.replace(/^[\p{Lu}\d]{1,2}[^\p{L}\d\s(]*\s+(?=\p{Ll}{3,})/u, ''); // «ΟΦ θεοφανους»
    }
    return s.trim();
  }

  function digitsCount(s) { return (s.match(/\d/g) || []).length; }
  function isPhoneLine(s) { return digitsCount(s) >= 10 && !isCode(s) && RE_PHONE.test(s.replace(/[\s-]/g, '')); } // όχι κωδικός «IPG - 2874356214"
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
  const RE_HEADER = /παρ[αά]δοση\s*σε\s*\S+|παραλαβ[ήη]\s*(απ[οό]|σε)|clever\s*point|πακ[εέ]τα\s*locker/i;
  // Locker / Clever Point: σημεία χωρίς διεύθυνση στην καρτέλα (μόνο όνομα και πλήθος δεμάτων)
  function hubKind(l) {
    if (/τοποθεσ/i.test(l)) return '';                       // κουμπί «Τοποθεσία Locker / Clever Point»
    if (/πακ[εέ]τα\s*locker/i.test(l)) return 'locker';
    if (/^clever\s*point\b/i.test(l)) return 'clever';
    return '';
  }
  function hubCounts(lines) {
    const c = { deliver: null, pickup: null, ret: null };
    lines.forEach((l) => {
      const m = l.match(/[:.;]\s*([\dΊIl|]{1,3})\s*$/) || l.match(/(\d{1,3})\s*$/);
      if (!m) return;
      m[1] = m[1].replace(/[ΊIl|]/g, '1');
      const t = l.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const n = +m[1];
      if (/στροφ/.test(t)) c.ret = n;
      else if (/λαβ/.test(t)) c.pickup = n;
      else if (/οση|οσh/.test(t)) c.deliver = n;
    });
    return c;
  }
  const RE_CUSTOMER = /παρ[αά]δοση\s*σε\s*πελ[αά]τη|παραλαβ[ήη]\s*(απ[οό]|σε)\s*πελ[αά]τη/i;
  const RE_STORE = /παρ[αά]δοση\s*σε\s*κατ[αά]στημα/i;
  // «1 πακέτο παράδοση» / «2 πακέτα …» (το 1 συχνά διαβάζεται Ί/I/l)
  function pkgCount(lines) {
    const l = lines.find((x) => /πακ[εέ]τ/i.test(x));
    if (!l) return 0;
    const m = l.match(/([0-9ΊIl|]{1,2})\s*πακ[εέ]τ/i);
    if (!m) return 1;
    let n = parseInt(m[1].replace(/[ΊIl|]/g, '1'), 10);
    if (n >= 10) n = n % 10; // «82 πακέτα» = εικονίδιο κολλημένο στο 2 (10+ δέματα σε έναν πελάτη πρακτικά δεν υπάρχουν)
    return n > 0 ? n : 1;
  }
  const RE_CODE = /^\S{1,5}\s*-+\s*-?\s*([\p{L}\d][\p{L}\d.)\]]{5,})/u;
  function codesOf(lines) {
    return lines.map((l) => (l.match(RE_CODE) || [])[1]).filter(Boolean).map(normCode).filter((c) => c.length >= 6);
  }
  // κωδικοί αποστολής: ενοποίηση γραμμάτων που μοιάζουν (ελληνικά/λατινικά, O/0, I/1 …) για σύγκριση
  const LOOK = { Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', Ω: 'W', Λ: 'A', Δ: 'A', Θ: '8', Φ: 'O' };
  function normCode(s) {
    return String(s).toUpperCase().replace(/[Α-Ω]/g, (c) => LOOK[c] || c).replace(/[^A-Z0-9]/g, '')
      .replace(/[OQD]/g, '0').replace(/[ILJ]/g, '1').replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6').replace(/V/g, 'Y');
  }
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function sameCode(a, b) { return lev(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.3)); }
  function codesOverlap(A, B) { return A.some((a) => B.some((b) => sameCode(a, b))); }

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
    raw.forEach((l, i) => { const c = clean(l); if (RE_HEADER.test(c) && !/τοποθεσ/i.test(c)) heads.push(i); });
    if (!heads.length) return { cards: null, items: extract(text) };
    const pre = extract(raw.slice(0, heads[0]).join('\n'));
    const preLines = raw.slice(0, heads[0]).map(clean);
    const prePhone = (preLines.find(isPhoneLine) || '');
    const cards = [];
    // «Παράδοση σε Αποθήκη»: η εφαρμογή courier τη μετράει σαν μία επιπλέον καρτέλα/στάση (επιστροφή στην αποθήκη)
    const depot = heads.some((h) => /παρ[αά]δοση\s*σε\s*αποθ[ήη]κη/i.test(clean(raw[h])));
    heads.forEach((h, k) => {
      const seg = raw.slice(h, k + 1 < heads.length ? heads[k + 1] : raw.length);
      const kind = hubKind(clean(seg[0]));
      if (kind) {
        const hl = seg.slice(1).map(clean).filter((l) => l.length > 1);
        const name = (hl[0] && !/\d/.test(hl[0]) && !/παραλαβ|παραδοσ|επιστροφ/i.test(hl[0])) ? hl[0] : '';
        const cnt = hubCounts(hl);
        cards.push({ hub: Object.assign({ kind, name }, cnt), address: '', name: (kind === 'locker' ? 'Locker' : 'Clever Point') + (name ? ' · ' + name : ''),
          phone: '', pkgs: cnt.deliver || 0, codes: [], closed: true });
        return;
      }
      const store = RE_STORE.test(clean(seg[0]));
      if (!store && !RE_CUSTOMER.test(clean(seg[0]))) return; // π.χ. «Παράδοση σε Αποθήκη», Locker
      const lines = seg.map(clean).filter((l) => l.length > 1);
      const found = extract(seg.slice(1).join('\n'));
      if (store) {
        // κατάστημα: όνομα καταστήματος, η διεύθυνση γράφεται δύο φορές, ωράριο — κρατάμε την καλύτερη διεύθυνση
        const best = found.filter((f) => hasStreet(f.address)).sort((a, b) => (RE_POSTAL.test(b.address) ? 1 : 0) - (RE_POSTAL.test(a.address) ? 1 : 0))[0];
        const ph = lines.find(isPhoneLine);
        if (best) cards.push({ pkgs: Math.max(pkgCount(lines), codesOf(lines).length), codes: codesOf(lines), address: best.address, name: lines[1] && !/\d/.test(lines[1]) ? lines[1] : '',
          phone: ph ? normPhone(ph) : '', closed: lines.some(isCardEnd) || !!ph, store: true });
        return;
      }
      let nameLine = lines[1] && looksLikeName(lines[1]) ? lines[1] : '';
      let addrStart = nameLine ? 2 : 1;
      // όνομα σε δύο γραμμές («Σταυρουλα Καναβακη» / «Τζώρτζογλου»)
      // («ΝΑΤΑΛΙΑ ΒΑΧΑΜΠΟΒΑ» / «ΜΠΙΤΣΑΚΑΚΗΣ ΒΑΓΓΕΛΗΣ»): 2η γραμμή χωρίς αριθμούς/κόμμα, και μετά ακολουθεί διεύθυνση
      const after = lines[3];
      if (nameLine && lines[2] && !/[\d,]/.test(lines[2]) && !isNoise(lines[2]) && /^\p{L}{3,}(\s+\p{L}{2,}){0,1}$/u.test(lines[2]) && !/^(λεωφ|οδ[οό]ς|πλατε|πάροδ|παροδ)/i.test(lines[2]) &&
        after && !isPhoneLine(after) && !isCardEnd(after)) { nameLine += ' ' + lines[2]; addrStart = 3; }
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
        pkgs: Math.max(pkgCount(lines), codesOf(lines).length), codes: codesOf(lines),
        address,
        name: nameLine || it.name || '',
        phone: phoneLine ? normPhone(phoneLine) : (it.phone || ''),
        closed: lines.some(isCardEnd) || !!phoneLine
      });
    });
    return { cards, pre, depot, prePhone: prePhone ? normPhone(prePhone) : '', prePkgs: pkgCount(preLines), preCodes: codesOf(preLines) };
  }

  // Ενώνει τα αποτελέσματα πολλών screenshots (με τη σειρά που τραβήχτηκαν).
  function mergeAcross(perImage) {
    const out = [];
    let lastOpen = null; // τελευταία καρτέλα του προηγούμενου screenshot, αν κόπηκε
    perImage.forEach((img, imgNo) => {
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
          const x = Object.assign({ img: imgNo }, it);
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
          } else out.push(Object.assign({ img: imgNo, codes: img.preCodes || [], pkgs: img.prePkgs || 0 }, p));
        } else if (lastOpen) {
          lastOpen.address = tidyAddress(lastOpen.address.replace(/[,\s]+$/, '') + ', ' + p.address);
          lastOpen.phone = lastOpen.phone || p.phone;
        }
        // αλλιώς: σκέτοι κωδικοί/κομμάτια ολοκληρωμένης καρτέλας -> αγνοούνται
      });
      if (lastOpen && !lastOpen.phone && img.prePhone) lastOpen.phone = img.prePhone;
      if (lastOpen && !lastOpen.pkgs && img.prePkgs) lastOpen.pkgs = img.prePkgs;
      if (lastOpen && img.preCodes && img.preCodes.length) lastOpen.codes = (lastOpen.codes || []).concat(img.preCodes);
      lastOpen = null;
      img.cards.forEach((c, i) => {
        const x = { address: c.address, name: c.name, phone: c.phone, pkgs: c.pkgs, codes: c.codes, img: imgNo };
        if (c.hub) x.hub = c.hub;
        out.push(x);
        if (i === img.cards.length - 1 && !c.closed) lastOpen = x;
      });
    });
    return out;
  }
  function RootingKey(s) { return key(s); }

  // ---------- Ίδια διεύθυνση = μία στάση ----------
  // Κλειδί διεύθυνσης: οδός + αριθμός (πρώτο κομμάτι), χωρίς τόνους/κεφαλαία
  function addrKey(a) { return key(String(a).split(',')[0]); }
  function nameKey(n) { return key(n || ''); }
  // Επιστρέφει στάσεις { address, people: [{name, phone, pkgs, codes}], pkgs, name, phone, codes }
  //  • ίδια καρτέλα σε δύο διαδοχικά screenshots (επικάλυψη) -> μετράει μία φορά
  //  • δύο καρτέλες στο ΙΔΙΟ screenshot -> πάντα διαφορετικά δέματα
  function groupCards(items) {
    // ίδιος κωδικός αποστολής σε διαφορετικά screenshots = η ίδια καρτέλα (κρατάμε την πιο «καθαρή» ανάγνωση)
    const better = (a, b) => (/\d/.test(String(b.address).split(',')[0]) && !/\d/.test(String(a.address).split(',')[0])) ? b : a;
    const uniq = [];
    items.forEach((it) => {
      const c = it.codes || [];
      // ο ίδιος κωδικός (σχεδόν): πολλοί κωδικοί μοιάζουν (ίδια αρχή «94GOEO…»), γι' αυτό με μικρή διαφορά
      // ζητάμε και ίδιο όνομα ή ίδια διεύθυνση
      const close = (u) => (u.codes || []).some((a) => c.some((b) => lev(a, b) <= 1));
      // το τηλέφωνο διαβάζεται σχεδόν πάντα σωστά: διαφορετικό τηλέφωνο = σίγουρα άλλη καρτέλα
      const phoneDiff = (u) => u.phone && it.phone && u.phone !== it.phone;
      const samePhone = (u) => u.phone && it.phone && u.phone === it.phone;
      const same = c.length ? uniq.find((u) => u.img !== it.img && (u.codes || []).length && codesOverlap(u.codes, c) && !phoneDiff(u) &&
        (close(u) || samePhone(u) || nameKey(u.name) === nameKey(it.name) || addrKey(u.address) === addrKey(it.address))) : null;
      if (!same) { uniq.push(Object.assign({}, it)); return; }
      const keep = better(same, it) === it ? Object.assign(same, { address: it.address }) : same;
      if ((it.name || '').length > (keep.name || '').length && nameKey(it.name).includes(nameKey(keep.name).slice(0, 6))) keep.name = it.name;
      keep.phone = keep.phone || it.phone;
      keep.pkgs = Math.max(keep.pkgs || 0, it.pkgs || 0);
      keep.codes = keep.codes.concat(c.filter((x) => !keep.codes.some((y) => sameCode(x, y))));
    });
    // κομμένη καρτέλα που έμεινε χωρίς οδό, όνομα και τηλέφωνο = σκουπίδι («Λι ςΧνπ« ΝΠπΘν»)
    const hubs = [];
    uniq.filter((it) => it.hub).forEach((it) => {
      const h = hubs.find((x) => x.hub.kind === it.hub.kind && nameKey(x.hub.name) === nameKey(it.hub.name));
      if (!h) { hubs.push(Object.assign({}, it, { hub: Object.assign({}, it.hub), cards: 1 })); return; }
      ['deliver', 'pickup', 'ret'].forEach((k) => { if (it.hub[k] != null) h.hub[k] = Math.max(h.hub[k] || 0, it.hub[k]); });
      h.pkgs = h.hub.deliver || 0;
    });
    items = uniq.filter((it) => !it.hub && (hasStreet(it.address) || it.name || it.phone));
    const groups = [];
    const num = (a) => (String(a).split(',')[0].match(/\d+/) || [''])[0];
    items.forEach((it) => {
      const k = addrKey(it.address);
      const person = { name: it.name || '', phone: it.phone || '', pkgs: it.pkgs || 1, codes: it.codes || [], img: it.img };
      let g = k.length >= 4 ? groups.find((x) => x.key === k) : null;
      // ίδιος πελάτης (όνομα + τηλέφωνο) και ίδιος αριθμός, γραμμένο αλλιώς («ανδρεου παπανδρεου 71» / «Λεωφόρος Ανδρέα Παπανδρέου 71»)
      if (!g && it.phone && num(it.address)) g = groups.find((x) => num(x.address) === num(it.address) &&
        x.people.some((p) => p.phone === it.phone && nameKey(p.name) === nameKey(it.name)));
      if (!g) {
        groups.push(Object.assign({}, it, { key: k, people: [person], cards: 1 }));
        return;
      }
      // είναι η ίδια καρτέλα (επικάλυψη screenshots);
      const dup = g.people.find((p) => p.img !== person.img && nameKey(p.name) === nameKey(person.name) &&
        !(p.phone && person.phone && p.phone !== person.phone) &&
        (!p.codes.length || !person.codes.length || codesOverlap(p.codes, person.codes)));
      if (dup) {
        dup.phone = dup.phone || person.phone;
        dup.pkgs = Math.max(dup.pkgs, person.pkgs);
        dup.codes = dup.codes.concat(person.codes.filter((c) => !dup.codes.some((d) => sameCode(c, d))));
        if (person.address && person.address.length > g.address.length && addrKey(person.address) === k) g.address = it.address;
        return;
      }
      g.people.push(person); g.cards++; // άλλη καρτέλα στην ίδια διεύθυνση
      if (it.ambig && !g.ambig) g.ambig = it.ambig;
    });
    groups.forEach((g) => {
      // ίδιος πελάτης σε πολλές καρτέλες -> μία γραμμή με άθροισμα δεμάτων
      const byName = [];
      g.people.forEach((p) => {
        const e = byName.find((x) => nameKey(x.name) === nameKey(p.name));
        if (e) {
          // ίδιος πελάτης σε ΔΙΑΦΟΡΕΤΙΚΑ screenshots χωρίς ίδιο κωδικό: μπορεί να είναι η ίδια καρτέλα δύο φορές -> ο χρήστης ελέγχει
          if (e.img !== p.img && !(e.codes.length && p.codes.length)) g.check = { name: e.name || p.name, minus: p.pkgs };
          e.pkgs += p.pkgs; e.phone = e.phone || p.phone; e.codes = e.codes.concat(p.codes);
        } else byName.push(Object.assign({}, p));
      });
      g.people = byName;
      // ίδιο πρόσωπο με λίγο διαφορετική ανάγνωση ονόματος σε άλλο screenshot («Σοκολη» / «Σοκοληή»)
      if (!g.check) byName.forEach((a, i) => byName.slice(i + 1).forEach((b) => {
        const ka = nameKey(a.name), kb = nameKey(b.name);
        if (!g.check && a.img !== b.img && !(a.codes.length && b.codes.length) && ka && kb && lev(ka, kb) <= Math.max(2, Math.floor(Math.min(ka.length, kb.length) * 0.25))) g.check = { name: b.name, minus: b.pkgs };
      }));
      g.pkgs = byName.reduce((a, p) => a + (p.pkgs || 1), 0);
      g.name = byName.map((p) => p.name).filter(Boolean).join(' · ');
      g.phone = (byName.find((p) => p.phone) || {}).phone || '';
      g.codes = byName.flatMap((p) => p.codes);
      delete g.key;
    });
    return groups.concat(hubs);
  }

  const api = { visionRecognize, _visionLines: visionLines, recognize, extract, extractImage, key, tidyAddress, mergeAcross, applyAmbig, fixAreas, groupCards, addrKey, codesOverlap, normCode };
  global.RootingOCR = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
