// animation 単位の override データ操作。 key = bone (Group) の uuid。
// BB / THREE / AnimatedJava には一切依存しない (= 将来 AnimatedJava の
// export driver からも直接呼ばれる)。
//
// この module の関数はすべて「入力を変異させず、 変更部分を新しい object で返す」
// 形に統一する。 Blockbench の Undo は object を参照 identity で差分捕捉するため、
// 共有参照を書き換えると Undo が差分を見失う (= 戻せない変更が生える)。

export interface SpringOverride {
	enabled?: boolean
	drag?: number
	stiffness?: number
	gravity?: number
}

// key = bone (Group) の uuid
export type SpringOverrideMap = Record<string, SpringOverride>

// 数値項目の有効値判定 (= NaN / Infinity / 非数値を「書かれていない」として扱う)
function isValidParam(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

// 保存データ (= 任意の JSON 由来の値) を正規化する。
// 検証は項目単位 : 無効な項目だけを drop し、 entry ごと捨てない (= 1 項目の破損で
// 他の有効な項目まで消えるのを防ぐ)。
// 未知の key は検証せず保持する : 将来 schema が拡張されたファイルをこの version で
// 開いて保存し直しても、 新しい項目が失われないようにするため (= 前方互換)。
// 既知項目が 1 つも残らず未知 key も無い entry は map から除去する。
// 返却する map と内側の entry は **null-prototype object** (= Object.create(null)) で作る :
// 任意の JSON 由来の uuid を添字代入するため、 通常の object literal だと `__proto__` を
// key に持つ入力で返却 map の prototype が書き換わり (= prototype pollution)、 正規化結果の
// 欠落や継承値の混入が起こり得る。 null-prototype なら `__proto__` は常に own key として
// 安全に保持される。
export function normalizeOverrides(raw: unknown): SpringOverrideMap {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return Object.create(null)
	const out: SpringOverrideMap = Object.create(null)
	for (const [uuid, entry] of Object.entries(raw)) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
		const cleaned: Record<string, unknown> = Object.create(null)
		for (const [key, value] of Object.entries(entry)) {
			if (key === 'enabled') {
				if (typeof value === 'boolean') cleaned[key] = value
			} else if (key === 'drag' || key === 'stiffness' || key === 'gravity') {
				if (isValidParam(value)) cleaned[key] = value
			} else {
				// 未知 key はそのまま保持 (= 前方互換)
				cleaned[key] = value
			}
		}
		if (Object.keys(cleaned).length > 0) out[uuid] = cleaned as SpringOverride
	}
	return out
}

// 項目を 1 つ書き換えた新しい map を返す。 対象 uuid が map に無ければ新規 entry を
// 作る。 入力の map / entry は変異させない (= 変更対象の entry も必ず新しく作る)。
// spread による複製は prototype を引き継がず、 `__proto__` も own key として安全に
// コピーされる (= CreateDataProperty 経由) ため、 normalizeOverrides の null-prototype
// 出力を入力にしても prototype pollution は起きない。 戻り値は通常の object になる
// (= null-prototype への統一は normalize 側の責務とし、 ここでは持ち回らない)。
export function setOverrideField(
	map: SpringOverrideMap,
	uuid: string,
	key: keyof SpringOverride,
	value: boolean | number,
): SpringOverrideMap {
	return { ...map, [uuid]: { ...map[uuid], [key]: value } }
}

// 項目を 1 つ消した新しい map を返す。 消した結果 entry が空になったら entry ごと
// 除去する (= 空 entry を残すと normalize 済みの表現と等価でない状態が生える)。
// 対象 uuid が map に無い場合は何も変えず、 入力と等価な新しい map を返す。
export function clearOverrideField(
	map: SpringOverrideMap,
	uuid: string,
	key: keyof SpringOverride,
): SpringOverrideMap {
	const prev = map[uuid]
	if (prev === undefined) return { ...map }
	const entry = { ...prev }
	delete entry[key]
	if (Object.keys(entry).length === 0) {
		const out = { ...map }
		delete out[uuid]
		return out
	}
	return { ...map, [uuid]: entry }
}

// override 変更を検知して replay を起こすための決定的な fingerprint。
// 対象は uuids に含まれる uuid のみ (= 関係ない bone の変更では replay しない)。
// uuid と entry 内 key の両方を昇順に並べるため、 map の key 挿入順には依存しない。
// **sorted な [key, value] tuple 全体を JSON.stringify する** : 未 escape の
// `key=value` カンマ連結だと、 保持対象の未知 key (= 前方互換でそのまま保持する key)
// に `=` や `,` が含まれる場合に衝突し得る (= {a: null, b: null} と {'a=null,b': null}
// が同じ文字列になり、 将来 field の変更を見逃す)。 JSON.stringify なら key 文字列も
// escape されるため衝突しない。 数値は JSON.stringify でそのまま文字列化する :
// toFixed 等で丸めると 0.0500001 → 0.05 のような細かい値変更で fingerprint が
// 変わらず、 replay がトリガされなくなるため。
export function overridesFingerprint(map: SpringOverrideMap, uuids: readonly string[]): string {
	const parts: Array<[string, Array<[string, unknown]>]> = []
	for (const uuid of [...new Set(uuids)].sort()) {
		const entry = map[uuid]
		if (entry === undefined) continue
		const keys = Object.keys(entry).sort()
		if (keys.length === 0) continue
		const fields = keys.map(
			(key): [string, unknown] => [key, (entry as Record<string, unknown>)[key]],
		)
		parts.push([uuid, fields])
	}
	return JSON.stringify(parts)
}
