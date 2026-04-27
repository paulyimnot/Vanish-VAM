import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['ws', 'dotenv'],
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/main.ts'],                 outfile: 'dist/main.js' }),
  build({ ...shared, entryPoints: ['src/workers/feedWorker.ts'],   outfile: 'dist/workers/feedWorker.js' }),
  build({ ...shared, entryPoints: ['src/workers/engineWorker.ts'], outfile: 'dist/workers/engineWorker.js' }),
  build({ ...shared, entryPoints: ['src/workers/omsWorker.ts'],    outfile: 'dist/workers/omsWorker.js' }),
  build({ ...shared, entryPoints: ['src/workers/calcWorker.ts'],   outfile: 'dist/workers/calcWorker.js' }),
]);

console.log('✅ Build complete → dist/');
