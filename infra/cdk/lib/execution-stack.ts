import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets';
import * as novaact from 'aws-cdk-lib/aws-novaact';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { REPO_ROOT, FINALIZE_LAMBDA_ENTRY, type BetaVersionConfig } from './config';
import type { BetaVersionDataStack } from './data-stack';
import { bundledFunction } from './lambda-bundle';
import { EXECUTION_LIMITS } from './limits';
import { addErrorAndLatencyAlarms, createAlarmTopic, createLogGroup } from './observability';

export interface ExecutionStackProps extends StackProps {
  config: BetaVersionConfig;
  data: BetaVersionDataStack;
}

const DEFAULT_NOVA_MODEL_ID = 'nova-act-latest';

/**
 * The execution layer: one AgentCore Browser, one session worker, one finalizer, and the
 * Step Functions state machine that bounds them.
 *
 * The state machine is the AWS expression of the limits the orchestrator enforces locally:
 * the Map's concurrency is the batch size, a session task cannot outlive the session
 * ceiling, the retry ceiling is the same two attempts, and the whole execution cannot
 * outlive the global run timeout. One AWS run is therefore bounded exactly like one local
 * run, which is what makes the two comparable.
 */
export class BetaVersionExecutionStack extends Stack {
  readonly browser: agentcore.BrowserCustom;
  readonly session_function: lambda.DockerImageFunction;
  readonly finalize_function: ReturnType<typeof bundledFunction>;
  readonly state_machine: sfn.StateMachine;

  private readonly config: BetaVersionConfig;
  private readonly data: BetaVersionDataStack;

