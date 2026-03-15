/**
 * ClawBot Cloud — Multi-layer CLAUDE.md Memory Loading
 *
 * Preserves NanoClaw's memory hierarchy:
 *   Layer 1: Shared memory   (read-only, user-wide across all bots)
 *   Layer 2: Bot global      (read-only, bot-wide across all groups)
 *   Layer 3: Group memory    (read-write, per conversation)
 *
 * Files are synced from S3 to /workspace by session.ts before this runs.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

const WORKSPACE_BASE = '/workspace';

/**
 * Build a composite system prompt from all memory layers.
 * Returns the concatenated markdown with section headers.
 */
export async function loadMemoryLayers(): Promise<string> {
  const layers: string[] = [];

  // Layer 1: User shared memory (read-only, across all bots)
  const shared = await safeReadFile(join(WORKSPACE_BASE, 'shared', 'CLAUDE.md'));
  if (shared) layers.push(`# Shared Memory\n${shared}`);

  // Layer 2: Bot global memory (read-only, across all groups)
  const global = await safeReadFile(join(WORKSPACE_BASE, 'global', 'CLAUDE.md'));
  if (global) layers.push(`# Bot Memory\n${global}`);

  // Layer 3: Group memory (read-write, per conversation)
  const group = await safeReadFile(join(WORKSPACE_BASE, 'group', 'CLAUDE.md'));
  if (group) layers.push(`# Group Memory\n${group}`);

  return layers.join('\n\n---\n\n');
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}
