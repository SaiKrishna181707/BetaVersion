import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GUARDRAILS } from '@centopus/contracts';
import type { DocumentClient } from './aws-store';

/** Adapted from foundation's atomic reservations; main's records stay top-level.
 * Reservations never expire or auto-refund. This bounds admitted estimates, not AWS billing.
 * The same transaction claims a QUEUED run, preventing duplicate/concurrent launches.
 */
export async function reserveRunBudget(client: DocumentClient, table: string, runId: string, cents: number, revision?: number) {
  const ceiling = GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100;
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > ceiling) throw new Error('Invalid spend reservation.');
  await client.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: table, Item: { pk: `RUN#${runId}`, sk: 'RESERVATION', cents },
        ConditionExpression: 'attribute_not_exists(pk)' } },
      { Update: { TableName: table, Key: { pk: 'BUDGET#GLOBAL', sk: 'META' },
        UpdateExpression: 'ADD reserved_cents :amount',
        ConditionExpression: 'attribute_not_exists(reserved_cents) OR reserved_cents <= :remaining',
        ExpressionAttributeValues: { ':amount': cents, ':remaining': ceiling - cents } } },
      { Update: { TableName: table, Key: { pk: `RUN#${runId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :starting, reserved_cost_cents = :amount, updated_at = :now',
        ConditionExpression: '#st = :queued AND ' + (revision === undefined ? 'attribute_not_exists(persona_revision)' : 'persona_revision = :revision'),
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':starting': 'PROVISIONING', ':queued': 'QUEUED', ':amount': cents, ':now': new Date().toISOString(),
          ...(revision === undefined ? {} : { ':revision': revision }) } } },
    ],
  }));
}
