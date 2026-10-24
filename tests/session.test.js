// 連線紀錄（第 5 階段）：格式檢查、和專案比對、重播結果的比較。
// 錄製與重播的畫面流程在 E2E（vmulti 段落）；這裡驗證資料格式與比對規則。
const test = require('node:test'); const assert = require('node:assert');
const { DL, solved } = require('./helpers'); const S = DL.session;

// 用模擬引擎做一份「紀錄」：按鈕量測在指定時刻送進去，每一毫秒記下輸出的變化（和真機模式下 DofLab 的錄製相同）
function record(p, inputs, T) {
  const rec = S.create({ project: { name: p.name, board: p.board.type }, device: { deviceId: 'vdev:uno-1@test', virtual: true } });
  S.push(rec, { t: 0, type: 'run', v: true });
  const e = DL.createEngine(p); let k = 0; const last = {};
  const ins = inputs.slice().sort((a, b) => a.t - b.t);
  for (let t = 1; t <= T; t++) {
    while (k < ins.length && ins[k].t <= t) { const x = ins[k++]; e.setButton(x.name.split('.')[0], x.v); S.push(rec, { t: x.t, type: 'measure', name: x.name, v: x.v }); S.push(rec, { t, st: t, type: 'input', name: x.name, v: x.v }); }
    const out = e.tick(t).out;
    for (const [id, v] of Object.entries(out)) { const n = id + '.state'; if (last[n] !== v) { last[n] = v; S.push(rec, { t, st: t, type: 'sim', name: n, v }); } }
  }
  return rec;
}
const IN = [{ t: 200, name: 'BTN1.pressed', v: true }, { t: 1400, name: 'BTN1.pressed', v: false }, { t: 1700, name: 'BTN1.pressed', v: true }, { t: 1850, name: 'BTN1.pressed', v: false }];

test('連線紀錄的格式：匯出再讀回一致；不是紀錄、版本不符、時間倒退、事件類型不明都明確拒絕', () => {
  const p = solved('hold-blink', 'uno'); const rec = record(p, IN, 2500);
  const back = S.parse(JSON.stringify(rec)); assert.ok(back.ok, back.msg); assert.deepStrictEqual(back.rec.events, rec.events);
  assert.match(S.parse('{').msg, /不是 JSON/);
  assert.match(S.parse({ format: 'x' }).msg, /不是 DofLab 的連線紀錄/);
  assert.match(S.parse(Object.assign({}, rec, { version: 9 })).msg, /版本 9 不支援/);
  assert.match(S.parse(Object.assign({}, rec, { events: [{ t: 5, type: 'measure' }, { t: 1, type: 'measure' }] })).msg, /比前一筆早/);
  assert.match(S.parse(Object.assign({}, rec, { events: [{ t: 1, type: 'hack' }] })).msg, /格式不正確/);
});

test('和目前的專案比對：板型不同不能重播；專案沒有的訊號、沒有量測只是警告', () => {
  const p = solved('hold-blink', 'uno'); const rec = record(p, IN, 500);
  assert.deepStrictEqual(S.check(rec, p, ['BTN1.pressed', 'LED1.state']), []);
  const e32 = solved('hold-blink', 'esp32');
  assert.strictEqual(S.check(rec, e32, ['BTN1.pressed', 'LED1.state'])[0].level, 'error');
  const w = S.check(rec, p, ['LED1.state']); assert.ok(w.some(i => i.level === 'warn' && /BTN1\.pressed/.test(i.msg)));
  const empty = S.create({ project: { board: 'uno' } }); assert.ok(S.check(empty, p, []).some(i => /沒有量測/.test(i.msg)));
});

test('重播比對：同樣的量測重算出同樣的輸出 → 一致；行為改了（閃爍變慢）→ 指出哪個輸出、第幾次變化開始不同；命令依序出現在重播的輸出中', () => {
  const p = solved('hold-blink', 'uno'); const rec = record(p, IN, 2500);
  // 紀錄裡送出的命令：輸出變化的子集合（真機受控寫入時才有）
  for (const e of rec.events.filter(x => x.type === 'sim').slice(1, 5)) S.push(rec, { t: e.t + 1, type: 'command', name: e.name, v: e.v, id: 'c' + e.t });
  rec.events.sort((a, b) => a.t - b.t);
  const again = record(p, IN, 2500).events.filter(e => e.type === 'sim');
  const r = S.compare(rec, again); assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.signals[0].name, 'LED1.state'); assert.ok(r.signals[0].recorded >= 4); assert.strictEqual(r.signals[0].worstMs, 0);
  assert.deepStrictEqual(r.commands, { total: 4, matched: 4 });
  assert.match(S.summary(r), /1 個輸出的變化和紀錄完全相同（LED1\.state \d+ 次；逐毫秒相同（模擬時間））；紀錄中送出的 4 個命令，4 個依序出現/);
  // 模擬時間差 1 ms 就算不同（引擎是確定的）；只有實際時間的紀錄容許 150 ms
  const shifted = again.map(e => Object.assign({}, e, { st: e.st + (e.v ? 1 : 0) }));
  assert.strictEqual(S.compare(rec, shifted).ok, false);
  const wallOnly = { events: rec.events.map(e => Object.assign({}, e, { st: undefined })) };
  assert.ok(S.compare(wallOnly, shifted.map(e => Object.assign({}, e, { st: undefined, t: e.t + 100 }))).ok, '只有實際時間時容許 150 ms');
  // 行為改了：閃爍 300 ms
  const q = JSON.parse(JSON.stringify(p)); q.behavior.ir.rules[0].actions[0].onMs = 300; q.behavior.ir.rules[0].actions[0].offMs = 300;
  const diff = S.compare(rec, record(q, IN, 2500).events.filter(e => e.type === 'sim'));
  assert.strictEqual(diff.ok, false); assert.strictEqual(diff.signals[0].same, false); assert.ok(diff.signals[0].firstDiff >= 1);
  assert.match(S.summary(diff), /有 1 個輸出和紀錄不同：LED1\.state（紀錄 \d+ 次變化、重播 \d+ 次，第 \d+ 次起值或時刻/);
  assert.match(S.summary(S.compare(S.create({}), [])), /沒有模擬的輸出/);
});
