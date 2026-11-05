/*
 * Λύτης διαδρομής (Traveling Salesman Problem).
 * Πίνακας κόστους D[i][j] (χρόνος οδήγησης από i προς j, μπορεί να είναι ασύμμετρος).
 * Ο κόμβος 0 είναι πάντα η αφετηρία.
 * mode:
 *   'open'  -> τελειώνει σε όποια στάση βγει καλύτερα
 *   'cycle' -> επιστρέφει στην αφετηρία
 *   'fixed' -> τελειώνει στον κόμβο n-1 (συγκεκριμένο τέλος)
 * Επιστρέφει τη σειρά των στάσεων (indices του πίνακα, χωρίς αφετηρία/τέλος).
 */
(function (global) {
  'use strict';

  function solveRoute(D, mode, opts) {
    opts = opts || {};
    const timeLimit = opts.timeLimitMs || 1500;
    const n = D.length;
    const endIdx = mode === 'fixed' ? n - 1 : -1;
    const nodes = [];
    for (let i = 1; i < n; i++) if (i !== endIdx) nodes.push(i);
    const m = nodes.length;
    if (m <= 1) return nodes.slice();

    const cost = (perm) => {
      let c = D[0][perm[0]];
      for (let i = 0; i < perm.length - 1; i++) c += D[perm[i]][perm[i + 1]];
      const last = perm[perm.length - 1];
      if (mode === 'cycle') c += D[last][0];
      else if (mode === 'fixed') c += D[last][endIdx];
      return c;
    };

    // Ακριβής λύση για λίγες στάσεις
    if (m <= 8) return bruteForce(nodes, cost);

    const t0 = Date.now();
    let best = nearestNeighbor(D, nodes, mode, endIdx);
    best = localSearch(best, cost);
    let bestCost = cost(best);

    // Iterated Local Search με double-bridge διαταραχές
    let cur = best.slice();
    let curCost = bestCost;
    let iter = 0;
    while (Date.now() - t0 < timeLimit && iter < 5000) {
      iter++;
      const cand = localSearch(doubleBridge(cur), cost);
      const cc = cost(cand);
      if (cc < curCost - 1e-9) {
        cur = cand; curCost = cc;
        if (cc < bestCost - 1e-9) { best = cand.slice(); bestCost = cc; }
      } else if (Math.random() < 0.05) {
        cur = best.slice(); curCost = bestCost;
      }
    }
    return best;
  }

  function bruteForce(nodes, cost) {
    let best = null, bestCost = Infinity;
    const perm = nodes.slice();
    const used = new Array(nodes.length).fill(false);
    const cur = [];
    (function rec() {
      if (cur.length === nodes.length) {
        const c = cost(cur);
        if (c < bestCost) { bestCost = c; best = cur.slice(); }
        return;
      }
      for (let i = 0; i < perm.length; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(perm[i]);
        rec();
        cur.pop(); used[i] = false;
      }
    })();
    return best;
  }

  function nearestNeighbor(D, nodes, mode, endIdx) {
    const left = new Set(nodes);
    const out = [];
    let at = 0;
    while (left.size) {
      let bj = -1, bd = Infinity;
      for (const j of left) if (D[at][j] < bd) { bd = D[at][j]; bj = j; }
      out.push(bj); left.delete(bj); at = bj;
    }
    return out;
  }

  function localSearch(perm, cost) {
    let p = perm.slice();
    let c = cost(p);
    let improved = true;
    while (improved) {
      improved = false;
      // 2-opt: αναστροφή τμήματος
      for (let i = 0; i < p.length - 1; i++) {
        for (let j = i + 1; j < p.length; j++) {
          const q = p.slice(0, i).concat(p.slice(i, j + 1).reverse(), p.slice(j + 1));
          const qc = cost(q);
          if (qc < c - 1e-9) { p = q; c = qc; improved = true; }
        }
      }
      // Or-opt: μετακίνηση τμήματος 1-3 στάσεων σε άλλη θέση
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= p.length; i++) {
          const seg = p.slice(i, i + len);
          const rest = p.slice(0, i).concat(p.slice(i + len));
          for (let k = 0; k <= rest.length; k++) {
            if (k === i) continue;
            for (const s of [seg, seg.slice().reverse()]) {
              const q = rest.slice(0, k).concat(s, rest.slice(k));
              const qc = cost(q);
              if (qc < c - 1e-9) { p = q; c = qc; improved = true; break; }
            }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
    }
    return p;
  }

  function doubleBridge(p) {
    const n = p.length;
    if (n < 8) {
      const q = p.slice();
      const a = Math.floor(Math.random() * n), b = Math.floor(Math.random() * n);
      [q[a], q[b]] = [q[b], q[a]];
      return q;
    }
    const cuts = [];
    while (cuts.length < 3) {
      const x = 1 + Math.floor(Math.random() * (n - 1));
      if (!cuts.includes(x)) cuts.push(x);
    }
    cuts.sort((a, b) => a - b);
    const [a, b, c] = cuts;
    return p.slice(0, a).concat(p.slice(c), p.slice(b, c), p.slice(a, b));
  }

  global.solveRoute = solveRoute;
  if (typeof module !== 'undefined') module.exports = { solveRoute };
})(typeof window !== 'undefined' ? window : globalThis);
