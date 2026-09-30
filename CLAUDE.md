# Agent Studio

## Dev build for aarch64 Linux (cross-built from x86_64)

A test AppImage the user downloads and runs directly on an arm64 machine. Do
NOT bump or override the version for dev builds — build with the version in
`package.json` as-is, so each build overwrites the same file.

```bash
npm run engine                                                  # engine/dist + dist-pack/engine.tgz
NODE_OPTIONS=--max-old-space-size=8192 npx electron-vite build  # renderer OOMs at the default heap
npx electron-builder --linux AppImage --arm64 \
  -c.npmRebuild=false
# -> release/Agent Studio-<package.json version>-arm64.AppImage
```

Gotchas:
- `-c.npmRebuild=false` is required. The rebuild fails on `cpu-features` (an
  optional ssh2 dep; ssh2 works without it) and there is no aarch64 cross
  compiler here anyway.
- That means native modules are packaged as they sit in `node_modules`, so they
  must already be aarch64: `node_modules/node-pty/build/Release/pty.node`, and
  `engine/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64` (the local
  engine's Claude binary). Verify before building:
  `file node_modules/node-pty/build/Release/pty.node` should say `ARM aarch64`.
  They're arm64 in this checkout, which also means `npm run dev` on this x86_64
  box won't get a working pty/engine until they're reinstalled for x64.
- Sanity-check the result: `file release/linux-arm64-unpacked/agent-studio`
  should be `ARM aarch64`.
- Typecheck: `npx tsc --noEmit -p tsconfig.web.json` for the renderer.
  `npm run typecheck` currently fails on a pre-existing
  `app.setDesktopName` error in `src/main/index.ts`.

## UI gotchas

- `src/renderer/src/codicon.css` is a trimmed subset of codicons. A class that
  isn't listed there (e.g. `codicon-project`, `codicon-ellipsis`) renders as an
  empty box — check with `grep "codicon-<name>" src/renderer/src/codicon.css`,
  or use a `lucide-react` icon instead.
