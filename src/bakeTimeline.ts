// spring 物理を timeline の bezier keyframe へ焼き付ける bake driver の純粋部分。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 scene への作用 (= 物理 session の開始 / frame 評価 /
// bone rotation の読み取り) はすべて呼び出し側 (= index.ts) が注入する BakeSceneOps 経由で行う。
//
// bake の流れ :
//   1. 物理 session を張る (= scene.beginSession)
//   2. 20fps 格子の frame ごとに評価し、 bone ごとの合成後 rotation を **keyframe 値**
//      (= rest 差分の degrees) で収集する (= scene.evaluateFrame → scene.readRotationDeg)
//   3. continuifyEulerSeries で Euler 表現の飛びを潰す (= 偽の急変で keyframe が増えるのを防ぐ)
//   4. fitSharedKnots で 3 軸共有 knot の bezier に落とす
//   5. BB の keyframe data 配列を組み立てる
//
// **元 animation は一切変更しない** : 出来上がった keyframe は派生 animation
// (= applyBakedCurvesToAnimationData で作る data) 側にだけ載る。 unbake = 派生 animation の削除。

import { EXPORT_FRAMES_PER_SECOND } from './springRuntime'
import { continuifyEulerSeries } from './eulerContinuity'
import { fitSharedKnots, type AxisTriple, type QuaternionOps } from './curveFit'

// --- 派生 animation に載せる Animation Property の key ---
// stale 検出 (= 元 animation や物理パラが変わった後の再 bake 促し) の UI は今回のスコープ外で、
// 記録だけ行う。 値は「bake した瞬間の入力」 を表す。
export const ANIM_BAKED_FROM_KEY = 'spring_bone_baked_from'
export const ANIM_BAKED_PARAM_HASH_KEY = 'spring_bone_baked_param_hash'
export const ANIM_BAKED_SOURCE_HASH_KEY = 'spring_bone_baked_source_hash'
export const ANIM_BAKED_VERSION_KEY = 'spring_bone_baked_version'

// bake の出力形式 version。 keyframe の作り方 (= handle の意味 / 収集する量) を変えたら上げる。
export const BAKE_VERSION = 1

// bake が作った派生 animation かどうかの **唯一の判定**。 メタデータを書くのがこの module
// なので、 読む側もここに置く (= key の解釈が 2 箇所に分裂しないようにする)。
// 派生 animation の rotation keyframe には「base pose + 物理 Δ」 が既に焼き込まれているため、
// これを再生する間は物理を止めないと Δ が二重に載る。
export function isBakedAnimation(animation: unknown): boolean {
	const from = (animation as Record<string, unknown> | null)?.[ANIM_BAKED_FROM_KEY]
	return typeof from === 'string' && from.length > 0
}

// 物理の抑制判定に使う context の最小形 (= PreviewAnimationContext が構造的に満たす)。
export interface BakedAnimationContextLike {
	animation: unknown
	animationStack?: readonly unknown[]
}

// この context で物理を止めるべきか。 **判定は必ずこの関数を通す** :
// preview (= tick 入口) と export / bake (= effective の解決) の両方が同じ判定を共有しないと、
// 片方の経路だけ抜けて Δ が二重に載る。
//
// **animation だけでなく animationStack も見る** : animation 未選択のまま複数 animation を
// 再生している場合 (= makePreviewAnimationContext の playing filter 経路) は context.animation が
// null のままで、 baked animation は stack 側にしか現れない。 animation だけを見ていると
// この経路で抑制が丸ごと外れる。
export function isBakedAnimationContext(context: BakedAnimationContextLike): boolean {
	if (isBakedAnimation(context.animation)) return true
	const stack = context.animationStack
	if (!Array.isArray(stack)) return false
	for (const entry of stack) {
		if (isBakedAnimation(entry)) return true
	}
	return false
}

