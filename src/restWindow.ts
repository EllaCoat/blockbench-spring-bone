// animation 両端の rest 整合を担う窓関数。 spring 物理の Δ (= keyframe だけの姿勢からの
// 回転差分) を animation の終端へ向けて 0 まで減衰させるための weight だけを計算する。
// 物理 state は最後まで通常どおり進め、 出力段で Δ に weight を掛ける前提 (= state 側を
// 止めてしまうと減衰の途中で速度が消え、 減衰カーブが物理パラに依存して暴れる)。
//
// なぜ必要か : 終端に慣性が残ったままだと最終 frame の姿勢が基底ポーズ (= 全 animation の
// 両端に共通で置いてあるポーズ) からズレる。 animation 間を即時切替で繋ぐ運用ではこの
// ズレがそのまま遷移の破綻になる。
//
// BB / THREE / AnimatedJava / window には一切依存しない (= node:test から素の Node で読める)。

// export frame (= 20 Hz) と物理 sub-step (= 60 Hz) の比。 springRuntime.ts の
// SUBSTEPS_PER_EXPORT_FRAME と同値だが、 循環 import を避けるためここでも定義する
// (= 値が食い違わないことは test で固定する)。
export const SUBSTEPS_PER_EXPORT_FRAME = 3

// Animation に登録する Property key と既定値 (= fade 長を animation 単位で持つ)。
// index.ts の register / backfill / read と ui.ts の slider 書き込みで共有するため、
// BB 非依存のこの module に置く (= 定義箇所を 1 つに保つ、 animOverrides.ts の
// ANIM_OVERRIDES_KEY と同じ方針)。 **spring_bone_schema_version は上げない** :
// この Property は override map の schema とは独立した additive な optional field で、
// 欠落時は既定値へ倒れるだけなので、 旧 version の plugin で開いても壊れない。
export const ANIM_REST_FADE_KEY = 'spring_bone_rest_fade_frames'
export const DEFAULT_REST_FADE_FRAMES = 4

// AJ hook / BB Animation から取り出した生の周期情報。 いずれも外部由来なので、
// この module 内では「型どおりの値が来る」 前提を置かない (= 非有限 / 負 / 非整数 /
// 想定外の loopMode でも throw せず安全側へ倒す)。
export interface RestWindowTiming {
	// export で焼かれる sample 数 (= frame 数)。 最終 frame index は N - 1。
	renderSampleCount: number
	// BB Animation の loop 種別 ('once' / 'hold' / 'loop')。 それ以外の文字列も来うる。
	loopMode: string
	// loop 時に末尾で挿入される待機 frame 数。 0 以下なら待機なし。
	loopDelayFrames: number
}

// BB Animation の loop 種別。 これ以外の値は「周期を判断できない」 = 契約違反として扱う。
export const KNOWN_LOOP_MODES = ['once', 'hold', 'loop'] as const

// timing が AJ v2 hook の契約を満たしているかの判定。 満たしていれば null、 破っていれば
// 理由の文字列を返す (= 呼び出し側が throw / warn のメッセージに使う)。
//
// **なぜ正規化と別に判定が要るか** : 正規化 (= toFrameCount) は壊れた値を 0 へ倒すため、
// 契約違反の renderSampleCount (= NaN / 負 / 非整数) と、 実在する極小 animation
// (= N が 0 / 1 / 2) がどちらも displayedFinalFrame 0 → weight ≡ 0 に潰れる。 前者は
// 「気付かないまま物理が消えた壊れた出力」 で、 後者は仕様どおりの縮退なので、
// 出力する前にこの境界で分ける。
//
// 未知の loopMode も契約違反に含める : 既定で once 扱いに倒すと、 実際が loop だった場合に
// 終点が 1 frame 遅れて表示される最終 frame に Δ が残る (= 対策そのものが効かない)。
//
// loopDelayFrames は検査しない : AJ 側が `Number(animation.loop_delay) || 0` で必ず有限値に
// しており、 かつこの値は「> 0 か否か」 しか見ないため、 負 / 非整数でも解釈が壊れない。
export function checkRestWindowTiming(timing: RestWindowTiming): string | null {
	const sampleCount = timing.renderSampleCount
	if (!Number.isInteger(sampleCount) || sampleCount < 0) {
		return `renderSampleCount must be a non-negative integer, got ${String(sampleCount)}`
	}
	if (!(KNOWN_LOOP_MODES as readonly string[]).includes(timing.loopMode)) {
		return `unknown loopMode ${JSON.stringify(timing.loopMode)}`
	}
	return null
}

