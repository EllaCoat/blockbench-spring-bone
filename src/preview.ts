// エディタの preview。 Blockbench の関数は差し替えず、 Blockbench が姿勢を当てた後の
// display_animation_frame で spring の差分を載せる。
import { evaluatePreview, invalidate, isEvaluating } from './engine'
import { forgetOverrides } from './properties'
import { clearRig, rescanRig } from './rig'

declare const Animator: any
declare const Blockbench: any
declare const Modes: any
declare const Undo: any

// 停止中は display_animation_frame が来ないので、 値を変えたらその場で描き直す。
// edit モードでは呼ばない (= playing の animation が edit の viewport に当たってしまう)。
export function requestPreview(): void {
	if (!Modes.animate) return
	try {
		Animator.preview()
	} catch (error) {
		console.warn('[spring_bone] Animator.preview failed', error)
	}
}

export function refreshPreview(): void {
	invalidate()
	requestPreview()
}

export function installPreview(): () => void {
	// keyframe を編集している間 (= Undo の編集中に keyframes がある) は値が毎フレーム変わり得るので、
	// 毎回 step 0 からやり直す。 編集が終わった (Esc の取り消しを含む) 後の 1 回もやり直す。
	let editing = false
	// select_project と load_project は .bbmodel を読み終える前に来る。 Group ができるまで評価を止める。
	let switching = false
	let switchFrame: number | null = null
	const onFrame = (): void => {
		if (isEvaluating() || switching) return
		try {
			const active = Array.isArray(Undo.current_save?.aspects?.keyframes)
			if (active || editing) invalidate()
			editing = active
			if (!Modes.animate) {
				invalidate()
				return
			}
			evaluatePreview()
		} catch (error) {
			invalidate()
			console.warn('[spring_bone] preview failed', error)
		}
	}
	const onProjectSwitch = (): void => {
		switching = true
		invalidate()
		forgetOverrides()
		if (switchFrame !== null) return
		switchFrame = requestAnimationFrame(() => {
			switchFrame = null
			switching = false
			rescanRig()
			refreshPreview()
		})
	}
	const onFinishedEdit = (event: any): void => {
		if (Array.isArray(event?.aspects?.keyframes)) refreshPreview()
	}
	const onUndoRedo = (): void => {
		rescanRig()
		refreshPreview()
	}

	const listeners: Array<[string, (event?: any) => void]> = [
		['display_animation_frame', onFrame],
		['select_project', onProjectSwitch],
		['load_project', onProjectSwitch],
		['new_project', onProjectSwitch],
		['update_selection', rescanRig],
		['select_mode', invalidate],
		['undo', onUndoRedo],
		['redo', onUndoRedo],
		['finished_edit', onFinishedEdit],
		['select_animation', refreshPreview],
	]
	for (const [event, listener] of listeners) Blockbench.on(event, listener)
	rescanRig()

	return () => {
		for (const [event, listener] of listeners) Blockbench.removeListener(event, listener)
		if (switchFrame !== null) cancelAnimationFrame(switchFrame)
		invalidate()
		clearRig()
		forgetOverrides()
	}
}
