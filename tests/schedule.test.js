// 月間スケジュールの抽選ロジックのテスト。
// 実装（月末からの逆向きDP）とは別の方法（正方向の到達判定・総当たり列挙）で正解を求めて突き合わせる。
//   node tests/schedule.test.js [index.html のパス]
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { webcrypto } = require('crypto');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const grab = (a, b) => {
  const m = html.match(new RegExp('/\\*' + a + '\\*/([\\s\\S]*?)/\\*' + b + '\\*/'));
  if (!m) throw new Error(a + ' block not found');
  return m[1];
};
const S = vm.runInNewContext(
  grab('LOGIC-START', 'LOGIC-END') + grab('SCHEDULE-LOGIC-START', 'SCHEDULE-LOGIC-END') +
  ';({parseIntervalDays,validateInterval,parseYear,isLeapYear,daysInMonth,ymKey,weekdayMon0,buildMonthGrid,' +
  'viability,firstChoices,isFeasible,explainInfeasible,generateSchedule,validateSchedule,scheduleIntervals,randomInt,SCHED_DEFAULTS})',
  { crypto: webcrypto, globalThis: { crypto: webcrypto }, Math, console, Uint32Array, Number, String, parseInt, Object, Array, Date, Map, Set }
);

// vm内で作られた配列/オブジェクトはプロトタイプが異なるため、比較前にJSON経由で複製する
const _deep = assert.deepStrictEqual.bind(assert);
assert.deepStrictEqual = (a, b, m) => _deep(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const crit = df => { const z = 3.09; return df * Math.pow(1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df)), 3); }; // χ² 99.9%

// ---------- 独立実装（オラクル） ----------
// 正方向の到達判定: 月初から間隔lo〜hiで進み、実行日dに到達でき、かつ月末までがlo〜hiに収まる d(>=2) が存在するか
function oracleFeasible(L, lo, hi) {
  const reach = new Array(L + 1).fill(false);
  reach[1] = true;
  for (let d = 1; d < L; d++) {
    if (!reach[d]) continue;
    for (let s = lo; s <= hi; s++) if (d + s < L) reach[d + s] = true;
  }
  for (let d = 2; d < L; d++) if (reach[d] && L - d >= lo && L - d <= hi) return true;
  return false;
}
// 総当たりで全ての有効スケジュールを列挙（lo,hiが小さい組み合わせ用）
function enumerateAll(L, lo, hi) {
  const out = [];
  (function dfs(cur, path) {
    for (let s = lo; s <= hi; s++) {
      const n = cur + s;
      if (n > L) break;
      if (n === L) { if (path.length > 0) out.push(path.slice()); }
      else { path.push(n); dfs(n, path); path.pop(); }
    }
  })(1, []);
  return out;
}
// 実装とは無関係に、各ステップの「有効に終われる候補」から一様に選ぶときの各スケジュールの確率
function stepwiseProbability(L, lo, hi, sched) {
  const memo = new Map();
  const comp = d => { // 実行日dから有効に終える方法の数
    if (memo.has(d)) return memo.get(d);
    let t = 0;
    for (let s = lo; s <= hi; s++) { const n = d + s; if (n > L) break; t += (n === L) ? 1 : comp(n); }
    memo.set(d, t); return t;
  };
  let p = 1, cur = 1;
  const seq = sched.concat([L]);
  for (let i = 0; i < seq.length; i++) {
    let c = 0;
    for (let s = lo; s <= hi; s++) {
      const n = cur + s; if (n > L) break;
      if (n === L) { if (i > 0) c++; } else if (comp(n) > 0) c++;
    }
    p /= c; cur = seq[i];
  }
  return p;
}
// スケジュールの3条件を独立に検証
function checkValid(y, m, lo, hi, dates) {
  const L = new Date(y, m, 0).getDate();               // 月の長さはDateから（実装の daysInMonth とは別経路）
  assert.ok(dates.length >= 1);
  let prev = 1;
  dates.forEach((d, i) => {
    assert.ok(Number.isInteger(d) && d > prev && d < L, `範囲/昇順 ${y}-${m} ${dates}`);
    assert.ok(d - prev >= lo && d - prev <= hi, `${i === 0 ? '月初→最初' : '間隔'} ${y}-${m} ${lo}-${hi} ${dates}`);
    assert.strictEqual(new Date(y, m - 1, d).getMonth(), m - 1, '月をまたいでいない');
    prev = d;
  });
  assert.ok(L - prev >= lo && L - prev <= hi, `最後→月末 ${y}-${m} ${lo}-${hi} ${dates}`);
}

