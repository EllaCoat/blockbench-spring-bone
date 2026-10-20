import test from 'node:test'
import assert from 'node:assert/strict'

class Vector3 {
	constructor(x = 0, y = 0, z = 0) {
		this.x = x
		this.y = y
		this.z = z
	}
}
class Group {
	constructor(name, origin, extra = {}) {
		this.name = name
		this.uuid = `uuid-${name}`
		this.origin = origin
		this.children = []
		this.parent = 'root'
		Object.assign(this, extra)
	}
	add(...children) {
		for (const child of children) {
			child.parent = this
			this.children.push(child)
		}
		return this
	}
}
globalThis.THREE = { Vector3 }
globalThis.Group = Group

const { rescanRig, clearRig, rig } = await import('../dist-test/rig.mjs')

function project(...groups) {
	globalThis.Project = { groups, saved: true }
	clearRig()
	rescanRig()
	return globalThis.Project
}

test('読み込んだ spring bone の未設定の物理パラメータを既定値で埋め、最初の変更を Undo で戻せるようにする', () => {
	const tail = new Group('tail', [0, 0, 0], { spring_bone_enabled: 'enabled', spring_drag: 0.3 })
	const off = new Group('off', [0, 0, 0], { spring_bone_enabled: 'disabled' })
	const plain = new Group('plain', [0, 0, 0])
	project(tail, off, plain)
	assert.deepEqual([tail.spring_drag, tail.spring_stiffness, tail.spring_gravity], [0.3, 1, 0])
	assert.deepEqual([off.spring_drag, off.spring_stiffness, off.spring_gravity], [0.05, 1, 0])
	assert.equal(plain.spring_drag, undefined)
})

test('名前が spring_ で始まる unset の Group を有効にし、プロジェクトを未保存にする', () => {
	const legacy = new Group('spring_hair', [0, 0, 0])
	const decided = new Group('spring_tail', [0, 0, 0], { spring_bone_enabled: 'disabled' })
	const p = project(legacy, decided)
	assert.equal(legacy.spring_bone_enabled, 'enabled')
	assert.equal(decided.spring_bone_enabled, 'disabled')
	assert.equal(p.saved, false)
	assert.equal(project(new Group('hair', [0, 0, 0])).saved, true)
})

test('間に普通の Group を挟んでも最寄りの spring の祖先を親にし、親から子の順に並べる', () => {
	const c = new Group('c', [0, 0, -12], { spring_bone_enabled: 'disabled' })
	const b = new Group('b', [0, 0, -8], { spring_bone_enabled: 'enabled' }).add(c)
	const plain = new Group('plain', [0, 0, -4]).add(b)
	const a = new Group('a', [0, 0, 0], { spring_bone_enabled: 'enabled' }).add(plain)
	project(c, b, plain, a)
	assert.deepEqual(rig.ordered.map((bone) => bone.uuid), ['uuid-a', 'uuid-b', 'uuid-c'])
	assert.deepEqual(rig.ordered.map((bone) => bone.parentUuid), [null, 'uuid-a', 'uuid-b'])
})

test('向きと長さは最初の子 Group の pivot へ向け、子が無ければ上へ 16', () => {
	const tip = new Group('tip', [0, 3, -4])
	const tail = new Group('tail', [0, 3, 0], { spring_bone_enabled: 'enabled' }).add(tip)
	const lone = new Group('lone', [5, 5, 5], { spring_bone_enabled: 'enabled' })
	project(tail, tip, lone)
	const bone = (uuid) => rig.bones.get(uuid)
	assert.equal(bone('uuid-tail').restLength, 4)
	assert.deepEqual({ ...bone('uuid-tail').restDir }, { x: 0, y: 0, z: -1 })
	assert.equal(bone('uuid-lone').restLength, 16)
	assert.deepEqual({ ...bone('uuid-lone').restDir }, { x: 0, y: 1, z: 0 })
})

test('version は構造が変わったときだけ増え、物理の state は選び直しでは消えない', () => {
	const tip = new Group('tip', [0, 0, -4])
	const tail = new Group('tail', [0, 0, 0], { spring_bone_enabled: 'enabled' }).add(tip)
	project(tail, tip)
	const version = rig.version
	const state = rig.bones.get('uuid-tail').state
	rescanRig()
	assert.equal(rig.version, version)
	assert.equal(rig.bones.get('uuid-tail').state, state)
	tip.origin = [0, 0, -6]
	rescanRig()
	assert.equal(rig.version, version + 1)
	tail.spring_bone_enabled = 'disabled'
	rescanRig()
	assert.equal(rig.version, version + 2)
})
