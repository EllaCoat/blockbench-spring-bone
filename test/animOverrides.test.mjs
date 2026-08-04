import test from 'node:test'
import assert from 'node:assert/strict'

const { normalizeOverrides, setOverrideField, clearOverrideField, overridesFingerprint } = await import('../dist-test/animOverrides.mjs')

// --- normalizeOverrides ---

test('normalizeOverrides: 非 object 入力は空 map', () => {
	for (const raw of [null, undefined, 42, 'spring', true, []]) {
		assert.deepEqual(normalizeOverrides(raw), {}, `raw=${JSON.stringify(raw)}`)
	}
})

test('normalizeOverrides: 無効な項目だけを drop し、 有効な項目は残す', () => {
	// 項目単位の検証 : 1 項目の破損で entry ごと消えないことを固定する
	const normalized = normalizeOverrides({
		bone1: { drag: Number.NaN, stiffness: 2, enabled: 'yes', gravity: Number.POSITIVE_INFINITY },
	})
	assert.deepEqual(normalized, { bone1: { stiffness: 2 } })
})

test('normalizeOverrides: entry が object でなければその entry ごと drop', () => {
	const normalized = normalizeOverrides({
		bone1: null,
		bone2: 42,
		bone3: 'spring',
		bone4: [1, 2],
		bone5: { drag: 0.1 },
	})
	assert.deepEqual(normalized, { bone5: { drag: 0.1 } })
})

test('normalizeOverrides: 未知の key は保持する (= 前方互換)', () => {
	// 将来 schema が拡張されたファイルを開いて保存し直しても失われないようにする
	const normalized = normalizeOverrides({
		bone1: { drag: 0.1, futureField: 'x', restLength: 2.5 },
	})
	assert.deepEqual(normalized, { bone1: { drag: 0.1, futureField: 'x', restLength: 2.5 } })
})

test('normalizeOverrides: 既知項目が全滅し未知 key も無い entry は除去する', () => {
	const normalized = normalizeOverrides({
		bone1: { drag: Number.NaN },
		bone2: {},
		bone3: { drag: Number.NaN, future: 1 }, // 未知 key が残るので保持
	})
	assert.deepEqual(normalized, { bone3: { future: 1 } })
})

test('normalizeOverrides: JSON round-trip を通しても同じ正規形', () => {
	// NaN / Infinity は JSON 化で null になるため、 round-trip 前後で正規形が
	// 変わりうる。 一度正規化した map は保存 → 読み込み → 再正規化で安定することを
	// 固定する (= 保存のたびにデータが変化しない)
	const raw = {
		bone1: { drag: 0.1, enabled: false },
		bone2: { drag: Number.NaN, stiffness: 3 },
		bone3: { future: 'x' },
	}
	const once = normalizeOverrides(raw)
	const roundTripped = normalizeOverrides(JSON.parse(JSON.stringify(once)))
	assert.deepEqual(roundTripped, once)
})

test('normalizeOverrides: 入力を変異させない', () => {
	const entry = { drag: Number.NaN, stiffness: 2, future: 'x' }
	const raw = { bone1: entry }
	normalizeOverrides(raw)
	assert.deepEqual(entry, { drag: Number.NaN, stiffness: 2, future: 'x' })
	assert.deepEqual(Object.keys(raw), ['bone1'])
})

// --- setOverrideField / clearOverrideField の immutability ---

test('setOverrideField: 入力 map / entry を変異させず、 新しい参照を返す', () => {
	const entry = { drag: 0.1 }
	const map = { bone1: entry }
	const next = setOverrideField(map, 'bone1', 'stiffness', 2)
	// 入力は不変 (= Blockbench の Undo が差分を捕捉できる)
	assert.deepEqual(map, { bone1: { drag: 0.1 } })
	assert.ok(map.bone1 === entry)
	// 戻り値は新しい map + 新しい entry
	assert.ok(next !== map)
	assert.ok(next.bone1 !== entry)
	assert.deepEqual(next, { bone1: { drag: 0.1, stiffness: 2 } })

	// 対象 uuid が map に無い場合は新規 entry を作る
	const created = setOverrideField(map, 'bone2', 'enabled', true)
	assert.deepEqual(created, { bone1: { drag: 0.1 }, bone2: { enabled: true } })
	assert.deepEqual(map, { bone1: { drag: 0.1 } })
})

