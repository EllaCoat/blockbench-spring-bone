// scene への作用: 基底ポーズを当てる、 姿勢を控えて戻す、 spring の差分を載せる。
import { rig, type SpringBone } from './rig'
import { resetState, step } from './sim'

declare const Animator: any
declare const Canvas: any
declare const Timeline: any
declare const Project: any
declare const THREE: any

// preview と同じ呼び出しで、 指定の時刻の keyframe だけの姿勢を当てる。 Timeline.time は元に戻す。
export function applyBasePose(timeSeconds: number, stack: readonly unknown[]): void {
	const time = Timeline.time
	try {
		Timeline.time = timeSeconds
		Animator.showDefaultPose(true)
		Animator.stackAnimations(stack, false)
	} finally {
		Timeline.time = time
	}
}

interface MeshPose {
	mesh: any
	position: number[]
	quaternion: number[]
	scale: number[]
	// stackAnimations が Group の mesh に足す、 transform gizmo 用の回転。 無い mesh では消して戻す
	// (= Blockbench は無いときに fix_rotation を使う)。
	preRotation: number[] | undefined
	preRotationOrder: string | undefined
}
export type PoseSnapshot = MeshPose[]

// stackAnimations が動かすのは Group と Outliner の要素 (= NullObject なども keyframe を持つ) の両方。
export function capturePose(): PoseSnapshot {
	const meshes = new Set<any>()
	for (const node of [...Project.groups, ...Project.elements]) if (node.mesh) meshes.add(node.mesh)
	return [...meshes].map((mesh) => ({
		mesh,
		position: mesh.position.toArray(),
		quaternion: mesh.quaternion.toArray(),
		scale: mesh.scale.toArray(),
		preRotation: mesh.pre_rotation ? [mesh.pre_rotation.x, mesh.pre_rotation.y, mesh.pre_rotation.z] : undefined,
		preRotationOrder: mesh.pre_rotation?.order,
	}))
}

export function restorePose(snapshot: PoseSnapshot): void {
	for (const pose of snapshot) {
		const { mesh } = pose
		mesh.position.fromArray(pose.position)
		mesh.quaternion.fromArray(pose.quaternion)
		mesh.scale.fromArray(pose.scale)
		if (pose.preRotation) {
			mesh.pre_rotation ??= new THREE.Euler()
			mesh.pre_rotation.set(pose.preRotation[0], pose.preRotation[1], pose.preRotation[2], pose.preRotationOrder)
		} else delete mesh.pre_rotation
	}
	Canvas.scene.updateMatrixWorld()
}

const anchor = new THREE.Vector3()
const boneAxis = new THREE.Vector3()
const tipDir = new THREE.Vector3()
const restLocal = new THREE.Vector3()
const simLocal = new THREE.Vector3()
const parentQuat = new THREE.Quaternion()
const parentInverse = new THREE.Quaternion()
const baseQuat = new THREE.Quaternion()
const delta = new THREE.Quaternion()
const identity = new THREE.Quaternion()

// bone の向きの目標は「親の向き × restDir」。 自分の keyframe の回転は目標に入れず、
// 物理が求めた先端の向きへの回転 (= 親のローカル座標) を keyframe の回転の前に掛ける。
// weight で回転の量を絞り、 0 なら keyframe の姿勢のまま残す。
function composeBone(bone: SpringBone, dt: number, advance: boolean, weight: number): void {
	const mesh = bone.group.mesh
	const parent = mesh?.parent
	if (!parent) return
	baseQuat.copy(mesh.quaternion)
	parent.getWorldQuaternion(parentQuat)
	anchor.setFromMatrixPosition(mesh.matrixWorld)
	if (advance) {
		boneAxis.copy(bone.restDir).applyQuaternion(parentQuat)
		step(bone.state, anchor, boneAxis, bone.config, dt)
	}
	if (!bone.state.initialized) return
	if (weight <= 0) {
		// 親の揺れが消えた姿勢を子へ伝える。
		mesh.updateMatrixWorld(true)
		return
	}
	tipDir.subVectors(bone.state.pos, anchor)
	if (tipDir.lengthSq() < 1e-8) return
	tipDir.normalize()
	restLocal.copy(bone.restDir).normalize()
	parentInverse.copy(parentQuat).invert()
	simLocal.copy(tipDir).applyQuaternion(parentInverse).normalize()
	delta.setFromUnitVectors(restLocal, simLocal)
	if (weight < 1) delta.slerp(identity.identity(), 1 - weight)
	mesh.quaternion.copy(baseQuat).premultiply(delta)
	mesh.updateMatrixWorld(true)
}

export function stepAndApply(dt: number, weight: number): void {
	for (const bone of rig.ordered) if (bone.enabled) composeBone(bone, dt, true, weight)
}

const shown = new Map<any, { before: number[]; after: number[] }>()

export function applyOnly(weight: number): void {
	shown.clear()
	for (const bone of rig.ordered) {
		const mesh = bone.group.mesh
		if (!bone.enabled || !bone.state.initialized || !mesh) continue
		const before = mesh.quaternion.toArray()
		composeBone(bone, 0, false, weight)
		shown.set(mesh, { before, after: mesh.quaternion.toArray() })
	}
}

export function takeOffShownSpring(): void {
	for (const [mesh, { before, after }] of shown) {
		if (mesh.quaternion.toArray().every((value: number, i: number) => value === after[i])) mesh.quaternion.fromArray(before)
	}
	shown.clear()
}

// 物理を掛けない bone も含めて先端を静止位置へ置く。 無効の間の慣性が、 有効に戻した瞬間に出ないようにする。
export function resetAllToRest(): void {
	for (const bone of rig.ordered) {
		const mesh = bone.group.mesh
		const parent = mesh?.parent
		if (!parent) continue
		anchor.setFromMatrixPosition(mesh.matrixWorld)
		parent.getWorldQuaternion(parentQuat)
		boneAxis.copy(bone.restDir).applyQuaternion(parentQuat)
		resetState(bone.state, anchor.clone().addScaledVector(boneAxis, bone.config.restLength))
	}
}
