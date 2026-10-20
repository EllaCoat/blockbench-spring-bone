// animate モードの Spring Bone パネル。 edit モードでは Property の element_panel の入力が出るので、 そちらに任せる。
// 行は 3 種類: 選択中の bone の物理パラメータ (= Group の値、 override の項目は animation の値)、
// 選択中の animation でのその bone の override、 選択中の animation の終わりの減衰。
import { PARAMS, paramsOf, resolveEffective, stateOf, isCapable, type ParamKey } from './config'
import { clearOverrideField, OVERRIDES_PROPERTY, setOverrideField, type SpringOverrideMap } from './overrides'
import { overridesOf, restFadeOf } from './properties'
import { DEFAULT_REST_FADE_TICKS, REST_FADE_PROPERTY } from './restWindow'

declare const Animation: any
declare const Blockbench: any
declare const Group: any
declare const InputForm: any
declare const Panel: any
declare const Undo: any

const REST_FADE = 'rest_fade_frames'

// remove_animation は Animation.selected が null になる前に来るので、 消した animation を選択中として読まない。
const selectedAnimation = (): any | null => (Animation.all.includes(Animation.selected) ? Animation.selected : null)
const selectedBone = (): any | null => (isCapable(stateOf(Group.first_selected)) ? Group.first_selected : null)

// スライダー 1 回の操作 (= drag、 矢印キー、 数値の確定) の書き込み先と、 操作前の値。
// 操作中は Undo の編集を開かず、 終わったときに 1 件の Undo にまとめる。 開いたままだと、
// その間のプロジェクト切り替えで別のプロジェクトの Undo 履歴を壊す。
interface Gesture {
	key: ParamKey | typeof REST_FADE
	kind: 'group' | 'animation' | 'rest_fade'
	group: any
	animation: any | null
	before: unknown
}

function readGesture(gesture: Gesture): unknown {
	if (gesture.kind === 'rest_fade') return gesture.animation[REST_FADE_PROPERTY]
	if (gesture.kind === 'animation') return overridesOf(gesture.animation)[gesture.group.uuid]?.[gesture.key as ParamKey]
	return gesture.group[PARAMS.find((param) => param.key === gesture.key)!.property]
}

function writeGesture(gesture: Gesture, value: unknown): void {
	if (gesture.kind === 'rest_fade') gesture.animation[REST_FADE_PROPERTY] = value
	else if (gesture.kind === 'animation') {
		const map = overridesOf(gesture.animation)
		const key = gesture.key as ParamKey
		gesture.animation[OVERRIDES_PROPERTY] =
			typeof value === 'number' && Number.isFinite(value) ? setOverrideField(map, gesture.group.uuid, key, value) : clearOverrideField(map, gesture.group.uuid, key)
	} else gesture.group[PARAMS.find((param) => param.key === gesture.key)!.property] = value
}

// 対象が今のプロジェクトに残っているか (= 別のプロジェクトの Undo に積まない)。
function gestureAlive(gesture: Gesture): boolean {
	if (!(gesture.animation === null || Animation.all.includes(gesture.animation))) return false
	return gesture.kind === 'rest_fade' || Group.all.includes(gesture.group)
}

