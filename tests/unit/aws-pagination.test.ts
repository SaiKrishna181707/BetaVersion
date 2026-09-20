import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryAll, scanAll, type DocumentClient } from '../../services/api/src/aws-store';

test('queries and scans continue past empty DynamoDB pages with a LastEvaluatedKey', async () => {
  for (const read of [queryAll, scanAll]) {
    const keys: unknown[] = [];
    const client = { send: async (command: { input: { ExclusiveStartKey?: unknown } }) => {
      keys.push(command.input.ExclusiveStartKey);
      return keys.length === 1 ? { Items: [], LastEvaluatedKey: { pk: 'next' } } : { Items: [{ pk: 'found' }] };
    } } as unknown as DocumentClient;
    assert.deepEqual(await read(client, { TableName: 'test' }), [{ pk: 'found' }]);
    assert.deepEqual(keys, [undefined, { pk: 'next' }]);
  }
});
