// animation ごとの override。 Animation の Property に bone (Group) の uuid をキーとして持つ。
export interface SpringOverride {
	enabled?: boolean
	drag?: number
	stiffness?: number
	gravity?: number
}

export type SpringOverrideMap = Record<string, SpringOverride>

export const OVERRIDES_PROPERTY = 'spring_bone_overrides'

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

// 既知の項目は型を検査して壊れた値だけ落とす。 未知の項目は残す。
// null prototype にするのは、 uuid キーに `__proto__` が来ても prototype を書き換えないため。
export function normalizeOverrides(raw: unknown): SpringOverrideMap {
	const out: SpringOverrideMap = Object.create(null)
	if (!isRecord(raw)) return out
	for (const [uuid, entry] of Object.entries(raw)) {
		if (!isRecord(entry)) continue
		const cleaned: Record<string, unknown> = Object.create(null)
		for (const [key, value] of Object.entries(entry)) {
			if (key === 'enabled') {
				if (typeof value === 'boolean') cleaned[key] = value
			} else if (key === 'drag' || key === 'stiffness' || key === 'gravity') {
				if (isFiniteNumber(value)) cleaned[key] = value
			} else {
				cleaned[key] = value
			}
		}
		if (Object.keys(cleaned).length > 0) out[uuid] = cleaned as SpringOverride
	}
	return out
}

// どちらも新しい map を返す。 呼び出し側は Property へ代入し直し、 Undo が変更を捉えられるようにする。
export function setOverrideField(map: SpringOverrideMap, uuid: string, key: keyof SpringOverride, value: boolean | number): SpringOverrideMap {
	return { ...map, [uuid]: { ...map[uuid], [key]: value } }
}

export function clearOverrideField(map: SpringOverrideMap, uuid: string, key: keyof SpringOverride): SpringOverrideMap {
	const prev = map[uuid]
	if (prev === undefined) return { ...map }
	const entry = { ...prev }
	delete entry[key]
	const out = { ...map }
	if (Object.keys(entry).length === 0) delete out[uuid]
	else out[uuid] = entry
	return out
}

// 指定した bone の override だけを、 キーの順に依らない文字列にする。
export function overridesFingerprint(map: SpringOverrideMap, uuids: readonly string[]): string {
	const parts: Array<[string, Array<[string, unknown]>]> = []
	for (const uuid of [...new Set(uuids)].sort()) {
		const entry = map[uuid]
		if (entry === undefined) continue
		const keys = Object.keys(entry).sort()
		if (keys.length > 0) parts.push([uuid, keys.map((key): [string, unknown] => [key, (entry as Record<string, unknown>)[key]])])
	}
	return JSON.stringify(parts)
}
