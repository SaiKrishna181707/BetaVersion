import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { join } from 'node:path';
import { REPO_ROOT } from './config';

export interface BundledFunctionProps {
  /** Absolute path to the TypeScript entry point inside this repository. */
  entry: string;
  description: string;
  timeout_seconds: number;
  memory_mb: number;
  environment: Record<string, string>;
  log_group: logs.ILogGroup;
}

/**
 * One place that decides how a BetaVersion Lambda is packaged.
 *
 * The handlers are TypeScript inside the npm workspaces, so they are bundled with esbuild at
 * synth time: the deployed artefact carries the workspace packages it imports and nothing
 * else. Output stays CommonJS because the Lambda entry points are plain request/response
 * handlers with no top-level await.
 */
export function bundledFunction(scope: Construct, id: string, props: BundledFunctionProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: props.entry,
    projectRoot: REPO_ROOT,
    depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    timeout: Duration.seconds(props.timeout_seconds),
    memorySize: props.memory_mb,
    description: props.description,
    environment: props.environment,
    logGroup: props.log_group,
    bundling: {
      target: 'node22',
      format: OutputFormat.CJS,
      sourceMap: true,
      minify: false,
      sourcesContent: false,
      keepNames: true,
      externalModules: [],
    },
  });
}
