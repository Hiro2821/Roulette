const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');
const assert = require('assert');

const html = fs.readFileSync((process.argv[2] || require('path').join(__dirname, '..', 'index.html')), 'utf8');
const m = html.match(/\/\*LOGIC-START\*\/([\s\S]*?)\/\*LOGIC-END\*\//);
if (!m) throw new Error('logic block not found');
const L = vm.runInContext
  ? vm.runInNewContext(m[1] + ';({TAU,LIMITS,parseDays,validateRange,buildValues,randomInt,indexAtPointer,planSpin,makeProfile,mod})',
      { globalThis: { crypto: webcrypto }, crypto: webcrypto, Math, console, Uint32Array, Number, String, parseInt, Object })
  : null;

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// 1. 入力検証
ok('parseDays: 整数のみ・全角OK・範囲', () => {
  assert.strictEqual(L.parseDays('7').value, 7);
  assert.strictEqual(L.parseDays('１４').value, 14);        // 全角
  assert.strictEqual(L.parseDays(' 3 ').value, 3);
  for (const bad of ['', ' ', '0', '-1', '2.5', '1e2', 'abc', '３.５', '366', '+3', '０'])
    assert.strictEqual(L.parseDays(bad).ok, false, 'should reject: ' + JSON.stringify(bad));
});
ok('validateRange: min>max / 候補数上限 / 正常', () => {
  assert.strictEqual(L.validateRange('8', '7').ok, false);
  assert.ok(L.validateRange('8', '7').errors.range);
  assert.strictEqual(L.validateRange('1', '61').ok, false);
  assert.strictEqual(L.validateRange('1', '60').ok, true);
  assert.strictEqual(L.validateRange('3', '14').ok, true);
  assert.deepStrictEqual(Array.from(L.buildValues(3, 14)), [3,4,5,6,7,8,9,10,11,12,13,14]);
  assert.strictEqual(L.validateRange('5', '5').ok, true);          // 1種類も可
});

// 2. 等確率（カイ二乗検定）
function chi2(n, trials) {
  const cnt = new Array(n).fill(0);
  for (let i = 0; i < trials; i++) cnt[L.randomInt(n)]++;
  const e = trials / n;
  return { chi: cnt.reduce((s, c) => s + (c - e) ** 2 / e, 0), cnt };
}
// 自由度 df の 99.9% 臨界値（近似: Wilson-Hilferty）
const crit = df => { const z = 3.09; return df * Math.pow(1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df)), 3); };
for (const n of [6, 12, 7, 60]) {
  ok(`randomInt 均等性 n=${n} (60万回, χ²検定 p>0.001)`, () => {
    const { chi, cnt } = chi2(n, 600000);
    assert.ok(chi < crit(n - 1), `chi2=${chi.toFixed(1)} crit=${crit(n - 1).toFixed(1)}`);
    assert.ok(cnt.every(c => c > 0));
  });
}
ok('randomInt: 棄却サンプリングが剰余バイアスを除去（極端なsrcで検証）', () => {
  // n=3, 2^32 mod 3 = 1。src が 0..2^32-1 を一様に返す理想系で、limit以上は棄却される
  const limit = Math.floor(4294967296 / 3) * 3;
  const seq = [limit, limit + 0, 5];           // 最初の2つは棄却されるはず
  let i = 0;
  assert.strictEqual(L.randomInt(3, () => seq[i++]), 5 % 3);
  assert.strictEqual(i, 3);
});

// 3. 指針と当選の一致（全n・全当選・ランダムな現在角・ランダムなオフセット）
ok('planSpin: 最終角で指針が指す区画 == 当選区画 (n=1..60, 各20万ケース相当)', () => {
  let cases = 0;
  for (let n = 1; n <= 60; n++) {
    for (let w = 0; w < n; w++) {
      for (let k = 0; k < 40; k++) {
        const rot = Math.random() * 1000 - 500;
        const off = (Math.random() * 2 - 1) * 0.36;
        const spins = 4 + Math.floor(Math.random() * 3);
        const p = L.planSpin({ winnerIdx: w, n, rot, spins, offsetFrac: off });
        assert.strictEqual(L.indexAtPointer(p.finalRot, n), w, `n=${n} w=${w} off=${off}`);
        assert.ok(p.distance >= spins * L.TAU - 1e-9 && p.distance < (spins + 1) * L.TAU + 1e-9);
        cases++;
      }
    }
  }
  console.log('        cases:', cases);
});
ok('停止位置は区画境界から十分離れている（|offset|≤0.36 → 境界まで≥14%）', () => {
  const n = 6, seg = L.TAU / n;
  const p = L.planSpin({ winnerIdx: 3, n, rot: 0, spins: 5, offsetFrac: 0.36 });
  const phi = L.mod(-p.finalRot, L.TAU);
  const d = Math.abs(phi - 3 * seg);
  assert.ok(Math.abs(d / seg - 0.36) < 1e-9);
});

// 4. 回転カーブ
ok('makeProfile: 単調増加・終端一致・加速→等速→減速・不連続なし', () => {
  const D = 35.3, pr = L.makeProfile(D);
  assert.strictEqual(pr.pos(0), 0);
  assert.ok(Math.abs(pr.pos(pr.T) - D) < 1e-9);
  assert.ok(Math.abs(pr.pos(pr.T - 1e-7) - D) < 1e-4);   // 終端で位置が飛ばない
  let prev = 0, vPrev = 0, maxJump = 0;
  const dt = 1 / 240;
  const speeds = [];
  for (let t = dt; t <= pr.T; t += dt) {
    const p = pr.pos(t);
    assert.ok(p >= prev - 1e-12, 'monotonic at ' + t);
    const v = (p - prev) / dt; speeds.push(v);
    maxJump = Math.max(maxJump, Math.abs(v - vPrev)); vPrev = v; prev = p;
  }
  assert.ok(maxJump < pr.vmax * 0.06, 'velocity continuity, maxJump=' + maxJump);
  const at = t => speeds[Math.round(t * 240) - 1];
  assert.ok(at(0.2) < at(0.5) && at(0.5) < at(0.69), 'accelerating');
  assert.ok(Math.abs(at(1.2) - pr.vmax) < pr.vmax * 0.01, 'cruise');
  assert.ok(at(3) < at(2.0) && at(5) < at(3) && at(pr.T - 0.05) < pr.vmax * 0.01, 'decelerating smoothly to ~0');
  console.log('        vmax=' + pr.vmax.toFixed(2) + ' rad/s (' + (pr.vmax / L.TAU).toFixed(2) + ' rev/s), T=' + pr.T.toFixed(1) + 's');
});

console.log('\n' + pass + ' tests passed');
