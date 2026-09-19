#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { BetaVersionApiStack } from '../lib/api-stack';
import { loadConfig } from '../lib/config';
import { BetaVersionDataStack } from '../lib/data-stack';
import { BetaVersionExecutionStack } from '../lib/execution-stack';
import { EXECUTION_LIMITS } from '../lib/limits';
import { createMonthlyBudget } from '../lib/observability';
import { BetaVersionWebStack } from '../lib/web-stack';

/**
 * The BetaVersion CDK app.
 *
 * Everything environment-specific comes from the environment (see lib/config.ts): no account
 * id, region, credential, or target URL is stored here. Stacks are named
 * `<prefix>-<env>-<layer>` so a deployment is recognisable in the console and in a bill.
 */
const app = new App();
const config = loadConfig();
const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
const base = `${config.prefix}-${config.env_name}`;

const data = new BetaVersionDataStack(app, `${base}-data`, {
  env: environment,
  config,
  description: `${config.prefix} ${config.env_name}: run records and evidence`,
});
const executionConfig = { ...config, authorized_domains: [...config.authorized_domains, data.demo_domain] };

const execution = new BetaVersionExecutionStack(app, `${base}-execution`, {
  env: environment,
  config: executionConfig,
  data,
  description: `${config.prefix} ${config.env_name}: AgentCore Browser, session worker, and Step Functions`,
});


const api = new BetaVersionApiStack(app, `${base}-api`, {
  env: environment,
  config: executionConfig,
  data,
  execution,
  description: `${config.prefix} ${config.env_name}: control plane`,
});
const web = new BetaVersionWebStack(app, `${base}-web`, {
  env: environment,
  config: { ...executionConfig, web_api_base_url: api.api_url },
  description: `${config.prefix} ${config.env_name}: reviewer console`,
});

// The account-level cost guard sits with the control plane that starts the spend.
createMonthlyBudget(api, 'MonthlyBudget', config);

Tags.of(app).add('project', config.prefix);
Tags.of(app).add('environment', config.env_name);
Tags.of(app).add('managed-by', 'cdk');
Tags.of(app).add('spend-ceiling-usd', String(EXECUTION_LIMITS.global_spend_ceiling_usd));

void web;
