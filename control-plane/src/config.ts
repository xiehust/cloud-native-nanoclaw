// ClawBot Cloud — Control Plane Configuration
// Environment variable names match CDK ControlPlaneStack container environment

export const config = {
  port: Number(process.env.PORT) || 3000,
  region: process.env.AWS_REGION || 'us-east-1',
  stage: process.env.STAGE || 'dev',

  // DynamoDB table names (match CDK: USERS_TABLE, BOTS_TABLE, etc.)
  tables: {
    users: process.env.USERS_TABLE || 'clawbot-dev-users',
    bots: process.env.BOTS_TABLE || 'clawbot-dev-bots',
    channels: process.env.CHANNELS_TABLE || 'clawbot-dev-channels',
    groups: process.env.GROUPS_TABLE || 'clawbot-dev-groups',
    messages: process.env.MESSAGES_TABLE || 'clawbot-dev-messages',
    tasks: process.env.TASKS_TABLE || 'clawbot-dev-tasks',
    sessions: process.env.SESSIONS_TABLE || 'clawbot-dev-sessions',
  },

  // SQS queue URLs (match CDK: MESSAGE_QUEUE_URL, REPLY_QUEUE_URL)
  queues: {
    messages: process.env.MESSAGE_QUEUE_URL || '',
    replies: process.env.REPLY_QUEUE_URL || '',
  },

  // S3 (match CDK: DATA_BUCKET)
  s3Bucket: process.env.DATA_BUCKET || 'clawbot-dev-data',

  // Cognito
  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID || '',
    clientId: process.env.COGNITO_CLIENT_ID || '',
    region: process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1',
  },

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // AgentCore
  agentcore: {
    runtimeArn: process.env.AGENTCORE_RUNTIME_ARN || '',
  },

  // Concurrency
  maxConcurrentDispatches: Number(process.env.MAX_CONCURRENT_DISPATCHES) || 20,

  // Cache TTL
  cacheTtlMs: Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000, // 5 minutes
} as const;
