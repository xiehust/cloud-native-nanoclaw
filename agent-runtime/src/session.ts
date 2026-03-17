/**
 * ClawBot Cloud — S3 Session Sync
 *
 * Replaces NanoClaw's Docker volume mounts with S3 round-trips:
 *   Before invocation → download session + memory files from S3
 *   After invocation  → upload changed files back to S3
 *
 * Layout:
 *   /home/node/.claude/           ← Claude Code session state + bot-level CLAUDE.md
 *   /workspace/group/             ← Group memory (CLAUDE.md) + conversations
 *   /workspace/learnings/         ← Learning journal
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import type pino from 'pino';

const WORKSPACE_BASE = '/workspace';
const CLAUDE_DIR = '/home/node/.claude';

export interface SyncPaths {
  /** S3 prefix for Claude Code session files */
  sessionPath: string;
  /** S3 key for bot-level CLAUDE.md → /home/node/.claude/CLAUDE.md */
  botClaude: string;
  /** S3 key for group CLAUDE.md → /workspace/group/CLAUDE.md */
  groupClaude: string;
  /** S3 prefix for learnings → /workspace/learnings/ */
  learningsPrefix?: string;
}

/**
 * Download session + memory files from S3 to local workspace.
 * Called before agent invocation.
 */
export async function syncFromS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
): Promise<void> {
  // 1. Download session directory → /home/node/.claude/
  await downloadDirectory(s3, bucket, paths.sessionPath, CLAUDE_DIR, logger);

  // 2. Download bot CLAUDE.md → /home/node/.claude/CLAUDE.md
  await downloadFile(s3, bucket, paths.botClaude, join(CLAUDE_DIR, 'CLAUDE.md'), logger);

  // 3. Download group CLAUDE.md → /workspace/group/CLAUDE.md
  await downloadFile(s3, bucket, paths.groupClaude, join(WORKSPACE_BASE, 'group', 'CLAUDE.md'), logger);

  // 4. Download learnings → /workspace/learnings/
  if (paths.learningsPrefix) {
    await downloadDirectory(s3, bucket, paths.learningsPrefix, join(WORKSPACE_BASE, 'learnings'), logger);
  }
}

/**
 * Upload changed session + memory files back to S3.
 * Called after agent invocation completes.
 */
export async function syncToS3(
  s3: S3Client,
  bucket: string,
  paths: SyncPaths,
  logger: pino.Logger,
): Promise<void> {
  // 1. Upload session directory (Claude Code state)
  await uploadDirectory(s3, bucket, CLAUDE_DIR, paths.sessionPath, logger);

  // 2. Upload bot CLAUDE.md from /home/node/.claude/CLAUDE.md → S3
  await uploadFile(s3, bucket, join(CLAUDE_DIR, 'CLAUDE.md'), paths.botClaude, logger);

  // 3. Upload group CLAUDE.md from /workspace/group/CLAUDE.md → S3
  await uploadFile(s3, bucket, join(WORKSPACE_BASE, 'group', 'CLAUDE.md'), paths.groupClaude, logger);

  // 4. Upload group conversations directory (archived transcripts)
  const conversationsDir = join(WORKSPACE_BASE, 'group', 'conversations');
  const conversationsPrefix = paths.groupClaude.replace(/CLAUDE\.md$/, 'conversations/');
  await uploadDirectory(s3, bucket, conversationsDir, conversationsPrefix, logger);

  // 5. Upload learnings directory
  if (paths.learningsPrefix) {
    await uploadDirectory(s3, bucket, join(WORKSPACE_BASE, 'learnings'), paths.learningsPrefix, logger);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function deleteS3Object(
  s3: S3Client,
  bucket: string,
  key: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    logger.debug({ key }, 'Deleted S3 object');
  } catch {
    // Best effort — object may not exist
  }
}

async function downloadFile(
  s3: S3Client,
  bucket: string,
  key: string,
  localPath: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (resp.Body) {
      await mkdir(dirname(localPath), { recursive: true });
      const content = await resp.Body.transformToString();
      await writeFile(localPath, content, 'utf-8');
      logger.debug({ key, localPath }, 'Downloaded file');
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') {
      logger.debug({ key }, 'File not found in S3, skipping');
    } else {
      throw err;
    }
  }
}

async function downloadDirectory(
  s3: S3Client,
  bucket: string,
  prefix: string,
  localDir: string,
  logger: pino.Logger,
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const relativePath = obj.Key.slice(prefix.length);
      if (!relativePath) continue;
      await downloadFile(s3, bucket, obj.Key, join(localDir, relativePath), logger);
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function uploadFile(
  s3: S3Client,
  bucket: string,
  localPath: string,
  key: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    const content = await readFile(localPath, 'utf-8');
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
    logger.debug({ key, localPath }, 'Uploaded file');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localPath }, 'Local file not found, skipping upload');
    } else {
      throw err;
    }
  }
}

async function uploadDirectory(
  s3: S3Client,
  bucket: string,
  localDir: string,
  prefix: string,
  logger: pino.Logger,
): Promise<void> {
  try {
    const entries = await readdir(localDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath || entry.path, entry.name);
      const relativePath = fullPath.slice(localDir.length);
      await uploadFile(s3, bucket, fullPath, prefix + relativePath, logger);
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ localDir }, 'Directory not found, skipping upload');
    } else {
      throw err;
    }
  }
}
