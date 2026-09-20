import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';

const client = new LambdaClient({ region: 'us-east-1' });

async function deploy(fnName, dir) {
  const zipPath = `${dir}.zip`;
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(`powershell -command "Compress-Archive -Path '${dir}/index.js' -DestinationPath '${zipPath}'"`);
  const zipBuffer = fs.readFileSync(zipPath);
  console.log(`Updating ${fnName} code (${zipBuffer.length} bytes)...`);
  const res = await client.send(new UpdateFunctionCodeCommand({
    FunctionName: fnName,
    ZipFile: zipBuffer
  }));
  console.log(`${fnName} updated successfully, LastModified: ${res.LastModified}`);
}

async function main() {
  await deploy('synthetic-beta-api', '.artifacts/lambda-bundles/api');
  await deploy('synthetic-beta-session-worker', '.artifacts/lambda-bundles/worker');
  await deploy('synthetic-beta-finalizer', '.artifacts/lambda-bundles/finalizer');
}

main().catch(console.error);
