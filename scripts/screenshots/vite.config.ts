// Serves the renderer in a plain browser against mock-studio.ts (sample data,
// no Electron/engine), for taking README screenshots:
//   npx vite --config scripts/screenshots/vite.config.ts
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const mock = resolve(__dirname, 'mock-studio.ts')

export default defineConfig({
  root: resolve(__dirname, '../../src/renderer'),
  plugins: [
    react(),
    {
      name: 'mock-studio',
      transformIndexHtml: (html) =>
        html
          // The app's CSP blocks the dev server's inline React preamble.
          .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/s, '')
          .replace(
            '<script type="module" src="/src/main.tsx">',
            `<script type="module" src="/@fs${mock}"></script>\n    <script type="module" src="/src/main.tsx">`
          )
    }
  ],
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } }
})
