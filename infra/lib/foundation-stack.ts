import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export interface FoundationStackProps extends cdk.StackProps {
  stage: string;
}

export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dataBucket: s3.Bucket;
  public readonly ecrRepo: ecr.Repository;
  public readonly messageQueue: sqs.Queue;
  public readonly replyQueue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly usersTable: dynamodb.Table;
  public readonly botsTable: dynamodb.Table;
  public readonly channelsTable: dynamodb.Table;
  public readonly groupsTable: dynamodb.Table;
  public readonly messagesTable: dynamodb.Table;
  public readonly tasksTable: dynamodb.Table;
  public readonly sessionsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';

    // ── VPC ──────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ── S3 Data Bucket ──────────────────────────────────────────────────
    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `clawbot-${stage}-data`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // ── ECR Repository ──────────────────────────────────────────────────
    this.ecrRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'clawbot-agent',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
    });

    // ── SQS: Message Queue (FIFO) ──────────────────────────────────────
    this.dlq = new sqs.Queue(this, 'MessagesDlq', {
      queueName: `clawbot-${stage}-messages-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: `clawbot-${stage}-messages.fifo`,
      fifo: true,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(600),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });

    // ── SQS: Reply Queue (Standard) ────────────────────────────────────
    this.replyQueue = new sqs.Queue(this, 'ReplyQueue', {
      queueName: `clawbot-${stage}-replies`,
    });

    // ── DynamoDB Tables ─────────────────────────────────────────────────
    const tableDefaults: Partial<dynamodb.TableProps> = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    };

    // 1. Users table
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-users`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    });

    // 2. Bots table
    this.botsTable = new dynamodb.Table(this, 'BotsTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-bots`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
    });

    this.botsTable.addGlobalSecondaryIndex({
      indexName: 'botId-index',
      partitionKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
    });

    // 3. Channels table
    this.channelsTable = new dynamodb.Table(this, 'ChannelsTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-channels`,
      partitionKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'channelKey', type: dynamodb.AttributeType.STRING },
    });

    // 4. Groups table
    this.groupsTable = new dynamodb.Table(this, 'GroupsTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-groups`,
      partitionKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'groupJid', type: dynamodb.AttributeType.STRING },
    });

    // 5. Messages table
    this.messagesTable = new dynamodb.Table(this, 'MessagesTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-messages`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // 6. Tasks table
    this.tasksTable = new dynamodb.Table(this, 'TasksTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-tasks`,
      partitionKey: { name: 'botId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
    });

    // 7. Sessions table
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      ...tableDefaults,
      tableName: `clawbot-${stage}-sessions`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    });
  }
}
