/**
 * ClawBot Cloud — STS ABAC Scoped Credentials
 *
 * Replaces NanoClaw's credential proxy with AWS-native security.
 * Each agent invocation gets short-lived credentials scoped to
 * (userId, botId) via STS session tags. IAM policies use ABAC
 * conditions to restrict S3, DynamoDB, SQS, and Scheduler access
 * to only that tenant's resources.
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';

const sts = new STSClient({});
const SCOPED_ROLE_ARN = process.env.SCOPED_ROLE_ARN || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

export interface ScopedClients {
  s3: S3Client;
  dynamodb: DynamoDBDocumentClient;
  scheduler: SchedulerClient;
  sqs: SQSClient;
}

/**
 * Assume a scoped IAM role with session tags for ABAC.
 * Returns pre-configured AWS SDK clients restricted to this (userId, botId).
 */
export async function getScopedClients(userId: string, botId: string): Promise<ScopedClients> {
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: SCOPED_ROLE_ARN,
      RoleSessionName: `agent-${botId}`,
      DurationSeconds: 3600,
      Tags: [
        { Key: 'userId', Value: userId },
        { Key: 'botId', Value: botId },
      ],
    }),
  );

  if (!assumed.Credentials?.AccessKeyId || !assumed.Credentials?.SecretAccessKey) {
    throw new Error('STS AssumeRole did not return credentials');
  }

  const credentials = {
    accessKeyId: assumed.Credentials.AccessKeyId,
    secretAccessKey: assumed.Credentials.SecretAccessKey,
    sessionToken: assumed.Credentials.SessionToken,
  };

  return {
    s3: new S3Client({ region: REGION, credentials }),
    dynamodb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials })),
    scheduler: new SchedulerClient({ region: REGION, credentials }),
    sqs: new SQSClient({ region: REGION, credentials }),
  };
}
