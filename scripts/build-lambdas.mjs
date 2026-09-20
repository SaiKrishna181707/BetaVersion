import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

const entries = { api: 'services/api/src/lambda.ts', worker: 'services/agent-worker/src/worker-lambda.ts', finalizer: 'services/report/src/finalizer.ts' };
for (const [name, entry] of Object.entries(entries)) {
  const directory = `.artifacts/lambda-bundles/${name}`;
  await mkdir(directory, { recursive: true });
  const result = await build({ entryPoints: [entry], outfile: `${directory}/index.js`, bundle: true,
    platform: 'node', target: 'node22', format: 'cjs', metafile: true });
  if (Object.keys(result.metafile.inputs).some(path => path.endsWith('services/api/src/handler.ts'))) {
    throw new Error('Legacy foundation handler must not enter a production bundle.');
  }
}
