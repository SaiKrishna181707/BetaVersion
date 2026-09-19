import { TransactWriteItemsCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { GUARDRAILS } from '@synthetic-beta/contracts';

/** Atomic, cumulative reservations. Fail closed across concurrent API/Lambda instances.
 * Reservations are deliberately retained: this is a conservative execution allowance,
 * not a claim about the AWS bill. An interrupted run cannot accidentally free spend.
 */
export function createBudgetReservation(table: string, client: Pick<DynamoDBClient, 'send'>) {
  return async (run_id: string, cents: number): Promise<void> => {
    const ceiling = GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100;
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > ceiling) throw new Error('Invalid spend reservation.');
    await client.send(new TransactWriteItemsCommand({
      TransactItems: [
        { Put: { TableName: table, Item: marshall({ pk: `RUN#${run_id}`, sk: 'RESERVATION', cents }),
          ConditionExpression: 'attribute_not_exists(pk)' } },
        { Update: { TableName: table, Key: marshall({ pk: 'BUDGET#GLOBAL', sk: 'META' }),
          UpdateExpression: 'ADD reserved_cents :amount',
          ConditionExpression: 'attribute_not_exists(reserved_cents) OR reserved_cents <= :remaining',
          ExpressionAttributeValues: marshall({ ':amount': cents, ':remaining': ceiling - cents }) } },
      ],
    }));
  };
}
