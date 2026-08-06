import test from 'node:test'
import assert from 'node:assert/strict'

const {
	bakeSpringRotations,
	applyBakedCurvesToAnimationData,
	hashFingerprint,
	BAKE_VERSION,
	DEFAULT_BAKE_MAX_ANGLE_DEG,
	BAKE_DENSITY_WARN_KF_PER_SECOND,
	ANIM_BAKED_FROM_KEY,
	isBakedAnimation,
	isBakedAnimationContext,
} = await import('../dist-test/bakeTimeline.mjs')
const { evalBezierBB, fitSharedKnots } = await import('../dist-test/curveFit.mjs')

// --- テスト用の最小 quaternion 演算 (= 本番は THREE を注入する) ---

function quaternionFromEuler(ex, ey, ez) {
	const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2)
	const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2)
	return {
		x: s1 * c2 * c3 + c1 * s2 * s3,
		y: c1 * s2 * c3 - s1 * c2 * s3,
		z: c1 * c2 * s3 + s1 * s2 * c3,
		w: c1 * c2 * c3 - s1 * s2 * s3,
	}
}

function quatAngleDeg(a, b) {
	const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
	return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI
}

const OPS = { quaternionFromEuler, quatAngleDeg }

// 物理の代わりに「frame → 絶対 Euler (degrees)」 の関数を差し込む fake scene。
// 呼び出し順の記録も兼ねる (= session の契約が守られているかの検証用)。
function makeFakeScene(targets, poseAt, { failAtFrame = -1 } = {}) {
	const calls = []
	let currentFrame = -1
	return {
		calls,
		beginSession() { calls.push('begin') },
		listTargets() {
			calls.push('list')
			return targets
		},
		evaluateFrame(frameIndex) {
			calls.push(`frame:${frameIndex}`)
			if (frameIndex === failAtFrame) throw new Error('boom')
			currentFrame = frameIndex
		},
		readRotationDeg(uuid) {
			return poseAt(uuid, currentFrame)
		},
		endSession() { calls.push('end') },
	}
}

function target(uuid, name, rest = { x: 0, y: 0, z: 0 }) {
	return { uuid, name, restRotationDeg: rest }
}

// BB の再生を模して baked keyframe を評価する。
// interpolate (= timeline_animators.js:451-463) と同じく time を挟む 2 keyframe を取り、
// control point を getBezierLerp と同じ形 (= keyframe.js:227-234) に組んで評価する。
function sampleBakedValue(keyframes, time, axis) {
	const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
	let before = null
	let after = null
	for (const kf of keyframes) {
		if (kf.time <= time && (!before || kf.time > before.time)) before = kf
		if (kf.time >= time && (!after || kf.time < after.time)) after = kf
	}
	if (!before) return after.data_points[0][axis]
	if (!after || after === before) return before.data_points[0][axis]
	const v0 = before.data_points[0][axis]
	const v1 = after.data_points[0][axis]
	return evalBezierBB({
		P0: [before.time, v0],
		P1: [before.time + before.bezier_right_time[index], v0 + before.bezier_right_value[index]],
		P2: [after.time + after.bezier_left_time[index], v1 + after.bezier_left_value[index]],
		P3: [after.time, v1],
	}, time)
}

// --- 定数 ---

test('bake 定数 : version / 既定閾値 / 密度警告の値', () => {
	assert.equal(BAKE_VERSION, 1)
	assert.equal(DEFAULT_BAKE_MAX_ANGLE_DEG, 0.5)
	assert.equal(BAKE_DENSITY_WARN_KF_PER_SECOND, 8)
	assert.equal(ANIM_BAKED_FROM_KEY, 'spring_bone_baked_from')
})

// --- bake 由来 animation の判定 (= 物理の二重適用防止) ---

function baked(uuid = 'source-uuid') {
	return { uuid: 'baked', [ANIM_BAKED_FROM_KEY]: uuid }
}

function plain(name = 'walk') {
	return { uuid: 'plain', name, [ANIM_BAKED_FROM_KEY]: '' }
}

test('isBakedAnimation: baked_from が非空文字なら bake 由来', () => {
	assert.equal(isBakedAnimation(baked()), true)
	assert.equal(isBakedAnimation(plain()), false)
	// Property 未登録 / 別 plugin の animation
	assert.equal(isBakedAnimation({ uuid: 'x' }), false)
	assert.equal(isBakedAnimation(null), false)
	assert.equal(isBakedAnimation(undefined), false)
	// 文字列以外は印として扱わない
	assert.equal(isBakedAnimation({ [ANIM_BAKED_FROM_KEY]: 1 }), false)
})

