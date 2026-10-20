import test from 'node:test'
import assert from 'node:assert/strict'

const { toSpringBoneState, stateOf, isCapable, shouldMigrate, paramsOf, resolveEffective, resolveEnabled, DEFAULT_PARAMS, PARAMS } = await import('../dist-test/config.mjs')

const BASE = { drag: 0.3, stiffness: 3, gravity: 2 }

test('resolveEffective: 項目ごとに有効な override → Group の値の順で決まる', () => {
	for (const key of ['drag', 'stiffness', 'gravity']) {
		assert.equal(resolveEffective(BASE, 'enabled', { [key]: 9 })[key], 9)
		assert.equal(resolveEffective(BASE, 'enabled', undefined)[key], BASE[key])
		assert.equal(resolveEffective(BASE, 'enabled', { [key]: Number.NaN })[key], BASE[key])
		assert.equal(resolveEffective(BASE, 'enabled', { [key]: Number.POSITIVE_INFINITY })[key], BASE[key])
	}
	assert.deepEqual(resolveEffective(BASE, 'enabled', { drag: 0.9 }), { enabled: true, drag: 0.9, stiffness: 3, gravity: 2 })
})

test('resolveEnabled: boolean の override を優先し、 無ければ Group の状態が enabled か (9 通り)', () => {
	for (const state of ['unset', 'enabled', 'disabled']) {
		for (const enabled of [true, false, undefined]) {
			const override = enabled === undefined ? undefined : { enabled }
			const expected = enabled ?? state === 'enabled'
			assert.equal(resolveEnabled(state, override), expected, `${state} ${enabled}`)
			assert.equal(resolveEffective(BASE, state, override).enabled, expected, `${state} ${enabled}`)
		}
	}
	assert.equal(resolveEnabled('enabled', { enabled: 1 }), true)
	assert.equal(resolveEnabled('disabled', { enabled: 'yes' }), false)
})

test('resolveEffective: 入力を変えず、 restLength などの余計な項目を返さない', () => {
	const base = { ...BASE }
	const override = { enabled: false, gravity: 1.5, restLength: 9 }
	const resolved = resolveEffective(base, 'enabled', override)
	assert.deepEqual(base, BASE)
	assert.deepEqual(override, { enabled: false, gravity: 1.5, restLength: 9 })
	assert.deepEqual(Object.keys(resolved).sort(), ['drag', 'enabled', 'gravity', 'stiffness'])
})

test('paramsOf: Group の Property を読み、 壊れた値と欠けた値は既定値にする', () => {
	assert.deepEqual(paramsOf({ spring_drag: 0.2, spring_stiffness: 4, spring_gravity: 10 }), { drag: 0.2, stiffness: 4, gravity: 10 })
	assert.deepEqual(paramsOf({ spring_drag: Number.NaN, spring_stiffness: '4' }), DEFAULT_PARAMS)
	assert.deepEqual(paramsOf(null), DEFAULT_PARAMS)
	assert.deepEqual(paramsOf({}), DEFAULT_PARAMS)
})

test('PARAMS: 既定値は DEFAULT_PARAMS と同じで、 範囲に収まる', () => {
	for (const param of PARAMS) {
		assert.equal(param.default, DEFAULT_PARAMS[param.key])
		assert.ok(param.min <= param.default && param.default <= param.max, param.key)
	}
})

test('shouldMigrate: unset かつ spring_ 接頭辞のときだけ true', () => {
	assert.equal(shouldMigrate('unset', 'spring_hair'), true)
	assert.equal(shouldMigrate('unset', 'hair'), false)
	assert.equal(shouldMigrate('enabled', 'spring_hair'), false)
	assert.equal(shouldMigrate('disabled', 'spring_hair'), false)
	assert.equal(shouldMigrate('unset', undefined), false)
	assert.equal(shouldMigrate('unset', 42), false)
})

test('isCapable: enabled / disabled は true、 unset は false', () => {
	assert.equal(isCapable('enabled'), true)
	assert.equal(isCapable('disabled'), true)
	assert.equal(isCapable('unset'), false)
})

test('toSpringBoneState / stateOf: 既知の 3 値はそのまま、 それ以外は unset', () => {
	for (const state of ['unset', 'enabled', 'disabled']) {
		assert.equal(toSpringBoneState(state), state)
		assert.equal(stateOf({ spring_bone_enabled: state }), state)
	}
	for (const raw of ['garbage', null, undefined, 1]) assert.equal(toSpringBoneState(raw), 'unset')
	assert.equal(stateOf(null), 'unset')
	assert.equal(stateOf({}), 'unset')
})
