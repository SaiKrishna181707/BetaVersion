import { QueryCommand, ScanCommand, type DynamoDBDocumentClient, type QueryCommandInput, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';

export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

/** DynamoDB pages are capped at 1 MB, including when filters return no items. */
export async function queryAll(client: DocumentClient, input: QueryCommandInput) {
  const items: Record<string, unknown>[] = [];
  let key = input.ExclusiveStartKey;
  do {
    const page = await client.send(new QueryCommand({ ...input, ConsistentRead: true, ExclusiveStartKey: key }));
    items.push(...page.Items ?? []);
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}

export async function scanAll(client: DocumentClient, input: ScanCommandInput) {
  const items: Record<string, unknown>[] = [];
  let key = input.ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ ...input, ExclusiveStartKey: key }));
    items.push(...page.Items ?? []);
    key = page.LastEvaluatedKey;
  } while (key);
  return items;
}
