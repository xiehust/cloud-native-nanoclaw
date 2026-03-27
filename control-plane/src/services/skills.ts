/**
 * Skills Service — Handles skill package installation from zip uploads and git repos.
 * Skills are stored in S3 at skills/{skillId}/ and metadata in DynamoDB.
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { createSkill } from './dynamo.js';
import type { Skill } from '@clawbot/shared';

const execFileAsync = promisify(execFile);
const s3 = new S3Client({ region: config.region });

const MAX_ZIP_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Recursively find all .md files in a directory.
 */
async function findMdFiles(dir: string, base = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      files.push(...await findMdFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md')) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Upload .md files from a local directory to S3 under skills/{skillId}/
 */
async function uploadSkillFiles(
  skillId: string,
  sourceDir: string,
  mdFiles: string[],
): Promise<void> {
  for (const file of mdFiles) {
    const content = await readFile(join(sourceDir, file));
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: `skills/${skillId}/${file}`,
        Body: content,
        ContentType: 'text/markdown',
      }),
    );
  }

  // Upload metadata.json for agent-runtime convenience
  const metadata = { skillId, files: mdFiles };
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: `skills/${skillId}/metadata.json`,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Install a skill from a zip buffer.
 */
export async function installFromZip(
  buffer: Buffer,
  name: string,
  description: string,
  version: string,
  adminUserId: string,
): Promise<Skill> {
  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(`Zip file exceeds maximum size of ${MAX_ZIP_SIZE / 1024 / 1024}MB`);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'skill-zip-'));
  try {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(tmpDir, true);

    const mdFiles = await findMdFiles(tmpDir);
    if (mdFiles.length === 0) {
      throw new Error('No .md files found in zip archive');
    }

    const skillId = ulid();
    await uploadSkillFiles(skillId, tmpDir, mdFiles);

    const now = new Date().toISOString();
    const skill: Skill = {
      skillId,
      name,
      description,
      version,
      source: 'zip',
      fileCount: mdFiles.length,
      files: mdFiles,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: adminUserId,
    };

    await createSkill(skill);
    return skill;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Install a skill from a git repository URL.
 */
export async function installFromGit(
  url: string,
  subPath: string | undefined,
  name: string,
  description: string,
  version: string,
  adminUserId: string,
): Promise<Skill> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'skill-git-'));
  try {
    // Shallow clone
    await execFileAsync('git', ['clone', '--depth', '1', url, tmpDir], {
      timeout: 60_000,
    });

    const sourceDir = subPath ? join(tmpDir, subPath) : tmpDir;
    const resolved = resolve(sourceDir);
    if (!resolved.startsWith(tmpDir)) {
      throw new Error('Subdirectory path escapes the repository root');
    }

    const mdFiles = await findMdFiles(resolved);
    if (mdFiles.length === 0) {
      throw new Error('No .md files found in git repository' + (subPath ? ` at path "${subPath}"` : ''));
    }

    const skillId = ulid();
    await uploadSkillFiles(skillId, sourceDir, mdFiles);

    const now = new Date().toISOString();
    const skill: Skill = {
      skillId,
      name,
      description,
      version,
      source: 'git',
      sourceUrl: url,
      fileCount: mdFiles.length,
      files: mdFiles,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: adminUserId,
    };

    await createSkill(skill);
    return skill;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Delete all S3 objects for a skill.
 */
export async function deleteSkillFiles(skillId: string): Promise<void> {
  const prefix = `skills/${skillId}/`;

  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (listed.Contents?.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: config.s3Bucket,
          Delete: {
            Objects: listed.Contents.map((obj) => ({ Key: obj.Key! })),
          },
        }),
      );
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}
