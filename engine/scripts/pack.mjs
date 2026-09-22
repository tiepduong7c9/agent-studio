// Packs the engine into a single tarball for provisioning onto a remote host
// (SFTP-uploaded, then extracted into ~/.agent-studio-server/<version>/). Ships
// the built bundles plus node_modules — the ACP adapter is spawned by path at
// runtime, so it must be present on the remote (VS Code Server ships its deps too).
//
// Everything here is portable JavaScript EXCEPT the Claude native binary, which
// npm installs as a platform-gated optional dep
// (@anthropic-ai/claude-agent-sdk-<os>-<arch>, ~300 MB of compiled CLI). Packing
// it would bake THIS machine's arch into the tarball, so an arm64 client
// provisioning an x64 host ships a binary the remote can't run. It is excluded
// here and fetched on the remote, for the remote's own platform, by
// ssh-provision's ensureRemoteNative(). That also keeps the upload ~50 MB
// instead of ~360 MB.
//
//   node scripts/pack.mjs   (or: npm run pack)

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engineDir = path.resolve(here, '..')
const outDir = path.join(engineDir, 'dist-pack')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'engine.tgz')

execFileSync(
  'tar',
  // --exclude must precede the members it filters for bsdtar (macOS).
  ['czf', out, '--exclude', 'node_modules/@anthropic-ai/claude-agent-sdk-*', '-C', engineDir, 'dist', 'node_modules', 'package.json'],
  { stdio: 'inherit' }
)
const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
console.log(`packed engine -> ${path.relative(engineDir, out)} (${size} MB)`)