test('isBakedAnimationContext: 選択中 animation が bake 由来なら抑制', () => {
	assert.equal(isBakedAnimationContext({ animation: baked(), animationStack: [baked()] }), true)
	assert.equal(isBakedAnimationContext({ animation: plain(), animationStack: [plain()] }), false)
})

test('isBakedAnimationContext: 複数 animation 再生 (= animation 未選択) でも stack から検出する', () => {
	// animation 未選択のまま複数再生している状況 : context.animation は null のままで、
	// baked animation は animationStack にしか現れない
	const context = { animation: null, animationStack: [plain('walk'), baked(), plain('idle')] }

	assert.equal(isBakedAnimationContext(context), true)
})

test('isBakedAnimationContext: stack に bake 由来が無ければ抑制しない', () => {
	const context = { animation: null, animationStack: [plain('walk'), plain('idle')] }

	assert.equal(isBakedAnimationContext(context), false)
	assert.equal(isBakedAnimationContext({ animation: null, animationStack: [] }), false)
})

test('isBakedAnimationContext: animationStack が無い context でも animation で判定する', () => {
	assert.equal(isBakedAnimationContext({ animation: baked() }), true)
	assert.equal(isBakedAnimationContext({ animation: plain() }), false)
	assert.equal(isBakedAnimationContext({ animation: null }), false)
})

// --- session の契約 ---

test('bakeSpringRotations: begin → listTargets → 全 frame 評価 → end の順に呼ぶ', () => {
	const scene = makeFakeScene([target('a', 'bone_a')], () => ({ x: 0, y: 0, z: 0 }))

	bakeSpringRotations(scene, { frameCount: 4, ...OPS })

	assert.deepEqual(scene.calls, ['begin', 'list', 'frame:0', 'frame:1', 'frame:2', 'frame:3', 'end'])
})

test('bakeSpringRotations: 途中で throw しても endSession は必ず通る', () => {
	const scene = makeFakeScene([target('a', 'bone_a')], () => ({ x: 0, y: 0, z: 0 }), { failAtFrame: 2 })

	assert.throws(() => bakeSpringRotations(scene, { frameCount: 5, ...OPS }), /boom/)

	assert.equal(scene.calls.at(-1), 'end')
})

test('bakeSpringRotations: 対象 bone が無ければ frame 評価すらしない', () => {
	const scene = makeFakeScene([], () => ({ x: 0, y: 0, z: 0 }))

	const result = bakeSpringRotations(scene, { frameCount: 100, ...OPS })

	assert.deepEqual(scene.calls, ['begin', 'list', 'end'])
	assert.deepEqual(result.bones, [])
	assert.equal(result.totalKeyframes, 0)
	assert.equal(result.maxKeyframesPerSecond, 0)
})

test('bakeSpringRotations: frameCount が正の整数でなければ RangeError', () => {
	const scene = makeFakeScene([target('a', 'bone_a')], () => ({ x: 0, y: 0, z: 0 }))

	assert.throws(() => bakeSpringRotations(scene, { frameCount: 0, ...OPS }), RangeError)
	assert.throws(() => bakeSpringRotations(scene, { frameCount: 1.5, ...OPS }), RangeError)
	assert.throws(() => bakeSpringRotations(scene, { frameCount: Number.NaN, ...OPS }), RangeError)
})

// --- keyframe data の形式 ---

test('bakeSpringRotations: BB が要求する keyframe data の形になっている', () => {
	const scene = makeFakeScene(
		[target('a', 'bone_a')],
		(_uuid, frame) => ({ x: 20 * Math.sin(frame / 3), y: 0, z: 0 }),
	)

	const result = bakeSpringRotations(scene, { frameCount: 41, ...OPS })
	const curve = result.bones[0]

	assert.ok(curve.keyframes.length >= 2)
	for (const kf of curve.keyframes) {
		assert.equal(kf.channel, 'rotation')
		// 既定は 'linear' なので明示が必須
		assert.equal(kf.interpolation, 'bezier')
		// 既定は true。 Hermite の非対称 handle が壊れるため false 固定
		assert.equal(kf.bezier_linked, false)
		assert.equal(typeof kf.time, 'number')
		for (const key of ['bezier_left_time', 'bezier_left_value', 'bezier_right_time', 'bezier_right_value']) {
			assert.equal(kf[key].length, 3, key)
			// 3 軸すべて数値 (= 欠けると getBezierLerp の control point が 0 に落ちる)
			for (const value of kf[key]) {
				assert.equal(typeof value, 'number', key)
				assert.ok(Number.isFinite(value), `${key} = ${value}`)
			}
		}
		assert.equal(kf.data_points.length, 1)
		for (const axis of ['x', 'y', 'z']) {
			assert.equal(typeof kf.data_points[0][axis], 'number')
			assert.ok(Number.isFinite(kf.data_points[0][axis]))
		}
	}
})

