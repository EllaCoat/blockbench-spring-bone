// 右クリックのメニュー: Group の「Spring 化 / 解除」 と、 Animation の「Spring を bake」。
// 状態は Group の Property だけで持ち、 bone の名前は変えない (= 書き出す名前が変わる)。
import { isBakedAnimation } from './bakeTimeline'
import { STATE_PROPERTY, stateOf, type SpringBoneState } from './config'
import { requestPreview } from './preview'
import { rescanRig, rig } from './rig'

declare const Action: any
declare const Animation: any
declare const Group: any
declare const MenuSeparator: any
declare const Undo: any
declare function updateSelection(): void

function withDescendants(group: any): any[] {
	const out: any[] = []
	const visit = (node: unknown) => {
		if (!(node instanceof Group)) return
		out.push(node)
		for (const child of (node as any).children) visit(child)
	}
	visit(group)
	return out
}

// メニューを開いたとき condition は右クリックした Group を受け取るが、 キー割り当てからの実行では
// Action 自身が来る。 その場合は click と同じく選択中の Group で判定する。
function scope(context: unknown, deep: boolean): any[] {
	const roots = Group.all.includes(context) ? [context] : Group.multi_selected.length > 0 ? Group.multi_selected : [Group.first_selected].filter(Boolean)
	return deep ? roots.flatMap(withDescendants) : roots
}

function setState(groups: any[], state: SpringBoneState, label: string): void {
	const targets = [...new Set(groups)].filter((group) => stateOf(group) !== state)
	if (targets.length === 0) return
	Undo.initEdit({ groups: targets })
	for (const group of targets) group[STATE_PROPERTY] = state
	Undo.finishEdit(label)
	rescanRig()
	updateSelection()
	requestPreview()
}

// 解除は 'unset' ではなく 'disabled' にする。 'unset' に戻すと、 名前に `spring_` が残る Group が旧方式の移行で再び有効になる。
function stateAction(id: string, name: string, icon: string, state: SpringBoneState, deep: boolean): any {
	const differs = (group: unknown) => (state === 'enabled' ? stateOf(group) !== 'enabled' : stateOf(group) === 'enabled')
	return new Action(id, {
		name,
		icon,
		condition: (context?: unknown) => scope(context, deep).some(differs),
		click: () => setState(scope(undefined, deep).filter(differs), state, name),
	})
}

// Animations パネルの右クリックでは押した animation が来る。 キー割り当てからは選択中のもの。
function menuAnimation(context: unknown): any | null {
	if (Animation.all.includes(context)) return context
	return Animation.all.includes(Animation.selected) ? Animation.selected : null
}

let groupEntries: any[] = []
let animationEntries: any[] = []

export function registerMenus(bake: (animation: any) => void): void {
	groupEntries = [
		new MenuSeparator('spring_bone_actions'),
		stateAction('spring_bone_springify', 'Spring 化', 'gesture', 'enabled', false),
		stateAction('spring_bone_springify_recursive', 'Spring 化 (子孫含む)', 'account_tree', 'enabled', true),
		stateAction('spring_bone_unspringify', 'Spring 解除', 'link_off', 'disabled', false),
		stateAction('spring_bone_unspringify_recursive', 'Spring 解除 (子孫含む)', 'link_off', 'disabled', true),
	]
	Group.prototype.menu.structure.push(...groupEntries)

	animationEntries = [
		new MenuSeparator('spring_bone_bake'),
		new Action('spring_bone_bake_animation', {
			name: 'Spring を bake (派生 animation)',
			icon: 'save_as',
			condition: (context?: unknown) => {
				const animation = menuAnimation(context)
				return rig.bones.size > 0 && animation !== null && !isBakedAnimation(animation)
			},
			click: (context?: unknown) => {
				const animation = menuAnimation(context)
				if (animation) bake(animation)
			},
		}),
	]
	Animation.prototype.menu.structure.push(...animationEntries)
}

export function unregisterMenus(): void {
	const remove = (menu: any, entries: any[]) => {
		menu.structure = menu.structure.filter((entry: unknown) => !entries.includes(entry))
		for (const entry of entries) if (entry instanceof Action) entry.delete()
	}
	remove(Group.prototype.menu, groupEntries)
	remove(Animation.prototype.menu, animationEntries)
	groupEntries = []
	animationEntries = []
}
