import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  stage: string;
  messageQueue: sqs.IQueue;
  dlq: sqs.IQueue;
  cluster: ecs.ICluster;
  service: ecs.FargateService;
  tables: {
    users: dynamodb.ITable;
    bots: dynamodb.ITable;
    channels: dynamodb.ITable;
    groups: dynamodb.ITable;
    messages: dynamodb.ITable;
    tasks: dynamodb.ITable;
    sessions: dynamodb.ITable;
  };
}

export class MonitoringStack extends cdk.Stack {
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { stage, messageQueue, dlq, cluster, service, tables } = props;

    // ── SNS Topic ───────────────────────────────────────────────────────
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `clawbot-${stage}-alerts`,
    });

    const snsAction = new cw_actions.SnsAction(this.alertsTopic);

    // ── CloudWatch Dashboard ────────────────────────────────────────────
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `clawbot-${stage}`,
    });

    // SQS Metrics
    const messageQueueVisibleMetric = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: messageQueue.queueName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const dlqVisibleMetric = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: dlq.queueName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // ECS Metrics
    const ecsCpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: {
        ClusterName: cluster.clusterName,
        ServiceName: service.serviceName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const ecsMemoryMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: {
        ClusterName: cluster.clusterName,
        ServiceName: service.serviceName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // DynamoDB Metrics (all tables)
    const tableNames = Object.keys(tables) as Array<keyof typeof tables>;
    const dynamoReadMetrics: cloudwatch.Metric[] = [];
    const dynamoWriteMetrics: cloudwatch.Metric[] = [];

    for (const name of tableNames) {
      const table = tables[name];
      dynamoReadMetrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ConsumedReadCapacityUnits',
          dimensionsMap: { TableName: table.tableName },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      );
      dynamoWriteMetrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ConsumedWriteCapacityUnits',
          dimensionsMap: { TableName: table.tableName },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      );
    }

    // Dashboard Widgets
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS — Messages Visible',
        left: [messageQueueVisibleMetric, dlqVisibleMetric],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS — CPU & Memory Utilization',
        left: [ecsCpuMetric],
        right: [ecsMemoryMetric],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB — Read Capacity (all tables)',
        left: dynamoReadMetrics,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB — Write Capacity (all tables)',
        left: dynamoWriteMetrics,
        width: 12,
      }),
    );

    // ── Alarms ──────────────────────────────────────────────────────────

    // DLQ messages > 0 for 1 minute
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `clawbot-${stage}-dlq-messages`,
      alarmDescription: 'Dead-letter queue has messages — investigate failed processing',
      metric: dlqVisibleMetric,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(snsAction);

    // ECS CPU > 80% for 5 minutes
    const cpuAlarm = new cloudwatch.Alarm(this, 'CpuAlarm', {
      alarmName: `clawbot-${stage}-ecs-cpu-high`,
      alarmDescription: 'ECS service CPU utilization above 80%',
      metric: ecsCpuMetric,
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cpuAlarm.addAlarmAction(snsAction);

    // SQS visible messages > 100 for 5 minutes
    const queueDepthAlarm = new cloudwatch.Alarm(this, 'QueueDepthAlarm', {
      alarmName: `clawbot-${stage}-queue-depth-high`,
      alarmDescription: 'Message queue depth above 100 — possible processing slowdown',
      metric: messageQueueVisibleMetric,
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    queueDepthAlarm.addAlarmAction(snsAction);
  }
}
