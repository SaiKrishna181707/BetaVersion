import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import type { RunRuntimePort } from '@synthetic-beta/contracts';
import { createApiHandler } from '../handler';
import { createAwsRunRuntime } from './run-runtime';
import { createAwsRunStore, createDynamoDocumentStore, createS3ObjectStore } from './store';

/**
 * The control plane as AWS runs it: API Gateway in, one Lambda out, DynamoDB/S3 behind it.
 *
 * The routing, validation, cost estimation, and response shapes are the ones in `handler.ts`;
 * this file only supplies the runtime. When the deployment has not configured a state machine
 * the runtime is absent, the health check reports `execution_available: false`, and a start
 * request is refused - the same honesty the local server shows when no executor is configured.
 */

interface ApiGatewayV2Event {
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function splitList(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined || value.trim().length === 0) return [...fallback];
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
}

/**
 * Built once per container. Lambda reuses a container across invocations, so the clients and
 * the resolved configuration are shared rather than rebuilt per request.
 */
function buildRuntime(): RunRuntimePort | null {
  const table = process.env.BETAVERSION_RUN_TABLE;
  const bucket = process.env.BETAVERSION_EVIDENCE_BUCKET;
  const state_machine_arn = process.env.BETAVERSION_STATE_MACHINE_ARN;
  if (table === undefined || bucket === undefined || state_machine_arn === undefined) return null;
  const store = createAwsRunStore(
    createDynamoDocumentStore({ table_name: table, client: new DynamoDBClient({}) }),
    createS3ObjectStore({ bucket_name: bucket, client: new S3Client({}) }),
  );
  return createAwsRunRuntime({ store, state_machine_arn, client: new SFNClient({}) });
}

export const handler = (() => {
  let runtime: RunRuntimePort | null | undefined;
  let api: ReturnType<typeof createApiHandler> | undefined;
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> => {
    if (api === undefined) {
      runtime = buildRuntime();
      api = createApiHandler(
        splitList(process.env.BETAVERSION_AUTHORIZED_DOMAINS, ['localhost', '127.0.0.1']),
        {
          runtime,
          checkpoint_plan: splitList(
            process.env.BETAVERSION_CHECKPOINT_PLAN,
            ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'],
          ),
        },
      );
    }
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';
    const body = event.body === undefined || event.body === null
      ? null
      : event.isBase64Encoded === true
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
    return api({ httpMethod: method, path, body });
  };
})();