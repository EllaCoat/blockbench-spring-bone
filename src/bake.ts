// spring の揺れを keyframe に焼き込んだ派生 animation (`<名前>_baked`) を作る。 元の animation は変えない。
import { applyBakedCurvesToAnimationData, BAKE_DENSITY_WARN_KF_PER_SECOND, BAKED_FROM_PROPERTY, bakeSpringRotations, isBakedAnimation, type BakeResult } from './bakeTimeline'
import type { AxisTriple, QuaternionOps } from './curveFit'
import { beginAnimation, evaluateAnimationTick, invalidate } from './engine'
import { capturePose, restorePose } from './pose'
import { refreshPreview } from './preview'
import { tickCount } from './restWindow'
import { rescanRig, rig } from './rig'

declare const Animation: any
declare const Blockbench: any
declare const Format: any
declare const Modes: any
declare const Property: any
declare const THREE: any
declare const Undo: any
declare function updateSelection(): void

const RAD2DEG = 180 / Math.PI
const TITLE = 'Spring bake'

function message(text: string): void {
	Blockbench.showMessageBox({ title: TITLE, message: text, icon: 'gesture', buttons: ['dialog.ok'] })
}

// blend_weight は Molang の文字列。 空か定数 1 なら掛からない。 焼いた回転には既に掛かっているので、
// 複製した data に残ると再生で二重に掛かる。
function isDefaultBlendWeight(raw: unknown): boolean {
	if (!raw) return true
	const text = String(raw).trim()
	return text.length === 0 || /^\+?1(\.0*)?$/.test(text)
}

// transform の channel の mute は姿勢の評価に効くが、 getUndoCopy には写らない。 派生側で mute が外れて
// 親の回転が戻ると、 子の spring bone の姿勢が焼いたときと変わる。
function mutedTransformAnimator(animation: any): string | null {
	for (const [key, animator] of Object.entries<any>(animation.animators ?? {})) {
		if (['rotation', 'position', 'scale'].some((channel) => animator?.muted?.[channel])) return animator.name || key
	}
	return null
}

// stackAnimations は effects (= particle、 sound、 script、 rigel-anim の variant) も毎回評価する。
// bake は全 tick の sub-step を一度に回すので、 その間だけ全 channel を mute する。
function muteEffects(animation: any): () => void {
	const effects = animation.animators?.effects
	if (!effects?.muted) return () => {}
	const muted = { ...effects.muted }
	const lastDisplayedTime = effects.last_displayed_time
	for (const channel of Object.keys(effects.muted)) effects.muted[channel] = true
	return () => {
		Object.assign(effects.muted, muted)
		effects.last_displayed_time = lastDisplayedTime
	}
}

// mesh.rotation の Euler の順は Format.euler_order。 誤差を測るときに同じ順で quaternion へ戻す。
function quaternionOps(): QuaternionOps<any> {
	const order = typeof Format.euler_order === 'string' && /^[XYZ]{3}$/.test(Format.euler_order) ? Format.euler_order : 'ZYX'
	const euler = new THREE.Euler(0, 0, 0, order)
	return {
		// fitSharedKnots が全 frame の値を持つので、 毎回新しい instance を返す。
		quaternionFromEuler: (x, y, z) => new THREE.Quaternion().setFromEuler(euler.set(x, y, z, order)),
		quatAngleDeg: (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))) * RAD2DEG,
	}
}

// Blockbench は keyframe の回転を rest の回転 (fix_rotation) に Euler の成分ごとに足す。
const degrees = (euler: any): AxisTriple => ({ x: (euler?.x ?? 0) * RAD2DEG, y: (euler?.y ?? 0) * RAD2DEG, z: (euler?.z ?? 0) * RAD2DEG })

function bakeRotations(animation: any): BakeResult {
	return bakeSpringRotations(
		{
			beginSession: () => beginAnimation(animation),
			listTargets: () =>
				rig.ordered
					.filter((bone) => bone.enabled && bone.group.mesh)
					.map((bone) => ({ uuid: bone.uuid, name: bone.group.name, restRotationDeg: degrees(bone.group.mesh.fix_rotation) })),
			evaluateFrame: (frame) => evaluateAnimationTick(animation, frame, false),
			readRotationDeg: (uuid) => {
				const rotation = rig.bones.get(uuid)?.group.mesh?.rotation
				return rotation ? degrees(rotation) : null
			},
			endSession: invalidate,
		},
		{ frameCount: tickCount(animation.length) + 1, ...quaternionOps() },
	)
}

