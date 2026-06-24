// blockbench-spring-bone — Blockbench plugin
// Spring bone physics simulation for hair / cloth / accessory bones.
// Built on Verlet integration + spring + damper. Real-time preview in the editor,
// bake into the AnimatedJava export pipeline so the motion shows up in-game.

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }

const PLUGIN_ID = 'spring_bone'
const PLUGIN_VERSION = '0.0.1'

let cleanups: Array<() => void> = []

Plugin.register(PLUGIN_ID, {
	title: 'Spring Bone',
	author: 'EllaCoat',
	description:
		'Spring bone physics (Verlet + spring + damper) for hair / cloth / accessory bones. Real-time preview in the editor and AnimatedJava export bake.',
	icon: 'gesture',
	variant: 'desktop',
	version: PLUGIN_VERSION,
	onload() {
		console.log(`[${PLUGIN_ID}] loaded v${PLUGIN_VERSION}`)
		// Phase 0: skeleton only. Feature install hooks land in Phase 1+.
	},
	onunload() {
		for (const fn of cleanups) {
			try {
				fn()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] cleanup failed`, e)
			}
		}
		cleanups = []
		console.log(`[${PLUGIN_ID}] unloaded`)
	},
})
