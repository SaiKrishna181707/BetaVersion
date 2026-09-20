import fs from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';

async function main() {
  console.log('Building web app...');
  execSync('npm run build --workspace @centopus/web', { stdio: 'inherit' });

  const zipPath = 'amplify.zip';
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const pyScript = `import os, zipfile, stat
with zipfile.ZipFile('amplify.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('apps/web/dist'):
        for d in sorted(dirs):
            full = os.path.join(root, d)
            rel = os.path.relpath(full, 'apps/web/dist').replace('\\\\', '/') + '/'
            zinfo = zipfile.ZipInfo(rel)
            zinfo.create_system = 3
            zinfo.external_attr = (stat.S_IFDIR | 0o755) << 16
            z.writestr(zinfo, '')
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, 'apps/web/dist').replace('\\\\', '/')
            with open(full, 'rb') as fp:
                data = fp.read()
            zinfo = zipfile.ZipInfo(rel)
            zinfo.create_system = 3
            zinfo.external_attr = (stat.S_IFREG | 0o644) << 16
            z.writestr(zinfo, data)
print('Packaged amplify.zip:', os.path.getsize('amplify.zip'), 'bytes')
`;
  execFileSync('python', ['-c', pyScript], { stdio: 'inherit' });

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
