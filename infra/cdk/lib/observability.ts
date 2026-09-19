import { Duration } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { BetaVersionConfig } from './config';
import { EXECUTION_LIMITS } from './limits';

/** Every Lambda and the state machine logs into a retained log group, never an implicit one. */
export function createLogGroup(
  scope: Construct,
  id: string,
  config: BetaVersionConfig,
  name: string,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/${config.prefix.toLowerCase()}/${config.env_name}/${name}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: config.removal_policy,
  });
}

/**
 * The notification endpoint for alarms and budget warnings, when an operator configured one.
 * With no address there is nothing to publish to, so no topic is created at all.
 */
export function createAlarmTopic(scope: Construct, config: BetaVersionConfig, name: string): sns.ITopic | null {
  if (config.alarm_email === undefined) return null;
  const topic = new sns.Topic(scope, 'AlarmTopic', {
    topicName: `${config.prefix}-${config.env_name}-${name}`,
    displayName: `BetaVersion ${config.env_name} alarms`,
  });
  topic.addSubscription(new subscriptions.EmailSubscription(config.alarm_email));
  return topic;
}

/**
 * Alarms that mean "the control plane or the execution layer is not working", as opposed to
 * "the product under test has a problem". Both matter, but only these say something about
 * BetaVersion itself.
 */
export function addErrorAndLatencyAlarms(
  scope: Construct,
  id: string,
  label: string,
  function_: {
    metricErrors(options?: cloudwatch.MetricOptions): cloudwatch.Metric;
    metricDuration(options?: cloudwatch.MetricOptions): cloudwatch.Metric;
  },
  config: BetaVersionConfig,
  topic: sns.ITopic | null,
): cloudwatch.Alarm[] {
  const alarms = [
    new cloudwatch.Alarm(scope, `${id}Errors`, {
      alarmName: `${config.prefix}-${config.env_name}-${label}-errors`,
      alarmDescription: `${label} reported errors. Runs in flight may not finish.`,
      metric: function_.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    new cloudwatch.Alarm(scope, `${id}Latency`, {
      alarmName: `${config.prefix}-${config.env_name}-${label}-latency`,
      alarmDescription: `${label} p95 duration is approaching its hard timeout.`,
      metric: function_.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }),
      // Three quarters of the hard ceiling: a session that needs longer than this is at risk
      // of being cut off, and that should be visible before it starts failing.
      threshold: Math.round((EXECUTION_LIMITS.max_session_seconds + 60) * 0.75 * 1000),
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  ];
  if (topic !== null) {
    for (const alarm of alarms) alarm.addAlarmAction(new cloudwatch_actions.SnsAction(topic));
  }
  return alarms;
}

/** A monthly cost budget so the platform ceiling is enforced by AWS, not only by the code. */
export function createMonthlyBudget(scope: Construct, id: string, config: BetaVersionConfig): budgets.CfnBudget {
  const subscribers = config.alarm_email === undefined
    ? []
    : [{ subscriptionType: 'EMAIL', address: config.alarm_email }];
  return new budgets.CfnBudget(scope, id, {
    budget: {
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetName: `${config.prefix}-${config.env_name}-monthly`,
      budgetLimit: { amount: config.monthly_budget_usd, unit: 'USD' },
    },
    notificationsWithSubscribers: subscribers.length === 0
      ? undefined
      : [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
  });
}