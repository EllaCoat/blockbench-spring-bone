// 物理の評価の入口。 preview、 rigel-anim の書き出し、 bake が 1 つの SpringRuntime を順に使う。
// どの animation をどの設定で評価しているかを session の key で持ち、 key が変わったら step 0 からやり直す。
import { isBakedAnimation } from './bakeTimeline'
import { paramsOf, resolveEffective, resolveEnabled, stateOf } from './config'
import { overridesFingerprint } from './overrides'
import { applyBasePose, applyOnly, capturePose, resetAllToRest, restorePose, stepAndApply, type PoseSnapshot } from './pose'
import { overridesOf, restFadeOf } from './properties'
import { restWindowOf, SUBSTEPS_PER_TICK, TICKS_PER_SECOND, type RestWindow } from './restWindow'
import { rescanRig, rig } from './rig'
import { SpringRuntime } from './runtime'

declare const Animation: any
declare const AnimationController: any
declare const Timeline: any

export interface SpringContext {
	// override と終わりの減衰を決める animation (= preview では選択中のもの、 無ければ null)。
	animation: any | null
	// 基底ポーズに積む animation。
	stack: readonly any[]
	restWindow?: RestWindow
	// 1 つの animation を書き出すときは、 基底ポーズの時刻を長さで止める (= rigel-anim と同じ)。
	endTime?: number
}

// bake で作った animation には物理が焼き込まれているので、 積んだら物理を掛けない。
const isBakedContext = (context: SpringContext): boolean => context.stack.some(isBakedAnimation)

const runtime = new SpringRuntime<SpringContext, PoseSnapshot>({
	resolveConfigs(context) {
		const overrides = overridesOf(context.animation)
		const baked = isBakedContext(context)
		for (const bone of rig.ordered) {
			const effective = resolveEffective(paramsOf(bone.group), stateOf(bone.group), overrides[bone.uuid])
			bone.enabled = effective.enabled && !baked
			bone.config = { drag: effective.drag, stiffness: effective.stiffness, gravity: effective.gravity, restLength: bone.restLength }
		}
	},
	basePose: (time, context) => applyBasePose(context.endTime === undefined ? time : Math.min(time, context.endTime), context.stack),
	capturePose,
	restorePose,
	resetAllToRest,
	stepAndApply,
	applyOnly,
})

let sessionKey: string | null = null

export const isEvaluating = (): boolean => runtime.isEvaluating

// 次の評価を step 0 からやり直させる。 構造や値が変わったかもしれないときに呼ぶ。
export function invalidate(): void {
	sessionKey = null
	runtime.end()
}

export function hasActiveBones(context: SpringContext): boolean {
	if (isBakedContext(context)) return false
	const overrides = overridesOf(context.animation)
	for (const bone of rig.ordered) if (resolveEnabled(stateOf(bone.group), overrides[bone.uuid])) return true
	return false
}

function ensureSession(kind: string, context: SpringContext): void {
	if (sessionKey === null) rescanRig()
	const restWindow = context.restWindow ? `${context.restWindow.finalTick},${context.restWindow.fadeTicks}` : '-'
	const overrides = overridesFingerprint(overridesOf(context.animation), [...rig.bones.keys()])
	const key = [kind, rig.version, context.animation?.uuid ?? '-', context.stack.map((a) => a.uuid).join(','), restWindow, context.endTime ?? '-', overrides].join('|')
	if (key === sessionKey) return
	sessionKey = null
	runtime.begin(context)
	sessionKey = key
}

export function animationContext(animation: any): SpringContext {
	return { animation, stack: [animation], restWindow: restWindowOf(animation.length, restFadeOf(animation)), endTime: animation.length }
}

// Blockbench が今再生している animation (= Animator.preview と同じ選び方)。 Animation Controller の再生中は、
// 今の state と、 遷移の途中なら前の state の animation。
function playingAnimations(): any[] {
	const all: any[] = Animation.all
	const controller = AnimationController.selected
	const state = controller?.selected_state
	if (!state) return all.filter((animation) => animation.playing)
	const last = controller.last_state
	let blending = false
	if (last) {
		const progress = last.blend_transition ? Math.min(1, Math.max(0, state.getStateTime() / last.blend_transition)) : 1
		blending = (last.calculateBlendValue?.(progress) ?? progress) < 1
	}
	const out: any[] = []
	for (const source of blending ? [state, last] : [state]) {
		for (const entry of source.animations ?? []) {
			const animation = all.find((a) => a.uuid === entry.animation)
			if (animation && !out.includes(animation)) out.push(animation)
		}
	}
	return out
}

function previewContext(): SpringContext {
	// 削除の途中は Animation.selected が消した animation を指したままになる。
	const selected = Animation.all.includes(Animation.selected) ? Animation.selected : null
	return {
		animation: selected,
		stack: playingAnimations(),
		restWindow: selected ? restWindowOf(selected.length, restFadeOf(selected)) : undefined,
	}
}

// Blockbench が今の時刻の姿勢を当てた直後に呼ぶ。
export function evaluatePreview(): void {
	const context = previewContext()
	if (!hasActiveBones(context)) {
		invalidate()
		return
	}
	ensureSession('preview', context)
	runtime.evaluateSample(Number.isFinite(Timeline.time) ? Timeline.time : 0)
}

// 1 つの animation を tick 0 から順に評価する (= rigel-anim の書き出しと bake)。 posed が false なら、
// その tick の基底ポーズをここで当てる。
export function evaluateAnimationTick(animation: any, tick: number, posed: boolean): void {
	if (tick === 0) invalidate()
	const context = animationContext(animation)
	if (!hasActiveBones(context)) return
	ensureSession('animation', context)
	if (!posed) applyBasePose(Math.min(tick / TICKS_PER_SECOND, animation.length), context.stack)
	runtime.evaluateStep(tick * SUBSTEPS_PER_TICK)
}

// bake が対象を決めるため、 animation の設定で bone の enabled を解決する。
export function beginAnimation(animation: any): void {
	invalidate()
	ensureSession('animation', animationContext(animation))
}
