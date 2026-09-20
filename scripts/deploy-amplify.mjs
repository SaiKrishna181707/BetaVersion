import fs from 'node:fs';
import { execSync } from 'node:child_process';

async function main() {
  console.log('Building web app...');
  execSync('npm run build --workspace @synthetic-beta/web', { stdio: 'inherit' });

  const zipPath = 'amplify.zip';
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(`powershell -command "Compress-Archive -Path 'apps/web/dist/*' -DestinationPath '${zipPath}'"`, { stdio: 'inherit' });

  console.log('Creating Amplify deployment...');
  const createOutput = execSync('aws amplify create-deployment --app-id d1s2dm4wj8xxb --branch-name main --region us-east-1').toString();
  const dep = JSON.parse(createOutput);
  const jobId = dep.jobId;
  const uploadUrl = dep.zipUploadUrl;
  console.log(`Created deployment job ${jobId}, uploading bundle...`);

  execSync(`curl.exe --fail --silent --show-error --request PUT --upload-file ${zipPath} "${uploadUrl}"`, { stdio: 'inherit' });

  console.log('Starting Amplify deployment...');
  execSync(`aws amplify start-deployment --app-id d1s2dm4wj8xxb --branch-name main --job-id ${jobId} --region us-east-1`, { stdio: 'inherit' });

  console.log('Waiting for deployment to succeed...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusOutput = execSync(`aws amplify get-job --app-id d1s2dm4wj8xxb --branch-name main --job-id ${jobId} --region us-east-1 --query "job.summary.status" --output text`).toString().trim();
    console.log(`[${i + 1}/60] Status: ${statusOutput}`);
    if (statusOutput === 'SUCCEED') {
      console.log('Amplify deployment succeeded!');
      break;
    }
    if (statusOutput === 'FAILED' || statusOutput === 'CANCELLED') {
      throw new Error(`Amplify deployment ended with ${statusOutput}`);
    }
  }

  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
}

main().catch(console.error);
