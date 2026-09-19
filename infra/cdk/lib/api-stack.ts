import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { API_LAMBDA_ENTRY, type BetaVersionConfig } from './config';
import type { BetaVersionDataStack } from './data-stack';
import type { BetaVersionExecutionStack } from './execution-stack';
import { bundledFunction } from './lambda-bundle';
import { addErrorAndLatencyAlarms, createAlarmTopic, createLogGroup } from './observability';

export interface ApiStackProps extends StackProps {
  config: BetaVersionConfig;
  data: BetaVersionDataStack;
  execution: BetaVersionExecutionStack;
  /** The console's own origin, added to the CORS allowlist so the site can call this API. */
  web_origin?: string;
}

export class BetaVersionApiStack extends Stack {
  readonly api: apigatewayv2.HttpApi;
  readonly api_function: ReturnType<typeof bundledFunction>;
  readonly api_url: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, data, execution } = props;
    const allowed_origins = [...new Set(
      props.web_origin === undefined ? config.cors_origins : [...config.cors_origins, props.web_origin],
    )];

    this.api_function = bundledFunction(this, 'Api', {
      entry: API_LAMBDA_ENTRY,
      description: `${config.prefix} control plane: configuration review, run start, run read models`,
      timeout_seconds: 29,
      memory_mb: 1024,
      log_group: createLogGroup(this, 'ApiLogs', config, 'api'),
      environment: {
        BETAVERSION_RUN_TABLE: data.run_table.tableName,
        BETAVERSION_EVIDENCE_BUCKET: data.evidence_bucket.bucketName,
        BETAVERSION_AUTHORIZED_DOMAINS: config.authorized_domains.join(','),
        BETAVERSION_CHECKPOINT_PLAN: config.checkpoint_plan.join(','),
        BETAVERSION_STATE_MACHINE_ARN: execution.state_machine.stateMachineArn,
        BETAVERSION_PREFIX: config.prefix,
        BETAVERSION_MODE: 'AWS',
      },
    });

    // The control plane owns run records and the artefacts a reviewer reads, and it may start
    // exactly one state machine. It cannot touch a browser, a model, or any other resource.
    data.run_table.grantReadWriteData(this.api_function);
    data.evidence_bucket.grantReadWrite(this.api_function);
    this.api_function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [execution.state_machine.stateMachineArn],
    }));
    this.api_function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:DescribeExecution', 'states:StopExecution'],
      resources: [`arn:aws:states:${this.region}:${this.account}:execution:${execution.state_machine.stateMachineName}:*`],
    }));

    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', this.api_function, {
      payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
    });

    const cors: apigatewayv2.CorsPreflightOptions = {
      allowOrigins: allowed_origins,
      allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
      allowHeaders: ['content-type'],
      maxAge: Duration.hours(1),
    };

    this.api = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-${config.env_name}-api`,
      description: `${config.prefix} control plane`,
      corsPreflight: cors,
      defaultIntegration: integration,
    });

    const routes: Array<{ path: string; methods: apigatewayv2.HttpMethod[] }> = [
      { path: '/health', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/estimate-cost', methods: [apigatewayv2.HttpMethod.POST] },
      { path: '/runs/{run_id}/population-preview', methods: [apigatewayv2.HttpMethod.POST] },
      { path: '/runs/{run_id}/start', methods: [apigatewayv2.HttpMethod.POST] },
      { path: '/projects/{project_id}/runs', methods: [apigatewayv2.HttpMethod.POST] },
      { path: '/runs/{run_id}', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/status', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/sessions', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/sessions/{session_id}', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/metrics', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/report', methods: [apigatewayv2.HttpMethod.GET] },
      { path: '/runs/{run_id}/evidence', methods: [apigatewayv2.HttpMethod.GET] },
    ];
    for (const route of routes) {
      this.api.addRoutes({ path: route.path, methods: route.methods, integration });
    }

    addErrorAndLatencyAlarms(this, 'Api', 'api', this.api_function, config, createAlarmTopic(this, config, 'alarms-api'));

    this.api_url = this.api.apiEndpoint;

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.apiEndpoint,
      exportName: `${config.prefix}-ApiUrl`,
      description: 'Control-plane endpoint the front end calls.',
    });
  }
}