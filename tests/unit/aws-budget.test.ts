import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createBudgetReservation } from '../../services/api/src/aws/budget';
import { createAwsRunRuntime } from '../../services/api/src/aws/run-runtime';
import { createAwsRunStore } from '../../services/api/src/aws/store';
import { fakeDocumentStore, fakeObjectStore } from '../fixtures/aws-fakes';
import { CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';

test('budget admission atomically claims a run and checks cumulative reservations', async () => {
  let input: unknown;
  const client = { send: async (command: { input: unknown }) => { input = command.input; } } as unknown as DynamoDBClient;
  await createBudgetReservation('runs', client)('r1', 4500);
  const json = JSON.stringify(input);
  assert.match(json, /TransactItems/);
  assert.match(json, /attribute_not_exists\(pk\)/);
  assert.match(json, /reserved_cents <= :remaining/);
  assert.match(json, /20500/);
});

test('a refused reservation starts neither records nor a state machine', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  let starts = 0;
  const runtime = createAwsRunRuntime({ store, state_machine_arn: 'test-only',
    client: { send: async () => { starts++; } } as never,
    reserve_budget: async () => { throw new Error('Budget exhausted'); } });
  await assert.rejects(runtime.start({ run_id: 'r1', configuration: validConfiguration,
    personas: [personaFixture('p1', 'C1')], checkpoint_plan: CHECKPOINT_PLAN,
    allowed_origins: ['127.0.0.1'] }), /Budget exhausted/);
  assert.equal(starts, 0);
  assert.equal(await store.getRun('r1'), null);
});
