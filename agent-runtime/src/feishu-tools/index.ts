/**
 * ClawBot Cloud — Feishu MCP Tool Registration Entry Point
 *
 * Conditionally registers Feishu/Lark document tools on the MCP server
 * based on available credentials and the enabled tool configuration.
 *
 * Individual tool implementations (doc, wiki, drive, perm) are registered
 * by their respective modules.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOrCreateLarkClient, type FeishuToolConfig } from './client.js';
import { registerDocTool } from './doc-tool.js';
import { registerWikiTool } from './wiki-tool.js';
import { registerDriveTool } from './drive-tool.js';
import { registerPermTool } from './perm-tool.js';

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Register Feishu/Lark MCP tools on the given MCP server.
 *
 * @param server          - The MCP server instance to register tools on
 * @param feishuCredentials - Lark app credentials (null = skip registration)
 * @param enabledTools    - Which tool categories to enable
 */
export async function registerFeishuTools(
  server: McpServer,
  feishuCredentials: { appId: string; appSecret: string; domain?: string } | null,
  enabledTools: FeishuToolConfig,
): Promise<void> {
  if (!feishuCredentials) return;

  const client = getOrCreateLarkClient(
    feishuCredentials.appId,
    feishuCredentials.appSecret,
    feishuCredentials.domain ?? 'feishu',
  );

  if (enabledTools.doc) registerDocTool(server, client);
  if (enabledTools.wiki) registerWikiTool(server, client);
  if (enabledTools.drive) registerDriveTool(server, client);
  if (enabledTools.perm) registerPermTool(server, client);
}

export type { FeishuToolConfig } from './client.js';
