// Generate a clean package.json for the published extension,
// keeping only the fields VS Code needs.

import fs from 'fs'

const keep = [
  'name',
  'version',
  'displayName',
  'description',
  'icon',
  'publisher',
  'license',
  'categories',
  'engines',
  'repository',
  'bugs',
  'homepage',
  'main',
  'browser',
  'activationEvents',
  'contributes',
]

const src = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const out = {}

for (const key of keep) {
  if (key in src) out[key] = src[key]
}

fs.writeFileSync('build/pkg/package.json', JSON.stringify(out, null, 2) + '\n')
