import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InvocationPayload, InvocationResult } from '@clawbot/shared';
import type { Logger } from 'pino';

// Stub config before importing the module under test
vi.mock('../config.js', () => ({
  config: {
    agentcore: {
      runtimeArn: 'http://agentcore.test/invocations',
    },
  },
}));

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const basePayload: InvocationPayload = {
  botId: 'bot-1',
  botName: 'TestBot',
  groupJid: 'tg:123',
  userId: 'user-1',
  channelType: 'telegram',
  prompt: 'Hello agent',
  systemPrompt: 'You are a test bot',
  sessionPath: 'user-1/bot-1/sessions/tg:123/',
  memoryPaths: {
    shared: 'user-1/shared/CLAUDE.md',
    botGlobal: 'user-1/bot-1/memory/global/CLAUDE.md',
    group: 'user-1/bot-1/memory/tg:123/CLAUDE.md',
  },
};

describe('invokeAgent', () => {
  let invokeAgent: (payload: InvocationPayload, logger: Logger) => Promise<InvocationResult>;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import to pick up fresh mocks each time
    const mod = await import('../sqs/dispatcher.js');
    invokeAgent = mod.invokeAgent;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns parsed output on successful invocation', async () => {
    const expected: InvocationResult = {
      status: 'success',
      result: 'Hello from agent',
      newSessionId: 'sess-42',
      tokensUsed: 1500,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: expected }),
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result).toEqual(expected);
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://agentcore.test/invocations');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body)).toEqual(basePayload);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns error result on HTTP failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('503');
    expect(result.error).toContain('Service Unavailable');
  });

  it('returns error result on network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await invokeAgent(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('Connection refused');
  });

  it('returns error when runtime URL is not configured', async () => {
    // Re-mock config with empty runtimeArn
    vi.doMock('../config.js', () => ({
      config: {
        agentcore: {
          runtimeArn: '',
        },
      },
    }));
    vi.resetModules();

    const mod = await import('../sqs/dispatcher.js');
    const invokeAgentNoConfig = mod.invokeAgent;

    globalThis.fetch = vi.fn();

    const result = await invokeAgentNoConfig(basePayload, mockLogger);

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('not configured');
    // fetch should never be called when config is missing
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
