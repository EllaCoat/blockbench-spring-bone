// animation の終わりに向けて spring の揺れ (= 基底ポーズからの回転差分) を 0 まで減らす窓。
// 最後の tick を基底ポーズに一致させ、 loop の継ぎ目や animation の切り替えで姿勢が跳ばないようにする。
// 物理の state は最後まで進め、 載せる差分の量だけを weight で絞る。

export const REST_FADE_PROPERTY = 'spring_bone_rest_fade_frames'
export const DEFAULT_REST_FADE_TICKS = 4

export const TICKS_PER_SECOND = 20
// 物理は 1 tick を 3 回に分けて進める (= 60 Hz)。
export const SUBSTEPS_PER_TICK = 3

// rigel-anim の tickCount (src/bake/sample.ts) と同じ数え方。 書き出しは tick 0 からこの tick までを書き、
// loop の最後の tick は tick 0 の姿勢を見せる。
export function tickCount(lengthSeconds: number): number {
	if (!Number.isFinite(lengthSeconds)) return 0
	return Math.max(0, Math.ceil(lengthSeconds * TICKS_PER_SECOND - 1e-9))
}

export interface RestWindow {
	finalTick: number
	fadeTicks: number
}

export function restWindowOf(lengthSeconds: number, fadeTicks: unknown): RestWindow {
	const fade = typeof fadeTicks === 'number' && Number.isFinite(fadeTicks) ? Math.max(0, Math.floor(fadeTicks)) : DEFAULT_REST_FADE_TICKS
	return { finalTick: tickCount(lengthSeconds), fadeTicks: fade }
}

// sub-step ごとの weight。 fade の手前は 1、 そこから smoothstep で下がり、 最後の tick 以降は 0。
export function restWindowWeight(stepIndex: number, window: RestWindow): number {
	const end = window.finalTick * SUBSTEPS_PER_TICK
	if (stepIndex >= end) return 0
	const start = end - Math.min(window.fadeTicks, window.finalTick) * SUBSTEPS_PER_TICK
	if (stepIndex <= start) return 1
	const x = (stepIndex - start) / (end - start)
	return 1 - x * x * (3 - 2 * x)
}
