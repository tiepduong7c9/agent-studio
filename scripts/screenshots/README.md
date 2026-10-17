# README screenshots

Renders the app's UI in a plain browser with sample data and captures the images in
`docs/screenshots/`. No Electron, engine, or real sessions are involved: the
renderer is served by Vite and `mock-studio.ts` stands in for the Electron preload
(`window.studio`), returning fake sessions, a conversation, a file tree, and git
status.

```bash
# 1. Serve the renderer against the mock (http://localhost:5199)
npx vite --config scripts/screenshots/vite.config.ts

# 2. In another shell, capture (Playwright isn't a project dependency)
npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install chromium
NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture.cjs
```

Open http://localhost:5199 in a browser to poke at the mocked UI by hand. To
change what's shown, edit the sample data in `mock-studio.ts` and the steps in
`capture.cjs`.