// preview 経路の timing 妥当性判定。 export 用 (= checkRestWindowTiming) との違いは
// **renderSampleCount 0 の扱い** :
// - export の N は AJ が実際に生成した frame 数そのもの (= 権威ある値)。 0 なら本当に
//   frame が無いので、 仕様どおり E = 0 → weight ≡ 0 の縮退に倒す
// - preview の N は deriveRenderSampleCount が animation.length から数えた値で、 length が
//   正当 (= 0 以上の有限値) なら必ず 1 以上になる。 したがって 0 は「length が壊れている」
//   (= NaN / 負 / 数値でない) ことの徴候であり、 契約違反として扱う
// この区別が無いと、 length 破損と実在する極小 animation がどちらも weight ≡ 0 に潰れ、
// preview から物理が黙って消える。
export function checkPreviewRestWindowTiming(timing: RestWindowTiming): string | null {
	const violation = checkRestWindowTiming(timing)
	if (violation !== null) return violation
	if (timing.renderSampleCount < 1) {
		return 'renderSampleCount is 0 (animation.length is not a finite non-negative number)'
	}
	return null
}

// 外部由来の frame 数を「0 以上の整数」 へ正規化する。 非有限値 (= NaN / Infinity) は
// 0 へ倒し、 非整数は floor する (= ceil だと存在しない frame を減衰の終点に据えてしまい、
// 終点に到達しないまま animation が終わる)。
function toFrameCount(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, Math.floor(value))
}

// AJ の render loop が 1 animation で回る回数 (= 生成される frame の数)。 preview 経路は
// AJ を通らないため renderSampleCount を自前で数える必要がある。
//
// **閉じた式 (= Math.floor(length / 0.05) + 1 等) で置き換えないこと** : AJ 側は
//   for (let time = 0; time <= animation.length; time = roundToNth(time + 0.05, 20))
// (= animationRenderer.ts、 roundToNth(n, x) = Math.round(n * x) / x = util/misc.ts) で
// 時刻を進めており、 丸めの入り方まで一致させないと格子際の length で off-by-one が出る。
// ここでは同じ loop をそのまま数え直す。
//
// 非有限 / 負の length は 0 に倒す (= 数える対象が無い)。 length が 0 ちょうどの場合は
// AJ 側と同じく 1 (= time 0 の 1 sample だけ) になる。
const EXPORT_SAMPLE_STEP_SECONDS = 0.05
const EXPORT_SAMPLE_ROUND_NTH = 20
// 進行不能な入力 (= 巨大 length で time + 0.05 が丸めに吸われて増えなくなる) でも
// 必ず停止させるための上限。 100000 sample = 5000 秒 (= 約 83 分) で、 実用上の
// animation 長は遥かに下回る。
const MAX_RENDER_SAMPLE_COUNT = 100000

function roundToNth(n: number, x: number): number {
	return Math.round(n * x) / x
}

export function deriveRenderSampleCount(lengthSeconds: number): number {
	if (!Number.isFinite(lengthSeconds) || lengthSeconds < 0) return 0
	let count = 0
	for (
		let time = 0;
		time <= lengthSeconds;
		time = roundToNth(time + EXPORT_SAMPLE_STEP_SECONDS, EXPORT_SAMPLE_ROUND_NTH)
	) {
		count++
		if (count >= MAX_RENDER_SAMPLE_COUNT) break
	}
	return count
}

