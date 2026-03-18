/**
 * ClawBot Cloud — Feishu Drive MCP Tool
 *
 * Registers the `feishu_drive` MCP tool for interacting with Feishu/Lark
 * cloud storage (Drive). Supports listing folder contents, getting file
 * metadata, creating folders, moving files, and deleting files.
 *
 * Uses the Lark SDK (@larksuiteoapi/node-sdk) for all API operations.
 *
 * Actions: list, info, create_folder, move, delete
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  };
}

// ── File type unions matching the Lark SDK parameter types ──────────────────

type MoveFileType =
  | 'doc'
  | 'docx'
  | 'sheet'
  | 'bitable'
  | 'folder'
  | 'file'
  | 'mindnote'
  | 'slides';

type DeleteFileType =
  | 'doc'
  | 'docx'
  | 'sheet'
  | 'bitable'
  | 'folder'
  | 'file'
  | 'mindnote'
  | 'shortcut'
  | 'slides';

// ── Core Functions ──────────────────────────────────────────────────────────

async function listFolder(client: Lark.Client, folderToken?: string) {
  // Filter out invalid folder_token values (empty, "0", etc.)
  const validFolderToken = folderToken && folderToken !== '0' ? folderToken : undefined;
  const res = await client.drive.file.list({
    params: validFolderToken ? { folder_token: validFolderToken } : {},
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    files:
      res.data?.files?.map((f) => ({
        token: f.token,
        name: f.name,
        type: f.type,
        url: f.url,
        created_time: f.created_time,
        modified_time: f.modified_time,
        owner_id: f.owner_id,
      })) ?? [],
    next_page_token: res.data?.next_page_token,
    has_more: res.data?.has_more,
  };
}

async function getFileInfo(client: Lark.Client, fileToken: string, folderToken?: string) {
  // Use list with optional folder_token to locate the file
  const res = await client.drive.file.list({
    params: folderToken ? { folder_token: folderToken } : {},
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const file = res.data?.files?.find((f) => f.token === fileToken);
  if (!file) {
    throw new Error(`File not found: ${fileToken}. If the file is in a subfolder, provide folder_token.`);
  }

  return {
    token: file.token,
    name: file.name,
    type: file.type,
    url: file.url,
    created_time: file.created_time,
    modified_time: file.modified_time,
    owner_id: file.owner_id,
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken: string) {
  const res = await client.drive.file.createFolder({
    data: { name, folder_token: folderToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    token: res.data?.token,
    url: res.data?.url,
  };
}

async function moveFile(
  client: Lark.Client,
  fileToken: string,
  fileType: string,
  targetFolderToken: string,
) {
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type: fileType as MoveFileType,
      folder_token: targetFolderToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function deleteFile(client: Lark.Client, fileToken: string, fileType: string) {
  const res = await client.drive.file.delete({
    path: { file_token: fileToken },
    params: { type: fileType as DeleteFileType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerDriveTool(server: McpServer, client: Lark.Client): void {
  server.tool(
    'feishu_drive',
    'Feishu cloud storage (Drive) operations. Actions: list (folder contents), info (file metadata), create_folder, move, delete. ' +
      'IMPORTANT: Bot applications do not have a personal "My Space" root folder. They can only operate in shared folders they have been explicitly granted access to. ' +
      'You must provide a valid folder_token for a shared folder the bot can access.',
    {
      action: z
        .enum(['list', 'info', 'create_folder', 'move', 'delete'])
        .describe('The action to perform'),
      folder_token: z
        .string()
        .optional()
        .describe(
          'Folder token. For list: folder to list (required — bot has no root folder). ' +
            'For info: parent folder to search in (optional). ' +
            'For create_folder: parent folder token (required). ' +
            'For move: target folder token (use target_folder_token instead).',
        ),
      file_token: z
        .string()
        .optional()
        .describe('File or folder token (required for info, move, delete actions)'),
      file_type: z
        .enum(['doc', 'docx', 'sheet', 'bitable', 'folder', 'file', 'mindnote', 'shortcut', 'slides'])
        .optional()
        .describe('File type (required for move, delete actions)'),
      name: z.string().optional().describe('Folder name (required for create_folder action)'),
      target_folder_token: z
        .string()
        .optional()
        .describe('Target folder token (required for move action)'),
    },
    async (params) => {
      try {
        switch (params.action) {
          case 'list': {
            return json(await listFolder(client, params.folder_token));
          }

          case 'info': {
            if (!params.file_token) throw new Error('file_token is required for info action');
            return json(await getFileInfo(client, params.file_token, params.folder_token));
          }

          case 'create_folder': {
            if (!params.name) throw new Error('name is required for create_folder action');
            if (!params.folder_token)
              throw new Error(
                'folder_token (parent folder) is required for create_folder action. ' +
                  'Bot apps do not have a root folder — provide a shared folder token.',
              );
            return json(await createFolder(client, params.name, params.folder_token));
          }

          case 'move': {
            if (!params.file_token) throw new Error('file_token is required for move action');
            if (!params.file_type) throw new Error('file_type is required for move action');
            if (!params.target_folder_token)
              throw new Error('target_folder_token is required for move action');
            return json(
              await moveFile(client, params.file_token, params.file_type, params.target_folder_token),
            );
          }

          case 'delete': {
            if (!params.file_token) throw new Error('file_token is required for delete action');
            if (!params.file_type) throw new Error('file_type is required for delete action');
            return json(await deleteFile(client, params.file_token, params.file_type));
          }

          default:
            return json({ error: `Unknown action: ${params.action}` });
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
