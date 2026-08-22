import test from 'node:test'
import assert from 'node:assert/strict'

const { createPreviewSession } = await import('../dist-test/previewSession.mjs')

// ops 呼び出しを発生順に log へ push する stub。 isExportActive は **getter** で持たせる :
// controller が判定のたびに読み直す前提の設計なので、 値のスナップショットだと
// 「生成後に export が始まる」 遷移を再現できない。
function makeOps({ beginError = null, endError = null } = {}) {
	const log = []
	let exportActive = false
	const ops = {
		log,
		setExportActive(value) { exportActive = value },
		get isExportActive() { return exportActive },
		getAnimation: (context) => context.animation,
		getStack: (context) => context.animationStack,
		endAnimation() {
			log.push('end')
			if (endError) throw endError
		},
		beginAnimation(context) {
			log.push('begin')
			if (beginError) throw beginError
		},
	}
	return ops
}

// index.ts の makePreviewAnimationContext / makeExportAnimationContext 相当。
function makeContext(animation, animationStack) {
	return { animation, animationStack: animationStack ?? (animation === null ? [] : [animation]) }
}

// --- 初回 ensure ---

test('PreviewSession: 初期状態は inactive', () => {
	const session = createPreviewSession(makeOps())
	assert.equal(session.isActive, false)
})

test('PreviewSession: 初回 ensure は end → begin の順で走り state が確定する', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	session.ensure(makeContext(animA))
	assert.deepEqual(ops.log, ['end', 'begin'])
	assert.equal(session.isActive, true)
})

test('PreviewSession: begin に渡るのは ensure の context そのもの', () => {
	const received = []
	const ops = makeOps()
	ops.beginAnimation = (context) => { ops.log.push('begin'); received.push(context) }
	const session = createPreviewSession(ops)
	const context = makeContext({ name: 'A' })
	session.ensure(context)
	assert.equal(received.length, 1)
	assert.equal(received[0], context)
})

// --- 同一判定 (= no-op) ---

test('PreviewSession: animation と stack 要素が同じなら no-op', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	const context = makeContext(animA)
	session.ensure(context)
	ops.log.length = 0
	session.ensure(context)
	assert.deepEqual(ops.log, [])
})

// makePreviewAnimationContext は毎 tick 新しい配列を返すため、 配列 instance の
// identity で判定すると毎 tick 張り直しになり、 cache advance 経路が死ぬ。
// 要素の identity 列だけを見る現行 semantics を固定する。
test('PreviewSession: 新しい配列 instance でも要素が同じなら張り直さない', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	session.ensure({ animation: animA, animationStack: [animA] })
	ops.log.length = 0
	session.ensure({ animation: animA, animationStack: [animA] })
	assert.deepEqual(ops.log, [])
})

test('PreviewSession: 空 stack + animation null の連続 ensure も no-op', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	session.ensure({ animation: null, animationStack: [] })
	ops.log.length = 0
	session.ensure({ animation: null, animationStack: [] })
	assert.deepEqual(ops.log, [])
})

// --- 張り直しが要る遷移 ---

test('PreviewSession: stack の要素が別 instance なら張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	const animB = { name: 'B' }
	session.ensure({ animation: animA, animationStack: [animA] })
	ops.log.length = 0
	session.ensure({ animation: animB, animationStack: [animB] })
	assert.deepEqual(ops.log, ['end', 'begin'])
})

test('PreviewSession: stack の長さが違えば張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	const animB = { name: 'B' }
	session.ensure({ animation: null, animationStack: [animA] })
	ops.log.length = 0
	session.ensure({ animation: null, animationStack: [animA, animB] })
	assert.deepEqual(ops.log, ['end', 'begin'])
})

test('PreviewSession: stack の順序が違えば張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	const animB = { name: 'B' }
	session.ensure({ animation: null, animationStack: [animA, animB] })
	ops.log.length = 0
	session.ensure({ animation: null, animationStack: [animB, animA] })
	assert.deepEqual(ops.log, ['end', 'begin'])
})

// stack が [A] のままでも animation: null → A は張り直す。 Phase β の per-animation
// パラメータ解決で context.animation が resolver の入力になるため。
test('PreviewSession: stack が同じでも animation の null → A 遷移で張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	session.ensure({ animation: null, animationStack: [animA] })
	ops.log.length = 0
	session.ensure({ animation: animA, animationStack: [animA] })
	assert.deepEqual(ops.log, ['end', 'begin'])
})

test('PreviewSession: stack が同じでも animation の A → null 遷移で張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	session.ensure({ animation: animA, animationStack: [animA] })
	ops.log.length = 0
	session.ensure({ animation: null, animationStack: [animA] })
	assert.deepEqual(ops.log, ['end', 'begin'])
})

// --- begin の失敗 ---