test('bakeSpringRotations: keyframe の時刻は 20fps 格子に載る', () => {
	const scene = makeFakeScene(
		[target('a', 'bone_a')],
		(_uuid, frame) => ({ x: 15 * Math.sin(frame / 2), y: 0, z: 0 }),
	)

	const result = bakeSpringRotations(scene, { frameCount: 41, ...OPS })
	const curve = result.bones[0]

	assert.equal(curve.keyframes[0].time, 0)
	assert.equal(curve.keyframes.at(-1).time, 40 / 20)
	for (const kf of curve.keyframes) {
		const frame = kf.time * 20
		assert.ok(Math.abs(frame - Math.round(frame)) < 1e-9, `time=${kf.time}`)
	}
	assert.equal(result.frameCount, 41)
	assert.equal(result.durationSeconds, 2)
})

// --- rest (= fix_rotation) の扱い ---

test('bakeSpringRotations: keyframe 値は絶対 Euler から rest を引いた差分になる', () => {
	// 姿勢が rest のまま動かない = keyframe 値は全軸 0
	const rest = { x: 30, y: -12, z: 5 }
	const scene = makeFakeScene([target('a', 'bone_a', rest)], () => ({ ...rest }))

	const result = bakeSpringRotations(scene, { frameCount: 21, ...OPS })
	const curve = result.bones[0]

	assert.equal(curve.keyframes.length, 2)
	for (const kf of curve.keyframes) {
		assert.ok(Math.abs(kf.data_points[0].x) < 1e-9)
		assert.ok(Math.abs(kf.data_points[0].y) < 1e-9)
		assert.ok(Math.abs(kf.data_points[0].z) < 1e-9)
	}
})

test('bakeSpringRotations: rest を引いても handle は変わらない (= 値方向の平行移動)', () => {
	const pose = (_uuid, frame) => ({ x: 18 * Math.sin(frame / 2.5), y: 0, z: 0 })
	const zero = bakeSpringRotations(makeFakeScene([target('a', 'bone_a')], pose), { frameCount: 41, ...OPS })
	const shifted = bakeSpringRotations(
		makeFakeScene([target('a', 'bone_a', { x: 40, y: 0, z: 0 })], pose),
		{ frameCount: 41, ...OPS },
	)

	assert.equal(zero.bones[0].keyframes.length, shifted.bones[0].keyframes.length)
	zero.bones[0].keyframes.forEach((kf, i) => {
		const other = shifted.bones[0].keyframes[i]
		assert.deepEqual(other.bezier_left_value, kf.bezier_left_value)
		assert.deepEqual(other.bezier_right_value, kf.bezier_right_value)
		assert.deepEqual(other.bezier_left_time, kf.bezier_left_time)
		assert.deepEqual(other.bezier_right_time, kf.bezier_right_time)
		assert.ok(Math.abs((kf.data_points[0].x - 40) - other.data_points[0].x) < 1e-9)
	})
})

// --- 再生したときに元の姿勢へ戻るか ---

test('bakeSpringRotations: BB の再生手順で元の絶対 Euler を閾値内に復元する', () => {
	// 減衰しながら揺れる 1 軸の系列 (= spring bone の典型)
	const rest = { x: 12, y: 0, z: 0 }
	const truth = (frame) => 12 + 25 * Math.exp(-frame / 60) * Math.sin(2 * Math.PI * frame / 9)
	const scene = makeFakeScene([target('a', 'bone_a', rest)], (_uuid, frame) => ({ x: truth(frame), y: 0, z: 0 }))

	const result = bakeSpringRotations(scene, { frameCount: 201, ...OPS })
	const curve = result.bones[0]

	let worst = 0
	for (let frame = 0; frame < 201; frame++) {
		const time = frame / 20
		// BB の再生 = fix_rotation + keyframe 値
		const played = rest.x + sampleBakedValue(curve.keyframes, time, 'x')
		worst = Math.max(worst, Math.abs(played - truth(frame)))
	}

	assert.ok(worst <= DEFAULT_BAKE_MAX_ANGLE_DEG, `復元誤差が閾値超え : ${worst}`)
	assert.ok(curve.maxAngleDeg <= DEFAULT_BAKE_MAX_ANGLE_DEG, `報告値が閾値超え : ${curve.maxAngleDeg}`)
	// 全 frame に打つより十分少ない (= フィッティングが効いている)
	assert.ok(curve.keyframes.length < 201 * 0.6, `keyframe が多すぎる : ${curve.keyframes.length}`)
})

