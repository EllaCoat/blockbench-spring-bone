import test from 'node:test'
import assert from 'node:assert/strict'

const { toSpringBoneState, isCapable, shouldMigrate, resolveEffective } = await import('../dist-test/springConfig.mjs')

const DEFAULTS = { drag: 0.05, stiffness: 1.0, gravity: 0 }

// --- resolveEffective: 数値項目の優先順位 matrix (override → base → defaults) ---

test('resolveEffective: drag の優先順位は override → base → defaults', () => {
	const cases = [
		// [override, base, 期待値]
		[{ drag: 0.9 }, { drag: 0.3 }, 0.9],
		[{ drag: 0.9 }, { drag: Number.NaN }, 0.9],
		[{ drag: 0.9 }, undefined, 0.9],
		[undefined, { drag: 0.3 }, 0.3],
		[undefined, { drag: Number.NaN }, DEFAULTS.drag],
		[undefined, undefined, DEFAULTS.drag],
		// override が無効値 (= 非 finite) なら「書かれていない」として base へ流れる
		[{ drag: Number.NaN }, { drag: 0.3 }, 0.3],
		[{ drag: Number.POSITIVE_INFINITY }, undefined, DEFAULTS.drag],
	]
	for (const [override, base, expected] of cases) {
		const resolved = resolveEffective(base, 'enabled', override, DEFAULTS)
		assert.equal(resolved.drag, expected, `override=${JSON.stringify(override)} base=${JSON.stringify(base)}`)
	}
})

test('resolveEffective: stiffness の優先順位は override → base → defaults', () => {
	const cases = [
		[{ stiffness: 9 }, { stiffness: 3 }, 9],
		[{ stiffness: 9 }, { stiffness: Number.NaN }, 9],
		[{ stiffness: 9 }, undefined, 9],
		[undefined, { stiffness: 3 }, 3],
		[undefined, { stiffness: Number.NaN }, DEFAULTS.stiffness],
		[undefined, undefined, DEFAULTS.stiffness],
		[{ stiffness: Number.NaN }, { stiffness: 3 }, 3],
	]
	for (const [override, base, expected] of cases) {
		const resolved = resolveEffective(base, 'enabled', override, DEFAULTS)
		assert.equal(resolved.stiffness, expected, `override=${JSON.stringify(override)} base=${JSON.stringify(base)}`)
	}
})

test('resolveEffective: gravity の優先順位は override → base → defaults', () => {
	const cases = [
		[{ gravity: 9 }, { gravity: 3 }, 9],
		[{ gravity: 9 }, { gravity: Number.NaN }, 9],
		[{ gravity: 9 }, undefined, 9],
		[undefined, { gravity: 3 }, 3],
		[undefined, { gravity: Number.NaN }, DEFAULTS.gravity],
		[undefined, undefined, DEFAULTS.gravity],
		[{ gravity: Number.NaN }, { gravity: 3 }, 3],
	]
	for (const [override, base, expected] of cases) {
		const resolved = resolveEffective(base, 'enabled', override, DEFAULTS)
		assert.equal(resolved.gravity, expected, `override=${JSON.stringify(override)} base=${JSON.stringify(base)}`)
	}
})

// --- resolveEffective: enabled の解決 ---

test('resolveEffective: enabled は boolean の override を優先、 無ければ groupState から決まる (9 通り)', () => {
	for (const groupState of ['unset', 'enabled', 'disabled']) {
		for (const overrideEnabled of [true, false, undefined]) {
			const override = overrideEnabled === undefined ? undefined : { enabled: overrideEnabled }
			const expected = overrideEnabled ?? (groupState === 'enabled')
			const resolved = resolveEffective(undefined, groupState, override, DEFAULTS)
			assert.equal(resolved.enabled, expected, `groupState=${groupState} override.enabled=${overrideEnabled}`)
		}
	}
	// boolean でない enabled (= 破損データ) は無視して groupState から決める
	assert.equal(resolveEffective(undefined, 'enabled', { enabled: 1 }, DEFAULTS).enabled, true)
	assert.equal(resolveEffective(undefined, 'disabled', { enabled: 'yes' }, DEFAULTS).enabled, false)
})

// --- resolveEffective: restLength の遮断 ---

test('resolveEffective: restLength は base / override に混入していても戻り値に現れない', () => {
	// restLength は rig 幾何由来の値で animation ごとに変える対象ではないため、
	// 解決結果には一切載せない (= 混入データを無視する)
	const base = { drag: 0.3, restLength: 2.5 }
	const override = { drag: 0.9, restLength: 9.9, enabled: true }
	const resolved = resolveEffective(base, 'enabled', override, DEFAULTS)
	assert.ok(!('restLength' in resolved))
	assert.deepEqual(Object.keys(resolved).sort(), ['drag', 'enabled', 'gravity', 'stiffness'])
})

// --- resolveEffective: 入力を変異させない ---

test('resolveEffective: 入力の base / override を変異させず、 毎回新しい object を返す', () => {
	const base = { drag: 0.3, stiffness: 2 }
	const override = { enabled: false, gravity: 1.5 }
	const resolved = resolveEffective(base, 'enabled', override, DEFAULTS)
	assert.deepEqual(base, { drag: 0.3, stiffness: 2 })
	assert.deepEqual(override, { enabled: false, gravity: 1.5 })
	// 同じ入力でも戻り値は別参照 (= 呼び出し側で安全に書き換えられる)
	assert.ok(resolveEffective(base, 'enabled', override, DEFAULTS) !== resolved)
})

// --- shouldMigrate ---

test('shouldMigrate: unset かつ spring_ 接頭辞のときだけ true', () => {
	assert.equal(shouldMigrate('unset', 'spring_hair'), true)
	assert.equal(shouldMigrate('unset', 'hair'), false)
	assert.equal(shouldMigrate('enabled', 'spring_hair'), false)
	assert.equal(shouldMigrate('disabled', 'spring_hair'), false)
	// name が非文字列なら false
	assert.equal(shouldMigrate('unset', undefined), false)
	assert.equal(shouldMigrate('unset', null), false)
	assert.equal(shouldMigrate('unset', 42), false)
})

test('shouldMigrate: 冪等 (= 移行後の状態で再判定しても true にならない)', () => {
	// 旧方式 bone の移行 (= unset → Property に enabled を書く) を模す。
	// 移行後にもう一度判定すると再移行対象にならないことを固定する
	const name = 'spring_hair'
	assert.equal(shouldMigrate(toSpringBoneState(undefined), name), true)
	assert.equal(shouldMigrate('enabled', name), false)
})

// --- isCapable ---

test('isCapable: enabled / disabled は true、 unset は false', () => {
	assert.equal(isCapable('enabled'), true)
	assert.equal(isCapable('disabled'), true)
	assert.equal(isCapable('unset'), false)
})

// --- toSpringBoneState ---

test('toSpringBoneState: 既知 3 値はそのまま、 それ以外は unset', () => {
	assert.equal(toSpringBoneState('unset'), 'unset')
	assert.equal(toSpringBoneState('enabled'), 'enabled')
	assert.equal(toSpringBoneState('disabled'), 'disabled')
	assert.equal(toSpringBoneState('garbage'), 'unset')
	assert.equal(toSpringBoneState(null), 'unset')
	assert.equal(toSpringBoneState(undefined), 'unset')
	assert.equal(toSpringBoneState(1), 'unset')
	assert.equal(toSpringBoneState(true), 'unset')
})
