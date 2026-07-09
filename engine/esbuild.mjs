// Bundles the engine (daemon + smoke) into single Node ESM files under dist/.
// esbuild transpiles the vendored VS Code TypeScript without type-checking
// (that's not our code to typecheck) and tree-shakes what the IPC layer doesn't
// use. A tiny resolver maps VS Code's explicit `.js` import specifiers onto the
// `.ts` files on disk.

import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

/** Resolve relative `./foo.js` imports to `./foo.ts` when only the .ts exists. */
const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return;
      const tsPath = path.resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
      if (fs.existsSync(tsPath)) return { path: tsPath };
      return; // leave real .js files to the default resolver
    });
  },
};

await esbuild.build({
  entryPoints: ['src/daemon.ts', 'src/cli.ts', 'src/client.ts', 'src/smoke.ts', 'src/smoke-acp.ts', 'src/smoke-tunnel.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // The ACP SDK and the Claude adapter are resolved from node_modules at runtime
  // (the adapter is spawned as a subprocess by path), so keep them external.
  external: ['@agentclientprotocol/sdk', '@agentclientprotocol/claude-agent-acp'],
  sourcemap: true,
  logLevel: 'info',
  // Use engine/tsconfig.json so esbuild applies legacy (experimental) decorators
  // and classic class-field semantics — what the vendored VS Code code expects.
  tsconfig: 'tsconfig.json',
  // ESM output + node builtins: keep dynamic require() working if any vendored
  // code reaches for it, and shim __dirname/import.meta for CJS-style vendored code.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  plugins: [jsToTs],
});

console.log('engine build complete -> dist/');
