import fs from 'node:fs';
import path from 'node:path';
import {
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { zipSingleFile } from './zip-helper.mjs';

const region = process.env.AWS_REGION || 'us-east-1';
const client = new LambdaClient({ region });

async function waitForFunctionUpdate(fnName, maxWaitSeconds = 180) {
  console.log(`Waiting for ${fnName} update to complete...`);
  try {
    await waitUntilFunctionUpdatedV2(
      { client, maxWaitTime: maxWaitSeconds },
      { FunctionName: fnName }
    );
  } catch (err) {
    // Fallback polling in case waiter times out or encounters transient SDK error
    const startTime = Date.now();
    while ((Date.now() - startTime) / 1000 < maxWaitSeconds) {
      const config = await client.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
      if (config.LastUpdateStatus === 'Successful') return config;
      if (config.LastUpdateStatus === 'Failed') {
        throw new Error(`Lambda update failed for ${fnName}: ${config.LastUpdateStatusReason}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`Timed out waiting for ${fnName} to update: ${err.message}`);
  }
}

async function deployCode(fnName, bundleDir) {
  const indexPath = path.resolve(bundleDir, 'index.js');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Bundle index.js not found at ${indexPath}. Did you run npm run build:lambdas?`);
  }
  const zipPath = path.resolve(bundleDir, '../', `${path.basename(bundleDir)}.zip`);
  console.log(`Packaging ${indexPath} into ${zipPath}...`);
  const zipBuffer = zipSingleFile(indexPath, 'index.js', zipPath);

  console.log(`Deploying code to ${fnName} (${zipBuffer.length} bytes)...`);
  await client.send(new UpdateFunctionCodeCommand({
    FunctionName: fnName,
    ZipFile: zipBuffer,
  }));

  await waitForFunctionUpdate(fnName);
  const updated = await client.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
  console.log(`✓ ${fnName} code deployed: CodeSha256=${updated.CodeSha256}, LastModified=${updated.LastModified}`);
  return updated;
}

async function updateApiEnvironment(fnName, releaseSha) {
  if (!releaseSha) {
    console.log(`No release SHA specified. Skipping environment variable update for ${fnName}.`);
    return;
  }
  console.log(`Updating ${fnName} environment with RELEASE_SHA=${releaseSha}...`);
  const current = await client.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
  const existingVars = current.Environment?.Variables || {};
  const mergedVars = {
    ...existingVars,
    RELEASE_SHA: releaseSha,
  };

  await client.send(new UpdateFunctionConfigurationCommand({
    FunctionName: fnName,
    Environment: {
      Variables: mergedVars,
    },
  }));

  await waitForFunctionUpdate(fnName);
  console.log(`✓ ${fnName} environment updated with RELEASE_SHA=${releaseSha}`);
}

async function main() {
  const args = process.argv.slice(2);
  let commitSha = process.env.RELEASE_SHA || process.env.GITHUB_SHA || process.env.APP_COMMIT_SHA || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit-sha' && args[i + 1]) {
      commitSha = args[i + 1];
    }
  }

  console.log(`Starting backend deployment (target commit: ${commitSha || 'unspecified'})...`);

  // Deployment order: worker -> finalizer -> api
  console.log('\n[1/3] Deploying session worker Lambda...');
  const workerInfo = await deployCode('centopus-session-worker', '.artifacts/lambda-bundles/worker');

  console.log('\n[2/3] Deploying finalizer Lambda...');
  const finalizerInfo = await deployCode('centopus-finalizer', '.artifacts/lambda-bundles/finalizer');

  console.log('\n[3/3] Deploying API Lambda...');
  const apiInfo = await deployCode('centopus-api', '.artifacts/lambda-bundles/api');

  if (commitSha) {
    await updateApiEnvironment('centopus-api', commitSha);
  }

  console.log('\n========================================');
  console.log('DEPLOYMENT SUMMARY:');
  console.log(`centopus-session-worker: CodeSha256=${workerInfo.CodeSha256} LastModified=${workerInfo.LastModified}`);
  console.log(`centopus-finalizer:      CodeSha256=${finalizerInfo.CodeSha256} LastModified=${finalizerInfo.LastModified}`);
  console.log(`centopus-api:            CodeSha256=${apiInfo.CodeSha256} LastModified=${apiInfo.LastModified}`);
  if (commitSha) console.log(`API RELEASE_SHA:               ${commitSha}`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
