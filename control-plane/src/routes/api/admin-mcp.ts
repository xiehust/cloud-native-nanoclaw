/**
 * Admin MCP Server Routes — CRUD for global platform-level MCP server definitions.
 * All routes require isAdmin. Registered under /api/admin/mcp-servers.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  createMcpServer,
  getBotById,
  getMcpServer,
  listMcpServers,
  updateBot,
  updateMcpServer,
  deleteMcpServer,
  deleteBotMcpConfigsByServer,
} from '../../services/dynamo.js';
import type { McpServer } from '@clawbot/shared/types';

const envVarSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  required: z.boolean().default(false),
  template: z.string().default(''),
});

const toolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
});

const createMcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  version: z.string().max(50).default('1.0.0'),
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().max(500).optional(),
  args: z.array(z.string()).optional(),
  npmPackages: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  envVars: z.array(envVarSchema).optional(),
  tools: z.array(toolDefSchema).optional(),
});

const updateMcpServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  version: z.string().max(50).optional(),
  type: z.enum(['stdio', 'sse', 'http']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string()).optional(),
  npmPackages: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  envVars: z.array(envVarSchema).optional(),
  tools: z.array(toolDefSchema).optional(),
}).refine((obj) => Object.values(obj).some((v) => v !== undefined), {
  message: 'At least one field is required',
});

export const adminMcpRoutes: FastifyPluginAsync = async (app) => {
  // Admin guard is inherited from parent admin plugin

  // GET / — List all MCP servers (optional ?status=active|disabled)
  app.get<{ Querystring: { status?: string } }>(
    '/',
    async (request) => {
      const status = request.query.status;
      if (status && status !== 'active' && status !== 'disabled') {
        return { mcpServers: await listMcpServers() };
      }
      return { mcpServers: await listMcpServers(status || undefined) };
    },
  );

  // POST / — Create new MCP server definition
  app.post('/', async (request, reply) => {
    const body = createMcpServerSchema.parse(request.body);

    // Type-specific validation
    if (body.type === 'stdio' && !body.command) {
      return reply.status(400).send({ error: 'command is required for STDIO type' });
    }
    if ((body.type === 'sse' || body.type === 'http') && !body.url) {
      return reply.status(400).send({ error: 'url is required for SSE/HTTP type' });
    }

    const now = new Date().toISOString();
    const server: McpServer = {
      mcpServerId: ulid(),
      ...body,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: request.userId,
    };

    await createMcpServer(server);
    return reply.status(201).send(server);
  });

  // GET /:mcpServerId — Get MCP server detail
  app.get<{ Params: { mcpServerId: string } }>(
    '/:mcpServerId',
    async (request, reply) => {
      const server = await getMcpServer(request.params.mcpServerId);
      if (!server) {
        return reply.status(404).send({ error: 'MCP server not found' });
      }
      return server;
    },
  );

  // PUT /:mcpServerId — Update MCP server definition
  app.put<{ Params: { mcpServerId: string } }>(
    '/:mcpServerId',
    async (request, reply) => {
      const updates = updateMcpServerSchema.parse(request.body);
      const existing = await getMcpServer(request.params.mcpServerId);
      if (!existing) {
        return reply.status(404).send({ error: 'MCP server not found' });
      }

      await updateMcpServer(request.params.mcpServerId, updates);
      const updated = await getMcpServer(request.params.mcpServerId);
      return updated;
    },
  );

  // DELETE /:mcpServerId — Delete MCP server (cascade to bot configs)
  app.delete<{ Params: { mcpServerId: string } }>(
    '/:mcpServerId',
    async (request, reply) => {
      const existing = await getMcpServer(request.params.mcpServerId);
      if (!existing) {
        return reply.status(404).send({ error: 'MCP server not found' });
      }

      // Cascade: remove all bot-level configs and clean up bot.mcpServers arrays
      const deletedConfigs = await deleteBotMcpConfigsByServer(request.params.mcpServerId);

      // Best-effort: remove mcpServerId from each affected bot's mcpServers array
      const affectedBotIds = [...new Set(deletedConfigs.map((c) => c.botId))];
      for (const botId of affectedBotIds) {
        try {
          const bot = await getBotById(botId);
          if (bot?.mcpServers) {
            const updated = bot.mcpServers.filter((id) => id !== request.params.mcpServerId);
            await updateBot(bot.userId, botId, { mcpServers: updated });
          }
        } catch {
          // Best-effort — don't fail the admin delete
        }
      }

      await deleteMcpServer(request.params.mcpServerId);
      return reply.status(204).send();
    },
  );
};