// ---------- 1. 日付・カレンダー ----------
ok('daysInMonth: 1970〜2100の全月がDateと一致、うるう年(2000/2024は29日, 2100は28日)', () => {
  for (let y = 1970; y <= 2100; y++) for (let m = 1; m <= 12; m++)
    assert.strictEqual(S.daysInMonth(y, m), new Date(y, m, 0).getDate(), y + '-' + m);
  assert.strictEqual(S.daysInMonth(2000, 2), 29); assert.strictEqual(S.daysInMonth(2024, 2), 29);
  assert.strictEqual(S.daysInMonth(2100, 2), 28); assert.strictEqual(S.daysInMonth(2025, 2), 28);
  assert.deepStrictEqual([1, 3, 4, 11].map(m => S.daysInMonth(2026, m)), [31, 31, 30, 30]);
});
ok('buildMonthGrid: 月曜始まり・全日が1回ずつ昇順・曜日位置がDateと一致（1970〜2100 全月）', () => {
  for (let y = 1970; y <= 2100; y++) for (let m = 1; m <= 12; m++) {
    const g = S.buildMonthGrid(y, m), L = new Date(y, m, 0).getDate();
    assert.ok(g.every(w => w.length === 7));
    const flat = g.flat();
    assert.deepStrictEqual(flat.filter(x => x !== null), Array.from({ length: L }, (_, i) => i + 1));
    flat.forEach((d, idx) => { if (d !== null) assert.strictEqual(idx % 7, (new Date(y, m - 1, d).getDay() + 6) % 7); });
    assert.ok(flat.indexOf(1) < 7 && g[g.length - 1].some(x => x !== null), '先頭/末尾の週に空行がない');
  }
  const feb2021 = S.buildMonthGrid(2021, 2);                    // 2021年2月は月曜始まり・28日 → ちょうど4週
  assert.strictEqual(feb2021.length, 4); assert.ok(feb2021.flat().every(x => x !== null));
  const nov2026 = S.buildMonthGrid(2026, 11);                   // 2026-11-01 は日曜
  assert.deepStrictEqual(nov2026[0], [null, null, null, null, null, null, 1]);
  assert.strictEqual(S.weekdayMon0(2026, 11, 16), 0);           // 2026-11-16 は月曜
});

// ---------- 2. 入力検証 ----------
ok('validateInterval: 整数のみ・1日以上・最短<=最長・全角OK・上限31', () => {
  assert.deepStrictEqual([S.validateInterval('2', '7').ok, S.validateInterval('２', '７').min], [true, 2]);
  for (const [a, b] of [['0', '7'], ['2', '0'], ['2.5', '7'], ['-1', '7'], ['abc', '7'], ['', '7'], ['2', ''], ['8', '7'], ['1', '32'], ['2e1', '7'], ['+2', '7']])
    assert.strictEqual(S.validateInterval(a, b).ok, false, a + ',' + b);
  assert.ok(S.validateInterval('8', '7').errors.range);
  assert.strictEqual(S.validateInterval('5', '5').ok, true);
  assert.strictEqual(S.parseYear('2026').value, 2026);
  for (const y of ['1969', '2101', '26', 'abcd', '2026.5', '']) assert.strictEqual(S.parseYear(y).ok, false, y);
});

