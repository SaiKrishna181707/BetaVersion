import { join } from 'node:path';
import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * Deployment configuration, read from the environment.
 *
 * No account id, region, credential, or target URL is hardcoded here. The account and region
 * come from the CDK environment (`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, or `-c` context)
 * and everything else has a documented default an operator can override.
 */
export interface BetaVersionConfig {
  /** Resource-name prefix. Keeps every resource recognisable as part of this project. */
  prefix: string;
  /** Short environment name used in stack names, for example `dev` or `beta`. */
  env_name: string;
  /** Domains the control plane accepts as targets. Exact hosts, no wildcards. */
  authorized_domains: string[];
  /** Origins allowed to call the control plane from a browser. Exact origins, no wildcards. */
  cors_origins: string[];
  /** API base URL compiled into the web build. Empty means the site calls its own origin. */
  web_api_base_url: string;
  /** Checkpoints the target under test declares, in order. */
  checkpoint_plan: string[];
  /** Git repository to connect Amplify Hosting to. Unset means manual deployment. */
  amplify_repository?: string;
  amplify_branch: string;
  amplify_oauth_token_secret_arn?: string;
  /** Name of the AgentCore Browser resource the session worker connects to. */
  agentcore_browser_name: string;
  /** Pip requirement for the Nova Act SDK, pinned by the operator at deploy time. */
  nova_act_requirement: string;
  nova_act_model_id?: string;
  /** CloudWatch log retention in days. */
  log_retention_days: number;
  /** Address that receives budget and alarm notifications, when one is configured. */
  alarm_email?: string;
  /** Monthly cost ceiling in USD. Mirrors GLOBAL_SPEND_CEILING_USD in the contracts package. */
  monthly_budget_usd: number;
  removal_policy: RemovalPolicy;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.length === 0) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BetaVersionConfig {
  const env_name = environment.BETAVERSION_ENV ?? 'dev';
  const ephemeral = readBoolean(environment.BETAVERSION_EPHEMERAL, env_name !== 'prod');
  const split = (value: string | undefined, fallback: readonly string[]): string[] => {
    if (value === undefined || value.trim().length === 0) return [...fallback];
    return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
  };
  return {
    prefix: environment.BETAVERSION_PREFIX ?? 'BetaVersion',
    env_name,
    authorized_domains: split(environment.BETAVERSION_AUTHORIZED_DOMAINS, ['localhost', '127.0.0.1']),
    cors_origins: split(
      environment.BETAVERSION_CORS_ORIGINS,
      ['http://localhost:5173', 'http://127.0.0.1:5173'],
    ),
    web_api_base_url: environment.BETAVERSION_WEB_API_BASE_URL ?? '',
    checkpoint_plan: split(environment.BETAVERSION_CHECKPOINT_PLAN, ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE']),
    amplify_repository: environment.BETAVERSION_AMPLIFY_REPOSITORY,
    amplify_branch: environment.BETAVERSION_AMPLIFY_BRANCH ?? 'main',
    amplify_oauth_token_secret_arn: environment.BETAVERSION_AMPLIFY_OAUTH_TOKEN_SECRET_ARN,
    agentcore_browser_name: environment.BETAVERSION_AGENTCORE_BROWSER_NAME ?? 'BetaVersionBrowser',
    nova_act_requirement: environment.BETAVERSION_NOVA_ACT_REQUIREMENT ?? 'nova-act',
    nova_act_model_id: environment.BETAVERSION_NOVA_ACT_MODEL_ID,
    log_retention_days: Number(environment.BETAVERSION_LOG_RETENTION_DAYS ?? 30),
    alarm_email: environment.BETAVERSION_ALARM_EMAIL,
    monthly_budget_usd: Number(environment.BETAVERSION_MONTHLY_BUDGET_USD ?? 250),
    removal_policy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
  };
}

/** Repository paths the stacks build their assets from. */
export const REPO_ROOT = join(__dirname, '..', '..', '..');
/** Control plane: API Gateway in, one Lambda handler out. */
export const API_LAMBDA_ENTRY = join(REPO_ROOT, 'services', 'api', 'src', 'aws', 'lambda.ts');
/** One session: opens an AgentCore Browser session and records its trace. */
export const SESSION_LAMBDA_ENTRY = join(REPO_ROOT, 'services', 'agent-worker', 'src', 'lambda', 'session.ts');
/** After the Map: metrics, report, and the evidence index over what was actually recorded. */
export const FINALIZE_LAMBDA_ENTRY = join(REPO_ROOT, 'services', 'api', 'src', 'aws', 'finalize.ts');