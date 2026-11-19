import { createRequire } from 'node:module';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
const outdir = resolve(process.argv[2] ?? 'dist-host');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { api: 'src/api.ts', worker: 'src/worker.ts', migrate: 'src/migrate.ts', 'model-setup': 'scripts/model-setup.ts' },
  outdir, bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await cp('drizzle', resolve(outdir, 'drizzle'), { recursive: true });
