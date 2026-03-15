import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export interface AgentStackProps extends cdk.StackProps {
  stage: string;
  dataBucket: s3.IBucket;
  messageQueue: sqs.IQueue;
  replyQueue: sqs.IQueue;
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

export class AgentStack extends cdk.Stack {
  public readonly agentBaseRole: iam.Role;
  public readonly agentScopedRole: iam.Role;
  public readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { stage, dataBucket, messageQueue, replyQueue, tables } = props;

    // ── Agent Base Role (created first so scoped role can trust it) ─────
    this.agentBaseRole = new iam.Role(this, 'AgentBaseRole', {
      roleName: `ClawBotAgentBaseRole-${stage}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ── Agent Scoped Role (only assumable by base role, NOT by ecs-tasks) ─
    this.agentScopedRole = new iam.Role(this, 'AgentScopedRole', {
      roleName: `ClawBotAgentScopedRole-${stage}`,
      assumedBy: new iam.ArnPrincipal(this.agentBaseRole.roleArn),
    });

    // Bedrock InvokeModel for Claude models — all regions
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`],
      }),
    );

    // STS AssumeRole on the scoped role
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeScopedRole',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.agentScopedRole.roleArn],
      }),
    );

    // SQS SendMessage on reply queue
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsSendReply',
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [replyQueue.queueArn],
      }),
    );

    // Add TagSession condition to the scoped role's trust policy
    this.agentScopedRole.grantAssumeRole(this.agentBaseRole);

    // ── Scoped Role: S3 ABAC ───────────────────────────────────────────
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BotData',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `${dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/\${aws:PrincipalTag/botId}/*`,
        ],
      }),
    );

    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ListBucket',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [dataBucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [
              '${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*',
            ],
          },
        },
      }),
    );

    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3SharedRead',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          `${dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/shared/*`,
        ],
      }),
    );

    // ── Scoped Role: DynamoDB ABAC ─────────────────────────────────────
    const allTableArns = Object.values(tables).map((t) => t.tableArn);
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbBotScoped',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
        ],
        resources: allTableArns,
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['${aws:PrincipalTag/botId}*'],
          },
        },
      }),
    );

    // ── Scoped Role: EventBridge Scheduler ─────────────────────────────
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SchedulerManage',
        effect: iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/clawbot-\${aws:PrincipalTag/botId}-*`,
        ],
      }),
    );

    // ── Scheduler Execution Role ────────────────────────────────────────
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `ClawBotSchedulerRole-${stage}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsSendMessage',
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [messageQueue.queueArn],
      }),
    );
  }
}
