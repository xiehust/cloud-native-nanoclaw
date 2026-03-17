import { describe, it, expect } from 'vitest';
import { buildAppendContent, type AppendOptions } from '../system-prompt.js';

const baseOpts: AppendOptions = {
  botId: 'bot-123',
  botName: 'TestBot',
  channelType: 'discord',
  groupJid: 'dc:456',
};

describe('buildAppendContent', () => {
  // ── Identity Override ──────────────────────────────────────────────

  it('includes identity override with bot name', () => {
    const result = buildAppendContent(baseOpts);
    expect(result).toContain('# Identity Override');
    expect(result).toContain('You are TestBot');
  });

  // ── Channel Guidance ───────────────────────────────────────────────

  it('includes Discord guidance for discord channel', () => {
    const result = buildAppendContent({ ...baseOpts, channelType: 'discord' });
    expect(result).toContain('# Channel: Discord');
    expect(result).toContain('standard Markdown');
  });

  it('includes Slack guidance for slack channel', () => {
    const result = buildAppendContent({ ...baseOpts, channelType: 'slack' });
    expect(result).toContain('# Channel: Slack');
    expect(result).toContain('mrkdwn');
  });

  it('includes Telegram guidance for telegram channel', () => {
    const result = buildAppendContent({ ...baseOpts, channelType: 'telegram' });
    expect(result).toContain('# Channel: Telegram');
    expect(result).toContain('MarkdownV2');
  });

  it('includes WhatsApp guidance for whatsapp channel', () => {
    const result = buildAppendContent({ ...baseOpts, channelType: 'whatsapp' });
    expect(result).toContain('# Channel: WhatsApp');
  });

  // ── Scheduled Task ─────────────────────────────────────────────────

  it('adds scheduled task note when isScheduledTask', () => {
    const result = buildAppendContent({ ...baseOpts, isScheduledTask: true });
    expect(result).toContain('automated scheduled task');
  });

  it('omits scheduled task note for normal messages', () => {
    const result = buildAppendContent(baseOpts);
    expect(result).not.toContain('scheduled task');
  });

  // ── Runtime Metadata ───────────────────────────────────────────────

  it('always includes runtime metadata', () => {
    const result = buildAppendContent(baseOpts);
    expect(result).toContain('Runtime: bot=bot-123');
    expect(result).toContain('name=TestBot');
    expect(result).toContain('channel=discord');
    expect(result).toContain('group=dc:456');
  });

  it('includes model in runtime metadata when provided', () => {
    const result = buildAppendContent({
      ...baseOpts,
      model: 'global.anthropic.claude-sonnet-4-6',
    });
    expect(result).toContain('model=global.anthropic.claude-sonnet-4-6');
  });

  it('omits model from runtime metadata when not provided', () => {
    const result = buildAppendContent(baseOpts);
    expect(result).not.toContain('model=');
  });

  // ── Managed Policy ─────────────────────────────────────────────────

  it('includes managed policy (fallback in test env)', () => {
    const result = buildAppendContent(baseOpts);
    // In test mode, managed policy falls back to "No managed policy loaded"
    expect(result).toContain('Organization Policy');
  });

  // ── Section ordering ───────────────────────────────────────────────

  it('sections appear in correct order', () => {
    const result = buildAppendContent(baseOpts);

    const policyIdx = result.indexOf('Organization Policy');
    const identityIdx = result.indexOf('# Identity Override');
    const channelIdx = result.indexOf('# Channel:');
    const runtimeIdx = result.indexOf('Runtime:');

    expect(policyIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(channelIdx);
    expect(channelIdx).toBeLessThan(runtimeIdx);
  });

  // ── Separator ──────────────────────────────────────────────────────

  it('separates sections with --- dividers', () => {
    const result = buildAppendContent(baseOpts);
    expect(result).toContain('\n\n---\n\n');
  });
});
