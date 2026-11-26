/*
 * Βίντεο εγγραφής οθόνης → λίγα καθαρά καρέ, σαν screenshots.
 *
 * 1. «Κοιτάμε» το βίντεο ανά 0,25″ σε μικρή ανάλυση και βρίσκουμε πόσο κύλησε η λίστα από καρέ σε καρέ.
 * 2. Κρατάμε ένα καρέ ανά ~μισή οθόνη κύλισης (ώστε κάθε κάρτα να φαίνεται ολόκληρη σε ένα τουλάχιστον),
 *    διαλέγοντας εκεί γύρω το πιο ακίνητο (= όχι θολό).
 * 3. Τα κρατημένα καρέ βγαίνουν σε πλήρη ανάλυση ως εικόνες και διαβάζονται όπως τα screenshots.
 */
(function (global) {
  'use strict';

  const STEP = 0.2; // δευτερόλεπτα ανάμεσα στα δείγματα
  const TW = 96; // πλάτος μικρογραφίας
  const TOP = 0.14, BOT = 0.10; // σταθερά κομμάτια οθόνης (μπάρα κατάστασης/τίτλος, κάτω μενού) — δεν κυλάνε

  function once(el, ev, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error('timeout ' + ev)); }, ms || 8000);
      function ok() { clearTimeout(t); el.removeEventListener(ev, ok); res(); }
      el.addEventListener(ev, ok);
    });
  }
  async function seek(v, t) {
    if (Math.abs(v.currentTime - t) < 0.001) return;
    const p = once(v, 'seeked', 5000);
    v.currentTime = t;
    await p;
    // το iPhone μερικές φορές ζωγραφίζει το προηγούμενο καρέ αμέσως μετά το seeked
    if (v.requestVideoFrameCallback) await Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r())), new Promise((r) => setTimeout(r, 120))]);
  }

  async function openVideo(file) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    const url = URL.createObjectURL(file);
    v.src = url;
    try {
      await once(v, 'loadeddata', 15000);
    } catch (e) { v.remove(); URL.revokeObjectURL(url); throw new Error('Δεν ανοίγει το βίντεο'); }
    // το iPhone αποκωδικοποιεί καρέ για canvas μόνο αφού «παίξει» λίγο
    try { await v.play(); v.pause(); } catch (e) { /* ignore */ }
    return { v, done: () => { try { v.pause(); } catch (e) { /* ignore */ } v.remove(); URL.revokeObjectURL(url); } };
  }

  // μικρογραφία σε αποχρώσεις του γκρι
  function thumb(v, ctx, th) {
    ctx.drawImage(v, 0, 0, TW, th);
    const d = ctx.getImageData(0, 0, TW, th).data, g = new Float32Array(TW * th);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return g;
  }
  // πόσες γραμμές (της μικρογραφίας) κύλησε το περιεχόμενο από το a στο b (+ = προς τα πάνω, δηλ. κατεβαίνεις τη λίστα)
  // pred = η κύλιση του προηγούμενου βήματος: οι λίστες είναι «επαναλαμβανόμενες» (κάρτες ίδιου σχήματος), οπότε
  // ανάμεσα σε σχεδόν ίσες ταυτίσεις διαλέγουμε αυτή που ταιριάζει με την κίνηση που ήδη έχει το δάχτυλο
  function shiftOf(a, b, th, pred) {
    const y0 = Math.round(th * TOP), y1 = Math.round(th * (1 - BOT)), H = y1 - y0;
    const maxS = Math.floor(H * 0.85);
    const errs = [];
    let minE = Infinity, zeroErr = Infinity;
    for (let s = -maxS; s <= maxS; s++) {
      // γραμμή y του b = γραμμή y+s του a
      const from = Math.max(y0, y0 - s), to = Math.min(y1, y1 - s);
      const n = to - from;
      if (n < H * 0.15) continue;
      let err = 0;
      for (let y = from; y < to; y += 1) {
        const ra = (y + s) * TW, rb = y * TW;
        for (let x = 0; x < TW; x += 2) err += Math.abs(a[ra + x] - b[rb + x]);
      }
      err /= n * (TW / 2);
      const e = err * (1 + 0.15 * (1 - n / H)); // μικρή προτίμηση στις μεγάλες επικαλύψεις
      if (s === 0) zeroErr = err;
      errs.push([s, e]);
      if (e < minE) minE = e;
    }
    const p = pred || 0;
    let best = 0, bestD = Infinity, bestErr = minE, groups = 0, lastS = null;
    for (const [s, e] of errs) {
      if (e > minE * 1.2 + 0.6) continue;
      if (lastS === null || s - lastS > 2) groups++; // ξεχωριστή «καλή» θέση = αμφισημία
      lastS = s;
      const d = Math.abs(s - p);
      if (d < bestD) { bestD = d; best = s; bestErr = e; }
    }
    return { s: best, err: bestErr, zeroErr, H, ambiguous: groups > 1 };
  }

  // Διαλέγει τις στιγμές του βίντεο που θα γίνουν «screenshots»
  function choose(samples, H) {
    const n = samples.length;
    if (!n) return { picks: [], gaps: 0 };
    const pos = [0], cut = [false];
    for (let k = 1; k < n; k++) {
      const r = samples[k].shift;
      cut[k] = r.err > 28; // άλλαξε η οθόνη (π.χ. άλλη εφαρμογή) — δεν ταιριάζει με το προηγούμενο
      pos[k] = pos[k - 1] + (cut[k] ? H : r.s);
    }
    // θόλωμα ≈ πόση κίνηση έχει γύρω του
    const mot = samples.map((_, k) => Math.max(k ? Math.abs(pos[k] - pos[k - 1]) : 0, k + 1 < n ? Math.abs(pos[k + 1] - pos[k]) : 0)
      + (k && !cut[k] && samples[k].shift.s === 0 ? samples[k].shift.zeroErr / 4 : 0));
    const score = (j, last) => mot[j] / H * 8 - (pos[j] - pos[last]) / H;
    const picks = [];
    let gaps = 0;
    // αρχή: το πιο ακίνητο καρέ πριν αρχίσει η κύλιση
    let first = 0;
    for (let k = 0; k < n && pos[k] - pos[0] < 0.15 * H; k++) if (mot[k] < mot[first]) first = k;
    picks.push(first);
    let last = first;
    for (;;) {
      const win = [];
      for (let j = last + 1; j < n; j++) {
        const d = pos[j] - pos[last];
        if (cut[j] && j > last) { win.length = 0; win.push(j); break; }
        if (d >= 0.22 * H && d <= 0.58 * H) win.push(j);
        if (d > 0.58 * H && win.length) break;
      }
      let next = -1;
      if (win.length) next = win.reduce((b, j) => (score(j, last) < score(b, last) ? j : b), win[0]);
      else {
        // πήγε πολύ γρήγορα: το πρώτο καρέ μετά από 0,22 οθόνης (ή το πιο ακίνητο από τα 3 επόμενα)
        let j = last + 1;
        while (j < n && pos[j] - pos[last] < 0.22 * H) j++;
        if (j >= n) break;
        next = j;
        for (let q = j + 1; q < Math.min(n, j + 3); q++) if (mot[q] < mot[next] && pos[q] - pos[last] < 1.0 * H) next = q;
        if (pos[next] - pos[last] > 0.7 * H) gaps++;
      }
      picks.push(next);
      last = next;
      if (picks.length > 80) break;
    }
    // τέλος λίστας: αν κύλησε λίγο ακόμα μετά το τελευταίο, κρατάμε και το πιο ακίνητο από το τέλος
    let maxK = last;
    for (let k = last + 1; k < n; k++) if (pos[k] > pos[maxK] + 0.5) maxK = k;
    if (pos[maxK] - pos[last] > 0.04 * H) {
      let endK = maxK;
      for (let k = maxK; k < n; k++) if (Math.abs(pos[k] - pos[maxK]) < 0.05 * H && mot[k] < mot[endK]) endK = k;
      picks.push(endK);
    }
    return { picks, gaps, pos, mot };
  }

  async function extractFrames(file, onProgress) {
    const { v, done } = await openVideo(file);
    try {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) throw new Error('Δεν ανοίγει το βίντεο');
      const th = Math.max(40, Math.round(TW * vh / vw));
      const c = document.createElement('canvas'); c.width = TW; c.height = th;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (!dur) throw new Error('Δεν διαβάζεται η διάρκεια του βίντεο');
      const times = [];
      for (let t = 0.05; t < dur - 0.02; t += STEP) times.push(t);
      times.push(Math.max(0, dur - 0.06));
      const samples = [];
      let prev = null;
      // αν η ταύτιση είναι αμφίσημη (κύλησε πολύ μέσα σε 0,2″), κοιτάμε και ενδιάμεσα καρέ ώσπου τα βήματα να είναι μικρά
      const measure = async (tA, gA, tB, gB, pred, depth) => {
        const r = shiftOf(gA, gB, th, pred);
        if (!r.ambiguous || depth >= 3) return r;
        const tm = (tA + tB) / 2;
        await seek(v, tm);
        const gm = thumb(v, ctx, th);
        const r1 = await measure(tA, gA, tm, gm, pred / 2, depth + 1);
        const r2 = await measure(tm, gm, tB, gB, r1.s, depth + 1);
        return { s: r1.s + r2.s, err: Math.max(r1.err, r2.err), zeroErr: r.zeroErr, H: r.H, ambiguous: false };
      };
      const Hrows = Math.round(th * (1 - TOP - BOT));
      // γρήγορη κύλιση: προσθέτουμε ενδιάμεσα δείγματα ώστε να υπάρχει καρέ κάθε ~1/3 οθόνης
      const addBetween = async (tA, gA, tB, gB, pred, depth) => {
        const r = await measure(tA, gA, tB, gB, pred, 0);
        if (Math.abs(r.s) <= Hrows * 0.3 || depth >= 3 || r.err > 28) { samples.push({ t: tB, shift: r }); return r.s; }
        const tm = (tA + tB) / 2;
        await seek(v, tm);
        const gm = thumb(v, ctx, th);
        const s1 = await addBetween(tA, gA, tm, gm, pred / 2, depth + 1);
        await seek(v, tB);
        return addBetween(tm, gm, tB, gB, s1, depth + 1);
      };
      for (let i = 0; i < times.length; i++) {
        await seek(v, times[i]);
        const g = thumb(v, ctx, th);
        const pred = samples.length ? samples[samples.length - 1].shift.s : 0;
        if (!prev) samples.push({ t: times[i], shift: { s: 0, err: 0, zeroErr: 0 } });
        else await addBetween(times[i - 1], prev, times[i], g, pred, 0);
        prev = g;
        if (onProgress && i % 5 === 0) onProgress(i / times.length * 0.8);
      }
      const H = Math.round(th * (1 - TOP - BOT));
      const ch = choose(samples, H);
      // πλήρης ανάλυση για τα καρέ που κρατήσαμε
      const big = document.createElement('canvas'); big.width = vw; big.height = vh;
      const bctx = big.getContext('2d');
      const files = [];
      for (let i = 0; i < ch.picks.length; i++) {
        await seek(v, samples[ch.picks[i]].t);
        bctx.drawImage(v, 0, 0, vw, vh);
        const blob = await new Promise((r) => big.toBlob(r, 'image/jpeg', 0.92));
        if (blob) files.push(new File([blob], `kare-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
        if (onProgress) onProgress(0.8 + 0.2 * (i + 1) / ch.picks.length);
      }
      return { files, gaps: ch.gaps, times: ch.picks.map((k) => samples[k].t), duration: dur };
    } finally { done(); }
  }

  global.RootingVideo = { extractFrames, _choose: choose, _shiftOf: shiftOf };
})(typeof window !== 'undefined' ? window : globalThis);
