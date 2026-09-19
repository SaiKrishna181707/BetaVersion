import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Construct } from 'constructs';
import { REPO_ROOT, type BetaVersionConfig } from './config';

export interface WebStackProps extends StackProps {
  config: BetaVersionConfig;
}

/**
 * The reviewer's console.
 *
 * Two hosting models, never both: when a Git repository is configured the Amplify app builds
 * and serves the site from source; otherwise the built `apps/web/dist` is published to S3
 * behind CloudFront. Which one is in use is visible in the stack outputs, so nobody has to
 * guess whether the deployment is the branch or a snapshot of it.
 */
export class BetaVersionWebStack extends Stack {
  readonly site_url: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;

    if (config.amplify_repository !== undefined) {
      const app = new amplify.CfnApp(this, 'AmplifyApp', {
        name: `${config.prefix}-${config.env_name}-web`,
        description: `${config.prefix} synthetic QA console`,
        repository: config.amplify_repository,
        oauthToken: config.amplify_oauth_token_secret_arn,
        environmentVariables: [
          { name: 'VITE_API_BASE_URL', value: config.web_api_base_url },
        ],
        buildSpec: [
          'version: 1',
          'frontend:',
          '  phases:',
          '    preBuild:',
          '      commands:',
          '        - npm ci',
          '    build:',
          '      commands:',
          '        - npm run build --workspace @synthetic-beta/web',
          '  artifacts:',
          '    baseDirectory: apps/web/dist',
          '    files:',
          '      - "**/*"',
          '  cache:',
          '    paths:',
          '      - node_modules/**/*',
        ].join('\n'),
      });
      new amplify.CfnBranch(this, 'AmplifyBranch', {
        appId: app.attrAppId,
        branchName: config.amplify_branch,
        enableAutoBuild: true,
        stage: config.env_name === 'prod' ? 'PRODUCTION' : 'DEVELOPMENT',
      });
      this.site_url = `https://${config.amplify_branch}.${app.attrDefaultDomain}`;
      new CfnOutput(this, 'SiteUrl', {
        value: this.site_url,
        exportName: `${config.prefix}-SiteUrl`,
        description: 'Amplify Hosting URL of the reviewer console.',
      });
      new CfnOutput(this, 'AmplifyAppId', {
        value: app.attrAppId,
        exportName: `${config.prefix}-AmplifyAppId`,
        description: 'Amplify app id, for wiring a custom domain or a webhook.',
      });
      return;
    }

    const dist = join(REPO_ROOT, 'apps', 'web', 'dist');
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. The console is deployed as a build output: run "npm run build" in the repository root before synthesising, or set BETAVERSION_AMPLIFY_REPOSITORY to let Amplify Hosting build the branch instead.`,
      );
    }

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${config.prefix.toLowerCase()}-web-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.removal_policy,
      // The bucket holds a build output, not evidence: it follows the stack's own lifecycle.
      autoDeleteObjects: config.removal_policy === RemovalPolicy.DESTROY,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: `${config.prefix} ${config.env_name} reviewer console`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        // The console is a single-page app: an unknown path is a route, not a 404 page.
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      sources: [s3deploy.Source.asset(dist)],
    });

    this.site_url = `https://${distribution.distributionDomainName}`;
    new CfnOutput(this, 'SiteUrl', {
      value: this.site_url,
      exportName: `${config.prefix}-SiteUrl`,
      description: 'CloudFront URL of the reviewer console.',
    });
    new CfnOutput(this, 'SiteBucketName', {
      value: bucket.bucketName,
      exportName: `${config.prefix}-SiteBucketName`,
      description: 'S3 bucket the built console is published to.',
    });
  }
}