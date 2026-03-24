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

// Rewrite paths to be relative to build/pkg/ instead of repo root
const prefix = './build/pkg/'
for (const key of ['main', 'browser']) {
  if (out[key]?.startsWith(prefix)) {
    out[key] = './' + out[key].slice(prefix.length)
  }
}

fs.writeFileSync('build/pkg/package.json', JSON.stringify(out, null, 2) + '\n')