// フィッティングの既定閾値 (= 合成姿勢の角度差、 degrees)。 spike の実測で
// 「0.5° なら実写と区別が付かず、 keyframe 数も許容範囲」 と確認した値。
export const DEFAULT_BAKE_MAX_ANGLE_DEG = 0.5

// 「手編集に向かない」 と警告する密度 (= bone 1 本あたりの keyframe / 秒)。
// **bake を拒否する閾値ではない** (= 警告だけ出して結果は必ず作る)。
export const BAKE_DENSITY_WARN_KF_PER_SECOND = 8

// --- 注入口 ---

export interface BakeTarget {
	// bone (= Group) の uuid。 keyframe の書き込み先 animator の key になる
	uuid: string
	// animator を新規に作る場合の名前 (= BB の animator は名前も持つ)
	name: string
	// bone の rest 回転 (= BB の fix_rotation) を degrees にしたもの。
	// **BB の keyframe 適用は componentwise な Euler の加算** (= showDefaultPose が
	// mesh.rotation へ fix_rotation を入れ、 displayRotation がそこへ keyframe 値を足す)
	// なので、 keyframe 値 = 合成後の絶対 Euler − rest になる。
	restRotationDeg: AxisTriple
}

// scene 側 (= BB / THREE 依存) の作用をまとめた注入口。
export interface BakeSceneOps {
	// 物理 session を張る (= runtime.beginAnimation 相当)。 物理パラの解決もここで済む
	beginSession(): void
	// **beginSession の後に呼ぶ** : 解決済みの有効判定を反映した bake 対象を返す
	listTargets(): readonly BakeTarget[]
	// 指定 frame の base pose を当ててから物理を評価する (= 20fps 格子の frameIndex)
	evaluateFrame(frameIndex: number): void
	// 評価後の bone rotation を **絶対 Euler** (= degrees) で読む。 読めない場合は null。
	// **rest 差分ではなく絶対値を要求する** : 連続化 (= 双対解の関係式) も誤差評価
	// (= geodesic) も絶対 Euler の空間でしか成立しない。 rest の減算は keyframe を
	// 組み立てる最終段でだけ行う (= bezier は値方向の平行移動に対して不変なので、
	// knot 値から rest を引いても handle は変わらず、 曲線全体がそのまま平行移動する)
	readRotationDeg(uuid: string): AxisTriple | null
	// session の破棄 (= runtime.endAnimation 相当)。 失敗しても bake 結果は返す
	endSession(): void
}

export interface BakeOptions<Q> extends QuaternionOps<Q> {
	// 評価する frame 数 (= 20fps 格子の sample 数、 export の renderSampleCount と同じ)
	frameCount: number
	// フィッティングの角度閾値 (= 省略時 DEFAULT_BAKE_MAX_ANGLE_DEG)
	maxAngleDeg?: number
	// knot 同士の最小 frame 間隔 (= 省略時 1)
	minGapFrames?: number
}

// --- 出力 (= BB の keyframe data そのまま) ---

// Keyframe.properties (= blockbench/js/animations/keyframe.js:597-605) に合わせた形。
// - interpolation の既定は 'linear' なので **必ず明示する**
// - bezier_linked の既定は true。 Hermite は前後の区間で gap が違うと handle 長が非対称に
//   なるため **false を明示する** (= true のままだと UI 操作で左右が鏡像に揃えられて壊れる)
// - handle 4 値は **3 軸すべて数値で書く** : getBezierLerp は `(val + handle) || 0` と
//   評価される (= 演算子優先順位) ため、 欠けた軸は control point が 0 に落ちて派手に壊れる
export interface BakedKeyframeData {
	channel: 'rotation'
	time: number
	interpolation: 'bezier'
	bezier_linked: false
	bezier_left_time: [number, number, number]
	bezier_left_value: [number, number, number]
	bezier_right_time: [number, number, number]
	bezier_right_value: [number, number, number]
	data_points: [{ x: number, y: number, z: number }]
}