// deriveRenderSampleCount の 1 件 memo。 preview は表示 frame ごとに sample 数を要求する
// ため、 毎回 loop を回すと animation の長さに比例して preview のコストが増える。
//
// key = animation の identity + raw length。 **length が変われば自動的に再計算される** ので、
// 呼び出し側が invalidate 条件を別途持つ必要は無い (= keyframe 編集で length が伸び縮み
// しても次の呼び出しで追従する)。 length の比較は Object.is : NaN の length でも
// memo hit させて、 壊れた入力で毎回 loop を回さないようにする。
//
// factory にしているのは module singleton にしないため (= 呼び出し側が生存期間を持ち、
// project 切替時に clear して旧 animation instance の参照を手放せる)。
export interface RenderSampleCountCache {
	get(animation: unknown, lengthSeconds: number): number
	clear(): void
}

export function createRenderSampleCountCache(): RenderSampleCountCache {
	let memo: { animation: unknown; length: number; count: number } | null = null
	return {
		get(animation: unknown, lengthSeconds: number): number {
			if (memo !== null && memo.animation === animation && Object.is(memo.length, lengthSeconds)) {
				return memo.count
			}
			const count = deriveRenderSampleCount(lengthSeconds)
			memo = { animation, length: lengthSeconds, count }
			return count
		},
		clear(): void {
			memo = null
		},
	}
}

// 表示上の最終 frame index を導出する。
//
// MC runtime は 0 delay の loop で `frame >= duration - 2` の時点で先頭へ戻すため、
// 末尾 frame の transform は表示されない。 減衰の終点はこの「表示される最後の frame」
// であり、 末尾 frame ではない (= 末尾 frame を終点にすると、 実際に表示される最終 frame
// にはまだ Δ が残ってしまい、 対策の意味がなくなる)。
//
//   loop かつ loopDelayFrames <= 0 -> max(0, N - 2)
//   loop かつ loopDelayFrames >  0 -> max(0, N - 1)
//   once / hold / その他            -> max(0, N - 1)
//
// loopDelayFrames が非有限の場合は「待機なし」 (= N - 2) 側に倒す : 終点が 1 frame 早い
// 分には減衰が早く終わるだけで rest 整合は崩れないが、 逆に遅いと表示されない frame を
// 終点にしてしまう。
export function deriveDisplayedFinalFrame(timing: RestWindowTiming): number {
	const sampleCount = toFrameCount(timing.renderSampleCount)
	const isLoop = timing.loopMode === 'loop'
	const hasDelay = Number.isFinite(timing.loopDelayFrames) && timing.loopDelayFrames > 0
	const offset = isLoop && !hasDelay ? 2 : 1
	return Math.max(0, sampleCount - offset)
}

// 要求された fade 長 (= frame 単位) を、 その animation で実際に使える長さへ正規化する。
//
// - 非有限値 / 負 / 非整数は toFrameCount で 0 以上の整数へ丸める
// - min(要求値, displayedFinalFrame) で animation 内へ圧縮する。 これにより fade の開始が
//   frame 0 より手前に出ることがなくなり、 frame 0 の weight が必ず 1 になる
//   (= animation 前半の振幅を削らない)
export function resolveFadeFrames(requestedFrames: number, displayedFinalFrame: number): number {
	return Math.min(toFrameCount(requestedFrames), toFrameCount(displayedFinalFrame))
}

