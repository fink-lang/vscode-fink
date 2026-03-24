// Dependency checker and updater for vscode-fink.
//
// Usage:
//   node deps.mjs check    — show outdated npm, cargo, and asset deps
//   node deps.mjs update   — update all deps to latest
//
// Tracks three dependency sources:
//   1. npm packages (package.json)
//   2. fink crate pinned to a git tag (Cargo.toml)
//   3. Asset dependencies from GitHub releases (package.json "assets")

import { execSync } from 'child_process'
import fs from 'fs'

const CARGO_TOML = 'Cargo.toml'
const PACKAGE_JSON = 'package.json'
const FINK_REPO = 'fink-lang/fink'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim()
  } catch (e) {
    // Some commands (npm outdated) exit non-zero when deps are outdated
    if (e.stdout) return e.stdout.trim()
    if (e.stderr) return e.stderr.trim()
    throw e
  }
}

/** Read the pinned fink tag from Cargo.toml. */
function readFinkTag() {
  const toml = fs.readFileSync(CARGO_TOML, 'utf8')
  const m = toml.match(/fink\s*=\s*\{[^}]*tag\s*=\s*"([^"]+)"/)
  return m ? m[1] : null
}

/** Rewrite the fink tag in Cargo.toml. */
function writeFinkTag(newTag) {
  let toml = fs.readFileSync(CARGO_TOML, 'utf8')
  toml = toml.replace(
    /(fink\s*=\s*\{[^}]*tag\s*=\s*")([^"]+)(")/,
    `$1${newTag}$3`,
  )
  fs.writeFileSync(CARGO_TOML, toml)
}

/** Read asset dependencies from package.json "assets" field. */
function readAssets() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  return pkg.assets || {}
}

/** Write an updated version for an asset dependency in package.json. */
function writeAssetVersion(name, newVersion) {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  if (pkg.assets && pkg.assets[name]) {
    pkg.assets[name].version = newVersion
    fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n')
  }
}

/** Query the latest release tag from a GitHub repo. */
async function latestGitHubTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.tag_name ?? null
}

/** Download and extract an asset tarball, then run post-processing. */
function downloadAsset(asset) {
  const url = asset.url.replace('{version}', asset.version)
  const dest = asset.dest

  fs.mkdirSync(dest, { recursive: true })
  run(`curl -sL "${url}" | tar xz -C "${dest}"`)

  // Post-processing: copy specific files to their destinations
  if (asset.files) {
    for (const [src, target] of Object.entries(asset.files)) {
      const srcPath = `${dest}/${src}`
      if (fs.existsSync(srcPath)) {
        const targetDir = target.substring(0, target.lastIndexOf('/'))
        if (targetDir) fs.mkdirSync(targetDir, { recursive: true })
        fs.copyFileSync(srcPath, target)
      } else {
        console.log(`  warning: ${srcPath} not found`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function check() {
  console.log('npm outdated:')
  const npmOut = run('npm outdated', { cwd: '.' })
  console.log(npmOut || '  all up to date')

  console.log('\ncargo outdated:')
  const cargoOut = run('cargo outdated')
  console.log(cargoOut || '  all up to date')

  console.log('\nfink git dependency:')
  const pinned = readFinkTag()
  if (!pinned) {
    console.log('  could not read pinned tag from Cargo.toml')
  } else {
    const latest = await latestGitHubTag(FINK_REPO)
    if (!latest) {
      console.log(`  ${pinned} (failed to query GitHub API)`)
    } else if (latest === pinned) {
      console.log(`  fink ${pinned} ✓`)
    } else {
      console.log(`  fink ${pinned} → ${latest} available`)
    }
  }

  const assets = readAssets()
  if (Object.keys(assets).length > 0) {
    console.log('\nasset dependencies:')
    for (const [name, asset] of Object.entries(assets)) {
      const latest = await latestGitHubTag(asset.repo)
      if (!latest) {
        console.log(`  ${name} ${asset.version} (failed to query GitHub API)`)
      } else if (latest === asset.version) {
        console.log(`  ${name} ${asset.version} ✓`)
      } else {
        console.log(`  ${name} ${asset.version} → ${latest} available`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function update() {
  // 1. npm
  console.log('npm update:')
  console.log(run('npm update'))

  // 2. fink git tag
  console.log('\nfink git dependency:')
  const pinned = readFinkTag()
  const latest = await latestGitHubTag(FINK_REPO)

  if (!pinned) {
    console.log('  could not read pinned tag from Cargo.toml')
  } else if (!latest) {
    console.log(`  ${pinned} (failed to query GitHub API — skipping)`)
  } else if (latest === pinned) {
    console.log(`  fink ${pinned} ✓ (already latest)`)
  } else {
    writeFinkTag(latest)
    console.log(`  fink ${pinned} → ${latest}`)
  }

  // 3. cargo update
  console.log('\ncargo update:')
  console.log(run('cargo update'))

  // 4. asset dependencies
  const assets = readAssets()
  if (Object.keys(assets).length > 0) {
    console.log('\nasset dependencies:')
    for (const [name, asset] of Object.entries(assets)) {
      const latestTag = await latestGitHubTag(asset.repo)

      if (!latestTag) {
        console.log(`  ${name} ${asset.version} (failed to query GitHub API — skipping)`)
      } else if (latestTag === asset.version) {
        console.log(`  ${name} ${asset.version} ✓ (already latest)`)
        // Still download if dest doesn't exist
        if (!fs.existsSync(asset.dest)) {
          console.log(`  ${name} downloading (missing locally)...`)
          downloadAsset(asset)
        }
      } else {
        writeAssetVersion(name, latestTag)
        asset.version = latestTag
        console.log(`  ${name} ${asset.version} → ${latestTag}`)
        downloadAsset({ ...asset, version: latestTag })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// install — fetch pinned asset deps without upgrading anything
// ---------------------------------------------------------------------------

function install() {
  console.log('npm install:')
  console.log(run('npm install') || '  done')

  console.log('\ncargo fetch:')
  console.log(run('cargo fetch') || '  done')

  console.log('\nasset dependencies:')
  const assets = readAssets()
  for (const [name, asset] of Object.entries(assets)) {
    console.log(`  ${name} ${asset.version}`)
    downloadAsset(asset)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cmd = process.argv[2]

switch (cmd) {
  case 'check':
    await check()
    break
  case 'update':
    await update()
    break
  case 'install':
    install()
    break
  default:
    console.error('Usage: node deps.mjs [check | update | install]')
    process.exit(1)
}
