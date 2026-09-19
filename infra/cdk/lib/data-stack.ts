import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { BetaVersionConfig } from './config';

export interface DataStackProps extends StackProps {
  config: BetaVersionConfig;
}

/**
 * Run metadata and evidence storage.
 *
 * DynamoDB holds the control-plane records (runs and sessions) because they are read and
 * updated item by item. S3 holds the bulk material (events, traces, artefacts, screenshots,
 * replays) because it is written once and read whole. Both are retained on stack deletion:
 * a run's evidence is the audit trail behind a report.
 */
export class BetaVersionDataStack extends Stack {
  readonly run_table: dynamodb.Table;
  readonly evidence_bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.run_table = new dynamodb.Table(this, 'RunTable', {
      tableName: `${config.prefix}Runs`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expires_at',
      removalPolicy: config.removal_policy,
    });

    this.evidence_bucket = new s3.Bucket(this, 'EvidenceBucket', {
      bucketName: `${config.prefix.toLowerCase()}-evidence-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.removal_policy,
      lifecycleRules: [
        {
          id: 'expire-noncurrent-evidence',
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    new CfnOutput(this, 'RunTableName', {
      value: this.run_table.tableName,
      exportName: `${config.prefix}-RunTableName`,
      description: 'DynamoDB table holding run and session records.',
    });
    new CfnOutput(this, 'EvidenceBucketName', {
      value: this.evidence_bucket.bucketName,
      exportName: `${config.prefix}-EvidenceBucketName`,
      description: 'S3 bucket holding events, traces, artefacts, screenshots, and replays.',
    });
  }
}