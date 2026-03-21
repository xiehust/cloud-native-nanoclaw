// ClawBot Cloud — Proxy Rules API
// CRUD for credential proxy injection rules (stored in Secrets Manager)

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getProxyRules, putProxyRules, type StoredProxyRule } from '../../services/secrets.js';

const ruleSchema = z.object({
  name: z.string().min(1).max(100),
  prefix: z.string().min(1).max(100).regex(/^\/[a-z0-9-]+$/, 'Prefix must be lowercase, e.g. /github'),
  target: z.string().url().max(500),
  authType: z.enum(['bearer', 'api-key', 'basic']),
  headerName: z.string().max(100).optional(),
  value: z.string().min(1).max(2000),
});

/** Strip secret values for API responses */
function sanitize(rule: StoredProxyRule) {
  return {
    id: rule.id,
    name: rule.name,
    prefix: rule.prefix,
    target: rule.target,
    authType: rule.authType,
    headerName: rule.headerName,
    hasValue: !!rule.value,
  };
}

export const proxyRulesRoutes: FastifyPluginAsync = async (app) => {
  // List all rules (without secret values)
  app.get('/', async (request) => {
    const rules = await getProxyRules(request.userId);
    return rules.map(sanitize);
  });

  // Create a new rule
  app.post('/', async (request, reply) => {
    const body = ruleSchema.parse(request.body);
    const rules = await getProxyRules(request.userId);

    // Check for duplicate prefix
    if (rules.some((r) => r.prefix === body.prefix)) {
      return reply.status(409).send({ error: `Prefix ${body.prefix} already exists` });
    }

    const newRule: StoredProxyRule = {
      id: `pr-${Date.now().toString(36)}`,
      ...body,
    };
    rules.push(newRule);
    await putProxyRules(request.userId, rules);
    return sanitize(newRule);
  });

  // Update a rule
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const body = ruleSchema.partial().parse(request.body);
    const rules = await getProxyRules(request.userId);
    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      return reply.status(404).send({ error: 'Rule not found' });
    }

    // Check prefix conflict if changing prefix
    if (body.prefix && body.prefix !== rules[idx].prefix && rules.some((r) => r.prefix === body.prefix)) {
      return reply.status(409).send({ error: `Prefix ${body.prefix} already exists` });
    }

    rules[idx] = { ...rules[idx], ...body };
    await putProxyRules(request.userId, rules);
    return sanitize(rules[idx]);
  });

  // Delete a rule
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const rules = await getProxyRules(request.userId);
    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      return reply.status(404).send({ error: 'Rule not found' });
    }
    rules.splice(idx, 1);
    await putProxyRules(request.userId, rules);
    return { ok: true };
  });
};