export function registerSpringPanel(onChange: () => void): () => void {
	const form = new InputForm({})
	const panel = new Panel('spring_bone', {
		icon: 'gesture',
		name: 'Spring Bone',
		condition: { modes: ['animate'] },
		default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [300, 200], height: 200, sidebar_index: 3 },
		form,
	})
	const boneRow = (): boolean => selectedBone() !== null
	const overrideRow = (): boolean => boneRow() && selectedAnimation() !== null
	const config = form.form_config
	config.spring_state = { label: 'In this animation', type: 'inline_select', options: { inherit: '継承', on: '有効', off: '無効' }, value: 'inherit', condition: overrideRow }
	config.overrides = { label: 'Override', type: 'inline_multi_select', options: { drag: 'drag', stiffness: 'stiffness', gravity: 'gravity' }, value: { drag: false, stiffness: false, gravity: false }, condition: overrideRow }
	config[REST_FADE] = { label: 'Rest fade (ticks)', type: 'num_slider', min: 1, max: 200, step: 1, value: DEFAULT_REST_FADE_TICKS, condition: () => selectedAnimation() !== null }
	for (const param of PARAMS) config[param.key] = { label: param.label, type: 'num_slider', min: param.min, max: param.max, step: param.step, value: param.default, condition: boneRow }
	form.buildForm()

	let gesture: Gesture | null = null
	// inline_multi_select は changed_keys に 'overrides' しか載せないので、 前回の同期との差で押された項目を知る。
	let checks: Record<string, boolean> = {}

	const sync = (): void => {
		const animation = selectedAnimation()
		const bone = selectedBone()
		const values: Record<string, unknown> = { [REST_FADE]: animation ? restFadeOf(animation) : DEFAULT_REST_FADE_TICKS }
		checks = {}
		if (bone) {
			const override = animation ? overridesOf(animation)[bone.uuid] : undefined
			const inherited = resolveEffective(paramsOf(bone), stateOf(bone), undefined)
			for (const param of PARAMS) {
				const value = override?.[param.key]
				values[param.key] = typeof value === 'number' ? value : inherited[param.key]
				checks[param.key] = value !== undefined
			}
			values.overrides = { ...checks }
			values.spring_state = override?.enabled === true ? 'on' : override?.enabled === false ? 'off' : 'inherit'
		}
		// NumSlider の drag は表示中の値に差分を足すので、 操作中に値を差し替えると表示が飛ぶ。
		if (gesture !== null) return
		form.setValues(values)
		form.update(values)
	}

	// 操作中の書き込みは Undo の外なので、 中断された操作は操作前の値へ戻す。
	const rollback = (stale: Gesture): void => {
		writeGesture(stale, stale.before)
		onChange()
	}

	const makeGesture = (key: Gesture['key']): Gesture | null => {
		const animation = selectedAnimation()
		if (key === REST_FADE) return animation ? { key, kind: 'rest_fade', group: null, animation, before: undefined } : null
		const bone = selectedBone()
		if (!bone) return null
		if (!checks[key]) return { key, kind: 'group', group: bone, animation: null, before: undefined }
		return animation ? { key, kind: 'animation', group: bone, animation, before: undefined } : null
	}

	const commit = (current: Gesture): void => {
		const after = readGesture(current)
		if (Object.is(after, current.before)) return
		if (Undo.current_save) {
			console.warn('[spring_bone] another undo edit is open; the slider change was not recorded')
			return rollback(current)
		}
		// 操作前の値に戻してから Undo の控えを取り、 操作後の値を書く。
		writeGesture(current, current.before)
		Undo.initEdit(current.kind === 'group' ? { groups: [current.group] } : { animations: [current.animation] })
		writeGesture(current, after)
		Undo.finishEdit(current.kind === 'rest_fade' ? 'Change spring rest fade' : 'Change spring config')
		onChange()
	}

	for (const key of [...PARAMS.map((param) => param.key), REST_FADE] as Gesture['key'][]) {
		const slider = form.form_data[key]?.slider
		if (!slider) continue
		slider.onBefore = () => {
			// 前の操作が onAfter を受け取らずに終わっていた (= mouseup の取りこぼしなど)。
			if (gesture !== null) {
				const stale = gesture
				gesture = null
				rollback(stale)
			}
			gesture = makeGesture(key)
			if (gesture === null) sync()
			else gesture.before = readGesture(gesture)
		}
		slider.onAfter = () => {
			const current = gesture
			gesture = null
			try {
				if (current === null) return
				if (!gestureAlive(current)) return rollback(current)
				commit(current)
			} catch (error) {
				console.warn('[spring_bone] slider change failed', error)
				if (Undo.current_save) Undo.cancelEdit()
				if (current) rollback(current)
			} finally {
				sync()
			}
		}
	}

	const writeOverrides = (result: Record<string, any>, changed: string[]): void => {
		const bone = selectedBone()
		const animation = selectedAnimation()
		if (!bone || !animation) return
		let map: SpringOverrideMap = overridesOf(animation)
		if (changed.includes('spring_state')) {
			const desired = result.spring_state === 'on' ? true : result.spring_state === 'off' ? false : undefined
			if (map[bone.uuid]?.enabled !== desired) map = desired === undefined ? clearOverrideField(map, bone.uuid, 'enabled') : setOverrideField(map, bone.uuid, 'enabled', desired)
		}
		if (changed.includes('overrides')) {
			// 新しく override にした項目は、 今の継承値から始める。
			const inherited = resolveEffective(paramsOf(bone), stateOf(bone), undefined)
			for (const param of PARAMS) {
				const now = result.overrides?.[param.key] === true
				if (now !== (checks[param.key] === true)) map = now ? setOverrideField(map, bone.uuid, param.key, inherited[param.key]) : clearOverrideField(map, bone.uuid, param.key)
			}
		}
		if (map === overridesOf(animation)) return
		if (Undo.current_save) return console.warn('[spring_bone] another undo edit is open; the override change was not recorded')
		const previous = animation[OVERRIDES_PROPERTY]
		try {
			Undo.initEdit({ animations: [animation] })
			animation[OVERRIDES_PROPERTY] = map
			Undo.finishEdit('Change spring animation override')
		} catch (error) {
			console.warn('[spring_bone] override change failed', error)
			if (Undo.current_save) Undo.cancelEdit()
			animation[OVERRIDES_PROPERTY] = previous
		}
	}

	form.on('input', ({ result, changed_keys }: { result: Record<string, any>; changed_keys: string[] }) => {
		// スライダーの操作中は、 開始時に決めた書き込み先へ書き続ける (= 途中で選択が変わっても別の bone へ飛ばない)。
		if (gesture !== null && changed_keys.includes(gesture.key) && gestureAlive(gesture)) {
			const value = result[gesture.key]
			if (typeof value === 'number' && Number.isFinite(value)) writeGesture(gesture, value)
		}
		if (changed_keys.includes('spring_state') || changed_keys.includes('overrides')) {
			writeOverrides(result, changed_keys)
			sync()
		}
		onChange()
	})

	const events = ['update_selection', 'select_animation', 'remove_animation', 'undo', 'redo', 'select_project', 'load_project']
	for (const event of events) Blockbench.on(event, sync)
	sync()

	return () => {
		if (gesture !== null) {
			const stale = gesture
			gesture = null
			rollback(stale)
		}
		for (const event of events) Blockbench.removeListener(event, sync)
		panel.delete()
	}
}
