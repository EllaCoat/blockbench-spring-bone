// プロジェクトの spring bone の一覧。 一度でも spring 化した Group (= 解除済みを含む) を持ち、
// 物理を掛けるかどうかは animation ごとに engine が決める (= enabled)。
import { DEFAULT_PARAMS, isCapable, PARAMS, shouldMigrate, stateOf, STATE_PROPERTY } from './config'
import { createState, type SpringConfig, type SpringState } from './sim'

declare const Project: any
declare const Group: any
declare const THREE: any

export interface SpringBone {
	uuid: string
	group: any
	// 最寄りの spring な祖先 (= 間に普通の Group を挟んでもよい)。
	parentUuid: string | null
	depth: number
	// 最初の子 Group の pivot へ向かう方向と距離 (= 親のローカル座標)。 子が無ければ上へ 16。
	restDir: any
	restLength: number
	// 今の animation で解決した値。 engine の resolveConfigs だけが書く。
	enabled: boolean
	config: SpringConfig
	state: SpringState
}

const bones = new Map<string, SpringBone>()
// 親から子の順。 子の bone は親の揺れを反映した後の pivot と向きを読む。
let ordered: SpringBone[] = []
let fingerprint = ''
let version = 0

export const rig = {
	get bones(): ReadonlyMap<string, SpringBone> {
		return bones
	},
	get ordered(): readonly SpringBone[] {
		return ordered
	},
	// 構造 (= どの bone がどの親に付き、 どの向きと長さか、 状態) が変わるたびに増える。
	get version(): number {
		return version
	},
}

function springParentUuid(group: any): string | null {
	for (let node = group.parent; node instanceof Group; node = node.parent) {
		if (isCapable(stateOf(node))) return node.uuid
	}
	return null
}

function restGeometry(group: any): { dir: any; length: number } {
	const child = group.children?.find((node: unknown) => node instanceof Group)
	if (child) {
		const [dx, dy, dz] = [0, 1, 2].map((i) => child.origin[i] - group.origin[i])
		const length = Math.hypot(dx!, dy!, dz!)
		if (Number.isFinite(length) && length >= 1e-4) return { dir: new THREE.Vector3(dx / length, dy / length, dz / length), length }
	}
	return { dir: new THREE.Vector3(0, 1, 0), length: 16 }
}

// 何度呼んでもよい。 残る bone の物理 state は保つ (= Group を選び直しただけで揺れが止まらない)。
export function rescanRig(): void {
	const groups: any[] = Project ? Project.groups : []
	let migrated = false
	for (const group of groups) {
		if (shouldMigrate(stateOf(group), group.name)) {
			group[STATE_PROPERTY] = 'enabled'
			migrated = true
		}
	}
	if (migrated) Project.saved = false

	const capable = groups.filter((group) => isCapable(stateOf(group)))
	const present = new Set(capable.map((group) => group.uuid))
	for (const uuid of [...bones.keys()]) if (!present.has(uuid)) bones.delete(uuid)
	for (const group of capable) {
		// 読み込みでは condition が偽の間に既定値が入らず、値の無い Property が残る。 値が無いまま Undo の控えを取ると
		// 最初の変更を Undo しても戻らず、 element panel にも前に選んだ Group の値が残る。
		for (const param of PARAMS) if (typeof group[param.property] !== 'number') group[param.property] = param.default
		const { dir, length } = restGeometry(group)
		const bone = bones.get(group.uuid)
		if (bone) {
			// Undo で同じ uuid の Group が作り直されると、 古い instance を握ったままになる。
			bone.group = group
			bone.restDir = dir
			bone.restLength = length
		} else {
			bones.set(group.uuid, {
				uuid: group.uuid,
				group,
				parentUuid: null,
				depth: 0,
				restDir: dir,
				restLength: length,
				enabled: false,
				config: { ...DEFAULT_PARAMS, restLength: length },
				state: createState(),
			})
		}
	}
	for (const bone of bones.values()) bone.parentUuid = springParentUuid(bone.group)
	for (const bone of bones.values()) {
		let depth = 0
		for (let parent = bone.parentUuid; parent !== null && depth <= bones.size; parent = bones.get(parent)?.parentUuid ?? null) depth++
		bone.depth = depth
	}
	const index = new Map(groups.map((group, i) => [group.uuid, i]))
	ordered = [...bones.values()].sort((a, b) => a.depth - b.depth || index.get(a.uuid)! - index.get(b.uuid)!)

	const next = ordered
		.map((bone) => `${bone.uuid}:${stateOf(bone.group)}:${bone.parentUuid}:${bone.restLength}:${bone.restDir.x},${bone.restDir.y},${bone.restDir.z}`)
		.join('|')
	if (next !== fingerprint) {
		fingerprint = next
		version++
	}
}

export function clearRig(): void {
	bones.clear()
	ordered = []
	fingerprint = ''
	version++
}
