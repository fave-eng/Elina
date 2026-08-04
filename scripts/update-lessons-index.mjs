import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const lessonsDir = path.join(root, 'data', 'lessons')
const indexPath = path.join(lessonsDir, 'index.json')
const checkOnly = process.argv.includes('--check')

if (!fs.existsSync(lessonsDir)) {
  throw new Error(`Lessons directory not found: ${lessonsDir}`)
}

const lessons = fs.readdirSync(lessonsDir)
  .filter((filename) => /^lesson-\d+\.json$/i.test(filename))
  .map((filename) => filename.replace(/\.json$/i, ''))
  .sort((left, right) => Number(left.replace('lesson-', '')) - Number(right.replace('lesson-', '')))

const nextContent = `${JSON.stringify({ lessons }, null, 2)}\n`

if (checkOnly) {
  const currentContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : ''
  if (currentContent !== nextContent) {
    console.error('data/lessons/index.json is out of date. Run: node scripts/update-lessons-index.mjs')
    process.exit(1)
  }
  console.log(`Lesson index is current (${lessons.length} lessons).`)
} else {
  fs.writeFileSync(indexPath, nextContent)
  console.log(`Updated data/lessons/index.json (${lessons.length} lessons).`)
}
