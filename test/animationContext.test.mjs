import test from 'node:test'
import assert from 'node:assert/strict'

const { makeExportAnimationContext } = await import('../dist-test/animationContext.mjs')

// --- makeExportAnimationContext: 引数の素通し ---

test('makeExportAnimationContext: animation は identity のまま context に載る', () => {
	const animation = { name: 'walk' }
	const excluded = new Set(['uuid-a'])
	const context = makeExportAnimationContext(animation, excluded)
	assert.equal(context.animation, animation)
})

test('makeExportAnimationContext: animationStack は長さ 1 で [0] が animation と同一', () => {
	const animation = { name: 'walk' }
	const context = makeExportAnimationContext(animation, new Set())
	assert.equal(context.animationStack.length, 1)
	assert.equal(context.animationStack[0], animation)
})

// excludedNodeUuids は previewOps.resolveConfigs が identity で読む前提なので、
// コピーせず **同じ Set instance** を通すことを固定する (= 後から AJ 側が同じ
// instance を書き換えた場合も含めて挙動が一致する)。
test('makeExportAnimationContext: excludedNodeUuids は同一 Set instance が通る', () => {
	const excluded = new Set(['uuid-a', 'uuid-b'])
	const context = makeExportAnimationContext({}, excluded)
	assert.equal(context.excludedNodeUuids, excluded)
})

test('makeExportAnimationContext: 空の excludedNodeUuids も同一 instance のまま通る', () => {
	const excluded = new Set()
	const context = makeExportAnimationContext({}, excluded)
	assert.equal(context.excludedNodeUuids, excluded)
	assert.equal(context.excludedNodeUuids.size, 0)
})

// --- makeExportAnimationContext: restWindow ---

// restWindow は SpringRuntime が weight 算出に読む optional field。 省略時は undefined で、
// runtime 側が weight ≡ 1 (= 減衰なし = 従来動作) に倒す。
test('makeExportAnimationContext: restWindow 省略時は undefined', () => {
	const context = makeExportAnimationContext({}, new Set())
	assert.equal(context.restWindow, undefined)
})

test('makeExportAnimationContext: restWindow は同一参照のまま素通しする', () => {
	// 解釈も正規化もしない (= 導出は restWindow.ts / SpringRuntime 側の責務)
	const restWindow = {
		timing: { renderSampleCount: 21, loopMode: 'loop', loopDelayFrames: 0 },
		requestedFadeFrames: 4,
	}
	const context = makeExportAnimationContext({ name: 'walk' }, new Set(), restWindow)
	assert.equal(context.restWindow, restWindow)
	assert.equal(context.restWindow.timing, restWindow.timing)
	assert.deepEqual(context.restWindow.timing, { renderSampleCount: 21, loopMode: 'loop', loopDelayFrames: 0 })
	assert.equal(context.restWindow.requestedFadeFrames, 4)
})

test('makeExportAnimationContext: restWindow の中身を検証しない (= 壊れた値もそのまま載る)', () => {
	// 正規化は読み側 (= restWindow.ts) の責務なので、 factory は素通しに徹する
	const restWindow = {
		timing: { renderSampleCount: Number.NaN, loopMode: 'bogus', loopDelayFrames: -1 },
		requestedFadeFrames: -3,
	}
	const context = makeExportAnimationContext({}, new Set(), restWindow)
	assert.equal(context.restWindow, restWindow)
})

// --- makeExportAnimationContext: animation の型を問わない ---

// AJ が渡してくる animation の中身は解釈しない (= 判定も正規化もしない) 契約。
// null / primitive でも加工せずそのまま載せる。
test('makeExportAnimationContext: animation が null でも加工せず素通しする', () => {
	const context = makeExportAnimationContext(null, new Set())
	assert.equal(context.animation, null)
	assert.deepEqual(context.animationStack, [null])
})

test('makeExportAnimationContext: animation が primitive でも加工せず素通しする', () => {
	for (const animation of ['walk', 0, 42, false, undefined]) {
		const context = makeExportAnimationContext(animation, new Set())
		assert.equal(context.animation, animation)
		assert.equal(context.animationStack.length, 1)
		assert.equal(context.animationStack[0], animation)
	}
})

test('makeExportAnimationContext: 任意 object の中身に触らない (= 変異させない)', () => {
	const animation = { name: 'walk', length: 1.5, nested: { a: 1 } }
	const before = JSON.parse(JSON.stringify(animation))
	makeExportAnimationContext(animation, new Set())
	assert.deepEqual(animation, before)
})

// --- makeExportAnimationContext: 呼び出しごとの独立性 ---

// 呼び出しごとに独立した context / stack を返す (= 内部で使い回さない)。 呼び出し元が
// 返り値を保持しても次の呼び出しに影響しない、 という現行挙動の固定。
test('makeExportAnimationContext: 呼び出しごとに新しい stack 配列を返す', () => {
	const animation = { name: 'walk' }
	const excluded = new Set()
	const first = makeExportAnimationContext(animation, excluded)
	const second = makeExportAnimationContext(animation, excluded)
	assert.notEqual(first.animationStack, second.animationStack)
	assert.equal(first.animationStack[0], second.animationStack[0])
	assert.notEqual(first, second)
})
