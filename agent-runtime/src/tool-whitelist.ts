// Tool whitelist hook — deny tools/skills not in the bot's whitelist

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type pino from 'pino';
import type { InvocationPayload } from '@clawbot/shared';

const MCP_PREFIX = 'mcp__nanoclawbot__';

/** Check if a tool name matches any allowed pattern (exact match or prefix with trailing *). */
function matchesPattern(toolName: string, strippedName: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*')
      ? toolName.startsWith(pattern.slice(0, -1))  // prefix match on full tool name (e.g., "mcp__duckduckgo*")
      : strippedName === pattern,                    // exact match on name without prefix
  );
}

export function createToolWhitelistHook(
  payload: InvocationPayload,
  logger: pino.Logger,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const hookInput = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const whitelist = payload.toolWhitelist!;

    // Check Skill tool — inspect the skill name inside tool_input
    if (whitelist.skillsEnabled && toolName === 'Skill') {
      const requestedSkill = (toolInput.skill as string) || '';
      if (!whitelist.allowedSkills.includes(requestedSkill)) {
        logger.warn({
          event: 'tool_access_denied',
          botId: payload.botId,
          userId: payload.userId,
          groupJid: payload.groupJid,
          toolType: 'skill',
          requestedTool: requestedSkill,
          allowedTools: whitelist.allowedSkills,
        }, `Skill access denied: ${requestedSkill}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Skill "${requestedSkill}" is not allowed for this bot. Allowed: ${whitelist.allowedSkills.join(', ') || 'none'}`,
          },
        };
      }
    }

    // Check MCP tools — format is "mcp__<serverName>__<toolName>"
    // Supports exact match (stripped name) or prefix match (pattern ending with *)
    if (whitelist.mcpToolsEnabled && toolName.startsWith('mcp__')) {
      const mcpToolName = toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
      if (!matchesPattern(toolName, mcpToolName, whitelist.allowedMcpTools)) {
        logger.warn({
          event: 'tool_access_denied',
          botId: payload.botId,
          userId: payload.userId,
          groupJid: payload.groupJid,
          toolType: 'mcp_tool',
          requestedTool: mcpToolName,
          allowedTools: whitelist.allowedMcpTools,
        }, `MCP tool access denied: ${mcpToolName}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Tool "${mcpToolName}" is not allowed for this bot. Allowed: ${whitelist.allowedMcpTools.join(', ') || 'none'}`,
          },
        };
      }
    }

    return {};
  };
}