function refusal(animation: any): string | null {
	if (!Modes.animate) return 'animate モードで実行してください'
	if (isBakedAnimation(animation)) return 'この animation は既に bake 済みの派生 animation です'
	if (!isDefaultBlendWeight(animation.blend_weight)) {
		return `blend_weight が既定ではありません ("${String(animation.blend_weight)}")。\nbake した rotation に blend_weight が二重に掛かるため、 この animation は bake できません。`
	}
	const muted = mutedTransformAnimator(animation)
	if (muted !== null) return `animator "${muted}" の transform channel が mute されています。\nmute は派生 animation に引き継げないため、 解除してから bake してください。`
	if (!(animation.length > 0)) return `animation の長さ (${String(animation.length)}) から frame 数を決められません`
	return null
}

function addBakedAnimation(animation: any, result: BakeResult): any {
	const data = applyBakedCurvesToAnimationData(animation.getUndoCopy({}), result.bones)
	delete data.uuid
	data.name = `${animation.name || 'animation'}_baked`
	Undo.initEdit({ animations: [] })
	let baked: any
	try {
		baked = new Animation(data)
		baked[BAKED_FROM_PROPERTY] = animation.uuid || 'unknown'
		// Blockbench の複製と同じ後始末。 path は resetUniqueValues の対象外なので自分で消す
		// (= 残ると元の animation と同じファイルとして保存・削除される)。
		Property.resetUniqueValues(Animation, baked)
		baked.path = ''
		baked.saved = false
		baked.add(false)
		Undo.finishEdit(TITLE, { animations: [baked] })
		return baked
	} catch (error) {
		// aspects が空なので cancelEdit では追加した animation が消えない。 先に自分で外す。
		baked?.remove(false, false)
		Undo.cancelEdit()
		throw error
	}
}

export function runSpringBake(animation: any): void {
	const refused = refusal(animation)
	if (refused !== null) return message(refused)
	rescanRig()

	let result: BakeResult
	const restoreEffects = muteEffects(animation)
	const snapshot = capturePose()
	try {
		result = bakeRotations(animation)
	} catch (error) {
		console.warn('[spring_bone] bake failed', error)
		return message(`bake に失敗しました : ${String(error)}`)
	} finally {
		// mute を先に戻す。 この後の preview が今の時刻の particle を張り直す。
		restoreEffects()
		restorePose(snapshot)
		refreshPreview()
	}
	if (result.bones.length === 0) return message('この animation で有効な spring bone がありません')

	let baked: any
	try {
		baked = addBakedAnimation(animation, result)
	} catch (error) {
		console.warn('[spring_bone] failed to add the baked animation', error)
		return message(`派生 animation を作成できませんでした : ${String(error)}`)
	}

	const summary =
		`"${baked.name}" を作成しました\n` +
		`bone ${result.bones.length} 本 / keyframe ${result.totalKeyframes} 個 (最大 ${result.maxKeyframesPerSecond.toFixed(1)} kf/秒)\n` +
		`姿勢誤差 最大 ${result.maxAngleDeg.toFixed(3)}°`
	console.log(`[spring_bone] bake done : ${summary.replace(/\n/g, ' / ')}`)
	const warnings: string[] = []
	if (result.maxKeyframesPerSecond > BAKE_DENSITY_WARN_KF_PER_SECOND) {
		warnings.push(`keyframe 密度が ${BAKE_DENSITY_WARN_KF_PER_SECOND} kf/秒 を超えています。手編集には向かない密度です (= 揺れが速いほど keyframe が増えます)。`)
	}
	if (result.unconvergedBones.length > 0) {
		warnings.push(`次の bone は目標の姿勢誤差に届きませんでした : ${result.unconvergedBones.join(', ')}\n物理の動きが速すぎて 20fps の keyframe では表現しきれていない可能性があります。`)
	}
	if (warnings.length > 0) message(`${summary}\n\n${warnings.join('\n\n')}`)
	updateSelection()
}
