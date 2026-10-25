import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => path.join(__dirname, f))

const stream = run({ files })
stream.on('test:fail', () => {
  process.exitCode = 1
})
stream.compose(new spec()).pipe(process.stdout)