export interface BakedBoneCurve {
	uuid: string
	name: string
	keyframes: BakedKeyframeData[]
	// 実測の姿勢誤差 (= degrees)
	maxAngleDeg: number
	avgAngleDeg: number
	// この bone の keyframe 密度 (= keyframe / 秒)
	keyframesPerSecond: number
	// 採用した傾きの求め方 (= true なら一括最小二乗、 false なら中央差分)。
	// 2 通り試して keyframe が少ない方を採るので、 bone ごとに変わり得る
	usedLeastSquares: boolean
	// フィッティングが閾値 (= maxAngleDeg) に届いたか。 false の bone は要求精度を
	// 満たしていない (= 分割の打ち切り / 分割不能)。 呼び出し側で警告すること
	converged: boolean
}

export interface BakeResult {
	frameCount: number
	durationSeconds: number
	bones: BakedBoneCurve[]
	totalKeyframes: number
	// bone 1 本あたりの密度の最大値 (= 警告判定に使う量)
	maxKeyframesPerSecond: number
	// 全 bone を通した姿勢誤差の最大値 (= degrees)
	maxAngleDeg: number
	// 閾値に届かなかった bone の名前 (= 空なら全 bone が要求精度を満たしている)。
	// 密度警告とは別軸の警告材料として呼び出し側が使う
	unconvergedBones: string[]
}

// 収集中の Euler 系列 (= degrees)
interface MutableSeries {
	x: number[]
	y: number[]
	z: number[]
}

function toTriple(values: AxisTriple): [number, number, number] {
	return [values.x, values.y, values.z]
}

// 読めなかった / 非有限だった sample は直前の値で埋める (= 系列に穴や NaN を作らない)。
// **先頭 sample の fallback は rest (= 絶対 Euler での rest 姿勢)**。 系列は絶対 Euler なので、
// ここで 0 を入れると fix_rotation が非ゼロの bone で「絶対角 0°」 = rest とは別の姿勢になり、
// keyframe 値が `0 − rest` になってしまう。
function pushSample(series: MutableSeries, value: AxisTriple | null, rest: AxisTriple): void {
	const last = series.x.length - 1
	const fallback = (axis: 'x' | 'y' | 'z'): number => (last >= 0 ? series[axis][last] : rest[axis])
	const pick = (raw: number | undefined, axis: 'x' | 'y' | 'z'): number =>
		typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback(axis)
	series.x.push(pick(value?.x, 'x'))
	series.y.push(pick(value?.y, 'y'))
	series.z.push(pick(value?.z, 'z'))
}

