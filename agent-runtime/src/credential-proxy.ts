/**
 * Credential Proxy — Lightweight reverse proxy for secure API key injection.
 *
 * Runs inside the AgentCore microVM on localhost. Matches outbound requests
 * by path prefix, injects auth headers, and forwards to the real API.
 * The agent never sees plaintext API keys — only the proxy has them in memory.
 *
 * Usage:
 *   const proxy = await startCredentialProxy(rules, 9090, logger);
 *   // ... agent runs, makes requests to http://localhost:9090/<prefix>/...
 *   await proxy.stop();
 */

import http from 'node:http';
import https from 'node:https';
import type { Logger } from 'pino';

export interface ProxyRule {
  /** Path prefix on the proxy, e.g. "/anthropic" */
  prefix: string;
  /** Target base URL to forward to, e.g. "https://api.anthropic.com" */
  target: string;
  /** Auth type */
  authType: 'bearer' | 'api-key' | 'basic';
  /** Header name for api-key type, e.g. "x-api-key" */
  headerName?: string;
  /** Secret value — never exposed to agent */
  value: string;
}

export interface CredentialProxy {
  stop(): Promise<void>;
  port: number;
}

/**
 * Start the credential proxy on the given port.
 * Returns a handle to stop it when the agent query completes.
 */
export async function startCredentialProxy(
  rules: ProxyRule[],
  port: number,
  logger: Logger,
): Promise<CredentialProxy> {
  // Normalize prefixes: ensure they start with / and don't end with /
  const normalizedRules = rules.map((r) => ({
    ...r,
    prefix: '/' + r.prefix.replace(/^\/+|\/+$/g, ''),
    target: r.target.replace(/\/+$/, ''),
  }));

  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    // Find matching rule by longest prefix match
    const rule = normalizedRules
      .filter((r) => url.startsWith(r.prefix + '/') || url === r.prefix)
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];

    if (!rule) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No proxy rule matched', path: url }));
      return;
    }

    // Strip prefix and build target URL (string concat preserves target's path component)
    const remainingPath = url.slice(rule.prefix.length) || '/';
    const targetUrl = new URL(rule.target + remainingPath);

    // Copy incoming headers, inject auth
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (key === 'host' || key === 'connection') continue;
      if (val) headers[key] = Array.isArray(val) ? val[0] : val;
    }

    // Inject credential based on auth type
    switch (rule.authType) {
      case 'bearer':
        headers['authorization'] = `Bearer ${rule.value}`;
        break;
      case 'api-key':
        headers[rule.headerName || 'x-api-key'] = rule.value;
        break;
      case 'basic':
        headers['authorization'] = `Basic ${Buffer.from(rule.value).toString('base64')}`;
        break;
    }

    const transport = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      logger.error({ err, target: targetUrl.href }, 'Credential proxy: upstream request failed');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Proxy upstream error', message: err.message }));
    });

    // Pipe request body (for POST, PUT, etc.)
    req.pipe(proxyReq);
  });

  return new Promise<CredentialProxy>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      logger.info({ port, ruleCount: rules.length }, 'Credential proxy started');
      resolve({
        port,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => {
              logger.info('Credential proxy stopped');
              res();
            });
          }),
      });
    });
  });
}