// 指定 stepIndex における weight を返す。 戻り値は必ず [0, 1]。
//
//   fadeEndStep   = displayedFinalFrame * SUBSTEPS_PER_EXPORT_FRAME
//   fadeStartStep = fadeEndStep - resolveFadeFrames(fadeFrames, displayedFinalFrame) * SUBSTEPS_PER_EXPORT_FRAME
//
// - stepIndex >= fadeEndStep   -> 0 (終点以後は厳密に 0)
// - stepIndex <= fadeStartStep -> 1 (減衰前)
// - 中間 -> 1 - smoothstep(x)、 smoothstep(x) = 3x^2 - 2x^3、
//           x = (stepIndex - fadeStartStep) / (fadeEndStep - fadeStartStep)
//
// 終点判定を減衰前判定より先に置くのは fadeFrames <= 0 のため : この時 fadeStartStep と
// fadeEndStep が一致するので、 減衰前判定を先に通すと fadeEndStep 上で 1 が返り hard cut に
// ならない。
//
// 0 は「限りなく 0 に近い値」 ではなく exact 0 を返す : 呼び出し側が weight 0 を
// identity 分岐 (= Δ を掛けずに base pose をそのまま使う) の判定に使うため。
export function computeRestWindowWeight(
	stepIndex: number,
	displayedFinalFrame: number,
	fadeFrames: number,
): number {
	const finalFrame = toFrameCount(displayedFinalFrame)
	// 中間 sample を持たない極端に短い animation。 減衰させる余地が無いので物理を
	// 一切見せない (= 正しい縮退動作)。
	if (finalFrame === 0) return 0
	// stepIndex が壊れている場合は Δ を載せない側 (= 0) に倒す。 NaN のまま計算式へ
	// 流すと戻り値が NaN になり、 [0, 1] の契約が壊れる。
	if (!Number.isFinite(stepIndex)) return 0

	const fadeEndStep = finalFrame * SUBSTEPS_PER_EXPORT_FRAME
	// fadeFrames はここでも resolveFadeFrames と同じ規則で animation 内へ圧縮する。
	// 呼び出し側が resolveFadeFrames を通し忘れて過大な値を渡すと fadeStartStep が負に
	// なり、 stepIndex = 0 が減衰区間の内側と判定されて w(0) < 1 になる (= animation
	// 前半の振幅を削り、 開始側の基底ポーズ整合まで静かに崩れる)。
	const fadeStartStep = fadeEndStep - resolveFadeFrames(fadeFrames, finalFrame) * SUBSTEPS_PER_EXPORT_FRAME
	if (stepIndex >= fadeEndStep) return 0
	if (stepIndex <= fadeStartStep) return 1

	const x = (stepIndex - fadeStartStep) / (fadeEndStep - fadeStartStep)
	const smoothstep = x * x * (3 - 2 * x)
	// 数学上は [0, 1] に収まるが、 x が 1 の直前だと丸め誤差で 1 をわずかに超えうる
	// (= 戻り値が負になる)。 契約を守るため最後に clamp する。
	return Math.min(1, Math.max(0, 1 - smoothstep))
}

// weight を「Δ の載せ方」 3 種へ分類する。 呼び出し側 (= index.ts の composeSpringPose) は
// THREE を触る数行だけを持ち、 分岐の判断はこちらに寄せる (= BB 非依存のまま test で固定する)。
//
// - 'full'     = Δ をそのまま載せる (= weight 1、 減衰前)
// - 'blend'    = Δ を identity へ向けて slerp する (= 0 < weight < 1)
// - 'identity' = Δ を **一切載せない** (= weight 0)。 slerp(Δ, identity, 1) は数学上 identity
//   だが浮動小数では厳密に一致せず、 premultiply を通すと純 keyframe pose との差が残る。
//   終端で基底ポーズと厳密一致させるのが本機能の目的なので、 0 では合成そのものを飛ばす
//
// weight が想定外 (= 非有限) の場合は 'identity' に倒す (= Δ を載せない安全側)。
export type RestWindowDeltaMode = 'full' | 'blend' | 'identity'

export function classifyRestWindowWeight(weight: number): RestWindowDeltaMode {
	if (!Number.isFinite(weight) || weight <= 0) return 'identity'
	if (weight >= 1) return 'full'
	return 'blend'
}

// preview の invalidate 判定と export hash に混ぜるための文字列表現。
// **導出値ではなく raw 値**を並べる : 導出関数に bug があった場合に invalidate 判定まで
// 道連れにしないため (= raw が変わったのに fingerprint が変わらない、 という取りこぼしを
// 導出ロジック側の都合で作らない)。
// 数値は JSON.stringify に直接載せず String() で文字列化する : JSON.stringify は
// NaN と Infinity を等しく null にするため、 両者の差を fingerprint が見落とす。
// String() は丸めを伴わないので 0.0500001 と 0.05 も別の文字列になる。
export function restWindowFingerprint(timing: RestWindowTiming, requestedFrames: number): string {
	return JSON.stringify([
		String(timing.renderSampleCount),
		String(timing.loopMode),
		String(timing.loopDelayFrames),
		String(requestedFrames),
	])
}