// 物理を replay して bone ごとの bezier keyframe 列を作る。
// **scene の後始末は必ず通す** : 途中で throw しても finally で endSession を呼ぶ。
export function bakeSpringRotations<Q>(scene: BakeSceneOps, options: BakeOptions<Q>): BakeResult {
	const { frameCount, maxAngleDeg = DEFAULT_BAKE_MAX_ANGLE_DEG, minGapFrames = 1 } = options
	if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
		throw new RangeError(`bakeSpringRotations: frameCount must be a positive safe integer, got ${frameCount}`)
	}
	const fps = EXPORT_FRAMES_PER_SECOND
	const durationSeconds = (frameCount - 1) / fps

	const times = new Array<number>(frameCount)
	for (let frame = 0; frame < frameCount; frame++) times[frame] = frame / fps

	// --- 1. 収集 ---
	let targets: readonly BakeTarget[] = []
	const collected = new Map<string, MutableSeries>()
	scene.beginSession()
	try {
		targets = scene.listTargets()
		for (const target of targets) {
			collected.set(target.uuid, { x: [], y: [], z: [] })
		}
		if (targets.length > 0) {
			for (let frame = 0; frame < frameCount; frame++) {
				scene.evaluateFrame(frame)
				for (const target of targets) {
					pushSample(collected.get(target.uuid)!, scene.readRotationDeg(target.uuid), target.restRotationDeg)
				}
			}
		}
	} finally {
		scene.endSession()
	}

	// --- 2. 連続化 + フィッティング ---
	const bones: BakedBoneCurve[] = []
	const unconvergedBones: string[] = []
	let totalKeyframes = 0
	let maxKeyframesPerSecond = 0
	let worstAngle = 0
	for (const target of targets) {
		const raw = collected.get(target.uuid)!
		// quaternion → Euler の正準形が gimbal 付近で飛ぶと、 姿勢としては連続でも
		// 曲線が急変して分割が誘発される。 フィッティングの **前** に潰しておく。
		const continuous = continuifyEulerSeries(raw)
		// **傾きの求め方は 2 通り試して keyframe が少ない方を採る** : 一括最小二乗 (= useLS)
		// が効く条件 (= spike の walk で 168 → 102) と、 中央差分の方が少なくなる条件の
		// 両方があり、 事前にどちらが勝つかは決められない。 bake は 1 回きりの処理なので
		// 2 回 fit するコストは許容する (= preview のように毎 frame 走る経路ではない)。
		// 同数なら誤差の小さい方 (= 見た目に近い方) を採る。
		const leastSquares = fitSharedKnots(times, continuous, maxAngleDeg, {
			fps,
			minGapFrames,
			useLS: true,
			quaternionFromEuler: options.quaternionFromEuler,
			quatAngleDeg: options.quatAngleDeg,
		})
		const centralDiff = fitSharedKnots(times, continuous, maxAngleDeg, {
			fps,
			minGapFrames,
			useLS: false,
			quaternionFromEuler: options.quaternionFromEuler,
			quatAngleDeg: options.quatAngleDeg,
		})
		// 片方だけが閾値に届いた場合は **届いた方を優先** する (= keyframe 数の比較は
		// 「どちらも要求精度を満たしている」 が前提。 未収束の方が少ないのは当然なので、
		// そこで数だけ見ると精度を捨てて数を取ることになる)。
		const preferCentral = leastSquares.converged !== centralDiff.converged
			? centralDiff.converged
			: centralDiff.keyframeCount < leastSquares.keyframeCount ||
				(centralDiff.keyframeCount === leastSquares.keyframeCount && centralDiff.maxAngle < leastSquares.maxAngle)
		const fit = preferCentral ? centralDiff : leastSquares
		// keyframe 値 = 絶対 Euler − rest。 handle は値の差分なので rest の影響を受けない
		// (= 曲線全体が値方向に平行移動するだけ)。
		const rest = target.restRotationDeg
		const keyframes = fit.keyframes.map((kf): BakedKeyframeData => ({
			channel: 'rotation',
			time: kf.time,
			interpolation: 'bezier',
			bezier_linked: false,
			bezier_left_time: toTriple(kf.bezierLeftTime),
			bezier_left_value: toTriple(kf.bezierLeftValue),
			bezier_right_time: toTriple(kf.bezierRightTime),
			bezier_right_value: toTriple(kf.bezierRightValue),
			data_points: [{
				x: kf.value.x - rest.x,
				y: kf.value.y - rest.y,
				z: kf.value.z - rest.z,
			}],
		}))
		const perSecond = durationSeconds > 0 ? keyframes.length / durationSeconds : 0
		totalKeyframes += keyframes.length
		if (perSecond > maxKeyframesPerSecond) maxKeyframesPerSecond = perSecond
		if (fit.maxAngle > worstAngle) worstAngle = fit.maxAngle
		if (!fit.converged) unconvergedBones.push(target.name)
		bones.push({
			uuid: target.uuid,
			name: target.name,
			keyframes,
			maxAngleDeg: fit.maxAngle,
			avgAngleDeg: fit.avgAngle,
			keyframesPerSecond: perSecond,
			usedLeastSquares: !preferCentral,
			converged: fit.converged,
		})
	}

	return {
		frameCount,
		durationSeconds,
		bones,
		totalKeyframes,
		maxKeyframesPerSecond,
		maxAngleDeg: worstAngle,
		unconvergedBones,
	}
}

