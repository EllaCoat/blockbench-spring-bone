// Outliner で spring が有効な Group の行に色を付ける。 判定は Group の Property だけで、
// 選択中の animation の override は見ない (= animation を切り替えるたびに色が変わらないように)。
import { stateOf } from './config'

declare const Blockbench: any
declare const Project: any

const MARKER = 'spring-bone-marker'
const STYLE_ID = 'spring-bone-outliner-marker-style'

// 選択色 (= .selected の background) は残し、 選択中は左端の線だけで示す。
const STYLE = `
	.outliner_object.${MARKER}:not(.selected) {
		background: linear-gradient(90deg, rgba(64, 192, 176, 0.16), rgba(64, 192, 176, 0.04) 60%, transparent);
	}
	.outliner_object.${MARKER} {
		box-shadow: inset 3px 0 0 rgba(64, 192, 176, 0.7);
	}
	.outliner_object.${MARKER} > i.material-icons.icon:not(.outliner_toggle) {
		color: rgba(64, 192, 176, 0.95) !important;
	}
`

// 行 (li.outliner_node) の id は node の uuid。
function scan(): void {
	const enabled = new Set<string>()
	for (const group of Project ? Project.groups : []) if (stateOf(group) === 'enabled') enabled.add(group.uuid)
	for (const li of document.querySelectorAll('li.outliner_node')) {
		li.querySelector(':scope > .outliner_object')?.classList.toggle(MARKER, enabled.has(li.id))
	}
}

export function installOutlinerMarker(): () => void {
	document.getElementById(STYLE_ID)?.remove()
	const style = Object.assign(document.createElement('style'), { id: STYLE_ID, textContent: STYLE })
	document.head.appendChild(style)

	let frame: number | null = null
	const schedule = (): void => {
		frame ??= requestAnimationFrame(() => {
			frame = null
			scan()
		})
	}
	// 行の作り直しは DOM の変化で、 値だけの変化 (= 右クリックの Spring 化、 Undo) はイベントで拾う。
	const observer = new MutationObserver(schedule)
	observer.observe(document.getElementById('cubes_list') ?? document.body, { childList: true, subtree: true })
	const events = ['update_selection', 'undo', 'redo', 'select_project', 'finished_edit']
	for (const event of events) Blockbench.on(event, schedule)
	schedule()

	return () => {
		if (frame !== null) cancelAnimationFrame(frame)
		observer.disconnect()
		for (const event of events) Blockbench.removeListener(event, schedule)
		style.remove()
		for (const node of document.querySelectorAll(`.outliner_object.${MARKER}`)) node.classList.remove(MARKER)
	}
}
