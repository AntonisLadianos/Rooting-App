#!/usr/bin/env node
/*
 * Δοκιμές ανάγνωσης screenshots (χωρίς browser):  node tests/run.js
 *   node tests/run.js --update   ξαναγράφει τα αναμενόμενα αποτελέσματα (μόνο αφού τα ελέγξεις με το μάτι!)
 * Τα δείγματα στο tests/fixtures είναι ΦΑΝΤΑΣΤΙΚΑ δεδομένα — ποτέ πραγματικά στοιχεία πελατών εδώ.
 */
const fs = require('fs');
const path = require('path');
global.window = global;
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'ocr.js'), 'utf8'));
const O = global.RootingOCR;

function pipeline(images) {
  const per = images.map((im) => O.extractImage(im.text));
  const ambig = images.flatMap((im) => im.ambig || []);
  return O.groupCards(O.fixAreas(O.applyAmbig(O.mergeAcross(per), ambig))).map((g) => ({
    address: g.address,
    pkgs: g.pkgs || 0,
    cards: g.cards || 1,
    people: (g.people || []).map((p) => ({ name: p.name, phone: p.phone, pkgs: p.pkgs })),
    hub: g.hub ? { kind: g.hub.kind, name: g.hub.name, deliver: g.hub.deliver, pickup: g.hub.pickup, ret: g.hub.ret } : undefined,
    check: g.check ? true : undefined
  }));
}

const dir = path.join(__dirname, 'fixtures');
const update = process.argv.includes('--update');
let failed = 0;
fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json')).forEach((f) => {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const got = pipeline(fx.images);
  const expFile = path.join(dir, f.replace(/\.json$/, '.expected.json'));
  if (update || !fs.existsSync(expFile)) { fs.writeFileSync(expFile, JSON.stringify(got, null, 1) + '\n'); console.log(`✎ ${f}: γράφτηκαν ${got.length} αναμενόμενες στάσεις`); return; }
  const exp = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  const a = JSON.stringify(got), b = JSON.stringify(exp);
  if (a === b) { console.log(`✓ ${f}: ${got.length} στάσεις`); return; }
  failed++;
  console.log(`✗ ${f}: διαφορά`);
  const n = Math.max(got.length, exp.length);
  for (let i = 0; i < n; i++) if (JSON.stringify(got[i]) !== JSON.stringify(exp[i])) console.log(`   #${i + 1}\n     περίμενα: ${JSON.stringify(exp[i])}\n     βγήκε:    ${JSON.stringify(got[i])}`);
});
process.exit(failed ? 1 : 0);
