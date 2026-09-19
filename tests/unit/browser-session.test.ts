import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAgentCoreConnection } from '../../services/agent-worker/src/aws/browser-session';

/**
 * The AgentCore automation stream is a WebSocket, and the upgrade request is authenticated with
 * header-based SigV4. These are fixed, disposable example credentials and a fixed signing date,
 * so the signature is reproducible; the real chain is resolved by the AWS SDK at runtime and
 * never appears in the repository.
 */

const SECRET = 'wJalrXUtnFEMI-EXAMPLE-SECRET-NOT-REAL';
const credentials = async () => ({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: SECRET,
  sessionToken: 'example-session-token-not-real',
  expiration: new Date('2099-01-01T00:00:00.000Z'),
});
const now = () => new Date('2026-09-18T00:00:00.000Z');
const ENDPOINT = 'wss://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/bv-demo/sessions/s-1/automation';

test('signs the automation stream for the bedrock-agentcore service', async () => {
  const headers = await signAgentCoreConnection({
    ws_endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials,
    now,
  });

  assert.equal(headers.host, 'bedrock-agentcore.us-east-1.amazonaws.com');
  assert.equal(headers['x-amz-date'], '20260918T000000Z');
  assert.ok(headers.authorization.startsWith('AWS4-HMAC-SHA256 '), 'the authorization header must be a SigV4 header');
  assert.ok(headers.authorization.includes('Credential=AKIDEXAMPLE/20260918/us-east-1/bedrock-agentcore/aws4_request'));
  assert.ok(headers.authorization.includes('SignedHeaders='));
  assert.ok(headers.authorization.includes('Signature='));
});

test('carries the temporary session token but never the secret key', async () => {
  const headers = await signAgentCoreConnection({
    ws_endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials,
    now,
  });
  for (const value of Object.values(headers)) {
    assert.equal(value.includes(SECRET), false, `a header contained the secret: ${value}`);
  }
  // Temporary credentials must travel with the request; the secret key must not, and only
  // its derived signature appears.
  assert.equal(headers['x-amz-security-token'], 'example-session-token-not-real');
  assert.deepEqual(
    Object.keys(headers).sort(),
    ['authorization', 'host', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'].sort(),
  );
});

test('a different region produces a different signature', async () => {
  const east = await signAgentCoreConnection({ ws_endpoint: ENDPOINT, region: 'us-east-1', credentials, now });
  const west = await signAgentCoreConnection({
    ws_endpoint: ENDPOINT.replace('us-east-1', 'us-west-2'),
    region: 'us-west-2',
    credentials,
    now,
  });
  assert.notEqual(east.authorization, west.authorization);
  assert.ok(west.authorization.includes('/us-west-2/bedrock-agentcore/'));
});

test('the query string and path of the endpoint are part of what is signed', async () => {
  const plain = await signAgentCoreConnection({ ws_endpoint: ENDPOINT, region: 'us-east-1', credentials, now });
  const withQuery = await signAgentCoreConnection({
    ws_endpoint: `${ENDPOINT}?sessionTimeout=300`,
    region: 'us-east-1',
    credentials,
    now,
  });
  assert.notEqual(plain.authorization, withQuery.authorization);
});