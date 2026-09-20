import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

const apiBaseUrl = process.env.API_BASE_URL || process.env.VITE_API_BASE_URL || 'https://fkvvrndb17.execute-api.us-east-1.amazonaws.com';
const region = process.env.AWS_REGION || 'us-east-1';

async function verifyHealthEndpoint(expectedSha) {
  const healthUrl = `${apiBaseUrl.replace(/\/+$/, '')}/health`;
  console.log(`Checking production health endpoint at ${healthUrl}...`);

  const response = await fetch(healthUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  console.log('Health response:', JSON.stringify(data, null, 2));

  if (data.status !== 'ok') {
    throw new Error(`Health status is not ok: ${data.status}`);
  }

  if (data.execution_available !== true) {
    throw new Error(`execution_available is not true: ${data.execution_available}`);
  }

  if (expectedSha) {
    if (data.release_sha !== expectedSha) {
      throw new Error(`release_sha mismatch! Expected: ${expectedSha}, Deployed: ${data.release_sha}`);
    }
    console.log(`✓ Verified release_sha matches expected commit: ${expectedSha}`);
  }

  console.log('✓ Health check passed successfully!');
  return data;
}

async function resolveFunctionName(client, preferredName, fallbackName) {
  try {
    await client.send(new GetFunctionConfigurationCommand({ FunctionName: preferredName }));
    return preferredName;
  } catch {
    return fallbackName;
  }
}

async function verifyLambdaMetadata() {
  console.log('\nVerifying deployed Lambda configurations in AWS...');
  const client = new LambdaClient({ region });
  const rawFunctions = [
    ['centopus-api', 'synthetic-beta-api'],
    ['centopus-session-worker', 'synthetic-beta-session-worker'],
    ['centopus-finalizer', 'synthetic-beta-finalizer'],
  ];

  const results = {};
  for (const [preferred, fallback] of rawFunctions) {
    const fnName = await resolveFunctionName(client, preferred, fallback);
    try {
      const config = await client.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
      if (config.LastUpdateStatus && config.LastUpdateStatus !== 'Successful') {
        throw new Error(`Function ${fnName} LastUpdateStatus is ${config.LastUpdateStatus}`);
      }
      results[fnName] = {
        CodeSha256: config.CodeSha256,
        LastModified: config.LastModified,
        Version: config.Version,
        LastUpdateStatus: config.LastUpdateStatus,
      };
      console.log(`✓ ${fnName}: LastUpdateStatus=${config.LastUpdateStatus || 'Successful'}, CodeSha256=${config.CodeSha256}, LastModified=${config.LastModified}`);
    } catch (err) {
      throw new Error(`Could not verify AWS Lambda metadata for ${fnName}: ${err.message}`);
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let expectedSha = process.env.EXPECTED_SHA || process.env.RELEASE_SHA || process.env.GITHUB_SHA || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expected-sha' && args[i + 1]) {
      expectedSha = args[i + 1];
    }
  }

  console.log('=== VERIFYING PRODUCTION BACKEND ===');
  await verifyHealthEndpoint(expectedSha);
  await verifyLambdaMetadata();
  console.log('=== PRODUCTION BACKEND VERIFICATION COMPLETE ===\n');
}

main().catch(err => {
  console.error('\n❌ Production verification failed:', err.message || err);
  process.exit(1);
});
