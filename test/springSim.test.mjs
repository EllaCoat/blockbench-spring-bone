import test from 'node:test'
import assert from 'node:assert/strict'

class Vector3 {
	constructor(x = 0, y = 0, z = 0) {
		this.x = x
		this.y = y
		this.z = z
	}

	copy(v) {
		this.x = v.x
		this.y = v.y
		this.z = v.z
		return this
	}

	subVectors(a, b) {
		this.x = a.x - b.x
		this.y = a.y - b.y
		this.z = a.z - b.z
		return this
	}

	multiplyScalar(s) {
		this.x *= s
		this.y *= s
		this.z *= s
		return this
	}

	add(v) {
		this.x += v.x
		this.y += v.y
		this.z += v.z
		return this
	}

	addScaledVector(v, s) {
		this.x += v.x * s
		this.y += v.y * s
		this.z += v.z * s
		return this
	}

	length() {
		return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
	}
}

globalThis.THREE = { Vector3 }

const { createState, resetState, step } = await import('../dist-test/springSim.mjs')

const EPSILON = 1e-4

function vec(x, y, z) {
	return new Vector3(x, y, z)
}

function distance(a, b) {
	return new Vector3().subVectors(a, b).length()
}

function assertVecApprox(actual, expected, epsilon = EPSILON) {
	assert.ok(Math.abs(actual.x - expected.x) <= epsilon, `x: expected ${expected.x}, got ${actual.x}`)
	assert.ok(Math.abs(actual.y - expected.y) <= epsilon, `y: expected ${expected.y}, got ${actual.y}`)
	assert.ok(Math.abs(actual.z - expected.z) <= epsilon, `z: expected ${expected.z}, got ${actual.z}`)
}

test('createState returns uninitialized Vector3 state', () => {
	const state = createState()

	assert.equal(state.initialized, false)
	assert.ok(state.pos instanceof Vector3)
	assert.ok(state.prevPos instanceof Vector3)
	assert.notEqual(state.pos, state.prevPos)
	assertVecApprox(state.pos, vec(0, 0, 0))
	assertVecApprox(state.prevPos, vec(0, 0, 0))
})

test('resetState copies rest tip into pos and prevPos and marks initialized', () => {
	const state = createState()
	const restTip = vec(1, 2, 3)

	resetState(state, restTip)

	assert.equal(state.initialized, true)
	assertVecApprox(state.pos, restTip)
	assertVecApprox(state.prevPos, restTip)

	restTip.x = 9
	assert.equal(state.pos.x, 1)
	assert.equal(state.prevPos.x, 1)
})

test('first step initializes at anchor plus bone axis times rest length without advancing physics', () => {
	const state = createState()
	const anchor = vec(10, 20, 30)
	const boneAxis = vec(0, 1, 0)

	step(state, anchor, boneAxis, { drag: 0, stiffness: 10, restLength: 4 }, 1)

	const restTip = vec(10, 24, 30)
	assert.equal(state.initialized, true)
	assertVecApprox(state.pos, restTip)
	assertVecApprox(state.prevPos, restTip)
})

test('drag 0 with no stiffness preserves inertia direction when the length snap is already satisfied', () => {
	const state = createState()
	resetState(state, vec(1, 0, 0))
	state.prevPos.copy(vec(0, 0, 0))

	step(state, vec(0, 0, 0), vec(1, 0, 0), { drag: 0, stiffness: 0, restLength: 2 }, 1)

	assertVecApprox(state.prevPos, vec(1, 0, 0))
	assertVecApprox(state.pos, vec(2, 0, 0))
})

test('drag 1 with no stiffness kills inertia', () => {
	const state = createState()
	resetState(state, vec(1, 0, 0))
	state.prevPos.copy(vec(0, 0, 0))

	step(state, vec(0, 0, 0), vec(1, 0, 0), { drag: 1, stiffness: 0, restLength: 1 }, 1)

	assertVecApprox(state.prevPos, vec(1, 0, 0))
	assertVecApprox(state.pos, vec(1, 0, 0))
})

test('step output satisfies the length constraint', () => {
	const state = createState()
	resetState(state, vec(3, 4, 0))
	state.prevPos.copy(vec(-2, 0, 0))
	const anchor = vec(1, 1, 0)
	const restLength = 2.5

	step(state, anchor, vec(0, 1, 0), { drag: 0, stiffness: 3, restLength }, 0.5)

	assert.ok(Math.abs(distance(state.pos, anchor) - restLength) <= EPSILON)
})

test('positive stiffness repeatedly pulls position toward the current rest direction', () => {
	const state = createState()
	resetState(state, vec(0, 1, 0))
	const anchor = vec(0, 0, 0)
	const boneAxis = vec(1, 0, 0)
	const restTip = vec(1, 0, 0)
	const config = { drag: 0.2, stiffness: 0.5, restLength: 1 }
	const initialDistance = distance(state.pos, restTip)

	for (let i = 0; i < 12; i += 1) {
		step(state, anchor, boneAxis, config, 1)
	}

	assert.ok(distance(state.pos, restTip) < initialDistance)
	assert.ok(Math.abs(distance(state.pos, anchor) - config.restLength) <= EPSILON)
})
