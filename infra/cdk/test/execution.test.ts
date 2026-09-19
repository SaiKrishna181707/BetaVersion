import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { loadConfig } from '../lib/config';
import { BetaVersionDataStack } from '../lib/data-stack';
import { BetaVersionExecutionStack } from '../lib/execution-stack';

test('synthesized execution passes Map items correctly and scopes the real Nova Act worker', () => {
  const app = new App({ context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong' } });
  const config = loadConfig({ BETAVERSION_AMPLIFY_BRANCH: 'feat/product-foundation' });
  const data = new BetaVersionDataStack(app, 'TestData', { config });
  const stack = new BetaVersionExecutionStack(app, 'TestExecution', { config, data });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::BedrockAgentCore::BrowserCustom', 1);
  template.resourceCountIs('AWS::NovaAct::WorkflowDefinition', 1);
  template.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', Timeout: 360,
    Environment: { Variables: { BETAVERSION_NOVA_MODEL_ID: 'nova-act-latest' } } });
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
  const state = Object.values(resources).find(resource => resource.Type === 'AWS::StepFunctions::StateMachine');
  const definition = state?.Properties.DefinitionString as { 'Fn::Join': [string, unknown[]] };
  const asl = JSON.parse(definition['Fn::Join'][1].map(part => typeof part === 'string' ? part : 'arn:test:lambda').join(''));
  assert.deepEqual(asl.States.Sessions.ItemSelector, { 'run_id.$': '$.run_id', 'session.$': '$$.Map.Item.Value', 'limits.$': '$.limits' });
  const worker = asl.States.Sessions.ItemProcessor.States.ExecuteSession;
  assert.equal(worker.Parameters['plan.$'], '$.session');
  assert.equal(worker.Retry, undefined, 'the state machine cannot multiply the worker retry ceiling');
  assert.equal(asl.States.Sessions.MaxConcurrencyPath, '$.limits.batch_size');
  assert.equal(asl.States.FinalizeResults.Next, 'CheckRunResult');
  const policies = Object.values(resources).filter(resource => resource.Type === 'AWS::IAM::Policy');
  const statements = policies.flatMap(policy => (policy.Properties.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] }).Statement);
  const actions = statements.flatMap(statement => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
  assert.ok(actions.includes('nova-act:InvokeActStep'));
  assert.ok(actions.includes('bedrock-agentcore:StartBrowserSession'));
  assert.ok(!actions.some(action => action === '*' || /^(s3|dynamodb):Delete|ListBrowsers|bedrock:InvokeModel/.test(action)));
  for (const statement of statements.filter(item => item.Resource === '*')) {
    const unscoped = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    assert.ok(unscoped.every(action => action.startsWith('logs:') || action.startsWith('xray:')), 'only AWS log delivery and X-Ray use service-required wildcard resources');
  }
  assert.ok(!JSON.stringify(resources).includes('AdministratorAccess'));
});