test('clearOverrideField: 入力 map / entry を変異させず、 新しい参照を返す', () => {
	const entry = { drag: 0.1, stiffness: 2 }
	const map = { bone1: entry }
	const next = clearOverrideField(map, 'bone1', 'stiffness')
	assert.deepEqual(map, { bone1: { drag: 0.1, stiffness: 2 } })
	assert.ok(map.bone1 === entry)
	assert.ok(next !== map)
	assert.ok(next.bone1 !== entry)
	assert.deepEqual(next, { bone1: { drag: 0.1 } })

	// 対象 uuid が map に無い場合は何もせず、 入力と等価な新しい map を返す
	const noop = clearOverrideField(map, 'unknown', 'drag')
	assert.ok(noop !== map)
	assert.deepEqual(noop, map)
})

// --- clearOverrideField の空 entry 除去と set → clear 往復 ---

test('clearOverrideField: entry が空になったら map から除去する', () => {
	const map = { bone1: { drag: 0.1 } }
	assert.deepEqual(clearOverrideField(map, 'bone1', 'drag'), {})
})

test('set → clear の往復で元の map と等価になる', () => {
	const map = { bone1: { drag: 0.1 } }
	const roundTrip = clearOverrideField(setOverrideField(map, 'bone1', 'gravity', 1), 'bone1', 'gravity')
	assert.deepEqual(roundTrip, map)
	// 新規 uuid への set → clear でも等価 (= entry ごと除去される)
	const roundTripNew = clearOverrideField(setOverrideField(map, 'bone2', 'enabled', true), 'bone2', 'enabled')
	assert.deepEqual(roundTripNew, map)
})

// --- overridesFingerprint ---

test('overridesFingerprint: override の値変更で文字列が変わる', () => {
	const a = overridesFingerprint({ bone1: { drag: 0.1 } }, ['bone1'])
	const b = overridesFingerprint({ bone1: { drag: 0.2 } }, ['bone1'])
	assert.notEqual(a, b)
})

test('overridesFingerprint: map の key 挿入順と uuids の順に依存しない', () => {
	const a = overridesFingerprint({ bone1: { drag: 0.1 }, bone2: { stiffness: 2 } }, ['bone1', 'bone2'])
	const b = overridesFingerprint({ bone2: { stiffness: 2 }, bone1: { drag: 0.1 } }, ['bone1', 'bone2'])
	assert.equal(a, b)
	// uuids 側の順序にも依存しない
	const c = overridesFingerprint({ bone1: { drag: 0.1 }, bone2: { stiffness: 2 } }, ['bone2', 'bone1'])
	assert.equal(a, c)
	// entry 内の key 順にも依存しない
	const d = overridesFingerprint({ bone1: { drag: 0.1, gravity: 1 } }, ['bone1'])
	const e = overridesFingerprint({ bone1: { gravity: 1, drag: 0.1 } }, ['bone1'])
	assert.equal(d, e)
})

test('overridesFingerprint: uuids に無い uuid の override は結果に影響しない', () => {
	const base = overridesFingerprint({ bone1: { drag: 0.1 } }, ['bone1'])
	const withExtra = overridesFingerprint({ bone1: { drag: 0.1 }, boneX: { drag: 9 } }, ['bone1'])
	assert.equal(withExtra, base)
})

test('overridesFingerprint: 数値を丸めない (= 0.0500001 と 0.05 は別の文字列)', () => {
	// 丸めると細かい値変更で replay がトリガされなくなるため、 実数の差は
	// そのまま fingerprint の差になることを固定する
	const a = overridesFingerprint({ bone1: { drag: 0.0500001 } }, ['bone1'])
	const b = overridesFingerprint({ bone1: { drag: 0.05 } }, ['bone1'])
	assert.notEqual(a, b)
})
