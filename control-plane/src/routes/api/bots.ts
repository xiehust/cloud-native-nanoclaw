// ClawBot Cloud — Bots API Routes
// CRUD operations for bot management

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  createBot,
  getBot,
  getSkill,
  getProvider,
  getUser,
  listBots,
  listSkills,
  listMcpServers,
  getMcpServer,
  putBotMcpConfig,
  listBotMcpConfigs,
  getBotMcpConfig,
  deleteBotMcpConfig,
  updateBot,
  deleteBot,
} from '../../services/dynamo.js';
import { botCache } from '../../services/cache.js';
import { putMcpSecret } from '../../services/secrets.js';
import type { Bot, BotMcpConfig, CreateBotRequest, UpdateBotRequest } from '@clawbot/shared';

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'paused', 'deleted']).optional(),
  toolWhitelist: z.object({
    mcpToolsEnabled: z.boolean(),
    skillsEnabled: z.boolean(),
    allowedMcpTools: z.array(z.string().max(100)).max(50),
    allowedSkills: z.array(z.string().max(100)).max(50),
  }).optional(),
});

const validTransitions: Record<string, string[]> = {
  created: ['active', 'deleted'],
  active: ['paused', 'deleted'],
  paused: ['active', 'deleted'],
};

export const botsRoutes: FastifyPluginAsync = async (app) => {
  // List all bots for the authenticated user
  app.get('/', async (request) => {
    const bots = await listBots(request.userId);
    // Filter out soft-deleted bots
    return bots.filter((b) => b.status !== 'deleted');
  });

  // Create a new bot
  app.post('/', async (request, reply) => {
    const body = createBotSchema.parse(request.body as CreateBotRequest);

    // Quota check: ensure user hasn't exceeded max bots
    const user = await getUser(request.userId);
    if (user) {
      const allBots = await listBots(request.userId);
      const activeBots = allBots.filter((b) => b.status !== 'deleted');
      if (activeBots.length >= user.quota.maxBots) {
        return reply.status(403).send({ error: 'Bot limit reached. Upgrade your plan to create more bots.' });
      }
    }

    // Validate provider and modelId if specified
    if (body.providerId) {
      const provider = await getProvider(body.providerId);
      if (!provider) {
        return reply.status(400).send({ error: 'Provider not found' });
      }
      if (body.modelId && !provider.modelIds.includes(body.modelId)) {
        return reply.status(400).send({ error: 'Model ID not available for this provider' });
      }
    }

    const now = new Date().toISOString();

    const bot: Bot = {
      userId: request.userId,
      botId: ulid(),
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      triggerPattern: body.triggerPattern || `@${body.name}`,
      providerId: body.providerId,
      modelId: body.modelId,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    await createBot(bot);
    return reply.status(201).send(bot);
  });

  // Available tools catalog (for whitelist UI)
  app.get('/available-tools', async () => {
    return {
      mcpTools: [
        { name: 'send_message', description: 'Send a message to the channel' },
        { name: 'send_file', description: 'Send a file to the channel' },
        { name: 'schedule_task', description: 'Schedule a recurring task' },
        { name: 'list_tasks', description: 'List scheduled tasks' },
        { name: 'pause_task', description: 'Pause a scheduled task' },
        { name: 'resume_task', description: 'Resume a paused task' },
        { name: 'cancel_task', description: 'Cancel a scheduled task' },
        { name: 'update_task', description: 'Update a scheduled task' },
      ],
      skills: [
        { name: 'agent-browser', description: 'Browser automation' },
        { name: 'docx', description: 'Word document creation' },
        { name: 'find-skills', description: 'Discover available skills' },
        { name: 'pdf', description: 'PDF manipulation' },
        { name: 'pptx', description: 'PowerPoint creation' },
        { name: 'skill-creator', description: 'Create new skills' },
        { name: 'skill-development', description: 'Skill development tools' },
        { name: 'xlsx', description: 'Excel spreadsheet creation' },
      ],
    };
  });

  // Get a specific bot
  app.get<{ Params: { botId: string } }>('/:botId', async (request, reply) => {
    const { botId } = request.params;
    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }
    return bot;
  });

  // Update a bot
  app.put<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const updates = updateBotSchema.parse(request.body as UpdateBotRequest);

      // Verify bot exists and belongs to user
      const existing = await getBot(request.userId, botId);
      if (!existing || existing.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Validate state transition
      if (updates.status) {
        const allowed = validTransitions[existing.status];
        if (!allowed || !allowed.includes(updates.status)) {
          return reply.status(400).send({
            error: `Invalid status transition from '${existing.status}' to '${updates.status}'`,
          });
        }
      }

      // Validate provider and modelId exist
      if (updates.providerId) {
        const provider = await getProvider(updates.providerId);
        if (!provider) {
          return reply.status(400).send({ error: 'Provider not found' });
        }
        if (updates.modelId && !provider.modelIds.includes(updates.modelId)) {
          return reply.status(400).send({ error: 'Model ID not available for this provider' });
        }
      }

      await updateBot(request.userId, botId, updates);
      botCache.delete(botId); // Invalidate so dispatcher picks up changes immediately
      const updated = await getBot(request.userId, botId);
      return updated;
    },
  );

  // Delete a bot (soft delete)
  app.delete<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;

      const existing = await getBot(request.userId, botId);
      if (!existing || existing.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      await deleteBot(request.userId, botId);
      return reply.status(204).send();
    },
  );

  // GET /:botId/skills — List available skills with enabled state for this bot
  app.get<{ Params: { botId: string } }>(
    '/:botId/skills',
    async (request, reply) => {
      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const allSkills = await listSkills('active');
      const enabledSet = new Set(bot.skills || []);

      return {
        skills: allSkills.map((skill) => ({
          ...skill,
          enabled: enabledSet.has(skill.skillId),
        })),
      };
    },
  );

  // PUT /:botId/skills — Update enabled skills for this bot
  app.put<{ Params: { botId: string } }>(
    '/:botId/skills',
    async (request, reply) => {
      const { skills } = z.object({
        skills: z.array(z.string().min(1)).max(50),
      }).parse(request.body);

      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Validate all skillIds exist and are active (concurrent lookups)
      const resolved = await Promise.all(skills.map((id) => getSkill(id)));
      for (let i = 0; i < resolved.length; i++) {
        if (!resolved[i] || resolved[i]!.status !== 'active') {
          return reply.status(400).send({ error: `Skill ${skills[i]} not found or not active` });
        }
      }

      await updateBot(request.userId, request.params.botId, { skills });
      botCache.delete(request.params.botId);
      return { ok: true, skills };
    },
  );

  // ── MCP Server Management ────────────────────────────────────────────

  // GET /:botId/mcp-servers — List all available MCP servers with enabled state
  app.get<{ Params: { botId: string } }>(
    '/:botId/mcp-servers',
    async (request, reply) => {
      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const [allPlatform, botConfigs] = await Promise.all([
        listMcpServers('active'),
        listBotMcpConfigs(request.params.botId),
      ]);

      const enabledSet = new Set(bot.mcpServers || []);
      const configMap = new Map(botConfigs.map((c) => [c.mcpServerId, c]));

      // Platform servers with enabled flag
      const platformEntries = allPlatform.map((s) => ({
        mcpServerId: s.mcpServerId,
        name: s.name,
        type: s.type,
        description: s.description,
        version: s.version,
        tools: s.tools,
        envVars: s.envVars,
        enabled: enabledSet.has(s.mcpServerId),
        source: 'platform' as const,
      }));

      // Custom servers (always shown, always enabled)
      const customEntries = botConfigs
        .filter((c) => c.source === 'custom' && c.customConfig)
        .map((c) => ({
          mcpServerId: c.mcpServerId,
          name: c.customConfig!.name,
          type: c.customConfig!.type,
          description: c.customConfig!.description,
          version: c.customConfig!.version,
          tools: c.customConfig!.tools,
          envVars: c.customConfig!.envVars,
          enabled: true,
          source: 'custom' as const,
        }));

      return { mcpServers: [...platformEntries, ...customEntries] };
    },
  );

  // PUT /:botId/mcp-servers — Update enabled platform MCP server list
  app.put<{ Params: { botId: string } }>(
    '/:botId/mcp-servers',
    async (request, reply) => {
      const { mcpServers } = z.object({
        mcpServers: z.array(z.string().min(1)).max(20),
      }).parse(request.body);

      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Validate all IDs exist and are active
      const resolved = await Promise.all(mcpServers.map((id) => getMcpServer(id)));
      for (let i = 0; i < resolved.length; i++) {
        if (!resolved[i] || resolved[i]!.status !== 'active') {
          return reply.status(400).send({ error: `MCP server ${mcpServers[i]} not found or not active` });
        }
      }

      // Determine which to add/remove
      const oldSet = new Set(bot.mcpServers || []);
      const newSet = new Set(mcpServers);
      const now = new Date().toISOString();

      // Create BotMcpConfig for newly enabled platform servers
      for (const id of mcpServers) {
        if (!oldSet.has(id)) {
          await putBotMcpConfig({
            botId: request.params.botId,
            mcpServerId: id,
            source: 'platform',
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // Delete BotMcpConfig for removed platform servers
      for (const id of oldSet) {
        if (!newSet.has(id)) {
          const cfg = await getBotMcpConfig(request.params.botId, id);
          if (cfg && cfg.source === 'platform') {
            await deleteBotMcpConfig(request.params.botId, id);
          }
        }
      }

      // Preserve custom server IDs in the mcpServers array
      const customIds = (await listBotMcpConfigs(request.params.botId))
        .filter((c) => c.source === 'custom')
        .map((c) => c.mcpServerId);
      const finalList = [...mcpServers, ...customIds];

      await updateBot(request.userId, request.params.botId, { mcpServers: finalList } as Partial<Bot>);
      botCache.delete(request.params.botId);
      return { ok: true, mcpServers: finalList };
    },
  );

  // POST /:botId/mcp-servers/custom — Add custom MCP server
  app.post<{ Params: { botId: string } }>(
    '/:botId/mcp-servers/custom',
    async (request, reply) => {
      const body = z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        version: z.string().max(50).default('1.0.0'),
        type: z.enum(['stdio', 'sse', 'http']),
        command: z.string().max(500).optional(),
        args: z.array(z.string()).optional(),
        npmPackages: z.array(z.string()).optional(),
        url: z.string().url().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        envVars: z.array(z.object({
          name: z.string().min(1),
          description: z.string().default(''),
          required: z.boolean().default(false),
          template: z.string().default(''),
        })).optional(),
        tools: z.array(z.object({
          name: z.string().min(1),
          description: z.string().default(''),
        })).optional(),
      }).parse(request.body);

      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      if (body.type === 'stdio' && !body.command) {
        return reply.status(400).send({ error: 'command is required for STDIO type' });
      }
      if ((body.type === 'sse' || body.type === 'http') && !body.url) {
        return reply.status(400).send({ error: 'url is required for SSE/HTTP type' });
      }

      const mcpServerId = `custom-${ulid()}`;
      const now = new Date().toISOString();

      await putBotMcpConfig({
        botId: request.params.botId,
        mcpServerId,
        source: 'custom',
        enabled: true,
        customConfig: body,
        createdAt: now,
        updatedAt: now,
      });

      // Add to bot.mcpServers array
      const currentList = bot.mcpServers || [];
      await updateBot(request.userId, request.params.botId, {
        mcpServers: [...currentList, mcpServerId],
      } as Partial<Bot>);
      botCache.delete(request.params.botId);

      return reply.status(201).send({
        mcpServerId,
        ...body,
        enabled: true,
        source: 'custom' as const,
      });
    },
  );

  // PUT /:botId/mcp-servers/custom/:mcpServerId — Update custom MCP server
  app.put<{ Params: { botId: string; mcpServerId: string } }>(
    '/:botId/mcp-servers/custom/:mcpServerId',
    async (request, reply) => {
      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getBotMcpConfig(request.params.botId, request.params.mcpServerId);
      if (!existing || existing.source !== 'custom') {
        return reply.status(404).send({ error: 'Custom MCP server not found' });
      }

      const body = z.object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        version: z.string().max(50).optional(),
        type: z.enum(['stdio', 'sse', 'http']).optional(),
        command: z.string().max(500).optional(),
        args: z.array(z.string()).optional(),
        npmPackages: z.array(z.string()).optional(),
        url: z.string().url().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        envVars: z.array(z.object({
          name: z.string().min(1),
          description: z.string().default(''),
          required: z.boolean().default(false),
          template: z.string().default(''),
        })).optional(),
        tools: z.array(z.object({
          name: z.string().min(1),
          description: z.string().default(''),
        })).optional(),
      }).parse(request.body);

      const updatedConfig = { ...existing.customConfig, ...body };
      await putBotMcpConfig({
        ...existing,
        customConfig: updatedConfig as BotMcpConfig['customConfig'],
        updatedAt: new Date().toISOString(),
      });
      botCache.delete(request.params.botId);

      return { mcpServerId: request.params.mcpServerId, ...updatedConfig, enabled: true, source: 'custom' };
    },
  );

  // DELETE /:botId/mcp-servers/custom/:mcpServerId — Delete custom MCP server
  app.delete<{ Params: { botId: string; mcpServerId: string } }>(
    '/:botId/mcp-servers/custom/:mcpServerId',
    async (request, reply) => {
      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getBotMcpConfig(request.params.botId, request.params.mcpServerId);
      if (!existing || existing.source !== 'custom') {
        return reply.status(404).send({ error: 'Custom MCP server not found' });
      }

      await deleteBotMcpConfig(request.params.botId, request.params.mcpServerId);

      // Remove from bot.mcpServers array
      const updated = (bot.mcpServers || []).filter((id) => id !== request.params.mcpServerId);
      await updateBot(request.userId, request.params.botId, { mcpServers: updated } as Partial<Bot>);
      botCache.delete(request.params.botId);

      return reply.status(204).send();
    },
  );

  // PUT /:botId/mcp-servers/:mcpServerId/secrets — Save per-bot MCP secrets
  app.put<{ Params: { botId: string; mcpServerId: string } }>(
    '/:botId/mcp-servers/:mcpServerId/secrets',
    async (request, reply) => {
      const { secrets } = z.object({
        secrets: z.record(z.string(), z.string()),
      }).parse(request.body);

      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const cfg = await getBotMcpConfig(request.params.botId, request.params.mcpServerId);
      if (!cfg) {
        return reply.status(404).send({ error: 'MCP server config not found for this bot' });
      }

      // Write each secret to Secrets Manager, collect references
      const secretRefs: Record<string, string> = { ...(cfg.secretRefs || {}) };
      for (const [envVarName, value] of Object.entries(secrets)) {
        secretRefs[envVarName] = await putMcpSecret(
          request.userId, request.params.botId, request.params.mcpServerId, envVarName, value,
        );
      }

      // Update BotMcpConfig with secret references
      await putBotMcpConfig({
        ...cfg,
        secretRefs,
        updatedAt: new Date().toISOString(),
      });

      return { ok: true };
    },
  );
};
