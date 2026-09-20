import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProductionApi } from '../../services/api/src/lambda';

const origin = 'https://centopus.example.com';

function event(path: string, subject?: string) {
  return {
    version: '2.0',
    rawPath: path,
    headers: { origin },
    requestContext: {
      http: { method: 'GET', path },
      ...(subject ? { authorizer: { jwt: { claims: { sub: subject } } } } : {}),
    },
  };
}

function apiFor(send: (input: unknown) => Promise<unknown>) {
  return createProductionApi({
    docClient: { send } as never,
    sfnClient: { send: async () => { throw new Error('unexpected Step Functions call'); } },
    s3Client: { send: async () => { throw new Error('unexpected S3 call'); } } as never,
    environment: {
      AWS_REGION: 'us-east-1',
      STATE_TABLE: 'centopus-state',
      ARTIFACT_BUCKET: 'centopus-artifacts',
      AMPLIFY_ORIGIN: origin,
      REQUIRE_AUTH: 'true',
    },
  });
}

test('production API rejects protected requests without a Cognito subject', async () => {
  let calls = 0;
  const handler = apiFor(async () => {
    calls++;
    return {};
  });

  const response = await handler(event('/runs'));

  assert.equal(response.statusCode, 401);
  assert.equal(calls, 0);
});

test('production API hides metrics from another operator', async () => {
  const handler = apiFor(async (input) => {
    const command = input as { input?: { Key?: { pk?: string; sk?: string } } };
    assert.deepEqual(command.input?.Key, { pk: 'RUN#run-owned-by-a', sk: 'META' });
    return { Item: { run_id: 'run-owned-by-a', owner_sub: 'operator-b' } };
  });

  const response = await handler(event('/runs/run-owned-by-a/metrics', 'operator-a'));

  assert.equal(response.statusCode, 404);
  assert.match(response.body, /Run not found/);
});

test('production API returns metrics to the owning operator', async () => {
  let call = 0;
  const handler = apiFor(async (input) => {
    const command = input as { input?: { Key?: { pk?: string; sk?: string } } };
    call++;
    if (call === 1) {
      assert.deepEqual(command.input?.Key, { pk: 'RUN#run-owned-by-a', sk: 'META' });
      return { Item: { run_id: 'run-owned-by-a', owner_sub: 'operator-a' } };
    }
    assert.deepEqual(command.input?.Key, { pk: 'RUN#run-owned-by-a', sk: 'METRICS' });
    return { Item: { metrics: { completion: { numerator: 1, denominator: 1, percentage: 100 } } } };
  });

  const response = await handler(event('/runs/run-owned-by-a/metrics', 'operator-a'));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    completion: { numerator: 1, denominator: 1, percentage: 100 },
  });
});