test('bakeSpringRotations: 中央差分と一括 LS の両方を試して keyframe が少ない方を採る', () => {
	const frameCount = 121
	const pose = (_uuid, frame) => ({
		x: 22 * Math.exp(-frame / 40) * Math.sin(2 * Math.PI * frame / 7),
		y: 8 * Math.sin(2 * Math.PI * frame / 11 + 0.6),
		z: 0,
	})
	const scene = makeFakeScene([target('a', 'bone_a')], pose)

	const result = bakeSpringRotations(scene, { frameCount, ...OPS })

	// 同じ入力で 2 通りを直接 fit して、 採用結果が「少ない方」 になっているか確かめる
	const times = []
	const axes = { x: [], y: [], z: [] }
	for (let frame = 0; frame < frameCount; frame++) {
		times.push(frame / 20)
		const value = pose('a', frame)
		axes.x.push(value.x)
		axes.y.push(value.y)
		axes.z.push(value.z)
	}
	const ls = fitSharedKnots(times, axes, DEFAULT_BAKE_MAX_ANGLE_DEG, { fps: 20, useLS: true, ...OPS })
	const cd = fitSharedKnots(times, axes, DEFAULT_BAKE_MAX_ANGLE_DEG, { fps: 20, useLS: false, ...OPS })

	assert.notEqual(ls.keyframeCount, cd.keyframeCount, 'この入力は両者が同数 = 比較にならない')
	const curve = result.bones[0]
	// 採用結果は必ず 2 候補のどちらか (= 両方 fit している証拠)
	const chosen = curve.usedLeastSquares ? ls : cd
	assert.equal(curve.keyframes.length, chosen.keyframeCount)
	// 片方だけが閾値に届いた場合は届いた方を採る
	if (ls.converged !== cd.converged) {
		assert.equal(curve.usedLeastSquares, ls.converged)
	} else {
		// どちらも同じ収束状態なら keyframe が少ない方
		assert.equal(curve.keyframes.length, Math.min(ls.keyframeCount, cd.keyframeCount))
	}
})

test('bakeSpringRotations: 閾値に届かない bone は converged=false で報告する', () => {
	// minGapFrames を系列長と同じにすると knot を増やせない = 分割不能で打ち切られる。
	// 誤差が閾値を超えたまま返るケースを、 黙って成功扱いにしないことの確認。
	const scene = makeFakeScene(
		[target('a', 'bone_a')],
		(_uuid, frame) => ({ x: 40 * Math.sin(2 * Math.PI * frame / 5), y: 0, z: 0 }),
	)

	const result = bakeSpringRotations(scene, { frameCount: 21, minGapFrames: 20, ...OPS })
	const curve = result.bones[0]

	assert.equal(curve.converged, false)
	assert.ok(curve.maxAngleDeg > DEFAULT_BAKE_MAX_ANGLE_DEG)
	assert.deepEqual(result.unconvergedBones, ['bone_a'])
})

test('bakeSpringRotations: 収束した bone は unconvergedBones に載らない', () => {
	const scene = makeFakeScene(
		[target('a', 'bone_a')],
		(_uuid, frame) => ({ x: 10 * Math.sin(2 * Math.PI * frame / 40), y: 0, z: 0 }),
	)

	const result = bakeSpringRotations(scene, { frameCount: 81, ...OPS })

	assert.equal(result.bones[0].converged, true)
	assert.deepEqual(result.unconvergedBones, [])
})

test('bakeSpringRotations: 閾値を上げると keyframe が減る', () => {
	const pose = (_uuid, frame) => ({ x: 25 * Math.sin(2 * Math.PI * frame / 9), y: 0, z: 0 })
	const tight = bakeSpringRotations(makeFakeScene([target('a', 'bone_a')], pose), { frameCount: 101, ...OPS })
	const loose = bakeSpringRotations(
		makeFakeScene([target('a', 'bone_a')], pose),
		{ frameCount: 101, maxAngleDeg: 3, ...OPS },
	)

	assert.ok(loose.totalKeyframes < tight.totalKeyframes, `${loose.totalKeyframes} < ${tight.totalKeyframes}`)
})

