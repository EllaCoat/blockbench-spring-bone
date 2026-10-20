import type { SpringOverride } from './overrides'

// Group の spring 状態。 'unset' と 'disabled' を分けるのは、 旧方式 (= 名前の `spring_` 接頭辞) の
// 移行を「まだ一度も決めていない Group」 だけに掛けるため。
export type SpringBoneState = 'unset' | 'enabled' | 'disabled'
export const STATE_PROPERTY = 'spring_bone_enabled'
export const STATES = ['unset', 'enabled', 'disabled'] as const

export interface SpringParams {
	drag: number
	stiffness: number
	gravity: number
}
export type ParamKey = keyof SpringParams

// 物理パラメータごとの Group Property 名とスライダーの範囲。 Property の登録と Panel で共有する。
export const PARAMS = [
	{ key: 'drag', property: 'spring_drag', label: 'Drag', min: 0, max: 1, step: 0.01, default: 0.05 },
	{ key: 'stiffness', property: 'spring_stiffness', label: 'Stiffness', min: 0, max: 10, step: 0.1, default: 1 },
	{ key: 'gravity', property: 'spring_gravity', label: 'Gravity', min: 0, max: 100, step: 1, default: 0 },
] as const

export const DEFAULT_PARAMS: SpringParams = { drag: 0.05, stiffness: 1, gravity: 0 }

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function toSpringBoneState(raw: unknown): SpringBoneState {
	return raw === 'enabled' || raw === 'disabled' ? raw : 'unset'
}

export function stateOf(group: unknown): SpringBoneState {
	return toSpringBoneState((group as { [STATE_PROPERTY]?: unknown } | null)?.[STATE_PROPERTY])
}

// 一度でも spring 化した Group。 解除済みも含めるのは、 animation の override で
// 「この animation だけ有効」 にできるようにするため。
export function isCapable(state: SpringBoneState): boolean {
	return state === 'enabled' || state === 'disabled'
}

export function shouldMigrate(state: SpringBoneState, name: unknown): boolean {
	return state === 'unset' && typeof name === 'string' && name.startsWith('spring_')
}

// Group の Property から物理パラメータを読む。 壊れた値は既定値に倒す。
export function paramsOf(group: unknown): SpringParams {
	const source = group as Record<string, unknown> | null
	const params = { ...DEFAULT_PARAMS }
	for (const param of PARAMS) {
		const raw = source?.[param.property]
		if (isFiniteNumber(raw)) params[param.key] = raw
	}
	return params
}

export function resolveEnabled(state: SpringBoneState, override: SpringOverride | undefined): boolean {
	return typeof override?.enabled === 'boolean' ? override.enabled : state === 'enabled'
}

// 項目ごとに animation の override → Group の値の順で決める。
export function resolveEffective(
	base: SpringParams,
	state: SpringBoneState,
	override: SpringOverride | undefined,
): SpringParams & { enabled: boolean } {
	const pick = (key: ParamKey): number => (isFiniteNumber(override?.[key]) ? override![key]! : base[key])
	return {
		enabled: resolveEnabled(state, override),
		drag: pick('drag'),
		stiffness: pick('stiffness'),
		gravity: pick('gravity'),
	}
}
