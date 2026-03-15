// ClawBot Cloud — Tasks API Routes
// CRUD operations for scheduled task management

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  getBot,
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
} from '../../services/dynamo.js';
import type {
  ScheduledTask,
  CreateTaskRequest,
  UpdateTaskRequest,
} from '@clawbot/shared';

const createTaskSchema = z.object({
  groupJid: z.string().min(1),
  prompt: z.string().min(1).max(5000),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().min(1),
  contextMode: z.enum(['group', 'isolated']).optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  prompt: z.string().min(1).max(5000).optional(),
  scheduleValue: z.string().min(1).optional(),
});

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  // List tasks for a bot
  app.get<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const tasks = await listTasks(botId);
    return tasks;
  });

  // Create a new task
  app.post<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const body = createTaskSchema.parse(request.body as CreateTaskRequest);
    const now = new Date().toISOString();

    const task: ScheduledTask = {
      botId,
      taskId: ulid(),
      groupJid: body.groupJid,
      prompt: body.prompt,
      scheduleType: body.scheduleType,
      scheduleValue: body.scheduleValue,
      contextMode: body.contextMode || 'isolated',
      status: 'active',
      createdAt: now,
    };

    // TODO: Create EventBridge Schedule for the task
    // For now, tasks are created but won't execute until
    // the EventBridge integration is complete.

    await createTask(task);
    return reply.status(201).send(task);
  });

  // Get a specific task
  app.get<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const task = await getTask(botId, taskId);
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      return task;
    },
  );

  // Update a task
  app.patch<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getTask(botId, taskId);
      if (!existing) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      const updates = updateTaskSchema.parse(
        request.body as UpdateTaskRequest,
      );

      await updateTask(botId, taskId, updates);
      const updated = await getTask(botId, taskId);
      return updated;
    },
  );

  // Delete a task
  app.delete<{ Params: { botId: string; taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      const { botId, taskId } = request.params;

      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const existing = await getTask(botId, taskId);
      if (!existing) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      // TODO: Delete EventBridge Schedule if it exists

      await deleteTask(botId, taskId);
      return reply.status(204).send();
    },
  );
};