// --- 密度と集計 ---

test('bakeSpringRotations: 密度は bone ごとに算出し、最大値を result に載せる', () => {
	const scene = makeFakeScene(
		[target('a', 'bone_a'), target('b', 'bone_b')],
		(uuid, frame) => (uuid === 'a'
			? { x: 25 * Math.sin(2 * Math.PI * frame / 6), y: 0, z: 0 }
			: { x: 0, y: 0, z: 0 }),
	)

	const result = bakeSpringRotations(scene, { frameCount: 201, ...OPS })

	assert.equal(result.bones.length, 2)
	const [a, b] = result.bones
	assert.equal(b.keyframes.length, 2)
	assert.ok(a.keyframes.length > b.keyframes.length)
	assert.ok(Math.abs(a.keyframesPerSecond - a.keyframes.length / 10) < 1e-9)
	assert.equal(result.maxKeyframesPerSecond, Math.max(a.keyframesPerSecond, b.keyframesPerSecond))
	assert.equal(result.totalKeyframes, a.keyframes.length + b.keyframes.length)
	assert.equal(result.maxAngleDeg, Math.max(a.maxAngleDeg, b.maxAngleDeg))
})

// --- 読めなかった sample の扱い ---

test('bakeSpringRotations: 読めない / 非有限の sample は直前の値で埋める', () => {
	const scene = makeFakeScene([target('a', 'bone_a')], (_uuid, frame) => {
		if (frame === 0) return null
		if (frame === 2) return { x: Number.NaN, y: 0, z: 0 }
		return { x: 10, y: 0, z: 0 }
	})

	const result = bakeSpringRotations(scene, { frameCount: 5, ...OPS })
	const curve = result.bones[0]

	for (const kf of curve.keyframes) {
		assert.ok(Number.isFinite(kf.data_points[0].x))
	}
	// frame 0 は読めないので rest (= keyframe 値 0)、 以降は 10 に張り付く
	assert.ok(Math.abs(curve.keyframes[0].data_points[0].x) < 1e-9)
	assert.ok(Math.abs(curve.keyframes.at(-1).data_points[0].x - 10) < 1e-9)
})

test('bakeSpringRotations: 先頭 sample が読めない場合の fallback は絶対 0° ではなく rest', () => {
	// rest が非ゼロの bone で先頭が読めないケース。 fallback が絶対 0° だと
	// keyframe 値が `0 − rest` になり、 rest ではない姿勢を再生してしまう
	const rest = { x: 25, y: -40, z: 10 }
	const scene = makeFakeScene([target('a', 'bone_a', rest)], (_uuid, frame) => (
		frame === 0 ? null : { ...rest }
	))

	const result = bakeSpringRotations(scene, { frameCount: 9, ...OPS })
	const first = result.bones[0].keyframes[0]

	for (const axis of ['x', 'y', 'z']) {
		assert.ok(Math.abs(first.data_points[0][axis]) < 1e-9, `${axis} = ${first.data_points[0][axis]}`)
	}
})

// --- 派生 animation data の組み立て ---

function makeSourceData() {
	return {
		uuid: 'source-uuid',
		name: 'walk',
		length: 2,
		loop: 'loop',
		animators: {
			'bone-a': {
				name: 'bone_a',
				type: 'bone',
				keyframes: [
					{ uuid: 'kf-1', channel: 'rotation', time: 0, data_points: [{ x: 1, y: 2, z: 3 }] },
					{ uuid: 'kf-2', channel: 'position', time: 0.5, data_points: [{ x: 4, y: 5, z: 6 }] },
				],
			},
			'bone-other': {
				name: 'bone_other',
				type: 'bone',
				keyframes: [
					{ uuid: 'kf-3', channel: 'rotation', time: 1, data_points: [{ x: 7, y: 8, z: 9 }] },
				],
			},
		},
	}
}

function makeCurve(uuid, name) {
	return {
		uuid,
		name,
		maxAngleDeg: 0,
		avgAngleDeg: 0,
		keyframesPerSecond: 1,
		keyframes: [{
			channel: 'rotation',
			time: 0,
			interpolation: 'bezier',
			bezier_linked: false,
			bezier_left_time: [-0.1, -0.1, -0.1],
			bezier_left_value: [0, 0, 0],
			bezier_right_time: [0.1, 0.1, 0.1],
			bezier_right_value: [0, 0, 0],
			data_points: [{ x: 11, y: 12, z: 13 }],
		}],
	}
}

