// rigel-anim の書き出しに spring の揺れを載せる。 rigel-anim は animation ごとに tick 0 から順に姿勢を当て、
// 当てるたびにこのイベントを出してから bone の行列を読む (rigel-anim の src/bake/sample.ts)。
// ここで投げた例外は書き出しを止める (= 揺れの無いパックを黙って書かない)。
import { evaluateAnimationTick } from './engine'

declare const Blockbench: any

export const RIGEL_EXPORT_POSE_EVENT = 'rigel_export_pose'

interface ExportPose {
	animation: unknown
	tick: number
}

export function installRigelExport(): () => void {
	const onPose = ({ animation, tick }: ExportPose): void => evaluateAnimationTick(animation, tick, true)
	Blockbench.on(RIGEL_EXPORT_POSE_EVENT, onPose)
	return () => Blockbench.removeListener(RIGEL_EXPORT_POSE_EVENT, onPose)
}
