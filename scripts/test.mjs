// Builds the Blockbench-independent modules and runs test/*.test.mjs. Prints one line when everything passes and
// only the failures otherwise; the full output goes to .test-logs/test.log.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import esbuild from 'esbuild'

const MODULES = ['config', 'overrides', 'sim', 'restWindow', 'runtime', 'rig', 'engine', 'bakeTimeline', 'curveFit', 'eulerContinuity']
const LOG_DIR = '.test-logs'
const LOG = join(LOG_DIR, 'test.log')
const MAX_FAILURE_LINES = 200

try {
	await esbuild.build({
		entryPoints: MODULES.map((name) => `src/${name}.ts`),
		bundle: true,
		format: 'esm',
		platform: 'node',
		outdir: 'dist-test',
		outExtension: { '.js': '.mjs' },
		logLevel: 'silent',
	})
} catch (error) {
	console.error('test: build failed')
	for (const message of error.errors ?? [error]) console.error(message.text ?? message)
	process.exit(1)
}

const files = readdirSync('test').filter((name) => name.endsWith('.test.mjs')).map((name) => join('test', name))
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
mkdirSync(LOG_DIR, { recursive: true })
writeFileSync(LOG, output)

const count = (label) => Number(output.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'))?.[1] ?? NaN)
const tests = count('tests')
const failed = count('fail')

if (run.error || run.signal || run.status === null) {
	console.error(`test: node --test did not finish (${run.error?.message ?? run.signal ?? 'no exit code'}); see ${LOG}`)
	process.exit(1)
}
if (!(tests > 0)) {
	console.error(`test: no tests ran (exit ${run.status}); see ${LOG}`)
	console.error(output.split('\n').slice(-40).join('\n'))
	process.exit(run.status || 1)
}
if (run.status === 0) {
	console.log(`test: ${tests} passed in ${files.length} files`)
	process.exit(0)
}

const lines = output.split('\n')
const start = lines.findIndex((line) => line.includes('failing tests:'))
const details = start >= 0 ? lines.slice(start) : lines
console.error(`test: ${failed} of ${tests} failed (exit ${run.status})`)
console.error(details.slice(0, MAX_FAILURE_LINES).join('\n'))
if (details.length > MAX_FAILURE_LINES) console.error(`... ${details.length - MAX_FAILURE_LINES} more lines in ${LOG}`)
process.exit(run.status)