test('applyBakedCurvesToAnimationData: 元 data を変異させない', () => {
	const source = makeSourceData()
	const snapshot = JSON.parse(JSON.stringify(source))

	applyBakedCurvesToAnimationData(source, [makeCurve('bone-a', 'bone_a')])

	assert.deepEqual(source, snapshot)
})

test('applyBakedCurvesToAnimationData: 対象 bone の rotation だけ差し替え、他 channel は残す', () => {
	const data = applyBakedCurvesToAnimationData(makeSourceData(), [makeCurve('bone-a', 'bone_a')])
	const animator = data.animators['bone-a']

	const rotation = animator.keyframes.filter((kf) => kf.channel === 'rotation')
	const position = animator.keyframes.filter((kf) => kf.channel === 'position')
	assert.equal(rotation.length, 1)
	assert.equal(rotation[0].data_points[0].x, 11)
	assert.equal(rotation[0].interpolation, 'bezier')
	assert.equal(position.length, 1)
	assert.equal(position[0].data_points[0].x, 4)
})

test('applyBakedCurvesToAnimationData: 再生解釈を変える animator flag を落とす', () => {
	const source = makeSourceData()
	source.animators['bone-a'].rotation_global = true
	source.animators['bone-a'].quaternion_interpolation = true
	source.animators['bone-other'].rotation_global = true

	const data = applyBakedCurvesToAnimationData(source, [makeCurve('bone-a', 'bone_a'), makeCurve('bone-new', 'bone_new')])

	assert.equal(data.animators['bone-a'].rotation_global, false)
	assert.equal(data.animators['bone-a'].quaternion_interpolation, false)
	assert.equal(data.animators['bone-new'].rotation_global, false)
	// 対象外の animator には触らない
	assert.equal(data.animators['bone-other'].rotation_global, true)
})

test('applyBakedCurvesToAnimationData: 対象外の animator はそのまま残る', () => {
	const data = applyBakedCurvesToAnimationData(makeSourceData(), [makeCurve('bone-a', 'bone_a')])
	const other = data.animators['bone-other']

	assert.equal(other.keyframes.length, 1)
	assert.equal(other.keyframes[0].channel, 'rotation')
	assert.equal(other.keyframes[0].data_points[0].x, 7)
})

test('applyBakedCurvesToAnimationData: keyframe を持たない bone には animator を新規に作る', () => {
	const data = applyBakedCurvesToAnimationData(makeSourceData(), [makeCurve('bone-new', 'bone_new')])
	const animator = data.animators['bone-new']

	assert.equal(animator.name, 'bone_new')
	assert.equal(animator.type, 'bone')
	assert.equal(animator.keyframes.length, 1)
	assert.equal(animator.keyframes[0].data_points[0].z, 13)
})

test('applyBakedCurvesToAnimationData: keyframe の uuid は全部落とす', () => {
	const data = applyBakedCurvesToAnimationData(makeSourceData(), [makeCurve('bone-a', 'bone_a')])

	for (const animator of Object.values(data.animators)) {
		for (const kf of animator.keyframes) {
			assert.equal(kf.uuid, undefined, JSON.stringify(kf))
		}
	}
})

test('applyBakedCurvesToAnimationData: animators を持たない data でも動く', () => {
	const data = applyBakedCurvesToAnimationData({ name: 'empty', length: 1 }, [makeCurve('bone-a', 'bone_a')])

	assert.equal(data.name, 'empty')
	assert.equal(data.animators['bone-a'].keyframes.length, 1)
})

// --- fingerprint ---

test('hashFingerprint: 同じ入力は同じ hash、違えば変わる', () => {
	const a = hashFingerprint([{ uuid: 'a', drag: 0.05 }])
	const b = hashFingerprint([{ uuid: 'a', drag: 0.05 }])
	const c = hashFingerprint([{ uuid: 'a', drag: 0.06 }])

	assert.equal(a, b)
	assert.notEqual(a, c)
	assert.match(a, /^[0-9a-f]{8}$/)
	assert.match(c, /^[0-9a-f]{8}$/)
})

test('hashFingerprint: undefined でも落ちない', () => {
	assert.match(hashFingerprint(undefined), /^[0-9a-f]{8}$/)
	assert.match(hashFingerprint(null), /^[0-9a-f]{8}$/)
})