// ---------- 3. 生成可否の判定が独立オラクルと一致 ----------
ok('isFeasible == 正方向オラクル（L=28〜31 × lo,hi=1..31 の全組み合わせ）', () => {
  let n = 0;
  for (let L = 28; L <= 31; L++) for (let lo = 1; lo <= 31; lo++) for (let hi = lo; hi <= 31; hi++) {
    assert.strictEqual(S.isFeasible(L, lo, hi), oracleFeasible(L, lo, hi), `L=${L} ${lo}-${hi}`); n++;
  }
  console.log('        組み合わせ:', n);
});
ok('isFeasible == 総当たり列挙の件数>0（lo>=2, hi<=9 の全組み合わせ）', () => {
  let n = 0;
  for (let L = 28; L <= 31; L++) for (let lo = 2; lo <= 9; lo++) for (let hi = lo; hi <= 9; hi++) {
    assert.strictEqual(S.isFeasible(L, lo, hi), enumerateAll(L, lo, hi).length > 0, `L=${L} ${lo}-${hi}`); n++;
  }
  console.log('        組み合わせ:', n);
});

// ---------- 4. 生成物の検証（複数の年月×複数の設定） ----------
const YEARS = [1999, 2000, 2023, 2024, 2025, 2026, 2100];
const CONFIGS = [[2, 7], [3, 10], [1, 3], [4, 6], [5, 9], [7, 7], [2, 2], [10, 20], [2, 31], [1, 1], [15, 31], [6, 8]];
ok('全年月(7年×12月)×12設定: 可能なら必ず有効なスケジュールを生成、不可能なら理由つきで拒否', () => {
  let gen = 0, rej = 0;
  for (const y of YEARS) for (let m = 1; m <= 12; m++) for (const [lo, hi] of CONFIGS) {
    const L = new Date(y, m, 0).getDate();
    const feasible = oracleFeasible(L, lo, hi);
    for (let k = 0; k < 40; k++) {
      const r = S.generateSchedule({ year: y, month: m, min: lo, max: hi });
      if (feasible) {
        assert.strictEqual(r.ok, true, `生成できるはず ${y}-${m} ${lo}-${hi}`);
        checkValid(y, m, lo, hi, r.dates);
        assert.strictEqual(S.validateSchedule({ year: y, month: m, min: lo, max: hi, dates: r.dates }).ok, true);
        gen++;
      } else {
        assert.strictEqual(r.ok, false);
        assert.ok(r.reason && r.reason.length > 10, '理由が表示できる');
        rej++;
      }
    }
  }
  console.log('        生成して検証:', gen, '件 / 拒否:', rej, '件');
});
ok('初期設定(2〜7日)×全年月: 最初の実行日が月初から2〜7日後、最後の実行日から月末まで2〜7日', () => {
  for (const y of YEARS) for (let m = 1; m <= 12; m++) for (let k = 0; k < 300; k++) {
    const r = S.generateSchedule({ year: y, month: m, min: 2, max: 7 });
    const L = new Date(y, m, 0).getDate();
    assert.ok(r.dates[0] >= 3 && r.dates[0] <= 8);
    assert.ok(L - r.dates[r.dates.length - 1] >= 2 && L - r.dates[r.dates.length - 1] <= 7);
  }
});
ok('2026年11月(30日): 最初の実行日は3〜8日、最後は23〜28日、両端の値も出現する', () => {
  const first = new Set(), last = new Set();
  for (let k = 0; k < 20000; k++) {
    const r = S.generateSchedule({ year: 2026, month: 11, min: 2, max: 7 });
    first.add(r.dates[0]); last.add(r.dates[r.dates.length - 1]);
  }
  assert.deepStrictEqual([...first].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual([...last].sort((a, b) => a - b), [23, 24, 25, 26, 27, 28]);
});
ok('うるう年: 2024-02(29日)・2000-02(29日)は29日まで、2025-02・2100-02(28日)は28日を超えない', () => {
  for (const [y, L] of [[2024, 29], [2000, 29], [2025, 28], [2100, 28]]) {
    let maxSeen = 0;
    for (let k = 0; k < 3000; k++) {
      const r = S.generateSchedule({ year: y, month: 2, min: 2, max: 7 });
      checkValid(y, 2, 2, 7, r.dates);
      maxSeen = Math.max(maxSeen, r.dates[r.dates.length - 1]);
    }
    assert.ok(maxSeen < L && maxSeen >= L - 7, `${y}: 最終実行日の最大 ${maxSeen}`);
  }
});

// ---------- 5. 「全ての有効スケジュールを網羅」「確率モデルどおり」 ----------
ok('2025年2月・5〜8日間隔: 有効スケジュールを総当たりで列挙→生成物は全てその集合に含まれ、全種類が出現', () => {
  const all = enumerateAll(28, 5, 8), set = new Set(all.map(a => a.join(',')));
  assert.ok(all.length > 20 && all.length < 2000, '件数=' + all.length);
  const seen = new Set();
  for (let k = 0; k < 200000; k++) {
    const r = S.generateSchedule({ year: 2025, month: 2, min: 5, max: 8 });
    const key = r.dates.join(',');
    assert.ok(set.has(key), '無効なスケジュール: ' + key);
    seen.add(key);
  }
  assert.strictEqual(seen.size, set.size);
  console.log('        有効スケジュール数:', set.size);
});
ok('確率モデル: 各ステップ「有効に終われる候補」から一様 → 総当たりで求めた厳密確率の総和が1', () => {
  const all = enumerateAll(28, 5, 8);
  const sum = all.reduce((t, a) => t + stepwiseProbability(28, 5, 8, a), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'sum=' + sum);
});
ok('確率モデル: 生成頻度が厳密確率に一致（χ²検定 p>0.001, 2025年2月・5〜8日間隔・40万回）', () => {
  const all = enumerateAll(28, 5, 8), N = 400000;
  const idx = new Map(all.map((a, i) => [a.join(','), i]));
  const cnt = new Array(all.length).fill(0);
  for (let k = 0; k < N; k++) cnt[idx.get(S.generateSchedule({ year: 2025, month: 2, min: 5, max: 8 }).dates.join(','))]++;
  let chi = 0, cells = 0, lowE = 0, lowO = 0;
  all.forEach((a, i) => {
    const e = N * stepwiseProbability(28, 5, 8, a);
    if (e < 5) { lowE += e; lowO += cnt[i]; } else { chi += (cnt[i] - e) ** 2 / e; cells++; }
  });
  if (lowE >= 5) { chi += (lowO - lowE) ** 2 / lowE; cells++; }
  assert.ok(chi < crit(cells - 1), `chi2=${chi.toFixed(1)} crit=${crit(cells - 1).toFixed(1)} cells=${cells}`);
});
ok('最初の実行日: 2026年11月・初期設定で3〜8日に一様（χ²検定）', () => {
  const N = 120000, cnt = {};
  for (let k = 0; k < N; k++) { const d = S.generateSchedule({ year: 2026, month: 11, min: 2, max: 7 }).dates[0]; cnt[d] = (cnt[d] || 0) + 1; }
  const e = N / 6; let chi = 0;
  for (let d = 3; d <= 8; d++) chi += (cnt[d] - e) ** 2 / e;
  assert.ok(chi < crit(5), 'chi2=' + chi.toFixed(1));
});
ok('「最終的に有効になる候補だけ」: 最初の実行日になり得る日 == 総当たりで有効なスケジュールの先頭日の集合', () => {
  for (const [L, lo, hi] of [[28, 5, 8], [30, 6, 9], [31, 4, 6], [29, 7, 10], [30, 3, 5]]) {
    const all = enumerateAll(L, lo, hi);
    const want = [...new Set(all.map(a => a[0]))].sort((a, b) => a - b);
    const got = S.firstChoices(L, lo, hi, S.viability(L, lo, hi));
    assert.deepStrictEqual(got, want, `${L} ${lo}-${hi}`);
  }
});

// ---------- 6. 再生成・決定的な選択・不可能時の説明 ----------
ok('再生成: 同じ設定・年月で毎回別のスケジュールが出る（50回で40通り以上）', () => {
  const seen = new Set();
  for (let k = 0; k < 50; k++) seen.add(S.generateSchedule({ year: 2026, month: 11, min: 2, max: 7 }).dates.join(','));
  assert.ok(seen.size >= 40, 'distinct=' + seen.size);
});
ok('選択関数を差し替え可能: 常に最小/最大/中央を選んでも有効（無限ループなし）', () => {
  for (const pick of [() => 0, n => n - 1, n => Math.floor(n / 2)])
    for (const y of [2024, 2025, 2026]) for (let m = 1; m <= 12; m++) for (const [lo, hi] of [[2, 7], [3, 10], [1, 31]]) {
      const r = S.generateSchedule({ year: y, month: m, min: lo, max: hi, pick });
      assert.strictEqual(r.ok, true); checkValid(y, m, lo, hi, r.dates);
    }
});
ok('不可能な設定は理由と提案を返し、提案どおりに直すと実際に生成できる', () => {
  let n = 0;
  for (const y of [2025, 2024, 2026]) for (let m = 1; m <= 12; m++) for (const [lo, hi] of CONFIGS) {
    const L = new Date(y, m, 0).getDate();
    if (oracleFeasible(L, lo, hi)) continue;
    const r = S.generateSchedule({ year: y, month: m, min: lo, max: hi });
    assert.ok(!r.ok && r.reason);
    if (r.suggest.max) assert.ok(oracleFeasible(L, lo, r.suggest.max), '提案(最長)が不正');
    if (r.suggest.min) assert.ok(oracleFeasible(L, r.suggest.min, hi), '提案(最短)が不正');
    if (r.suggest.max || r.suggest.min) assert.ok(r.hint.includes('日'));
    n++;
  }
  assert.ok(n > 50);
  const r = S.generateSchedule({ year: 2026, month: 11, min: 7, max: 7 });    // 29日間は7の倍数でない
  assert.ok(!r.ok && r.reason.includes('倍数'));
  const r2 = S.generateSchedule({ year: 2025, month: 2, min: 15, max: 20 });   // 月が短すぎる
  assert.ok(!r2.ok && r2.reason.includes('2回分'));
});
ok('実行日が1回も入らない設定（月初→月末を1歩で渡れる）は不採用', () => {
  const r = S.generateSchedule({ year: 2026, month: 11, min: 29, max: 29 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(S.generateSchedule({ year: 2026, month: 11, min: 10, max: 29 }).ok, true);   // 他の区切り方があれば生成できる
});

// ---------- 7. 検証関数 ----------
ok('validateSchedule: 3条件のどれかが崩れたデータ・月またぎ・順序違反を拒否', () => {
  const base = { year: 2026, month: 11, min: 2, max: 7 };
  assert.ok(S.validateSchedule({ ...base, dates: [4, 10, 13, 19, 24, 27] }).ok);
  assert.ok(!S.validateSchedule({ ...base, dates: [4, 10, 13, 19, 24, 29] }).ok);       // 最後→月末が1日
  assert.ok(!S.validateSchedule({ ...base, dates: [2, 10, 13, 19, 24, 27] }).ok);       // 月初→最初が1日
  assert.ok(!S.validateSchedule({ ...base, dates: [4, 12, 13, 19, 24, 27] }).ok);       // 間隔8日
  assert.ok(!S.validateSchedule({ ...base, dates: [4, 5, 13, 19, 24, 27] }).ok);        // 間隔1日
  assert.ok(!S.validateSchedule({ ...base, dates: [4, 10, 31] }).ok);                   // 11月に31日はない
  assert.ok(!S.validateSchedule({ ...base, dates: [10, 4, 13, 19, 24, 27] }).ok);       // 昇順でない
  assert.ok(!S.validateSchedule({ ...base, dates: [] }).ok);
  assert.ok(!S.validateSchedule({ ...base, dates: [4.5, 10] }).ok);
  assert.ok(!S.validateSchedule(null).ok);
  assert.deepStrictEqual(S.scheduleIntervals([4, 10, 13, 19, 24, 27], 30), { first: 3, gaps: [6, 3, 6, 5, 3], last: 3 });
});

console.log('\n' + pass + ' tests passed');
