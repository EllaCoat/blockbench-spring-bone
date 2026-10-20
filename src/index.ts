// Blockbench plugin: 髪・布・装飾の bone に spring の二次的な揺れを付ける。
// エディタの preview で揺れを見せる。 keyframe へ焼き込む bake もある。
import { runSpringBake } from './bake'
import { installOutlinerMarker } from './outliner'
import { registerMenus, unregisterMenus } from './menu'
import { installPreview, refreshPreview } from './preview'
import { registerProperties, unregisterProperties } from './properties'
import { registerSpringPanel } from './ui'

declare const Plugin: any

const PLUGIN_ID = 'spring_bone'
const VERSION = '0.1.0'

let cleanups: Array<() => void> = []

Plugin.register(PLUGIN_ID, {
	title: 'Spring Bone',
	author: 'EllaCoat',
	description: 'Spring bone physics for hair / cloth / accessory bones: real-time preview in the editor and a bake into keyframes.',
	icon: 'gesture',
	variant: 'desktop',
	version: VERSION,
	onload() {
		// 値を変えたら step 0 からやり直して描き直す (= 停止中でもその場で反映する)。
		registerProperties(refreshPreview)
		cleanups = [installPreview(), registerSpringPanel(refreshPreview), installOutlinerMarker()]
		registerMenus(runSpringBake)
	},
	onunload() {
		unregisterMenus()
		for (const cleanup of cleanups.reverse()) cleanup()
		cleanups = []
		unregisterProperties()
	},
})
