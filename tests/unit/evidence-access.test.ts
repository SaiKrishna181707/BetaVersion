import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentEvidence } from '../../services/api/src/evidence-access';
import { createEvidenceSigner, createS3ObjectStore } from '../../services/api/src/aws/store';

test('API evidence links are resolved without mutating the stored source', async () => {
  const source = { screenshots: [{ ref: 's3://evidence/runs/r1/a.png' }], screenshot_ref: 's3://evidence/runs/r1/a.png', note: 's3://unchanged' };
  let calls = 0;
  const view = await presentEvidence(source, async () => { calls++; return 'https://signed.example/a.png'; });
  assert.equal(calls, 1);
  assert.equal(view.screenshots[0]?.ref, 'https://signed.example/a.png');
  assert.equal(view.note, source.note);
  assert.equal(source.screenshot_ref, 's3://evidence/runs/r1/a.png');
});

test('evidence signing cannot grant access to a different bucket or recordings prefix', async () => {
  const sign = createEvidenceSigner('evidence');
  assert.equal(await sign('s3://other/runs/r1/a.png'), null);
  assert.equal(await sign('s3://evidence/private/a.png'), null);
});

test('S3 permission errors are surfaced instead of silently omitting evidence', async () => {
  const objects = createS3ObjectStore({ bucket_name: 'evidence', client: { send: async () => {
    throw Object.assign(new Error('Denied'), { name: 'AccessDenied' });
  } } as never });
  await assert.rejects(objects.getJson('runs/r1/events.json'), /Denied/);
  await assert.rejects(objects.getJson('s3://other/runs/r1/events.json'), /bucket does not match/);
});
