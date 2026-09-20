import { CfnOutput, Duration, RemovalPolicy, Stack, type App } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as gateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as nova from 'aws-cdk-lib/aws-novaact';
import { GUARDRAILS } from '../../packages/contracts/src/model';
import { resolve } from 'node:path';
import type { DeploymentConfig } from './config';

/** Main's cross-account execution architecture, using its top-level DynamoDB records. */
export function createStacks(app: App, config: DeploymentConfig) {
  const { prefix, region, controlAccount, agentAccount } = config;
  const control = new Stack(app, `${prefix}-control`, { env: { account: controlAccount, region } });
  const agent = new Stack(app, `${prefix}-agent`, { env: { account: agentAccount, region } });
  const workerRoleName = `${prefix}-session-worker`;
  const bridgeRoleName = `${prefix}-agent-execution`;
  const novaFunctionName = `${prefix}-nova-worker`;
  const bridgeArn = `arn:aws:iam::${agentAccount}:role/${bridgeRoleName}`;
  const novaArn = `arn:aws:lambda:${region}:${agentAccount}:function:${novaFunctionName}`;
  const table = config.existingStateTable
    ? dynamodb.Table.fromTableName(control, 'State', config.existingStateTable)
    : new dynamodb.Table(control, 'State', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, timeToLiveAttribute: 'ttl', removalPolicy: RemovalPolicy.RETAIN });
  const bucket = config.existingArtifactBucket
    ? s3.Bucket.fromBucketName(control, 'Artifacts', config.existingArtifactBucket)
    : new s3.Bucket(control, 'Artifacts', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED, versioned: true, removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(7), noncurrentVersionExpiration: Duration.days(7) }] });
  const topic = new sns.Topic(control, 'Alerts');
  if (config.alarmEmail) topic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
  topic.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
    actions: ['sns:Publish'], resources: [topic.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': controlAccount } } }));
  new budgets.CfnBudget(control, 'Budget', {
    budget: { budgetName: `${prefix}-monthly-notification`, budgetType: 'COST', timeUnit: 'MONTHLY',
      budgetLimit: { amount: GUARDRAILS.GLOBAL_SPEND_CEILING_USD, unit: 'USD' } },
    notificationsWithSubscribers: [80, 100].map(threshold => ({
      notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'ACTUAL', threshold, thresholdType: 'PERCENTAGE' },
      subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }],
    })),
  });
  const workerRole = new iam.Role(control, 'WorkerRole', { roleName: workerRoleName, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')] });
  workerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [bridgeArn],
    conditions: { StringEquals: { 'sts:ExternalId': config.externalId } } }));
  const makeFunction = (id: string, bundle: string, timeout: number, extra: Partial<lambda.FunctionProps> = {}) => {
    const fn = new lambda.Function(control, id, { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler',
      code: lambda.Code.fromAsset(resolve('.artifacts/lambda-bundles', bundle)), timeout: Duration.seconds(timeout), memorySize: 1024,
      logGroup: new logs.LogGroup(control, `${id}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN }),
      environment: { STATE_TABLE: table.tableName, ARTIFACT_BUCKET: bucket.bucketName }, ...extra });
    table.grantReadWriteData(fn);
    new cloudwatch.Alarm(control, `${id}Errors`, { metric: fn.metricErrors(), threshold: 1, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING }).addAlarmAction(new actions.SnsAction(topic));
    return fn;
  };
  const worker = makeFunction('SessionWorker', 'worker', 420, { role: workerRole, reservedConcurrentExecutions: GUARDRAILS.MAX_BATCH_SIZE });
  worker.addEnvironment('AGENT_EXECUTION_ROLE_ARN', bridgeArn);
  worker.addEnvironment('NOVA_WORKER_FUNCTION_ARN', novaArn);
  worker.addEnvironment('CROSS_ACCOUNT_EXTERNAL_ID', config.externalId);
  worker.addEnvironment('AGENT_REGION', region);
  bucket.grantPut(worker, 'nova-trajectories/*');
  const finalizer = makeFunction('Finalizer', 'finalizer', 180);
  bucket.grantPut(finalizer, 'reports/*');
  finalizer.addEnvironment('NOVA_REPORT_MODEL_ID', 'amazon.nova-micro-v1:0');
  finalizer.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0'] }));

  const sessionTask = new tasks.LambdaInvoke(control, 'ExecuteSession', { lambdaFunction: worker,
    payloadResponseOnly: true, retryOnServiceExceptions: false, taskTimeout: sfn.Timeout.duration(Duration.seconds(450)) });
  const map = new sfn.Map(control, 'Sessions', { itemsPath: '$.sessions', maxConcurrencyPath: '$.maxConcurrency', resultPath: sfn.JsonPath.DISCARD });
  map.itemProcessor(sessionTask);
  const finalize = new tasks.LambdaInvoke(control, 'Finalize', { lambdaFunction: finalizer, payloadResponseOnly: true,
    payload: sfn.TaskInput.fromObject({ runId: sfn.JsonPath.stringAt('$.runId') }), resultPath: '$.finalization' });
  const failedFinalize = new tasks.LambdaInvoke(control, 'FinalizeFailed', { lambdaFunction: finalizer, payloadResponseOnly: true,
    payload: sfn.TaskInput.fromObject({ runId: sfn.JsonPath.stringAt('$.runId'), failed: true }), resultPath: '$.finalization' });
  const settle = new sfn.Wait(control, 'WaitForInFlightWorkers', { time: sfn.WaitTime.duration(Duration.seconds(480)) });
  settle.next(failedFinalize).next(new sfn.Fail(control, 'ExecutionFailed'));
  map.addCatch(settle, { resultPath: '$.failure' });
  finalize.addCatch(settle, { resultPath: '$.failure' });
  map.next(finalize).next(new sfn.Choice(control, 'ReportOutcome')
    .when(sfn.Condition.stringEquals('$.finalization.status', 'COMPLETED'), new sfn.Succeed(control, 'Completed'))
    .otherwise(new sfn.Fail(control, 'SessionsFailed')));
  const gate = new sfn.Choice(control, 'ValidateConcurrency').when(sfn.Condition.and(
    sfn.Condition.numberGreaterThanEquals('$.maxConcurrency', 1),
    sfn.Condition.numberLessThanEquals('$.maxConcurrency', GUARDRAILS.MAX_BATCH_SIZE)), map)
    .otherwise(new sfn.Fail(control, 'InvalidConcurrency'));
  const machine = new sfn.StateMachine(control, 'RunOrchestrator', { stateMachineName: `${prefix}-run-orchestrator`, definitionBody: sfn.DefinitionBody.fromChainable(gate),
    timeout: Duration.hours(2), logs: { destination: new logs.LogGroup(control, 'RunLogs', { retention: logs.RetentionDays.ONE_WEEK }),
      level: sfn.LogLevel.ERROR, includeExecutionData: false } });
  finalizer.addEnvironment('RUN_STATE_MACHINE_ARN', `arn:aws:states:${region}:${controlAccount}:stateMachine:${prefix}-run-orchestrator`);
  finalizer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [`arn:aws:states:${region}:${controlAccount}:execution:${prefix}-run-orchestrator:*`] }));
  // Stops/timeouts bypass the Map catch. Let already-running browsers finish before reconciliation.
  const reconcile = new sfn.Wait(control, 'WaitAfterInterruption', { time: sfn.WaitTime.duration(Duration.seconds(480)) });
  reconcile.next(new tasks.LambdaInvoke(control, 'Reconcile', { lambdaFunction: finalizer, payloadResponseOnly: true }));
  const cleanup = new sfn.StateMachine(control, 'InterruptionReconciliation', { definitionBody: sfn.DefinitionBody.fromChainable(reconcile), timeout: Duration.minutes(15) });
  new events.Rule(control, 'InterruptedRuns', { eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
    detail: { stateMachineArn: [machine.stateMachineArn], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } }, targets: [new targets.SfnStateMachine(cleanup)] });

  const apiFunction = makeFunction('Api', 'api', 45);
  apiFunction.addEnvironment('RUN_STATE_MACHINE_ARN', machine.stateMachineArn);
  apiFunction.addEnvironment('AMPLIFY_ORIGIN', config.webOrigin);
  apiFunction.addEnvironment('REQUIRE_AUTH', 'true');
  apiFunction.addEnvironment('NOVA_INTELLIGENCE_MODEL_ID', 'amazon.nova-micro-v1:0');
  apiFunction.addEnvironment('NOVA_PERSONA_MODEL_ID', 'amazon.nova-lite-v1:0');
  apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [
    'arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0',
    'arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0',
  ] }));
  machine.grantStartExecution(apiFunction); machine.grantExecution(apiFunction, 'states:StopExecution');
  bucket.grantRead(apiFunction, 'reports/*'); bucket.grantRead(apiFunction, 'nova-trajectories/*');
  const operatorPool = new cognito.UserPool(control, 'Operators', {
    userPoolName: prefix + '-operators',
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const operatorClient = operatorPool.addClient('WebClient', {
    generateSecret: false,
    preventUserExistenceErrors: true,
    oAuth: {
      flows: { authorizationCodeGrant: true },
      callbackUrls: [config.webOrigin + '/auth/callback'],
      logoutUrls: [config.webOrigin],
    },
  });
  operatorPool.addDomain('HostedUi', { cognitoDomain: { domainPrefix: config.cognitoDomainPrefix } });

  const integration = new HttpLambdaIntegration('ProductionApi', apiFunction);
  const operatorAuthorizer = new HttpUserPoolAuthorizer('OperatorAuthorizer', operatorPool, {
    userPoolClients: [operatorClient],
  });
  const api = new gateway.HttpApi(control, 'HttpApi', { corsPreflight: { allowOrigins: [config.webOrigin],
    allowMethods: [gateway.CorsHttpMethod.GET, gateway.CorsHttpMethod.POST, gateway.CorsHttpMethod.PATCH, gateway.CorsHttpMethod.OPTIONS],
    allowHeaders: ['content-type', 'authorization'] } });
  api.addRoutes({ path: '/health', methods: [gateway.HttpMethod.GET], integration });
  api.addRoutes({ path: '/{proxy+}', integration, authorizer: operatorAuthorizer });
  new CfnOutput(control, 'OperatorUserPoolId', { value: operatorPool.userPoolId });
  new CfnOutput(control, 'OperatorClientId', { value: operatorClient.userPoolClientId });
  new CfnOutput(control, 'OperatorHostedUi', { value: 'https://' + config.cognitoDomainPrefix + '.auth.' + region + '.amazoncognito.com' });

  const workflow = new nova.CfnWorkflowDefinition(agent, 'NovaWorkflow', { name: `${prefix}-browser-session` });
  const novaWorker = new lambda.DockerImageFunction(agent, 'NovaWorker', { functionName: novaFunctionName,
    code: lambda.DockerImageCode.fromImageAsset(resolve('services/nova-worker')),
    architecture: lambda.Architecture.X86_64, timeout: Duration.seconds(360), memorySize: 2048,
    reservedConcurrentExecutions: GUARDRAILS.MAX_BATCH_SIZE,
    environment: { NOVA_ACT_WORKFLOW_NAME: workflow.name, NOVA_ACT_MODEL_ID: 'nova-act-latest', AGENTCORE_BROWSER_IDENTIFIER: 'aws.browser.v1' },
    logGroup: new logs.LogGroup(agent, 'NovaLogs', { retention: logs.RetentionDays.ONE_WEEK }) });
  novaWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
    resources: [`arn:aws:bedrock-agentcore:${region}:aws:browser/aws.browser.v1`] }));
  novaWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['nova-act:CreateWorkflowRun', 'nova-act:UpdateWorkflowRun', 'nova-act:CreateSession', 'nova-act:CreateAct', 'nova-act:UpdateAct', 'nova-act:InvokeActStep'], resources: [workflow.attrArn] }));
  const bridge = new iam.Role(agent, 'ControlBridge', { roleName: bridgeRoleName,
    assumedBy: new iam.AccountPrincipal(controlAccount).withConditions({ StringEquals: { 'sts:ExternalId': config.externalId },
      ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${controlAccount}:role/${workerRoleName}` } }) });
  novaWorker.grantInvoke(bridge);
  new CfnOutput(control, 'ApiUrl', { value: api.apiEndpoint });
  new CfnOutput(control, 'StateTable', { value: table.tableName });
  new CfnOutput(control, 'ArtifactBucket', { value: bucket.bucketName });
  new CfnOutput(control, 'StateMachineArn', { value: machine.stateMachineArn });
  return { control, agent };
}
