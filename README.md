# Agent Studio

Standalone desktop app (Electron + React + TypeScript) modeled on the VS Code
agent sessions window (light modern). It runs real Claude agent sessions over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), backed by a
deployable session engine, wrapped in a full local/remote code workspace.

- **Frameless title bar** — sidebar toggles, command-center pill, window controls
- **Left panel** — live agent Sessions list + Customizations
- **Chat pane** — start a session in a project and chat with the agent; the thread
  renders assistant output, tool calls, and diffs, with a composer that supports
  up/down prompt history
- **Editor area** — letterpress watermark; selecting a file opens Monaco (syntax
  highlighted); selecting a git change opens a Working Tree ↔ HEAD diff; integrated
  xterm terminal
- **Right panel** — Changes | Files tabs: lazy tree with Seti file icons, git status
  (branch, ahead/behind, staged / changes / untracked / conflicts), and a git graph
- **Command palette, quick open, branch switcher, theme picker**

## Session engine

Agent sessions run in `engine/` (`@agent-studio/engine`) — a standalone daemon that
exposes VS Code-style IPC channels and drives the Claude agent over ACP
(`@agentclientprotocol/claude-agent-acp`). It is packed and embedded by the app at
build time (`npm run engine`), and can also be deployed on its own so the desktop
app can attach to sessions running elsewhere. After changing anything under
`engine/src`, bump `engine`'s `VERSION` so the app stops using a stale daemon.

## Reused VS Code components

The trees are not imitations — they are VS Code's real `vs/base` widgets, imported
from monaco-editor's ESM distribution (monaco ships `vs/base/browser/ui/*` compiled):

- **Files** — `AsyncDataTree` (virtualized, lazy `IAsyncDataSource` over the project
  provider, real twisties/indent guides/selection model, keyboard navigation)
- **Changes** — `ObjectTree` with collapsible SCM-style groups
- **Sessions** — `List` widget styled by the agent window's own stylesheet, copied
  verbatim (`src/renderer/src/vscode-css/agentsessionsviewer.css` from
  `vscode/.../chat/browser/agentSessions/media/`), with the renderer emitting the
  same DOM classes as the real `agentSessionsViewer.ts`
- **Editor / diffs** — Monaco, which is VS Code's editor component
- `defaultListStyles` maps the widgets onto the same `--vscode-*` CSS variables the
  app's ported theme defines

The agent window's TypeScript components themselves cannot be copied: their
transitive import closure is ~1,760 files and they resolve live workbench services
(chat, menus, commands, context keys) from the DI container at runtime — reusing
them means building all of VS Code (the fork path).

Dev aids: `STUDIO_OPEN_PATH=<dir>` auto-opens a folder, `STUDIO_DEMO_SESSIONS=1`
renders sample sessions, `STUDIO_SCREENSHOT=<png>` captures and quits. If Electron
fails with `Cannot read properties of undefined (reading 'whenReady')`, unset
`ELECTRON_RUN_AS_NODE` (it leaks from IDE extension hosts).

The rest of the look and feel is extracted from the VS Code reference checkout in `vscode/`:

- codicon icon font (codepoints from `src/vs/base/common/codiconsLibrary.ts`)
- Light Modern workbench palette (`extensions/theme-defaults/themes/light_modern.json`)
- Seti file icons (`extensions/theme-seti/icons/` — seti.woff + theme json)
- git decoration colors (`extensions/git/package.json`)
- tree/list metrics and indent guides (`src/vs/base/browser/ui/tree/media/tree.css`)
- resizable sash (`src/vs/base/browser/ui/sash/sash.css`)
- editor watermark (`src/vs/workbench/browser/parts/editor/media/letterpress-light.svg`)

Note: the agent window itself is not an extractable component — it is the whole
VS Code workbench (layout.ts + DI services + contrib views), so this app recreates
its layout with the workbench's real styles instead of forking the build.

Projects can live on the **local disk** or on an **SSH remote** — both are served
through the same `ProjectProvider` interface (`src/main/providers/`):

- `LocalProjectProvider` — Node `fs` + the `git` CLI
- `SshProjectProvider` — `ssh2` SFTP for the file tree, `git` over ssh exec for status.
  Auth via password, a private key file, ssh-agent (`SSH_AUTH_SOCK`), or the default
  `~/.ssh/id_ed25519` / `id_rsa` keys. Remote paths support a `~/` prefix.

## Develop

```bash
npm install
npm run dev                 # hot-reloading dev app
STUDIO_OPEN_PATH=/some/dir npm run dev   # auto-open a folder on launch
npm run typecheck
```

## Build / package

```bash
npm run build               # compile to out/
npm run package             # unpacked app in release/
npm run dist                # AppImage in release/
```

## Layout

```
src/
  main/        Electron main process
    providers/ local & ssh project providers (ProjectProvider interface)
    git/       porcelain v2 status parser
    ipc.ts     IPC handlers (Result<T> envelopes)
  preload/     contextBridge API (window.studio)
  renderer/    React UI (TitleBar, panels, FileTree, GitPanel, AcpThread, TerminalView, …)
  shared/      types shared across processes (incl. ACP protocol types)
engine/        session engine daemon
  src/acp/     ACP session manager + Claude agent driver
  src/channels/  VS Code-style IPC channels
```

The `vscode/` folder is a reference checkout of VS Code and is not part of the build
(it is git-ignored).
