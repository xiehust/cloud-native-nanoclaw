/**
 * ClawBot Cloud — Feishu Permission MCP Tool
 *
 * Registers the `feishu_perm` MCP tool for managing document/folder permissions
 * in Feishu/Lark Drive. Supports listing collaborators, granting access, and
 * revoking access.
 *
 * Uses the Lark SDK (@larksuiteoapi/node-sdk) for all API operations.
 *
 * SECURITY: This tool is SENSITIVE — it is disabled by default and requires
 * explicit user enablement via the bot's tool configuration.
 *
 * Actions: list, add, remove
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

// ── Type aliases matching the Lark SDK parameter types ──────────────────────

type ListTokenType =
  | 'doc'
  | 'sheet'
  | 'file'
  | 'wiki'
  | 'bitable'
  | 'docx'
  | 'mindnote'
  | 'minutes'
  | 'slides';

type CreateTokenType =
  | 'doc'
  | 'sheet'
  | 'file'
  | 'wiki'
  | 'bitable'
  | 'docx'
  | 'folder'
  | 'mindnote'
  | 'minutes'
  | 'slides';

type MemberType =
  | 'email'
  | 'openid'
  | 'unionid'
  | 'openchat'
  | 'opendepartmentid'
  | 'userid'
  | 'groupid'
  | 'wikispaceid';

type PermType = 'view' | 'edit' | 'full_access';

// ── Core Functions ──────────────────────────────────────────────────────────

async function listMembers(client: Lark.Client, token: string, fileType: string) {
  const res = await client.drive.permissionMember.list({
    path: { token },
    params: { type: fileType as ListTokenType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    members:
      res.data?.items?.map((m) => ({
        member_type: m.member_type,
        member_id: m.member_id,
        perm: m.perm,
        name: m.name,
      })) ?? [],
  };
}

async function addMember(
  client: Lark.Client,
  token: string,
  fileType: string,
  memberType: string,
  memberId: string,
  perm: string,
) {
  const res = await client.drive.permissionMember.create({
    path: { token },
    params: { type: fileType as CreateTokenType, need_notification: false },
    data: {
      member_type: memberType as MemberType,
      member_id: memberId,
      perm: perm as PermType,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    member: res.data?.member,
  };
}

async function removeMember(
  client: Lark.Client,
  token: string,
  fileType: string,
  memberType: string,
  memberId: string,
) {
  const res = await client.drive.permissionMember.delete({
    path: { token, member_id: memberId },
    params: { type: fileType as CreateTokenType, member_type: memberType as MemberType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
  };
}

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerPermTool(server: McpServer, client: Lark.Client): void {
  server.tool(
    'feishu_perm',
    'Feishu document/folder permission management. Actions: list (list collaborators), add (grant access), remove (revoke access). ' +
      'WARNING: This is a SENSITIVE tool that modifies access permissions on documents and folders. ' +
      'Use with caution — incorrect permission changes can expose confidential documents or lock out collaborators. ' +
      'This tool is disabled by default and must be explicitly enabled by the bot owner.',
    {
      action: z
        .enum(['list', 'add', 'remove'])
        .describe('The action to perform'),
      file_token: z
        .string()
        .describe('File or folder token'),
      file_type: z
        .enum([
          'doc',
          'docx',
          'sheet',
          'bitable',
          'folder',
          'file',
          'wiki',
          'mindnote',
          'minutes',
          'slides',
        ])
        .describe('Document/file type'),
      member_type: z
        .enum(['email', 'openid', 'userid', 'unionid', 'openchat', 'opendepartmentid'])
        .optional()
        .describe('Member identifier type (required for add, remove actions)'),
      member_id: z
        .string()
        .optional()
        .describe(
          'Member identifier value — email address, open_id, user_id, etc. (required for add, remove actions)',
        ),
      perm: z
        .enum(['view', 'edit', 'full_access'])
        .optional()
        .describe('Permission level to grant (required for add action)'),
    },
    async (params) => {
      try {
        switch (params.action) {
          case 'list': {
            return json(await listMembers(client, params.file_token, params.file_type));
          }

          case 'add': {
            if (!params.member_type) throw new Error('member_type is required for add action');
            if (!params.member_id) throw new Error('member_id is required for add action');
            if (!params.perm) throw new Error('perm is required for add action');
            return json(
              await addMember(
                client,
                params.file_token,
                params.file_type,
                params.member_type,
                params.member_id,
                params.perm,
              ),
            );
          }

          case 'remove': {
            if (!params.member_type) throw new Error('member_type is required for remove action');
            if (!params.member_id) throw new Error('member_id is required for remove action');
            return json(
              await removeMember(
                client,
                params.file_token,
                params.file_type,
                params.member_type,
                params.member_id,
              ),
            );
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
