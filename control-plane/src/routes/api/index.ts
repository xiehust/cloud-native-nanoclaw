// ClawBot Cloud — API Route Registry
// Registers all REST API routes under /api with Cognito JWT auth middleware

import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { config } from '../../config.js';
import { getUser } from '../../services/dynamo.js';
import { botsRoutes } from './bots.js';
import { channelsRoutes } from './channels.js';
import { groupsRoutes } from './groups.js';
import { tasksRoutes } from './tasks.js';
import { memoryRoutes } from './memory.js';
import { userRoutes } from './user.js';
import { adminRoutes } from './admin.js';
import { filesRoutes } from './files.js';
import { providersRoutes } from './providers.js';
import { proxyRulesRoutes } from './proxy-rules.js';
import { webchatRoutes } from './webchat.js';

// Extend Fastify request to include authenticated user info
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
    isAdmin: boolean;
    /** Raw request body string, stored before JSON parsing for webhook signature verification */
    rawBody?: string;
    /** When using INTEGRATION_SECRET (e.g. Ad-Platform proxy), isolates web sessions per end-user */
    integrationGroupKey?: string;
  }
}

type SinglePoolVerifier = CognitoJwtVerifierSingleUserPool<{
  userPoolId: string;
  tokenUse: 'access';
  clientId: string;
}>;

export const apiRoutes: FastifyPluginAsync = async (app) => {
  // Set up Cognito JWT verification — required for all environments
  if (!config.cognito.userPoolId || !config.cognito.clientId) {
    app.log.warn('Cognito not configured (COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID missing) — all API requests will return 503');
  }
  const verifier: SinglePoolVerifier | null =
    config.cognito.userPoolId && config.cognito.clientId
      ? CognitoJwtVerifier.create({
          userPoolId: config.cognito.userPoolId,
          tokenUse: 'access',
          clientId: config.cognito.clientId,
        })
      : null;

  // Auth middleware — integration secret (server-to-server) OR Cognito JWT
  app.addHook('onRequest', async (request, reply) => {
    const integHeader = request.headers['x-integration-secret'];
    const botOwnerHeader = request.headers['x-nanoclaw-bot-owner-user-id'];
    const groupKeyHeader = request.headers['x-integration-group-key'];
    const integSecret =
      typeof integHeader === 'string' ? integHeader : '';
    const botOwnerId =
      typeof botOwnerHeader === 'string' ? botOwnerHeader : '';
    const groupKey =
      typeof groupKeyHeader === 'string' ? groupKeyHeader : '';

    if (config.integrationSecret && integSecret && botOwnerId) {
      const a = Buffer.from(integSecret);
      const b = Buffer.from(config.integrationSecret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.status(401).send({ error: 'Invalid integration credentials' });
      }
      request.userId = botOwnerId;
      request.userEmail = '';
      request.isAdmin = false;
      request.integrationGroupKey = groupKey || undefined;

      const user = await getUser(request.userId);
      if (user && (user.status === 'suspended' || user.status === 'deleted')) {
        return reply.status(403).send({ error: 'Account is ' + user.status });
      }
      return;
    }

    if (!verifier) {
      return reply.status(503).send({ error: 'Authentication service not configured' });
    }

    const authHeader = request.headers.authorization;
    const allowQueryToken =
      request.method === 'GET' && request.url.includes('/webchat/ws');
    const tokenFromQuery = allowQueryToken
      ? new URL(request.url, 'http://localhost').searchParams.get('token')
      : null;
    const token =
      authHeader?.startsWith('Bearer ')
        ? authHeader.substring(7)
        : tokenFromQuery;

    if (!token) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    try {
      const payload = await verifier.verify(token);
      request.userId = payload.sub;
      request.userEmail = (payload as Record<string, unknown>).email as string || '';
      const groups = ((payload as Record<string, unknown>)['cognito:groups'] as string[]) || [];
      request.isAdmin = groups.includes('clawbot-admins');
    } catch (err) {
      request.log.warn({ err }, 'JWT verification failed');
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    // Check user status — suspended or deleted users are forbidden
    const user = await getUser(request.userId);
    if (user && (user.status === 'suspended' || user.status === 'deleted')) {
      return reply.status(403).send({ error: 'Account is ' + user.status });
    }
  });

  // Register resource routes
  await app.register(botsRoutes, { prefix: '/bots' });
  await app.register(channelsRoutes, { prefix: '/bots/:botId/channels' });
  await app.register(groupsRoutes, { prefix: '/bots/:botId/groups' });
  await app.register(tasksRoutes, { prefix: '/bots/:botId/tasks' });
  await app.register(filesRoutes, { prefix: '/bots/:botId/files' });
  await app.register(memoryRoutes);
  await app.register(userRoutes);
  await app.register(providersRoutes, { prefix: '/providers' });
  await app.register(proxyRulesRoutes, { prefix: '/proxy-rules' });
  await app.register(webchatRoutes, { prefix: '/bots/:botId/webchat' });
  await app.register(adminRoutes, { prefix: '/admin' });
};
