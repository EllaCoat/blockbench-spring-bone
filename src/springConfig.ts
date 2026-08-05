// spring bone の状態 (= Group の Property 由来の 3 値) と per-animation override を
// 合成して実効 config を解決する純粋関数群。 BB / THREE / AnimatedJava には一切
// 依存しない (= 将来 AnimatedJava の export driver からも直接呼ばれる)。
//
// 解決順は override → base → defaults の項目単位 sparse : override に drag だけ
// 書かれていれば drag だけ override され、 残りは base / defaults から来る。
// restLength はここに含めない : これは子 bone の origin から算出される rig 幾何由来の
// 値で、 animation ごとに変える対象ではない。 override データに混入していても無視する。

import type { SpringOverride } from './animOverrides'

export type SpringBoneState = 'unset' | 'enabled' | 'disabled'

export interface SpringBaseConfig { drag: number; stiffness: number; gravity: number }
export interface ResolvedSpringConfig { enabled: boolean; drag: number; stiffness: number; gravity: number }

// Group の Property に入っている任意の値を 3 値へ正規化する。 旧 version の plugin や
// 手編集で変な値が入っていても「未設定」に倒す (= 既知値以外はすべて 'unset')。
export function toSpringBoneState(raw: unknown): SpringBoneState {
	return raw === 'enabled' || raw === 'disabled' ? raw : 'unset'
}

// 「一度 spring bone として設定された bone か」の判定。 'disabled' は設定済みだが
// 切られている状態で、 'unset' はそもそも spring bone として触られていない状態。
export function isCapable(state: SpringBoneState): boolean {
	return state === 'enabled' || state === 'disabled'
}

// 旧方式 (= group 名の 'spring_' 接頭辞) で spring 化されていた bone を新方式
// (= Property) へ移行すべきかの判定。 既に Property 側の状態を持つ bone
// (= enabled / disabled) は対象外なので、 移行後に再判定しても true にならない
// (= 冪等)。
export function shouldMigrate(state: SpringBoneState, name: unknown): boolean {
	return state === 'unset' && typeof name === 'string' && name.startsWith('spring_')
}

// 数値項目の有効値判定。 NaN / Infinity / 非数値は「書かれていない」として
// 次の優先順位へ流す。
function isValidParam(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

// 数値項目 1 つ分の解決 : override → base → defaults の順で最初の有効値を採用する。
function pickParam(
	key: 'drag' | 'stiffness' | 'gravity',
	base: Partial<SpringBaseConfig> | null | undefined,
	override: SpringOverride | null | undefined,
	defaults: SpringBaseConfig,
): number {
	const fromOverride = override?.[key]
	if (isValidParam(fromOverride)) return fromOverride
	const fromBase = base?.[key]
	if (isValidParam(fromBase)) return fromBase
	return defaults[key]
}

// enabled だけの解決 (= resolveEffective の enabled 部分を単独で使う経路向け)。
// tick() 冒頭の「active な entry があるか」判定 (= index.ts hasActiveSpringEntry) は
// resolveConfigs より前に走るため前 session の解決結果 (= entry.enabled) を読めず、
// 生の groupState と override から毎回ここで判定する必要がある。
// resolveEffective 内部もこれを呼び、 ロジックの重複を防ぐ。
export function resolveEnabled(
	groupState: SpringBoneState,
	override: SpringOverride | null | undefined,
): boolean {
	return typeof override?.enabled === 'boolean' ? override.enabled : groupState === 'enabled'
}

// 実効 config の解決。 毎回新しい object を返し、 入力の base / override は変異させない。
// enabled は boolean の override があればそれを優先し、 無ければ Group の状態から決める
// (= resolveEnabled 参照)。
export function resolveEffective(
	base: Partial<SpringBaseConfig> | null | undefined,
	groupState: SpringBoneState,
	override: SpringOverride | null | undefined,
	defaults: SpringBaseConfig,
): ResolvedSpringConfig {
	return {
		enabled: resolveEnabled(groupState, override),
		drag: pickParam('drag', base, override, defaults),
		stiffness: pickParam('stiffness', base, override, defaults),
		gravity: pickParam('gravity', base, override, defaults),
	}
}