  constructor(scope: Construct, id: string, props: ExecutionStackProps) {
    super(scope, id, props);
    const { config, data } = props;
    this.config = config;
    this.data = data;
    const region = this.region;
    const model_id = config.nova_act_model_id ?? DEFAULT_NOVA_MODEL_ID;
    const workflow = new novaact.CfnWorkflowDefinition(this, 'NovaWorkflow', {
      name: `${config.prefix}-${config.env_name}-qa`,
      description: 'Authorized demo browser QA sessions',
    });

    // The browser, not the worker, is the isolation boundary: one browser session per
    // synthetic user, with its own cookies, storage, and profile.
    this.browser = new agentcore.BrowserCustom(this, 'Browser', {
      browserCustomName: config.agentcore_browser_name.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: `${config.prefix} isolated browser sessions for synthetic QA runs`,
      networkConfiguration: agentcore.BrowserNetworkConfiguration.usingPublicNetwork(),
      recordingConfig: {
        enabled: true,
        s3Location: { bucketName: data.evidence_bucket.bucketName, objectKey: 'browser-recordings/' },
      },
    });

    const topic = createAlarmTopic(this, config, 'alarms-execution');

    const commonEnvironment: Record<string, string> = {
      BETAVERSION_RUN_TABLE: data.run_table.tableName,
      BETAVERSION_EVIDENCE_BUCKET: data.evidence_bucket.bucketName,
      BETAVERSION_AUTHORIZED_DOMAINS: config.authorized_domains.join(','),
      BETAVERSION_CHECKPOINT_PLAN: config.checkpoint_plan.join(','),
      BETAVERSION_AGENTCORE_BROWSER_NAME: this.browser.browserId,
      BETAVERSION_PREFIX: config.prefix,
    };

    this.session_function = new lambda.DockerImageFunction(this, 'SessionWorker', {
      code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
        file: 'services/agent-worker/Dockerfile', platform: ecrassets.Platform.LINUX_ARM64,
        buildArgs: { NOVA_ACT_REQUIREMENT: config.nova_act_requirement },
        exclude: ['.git', '.cache', '.artifacts', '**/node_modules', '**/dist', 'infra/cdk/cdk.out'],
      }),
      architecture: lambda.Architecture.ARM_64,
      description: `${config.prefix} session worker: one synthetic user in one AgentCore Browser session`,
      timeout: Duration.seconds(EXECUTION_LIMITS.max_session_seconds + 60),
      memorySize: 2048,
      logGroup: createLogGroup(this, 'SessionLogs', config, 'session'),
      environment: {
        ...commonEnvironment,
        BETAVERSION_AGENTCORE_REGION: region,
        BETAVERSION_NOVA_MODEL_ID: model_id,
        BETAVERSION_NOVA_WORKFLOW_NAME: workflow.name,
        BETAVERSION_ARTIFACTS_DIR: '/tmp/betaversion',
      },
    });

    this.finalize_function = bundledFunction(this, 'FinalizeRun', {
      entry: FINALIZE_LAMBDA_ENTRY,
      description: `${config.prefix} finalize: deterministic metrics, report, and evidence over recorded events`,
      timeout_seconds: 300,
      memory_mb: 1024,
      log_group: createLogGroup(this, 'FinalizeLogs', config, 'finalize'),
      environment: commonEnvironment,
    });

    this.grantSessionPermissions(workflow.attrArn);
    this.grantFinalizePermissions();
    addErrorAndLatencyAlarms(this, 'Session', 'session-worker', this.session_function, config, topic);
    addErrorAndLatencyAlarms(this, 'Finalize', 'finalize-run', this.finalize_function, config, topic);

    this.state_machine = this.buildStateMachine();
    // State-machine timeouts and operator stops bypass the normal finalizer task.
    new events.Rule(this, 'InterruptedRuns', {
      eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
        detail: { stateMachineArn: [this.state_machine.stateMachineArn], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } },
      targets: [new targets.LambdaFunction(this.finalize_function)],
    });
    this.finalize_function.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'],
      resources: [this.formatArn({ service: 'states', resource: 'execution', resourceName: `${config.prefix}-${config.env_name}-run:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));

    new CfnOutput(this, 'BrowserId', {
      value: this.browser.browserId,
      exportName: `${config.prefix}-BrowserId`,
      description: 'AgentCore Browser the session worker connects to.',
    });
    new CfnOutput(this, 'StateMachineArn', {
      value: this.state_machine.stateMachineArn,
      exportName: `${config.prefix}-StateMachineArn`,
      description: 'State machine that executes one AWS run.',
    });
    new CfnOutput(this, 'SessionFunctionName', {
      value: this.session_function.functionName,
      exportName: `${config.prefix}-SessionFunctionName`,
      description: 'Lambda that executes exactly one synthetic session.',
    });
  }

  /**
   * A session worker may open a browser session, read and write this project's own table and
   * bucket, and use the configured Nova Act workflow.
   */
  private grantSessionPermissions(workflowArn: string): void {
    const fn = this.session_function;
    fn.addToRolePolicy(new iam.PolicyStatement({
      // The automation stream carries the CDP traffic; it is a data-plane action the
      // browser's use grant does not cover on its own.
      actions: ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:ConnectBrowserAutomationStream'],
      resources: [this.browser.browserArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['nova-act:CreateWorkflowRun', 'nova-act:UpdateWorkflowRun', 'nova-act:CreateSession',
        'nova-act:CreateAct', 'nova-act:UpdateAct', 'nova-act:InvokeActStep'],
      resources: [workflowArn],
    }));
    this.data.run_table.grant(fn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem');
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [this.data.evidence_bucket.arnForObjects('runs/*')] }));
  }

  /**
   * The finalizer only reads what the run produced and writes the derived artefacts, so it
   * takes exactly the grants the run store needs and nothing more.
   */
  private grantFinalizePermissions(): void {
    const fn = this.finalize_function;
    this.data.run_table.grant(fn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query');
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [this.data.evidence_bucket.arnForObjects('runs/*')] }));
  }

  private buildStateMachine(): sfn.StateMachine {
    const config = this.config;

    const executeSession = new tasks.LambdaInvoke(this, 'ExecuteSession', {
      lambdaFunction: this.session_function,
      comment: 'One synthetic user in one isolated AgentCore Browser session.',
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      payload: sfn.TaskInput.fromObject({
        run_id: sfn.JsonPath.stringAt('$.run_id'),
        plan: sfn.JsonPath.objectAt('$.session'),
        limits: sfn.JsonPath.objectAt('$.limits'),
      }),
      taskTimeout: sfn.Timeout.duration(Duration.seconds(EXECUTION_LIMITS.max_session_seconds + 60)),
    });
    // The worker owns the two-attempt ceiling. Retrying this task would execute the
    // browser again and overwrite its first attempt's evidence.
    executeSession.addCatch(new sfn.Pass(this, 'SessionInfrastructureFailure', {
      result: sfn.Result.fromObject({ status: 'FAILED' }),
    }), { resultPath: '$.worker_error' });

    const sessions = new sfn.Map(this, 'Sessions', {
      comment: 'Every planned persona gets its own session; concurrency is the batch size.',
      itemsPath: '$.plan.sessions',
      itemSelector: {
        'run_id.$': '$.run_id', 'session.$': '$$.Map.Item.Value', 'limits.$': '$.limits',
      },
      maxConcurrencyPath: '$.limits.batch_size',
      // The plan is what the finalizer needs; twenty per-session results would only bloat state.
      resultPath: sfn.JsonPath.DISCARD,
    });
    sessions.itemProcessor(executeSession);

    const finalize = new tasks.LambdaInvoke(this, 'FinalizeResults', {
      lambdaFunction: this.finalize_function,
      comment: 'Deterministic metrics, report, and evidence over the events that were recorded.',
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        run_id: sfn.JsonPath.stringAt('$.run_id'),
        plan: sfn.JsonPath.objectAt('$.plan'),
        limits: sfn.JsonPath.objectAt('$.limits'),
        finalize_failed_run: false,
      }),
    });

    const finalizeFailed = new tasks.LambdaInvoke(this, 'FinalizeFailedRun', {
      lambdaFunction: this.finalize_function,
      comment: 'A run that could not execute every session is still closed out with the evidence it has.',
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        run_id: sfn.JsonPath.stringAt('$.run_id'),
        plan: sfn.JsonPath.objectAt('$.plan'),
        limits: sfn.JsonPath.objectAt('$.limits'),
        finalize_failed_run: true,
        failure: sfn.JsonPath.objectAt('$.error'),
      }),
    });

    sessions.addCatch(finalizeFailed, { resultPath: '$.error' });
    sessions.next(finalize);
    finalize.next(new sfn.Choice(this, 'CheckRunResult')
      .when(sfn.Condition.stringEquals('$.state', 'COMPLETED'), new sfn.Succeed(this, 'RunCompleted'))
      .otherwise(new sfn.Fail(this, 'RunHadFailures', { error: 'RunFailed', cause: 'Read the recorded run report for evidence.' })));
    finalizeFailed.next(new sfn.Fail(this, 'RunFailed', {
      error: 'RunExecutionFailed',
      cause: 'At least one session could not be executed. The run was recorded as FAILED with the evidence that was collected.',
    }));

    return new sfn.StateMachine(this, 'RunStateMachine', {
      stateMachineName: `${config.prefix}-${config.env_name}-run`,
      comment: `Executes up to ${EXECUTION_LIMITS.max_users} independent synthetic sessions against an authorized target.`,
      definitionBody: sfn.DefinitionBody.fromChainable(sessions),
      // One execution cannot outlive the global run timeout, whatever the Map is doing.
      timeout: Duration.millis(EXECUTION_LIMITS.max_run_timeout_ms),
      tracingEnabled: true,
      logs: {
        destination: createLogGroup(this, 'StateMachineLogs', config, 'runs'),
        level: sfn.LogLevel.ALL,
        // The plan payload names the target and the personas; execution data would duplicate it.
        includeExecutionData: false,
      },
    });
  }
}
