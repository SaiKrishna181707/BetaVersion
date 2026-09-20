import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentClient } from '../../services/api/src/aws-store';

type Item = Record<string, unknown>;
type Write = { Key?: Item; Item?: Item; ConditionExpression?: string; UpdateExpression?: string;
  ExpressionAttributeValues?: Item; ExpressionAttributeNames?: Record<string, string> };

/** Small transactional fake for cross-service contract tests. AWS semantics still need a deployed smoke test. */
export function memoryDynamo(initial: Item[] = []) {
  const id = (item: Item) => `${item.pk}|${item.sk}`;
  let records = new Map(initial.map(item => [id(item), structuredClone(item)]));
  const calls: unknown[] = [];
  function apply(write: Write, store: Map<string, Item>, checkOnly = false) {
    const key = id(write.Key ?? write.Item!);
    const existing = store.get(key) ?? {};
    const values = write.ExpressionAttributeValues ?? {};
    const attr = (name: string) => write.ExpressionAttributeNames?.[name] ?? name;
    const evaluate = (expression: string): boolean => expression.split(' OR ').some(term => term.split(' AND ').every(clause => {
      const absent = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (absent) return existing[attr(absent[1]!)] === undefined;
      const comparison = clause.match(/^(\S+)\s+(=|<=)\s+(\S+)$/);
      if (!comparison) throw new Error(`Unsupported fake condition: ${clause}`);
      const left = existing[attr(comparison[1]!)]; const right = values[comparison[3]!];
      return comparison[2] === '=' ? left === right : typeof left === 'number' && typeof right === 'number' && left <= right;
    }));
    if (write.ConditionExpression && !evaluate(write.ConditionExpression)) throw Object.assign(new Error('Condition failed'), { name: 'TransactionCanceledException' });
    if (checkOnly) return;
    if (write.Item) { store.set(key, structuredClone(write.Item)); return; }
    const next = { ...existing, ...write.Key };
    if (write.UpdateExpression?.startsWith('ADD ')) {
      const [, name, value] = write.UpdateExpression.split(' ');
      next[attr(name!)] = Number(next[attr(name!)] ?? 0) + Number(values[value!]);
    } else if (write.UpdateExpression?.startsWith('SET ')) {
      for (const assignment of write.UpdateExpression.slice(4).split(',')) {
        const [name, value] = assignment.trim().split(/\s*=\s*/);
        next[attr(name!)] = values[value!];
      }
    }
    store.set(key, next);
  }
  const send = async (command: unknown): Promise<unknown> => {
    calls.push(command);
    if (command instanceof GetCommand) return { Item: structuredClone(records.get(id(command.input.Key!))) };
    if (command instanceof QueryCommand) return { Items: [...records.values()].filter(item => item.pk === command.input.ExpressionAttributeValues?.[':pk'] && String(item.sk).startsWith(String(command.input.ExpressionAttributeValues?.[':prefix']))).map(item => structuredClone(item)) };
    if (command instanceof ScanCommand) return { Items: [...records.values()].filter(item => item.sk === 'META' && String(item.pk).startsWith('RUN#')) };
    if (command instanceof PutCommand || command instanceof UpdateCommand) {
      try { apply(command.input, records); }
      catch (cause) {
        if (cause instanceof Error && cause.name === 'TransactionCanceledException') cause.name = 'ConditionalCheckFailedException';
        throw cause;
      }
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const next = structuredClone(records);
      for (const part of command.input.TransactItems ?? []) {
        if (part.Put) apply(part.Put, next);
        if (part.Update) apply(part.Update, next);
        if (part.ConditionCheck) apply(part.ConditionCheck, next, true);
      }
      records = next;
      return {};
    }
    throw new Error('Unexpected DynamoDB command');
  };
  return { client: { send } as DocumentClient, calls, get: (pk: string, sk: string) => records.get(`${pk}|${sk}`),
    put: (item: Item) => records.set(id(item), structuredClone(item)) };
}
