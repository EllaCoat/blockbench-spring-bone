// Group と Animation に足す Property と、 その読み取り口。
import { BAKED_FROM_PROPERTY } from './bakeTimeline'
import { PARAMS, STATE_PROPERTY, STATES, isCapable, stateOf } from './config'
import { OVERRIDES_PROPERTY, normalizeOverrides, type SpringOverrideMap } from './overrides'
import { DEFAULT_REST_FADE_TICKS, REST_FADE_PROPERTY } from './restWindow'

declare const Property: any
declare const Group: any
declare const Animation: any

// 毎フレーム読むので、 Property に入っている object ごとに 1 回だけ正規化する。
// Panel と Undo は値を変えるとき必ず新しい object を代入するので、 identity で足りる。
let overridesMemo: { animation: unknown; raw: unknown; map: SpringOverrideMap } | null = null

export function overridesOf(animation: any): SpringOverrideMap {
	const raw = animation?.[OVERRIDES_PROPERTY]
	if (overridesMemo !== null && overridesMemo.animation === animation && overridesMemo.raw === raw) return overridesMemo.map
	const map = normalizeOverrides(raw)
	overridesMemo = { animation, raw, map }
	return map
}

export function forgetOverrides(): void {
	overridesMemo = null
}

export function restFadeOf(animation: any): number {
	const raw = animation?.[REST_FADE_PROPERTY]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_REST_FADE_TICKS
}

// Blockbench の標準の merge は Property の condition を見るが、 読み込みでは Group の状態より先に
// 数値が merge されて condition が偽になり、 値が落ちる。 condition を見ずに型だけ検査して入れる。
// data にキーが無いときは何もしない (= 一部のキーだけの extend で値を巻き戻さない)。
function mergeNumber(key: string) {
	return (instance: any, data: any): void => {
		const value = data?.[key]
		if (typeof value === 'number' && Number.isFinite(value)) instance[key] = value
	}
}

// 標準の object の merge は中身を検査しないので、 壊れた項目をここで落とす。
function mergeOverrides(instance: any, data: any): void {
	if (data?.[OVERRIDES_PROPERTY] !== undefined) instance[OVERRIDES_PROPERTY] = normalizeOverrides(data[OVERRIDES_PROPERTY])
}

let properties: any[] = []

// condition は Property.copy (= Undo と保存) の gate も兼ねる。 状態と override の Property に付けると
// 'unset' の Group や override の無い animation で Undo の控えからキーが落ち、 Undo しても戻らなくなるので付けない。
// 数値の Property は、 一度でも spring 化した Group (= 解除済みを含む) にだけ付ける。
export function registerProperties(onParamChange: () => void): void {
	const capable = (group?: unknown): boolean => isCapable(stateOf(group ?? Group.first_selected))
	for (const param of PARAMS) {
		const property = new Property(Group, 'number', param.property, {
			default: param.default,
			condition: capable,
			inputs: {
				element_panel: {
					input: { label: `Spring ${param.label.toLowerCase()}`, type: 'num_slider', min: param.min, max: param.max, step: param.step, value: param.default },
					onChange: onParamChange,
				},
			},
		})
		property.merge = mergeNumber(param.property)
		properties.push(property)
	}
	const state = new Property(Group, 'enum', STATE_PROPERTY, { default: 'unset', values: STATES })
	const overrides = new Property(Animation, 'object', OVERRIDES_PROPERTY, { default: {} })
	overrides.merge = mergeOverrides
	const restFade = new Property(Animation, 'number', REST_FADE_PROPERTY, { default: DEFAULT_REST_FADE_TICKS })
	const bakedFrom = new Property(Animation, 'string', BAKED_FROM_PROPERTY, { default: '' })
	properties.push(state, overrides, restFade, bakedFrom)

	// 既定値は新しく作る instance にしか入らない。 値の無いまま Undo の控えを取ると、 最初の変更を Undo しても戻らない。
	for (const group of Group.all ?? []) group[STATE_PROPERTY] ??= 'unset'
	for (const animation of Animation.all ?? []) {
		animation[OVERRIDES_PROPERTY] ??= {}
		animation[REST_FADE_PROPERTY] ??= DEFAULT_REST_FADE_TICKS
	}
}

export function unregisterProperties(): void {
	for (const property of properties) property.delete()
	properties = []
	overridesMemo = null
}
