import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const THREE = createRequire(import.meta.url)('three')

class Group {
	constructor(name, origin, parent, extra = {}) {
		this.name = name
		this.uuid = `uuid-${name}`
		this.origin = origin
		this.children = []
		this.parent = parent ?? 'root'
		this.mesh = new THREE.Object3D()
		const at = parent ? origin.map((v, i) => v - parent.origin[i]) : origin
		this.mesh.position.set(...at)
		;(parent ? parent.mesh : scene).add(this.mesh)
		parent?.children.push(this)
		Object.assign(this, extra)
	}
}
const scene = new THREE.Scene()
globalThis.THREE = THREE
globalThis.Group = Group
const body = new Group('body', [0, 8, 0])
const tail = new Group('tail', [0, 8, -4], body, { spring_bone_enabled: 'enabled' })
new Group('tip', [0, 8, -8], tail)
const swing = { uuid: 'swing', name: 'swing', length: 2, loop: 'loop', playing: true, spring_bone_overrides: {}, spring_bone_rest_fade_frames: 4 }
const timeline = { time: 0 }
Object.assign(globalThis, {
	Project: { groups: Group.all = [body, tail, ...tail.children], elements: [], saved: true },
	Canvas: { scene },
	Timeline: timeline,
	Animation: { all: [swing], selected: swing },
	AnimationController: { selected: undefined },
	Animator: {
		showDefaultPose() {
			for (const group of globalThis.Project.groups) group.mesh.quaternion.identity()
			scene.updateMatrixWorld()
		},
		stackAnimations(stack) {
			if (stack.includes(swing)) body.mesh.rotation.y = Math.sin(timeline.time * Math.PI) * 1.2
			scene.updateMatrixWorld()
		},
	},
})

const { evaluatePreview } = await import('../dist-test/engine.mjs')

function pose(time) {
	timeline.time = time
	globalThis.Animator.showDefaultPose(true)
	globalThis.Animator.stackAnimations([swing], false)
}
const tailTurn = () => tail.mesh.quaternion.toArray()
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))

test('姿勢を当てた後の評価で、その時刻の揺れを尻尾に載せる', () => {
	pose(0.6)
	const keyframed = tailTurn()
	evaluatePreview()
	assert.ok(angle(tailTurn(), keyframed) > 0.01, `the spring turned the tail by ${angle(tailTurn(), keyframed)} rad`)
})

test('ほかのプラグインが preview を入れ子で呼び、揺れの載った姿勢のまま次の評価が来ても、揺れを一度だけ載せる', () => {
	pose(0.6)
	evaluatePreview()
	const once = tailTurn()
	evaluatePreview()
	assert.ok(angle(tailTurn(), once) < 1e-6, `off by ${angle(tailTurn(), once)} rad`)
})

test('オニオンスキンが前後の時刻を当てた後に揺れの載った姿勢へ戻しても、揺れを一度だけ載せる', () => {
	pose(0.6)
	evaluatePreview()
	const once = tailTurn()
	const kept = tail.mesh.quaternion.clone()
	pose(0.55)
	pose(0.6)
	tail.mesh.quaternion.copy(kept)
	scene.updateMatrixWorld()
	evaluatePreview()
	assert.ok(angle(tailTurn(), once) < 1e-6, `off by ${angle(tailTurn(), once)} rad`)
})

test('当て直した姿勢には、同じ時刻なら同じ揺れを載せる', () => {
	pose(0.7)
	evaluatePreview()
	const first = tailTurn()
	pose(0.7)
	evaluatePreview()
	assert.ok(angle(tailTurn(), first) < 1e-6, `off by ${angle(tailTurn(), first)} rad`)
})