// --- 派生 animation data の組み立て ---

// BB の Animation.getUndoCopy(options, true) が返す形のうち、 この module が触る部分だけ。
// 触らない key (= name / loop / length / markers / plugin の Property 等) はそのまま素通しする。
export interface AnimationDataLike {
	animators?: Record<string, AnimatorDataLike>
	[key: string]: unknown
}

export interface AnimatorDataLike {
	name?: string
	type?: string
	keyframes?: Array<Record<string, unknown>>
	[key: string]: unknown
}

// 元 animation の data (= getUndoCopy の戻り値) に bake 結果を載せた **新しい data** を返す。
// 入力は変異させない。
//
// - bake 対象 bone の **rotation channel だけ** を差し替える (= position / scale の keyframe は
//   元のまま残す)。 bake した rotation は「base pose + 物理 Δ」 を既に含むため、 元の rotation
//   keyframe を残すと二重に載る
// - 対象 bone の animator が元 animation に無い場合 (= keyframe を持たない純物理 bone) は
//   新規に作る (= type 'bone'、 Animation.extend の bone 分岐に乗る形)
// - **keyframe の uuid は落とす** : 元 animation の keyframe と uuid が重複した状態で
//   両方が project 内に生きると、 選択 / Undo が別 animation の keyframe を掴み得る。
//   uuid を渡さなければ BB 側 (= Keyframe constructor) が新しい guid を振る
export function applyBakedCurvesToAnimationData(
	sourceData: AnimationDataLike,
	curves: readonly BakedBoneCurve[],
): AnimationDataLike {
	const data = structuredClone(sourceData) as AnimationDataLike
	const animators: Record<string, AnimatorDataLike> = data.animators ?? {}
	data.animators = animators

	for (const key of Object.keys(animators)) {
		const animator = animators[key]
		if (!animator || !Array.isArray(animator.keyframes)) continue
		for (const kf of animator.keyframes) {
			delete kf.uuid
		}
	}

	for (const curve of curves) {
		const existing = animators[curve.uuid]
		const animator: AnimatorDataLike = existing ?? { name: curve.name, type: 'bone' }
		const kept = Array.isArray(animator.keyframes)
			? animator.keyframes.filter((kf) => kf.channel !== 'rotation')
			: []
		animator.keyframes = [...kept, ...curve.keyframes.map((kf) => ({ ...kf }))]
		// bake した曲線は **bone local の Euler を BB の bezier 評価器で再生する** 前提で
		// 作ってあるため、 再生の解釈を変える animator flag は明示的に落とす
		// (= どちらも BoneAnimator の Property なので、 元 animation で ON なら複製に載る) :
		// - rotation_global = ON だと displayRotation が親の world 回転の逆を前乗算する
		//   (= timeline_animators.js:392-397) ので、 local 前提の値では姿勢がずれる
		// - quaternion_interpolation = ON だと interpolate が slerp 経路へ入り
		//   (= 同 :510-531)、 handle が無視されてフィッティングの意味が消える
		animator.rotation_global = false
		animator.quaternion_interpolation = false
		animators[curve.uuid] = animator
	}

	return data
}

// --- 決定的な fingerprint ---

// bake 時の入力を記録するための短い hash。 JSON.stringify した値の FNV-1a 32bit を
// 8 桁の hex にする。 **暗号用途ではない** : 「入力が変わったか」 の検出だけに使う。
// JSON.stringify の key 順は insertion 順なので、 呼び出し側が uuid 昇順など
// 決定的な順序で配列を作って渡すこと (= object の key 順に依存させない)。
export function hashFingerprint(value: unknown): string {
	const text = JSON.stringify(value) ?? 'undefined'
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		// FNV prime 16777619 の乗算を 32bit で回す (= Math.imul で桁溢れを切る)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}
