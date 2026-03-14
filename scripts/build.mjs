import * as esbuild from 'esbuild';

const external = ['commander', 'inquirer', 'zod', '@modelcontextprotocol/sdk'];
const shebang = '#!/usr/bin/env node';

await esbuild.build({
  entryPoints: ['src/core.ts'], bundle: true, minify: true,
  format: 'esm', platform: 'node', external, outfile: 'dist/core.js',
});
await esbuild.build({
  entryPoints: ['src/index.ts'], bundle: true, minify: true,
  format: 'esm', platform: 'node', external,
  banner: { js: shebang }, outfile: 'dist/index.js',
});
await esbuild.build({
  entryPoints: ['src/mcp.ts'], bundle: true, minify: true,
  format: 'esm', platform: 'node', external,
  banner: { js: shebang }, outfile: 'dist/mcp.js',
});
console.log('build complete');
