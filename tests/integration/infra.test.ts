import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createStacks } from '../../infra/cdk/stacks';
import { loadDeploymentConfig, validationConfig } from '../../infra/cdk/config';
import { GUARDRAILS } from '@synthetic-beta/contracts';

test('CDK defines main storage schema, public judge API, cross-account worker and shared limits', () => {
  const app = new App();
  const stacks = createStacks(app, validationConfig);
  const control = Template.fromStack(stacks.control);
  const agent = Template.fromStack(stacks.agent);
  control.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });
  control.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: GUARDRAILS.GLOBAL_SPEND_CEILING_USD, Unit: 'USD' } }) });
  control.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Runtime: 'nodejs22.x', ReservedConcurrentExecutions: GUARDRAILS.MAX_BATCH_SIZE });
  control.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /{proxy+}', AuthorizationType: 'NONE' });
  control.resourceCountIs('AWS::Cognito::UserPool', 0);
  agent.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', Timeout: 360, ReservedConcurrentExecutions: GUARDRAILS.MAX_BATCH_SIZE });
  agent.hasResourceProperties('AWS::IAM::Role', { RoleName: `${validationConfig.prefix}-agent-execution`, AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Condition: {
    StringEquals: { 'sts:ExternalId': validationConfig.externalId }, ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${validationConfig.controlAccount}:role/${validationConfig.prefix}-session-worker` },
  } })]) }) });
  // Synthesis validates dependency graphs too: no finalizer/state-machine cycle.
  assert.equal(app.synth().stacks.length, 2);
});

test('deployment config never infers production accounts or silently adopts the old foundation stack', () => {
  assert.throws(() => loadDeploymentConfig({}), /explicitly configured/);
  assert.throws(() => loadDeploymentConfig({ CENTOPUS_CONTROL_ACCOUNT: '111111111111', CENTOPUS_AGENT_ACCOUNT: '111111111111' }), /distinct/);
});