test('PreviewSession: begin が throw したら伝播し、 新 state を確定しない', () => {
	const error = new Error('begin boom')
	const ops = makeOps({ beginError: error })
	const session = createPreviewSession(ops)
	const context = makeContext({ name: 'A' })
	assert.throws(() => session.ensure(context), error)
	assert.equal(session.isActive, false)
})

test('PreviewSession: begin 失敗後の同じ context の ensure は再試行する', () => {
	const error = new Error('begin boom')
	const ops = makeOps({ beginError: error })
	const session = createPreviewSession(ops)
	const context = makeContext({ name: 'A' })
	assert.throws(() => session.ensure(context), error)
	ops.log.length = 0
	// 失敗しても no-op に落ちず、 もう一度 end → begin を試す
	assert.throws(() => session.ensure(context), error)
	assert.deepEqual(ops.log, ['end', 'begin'])
})

test('PreviewSession: 切り替え先の begin 失敗後は inactive になり元 context を張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const animA = { name: 'A' }
	const animB = { name: 'B' }
	const contextA = makeContext(animA)
	const contextB = makeContext(animB)

	session.ensure(contextA)
	assert.deepEqual(ops.log, ['end', 'begin'])
	assert.equal(session.isActive, true)

	const error = new Error('begin boom')
	ops.beginAnimation = (context) => {
		ops.log.push('begin')
		if (context === contextB) throw error
	}
	ops.log.length = 0
	assert.throws(() => session.ensure(contextB), error)
	assert.deepEqual(ops.log, ['end', 'begin'])
	assert.equal(session.isActive, false)

	ops.log.length = 0
	session.ensure(contextA)
	assert.deepEqual(ops.log, ['end', 'begin'])
	assert.equal(session.isActive, true)
})

// --- invalidate ---

test('PreviewSession: invalidate は state を落として endAnimation を呼ぶ', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	session.ensure(makeContext({ name: 'A' }))
	ops.log.length = 0
	session.invalidate()
	assert.deepEqual(ops.log, ['end'])
	assert.equal(session.isActive, false)
})

test('PreviewSession: invalidate 後は同じ context でも張り直す', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const context = makeContext({ name: 'A' })
	session.ensure(context)
	session.invalidate()
	ops.log.length = 0
	session.ensure(context)
	assert.deepEqual(ops.log, ['end', 'begin'])
})

// **state を先に落としてから endAnimation を呼ぶ** ことの固定。 逆順だと endAnimation の
// 失敗で state が残り、 次の ensure が no-op に落ちて session が復帰しなくなる。
test('PreviewSession: endAnimation が throw しても観測上は invalidated', () => {
	const error = new Error('end boom')
	const ops = makeOps()
	const session = createPreviewSession(ops)
	session.ensure(makeContext({ name: 'A' }))
	ops.endAnimation = () => { ops.log.push('end'); throw error }
	assert.throws(() => session.invalidate(), error)
	assert.equal(session.isActive, false)
})

// --- export 中の invalidate ---

test('PreviewSession: export 中の invalidate は完全 no-op (= endAnimation も呼ばない)', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	session.ensure(makeContext({ name: 'A' }))
	ops.log.length = 0
	ops.setExportActive(true)
	session.invalidate()
	assert.deepEqual(ops.log, [])
	// state にも触れていない (= session は張られたまま)
	assert.equal(session.isActive, true)
})

test('PreviewSession: export 中に invalidate しても session の同一判定は維持される', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	const context = makeContext({ name: 'A' })
	session.ensure(context)
	ops.setExportActive(true)
	session.invalidate()
	ops.setExportActive(false)
	ops.log.length = 0
	// export 中の invalidate が state を消していないので、 同じ context は no-op のまま
	session.ensure(context)
	assert.deepEqual(ops.log, [])
})

// isExportActive を値でコピーしていたら、 controller 生成時の false が固定されて
// この test が落ちる (= getter で受けていることの証明)。
test('PreviewSession: gate の状態変更は controller 生成後も live に反映される', () => {
	const ops = makeOps()
	const session = createPreviewSession(ops)
	session.ensure(makeContext({ name: 'A' }))
	ops.setExportActive(true)
	ops.log.length = 0
	session.invalidate()
	assert.deepEqual(ops.log, [])
	ops.setExportActive(false)
	session.invalidate()
	assert.deepEqual(ops.log, ['end'])
	assert.equal(session.isActive, false)
})

// --- instance の独立性 ---

test('PreviewSession: 別 instance の state は独立している', () => {
	const opsA = makeOps()
	const opsB = makeOps()
	const sessionA = createPreviewSession(opsA)
	const sessionB = createPreviewSession(opsB)
	sessionA.ensure(makeContext({ name: 'A' }))
	assert.equal(sessionA.isActive, true)
	assert.equal(sessionB.isActive, false)
	sessionB.invalidate()
	assert.equal(sessionA.isActive, true)
	assert.deepEqual(opsA.log, ['end', 'begin'])
})
