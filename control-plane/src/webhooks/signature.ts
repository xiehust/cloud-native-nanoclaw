// ClawBot Cloud — Webhook Signature Verification
// Per-channel verification of inbound webhook authenticity

import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Telegram ────────────────────────────────────────────────────────────────
// Telegram sends a secret token in X-Telegram-Bot-Api-Secret-Token header.
// This was set when registering the webhook via setWebhook(secret_token=...).

export function verifyTelegramSignature(
  headers: Record<string, string | undefined>,
  _body: string,
  secret: string,
): boolean {
  const token = headers['x-telegram-bot-api-secret-token'];
  if (!token || !secret) return false;

  // Constant-time comparison to prevent timing attacks
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret);
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

// ── Discord ─────────────────────────────────────────────────────────────────
// Discord uses Ed25519 signatures. Headers: X-Signature-Ed25519, X-Signature-Timestamp
// The message to verify is: timestamp + body

export async function verifyDiscordSignature(
  headers: Record<string, string | undefined>,
  body: string,
  publicKey: string,
): Promise<boolean> {
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  if (!signature || !timestamp || !publicKey) return false;

  try {
    // Import the public key and verify using Web Crypto API
    const keyBytes = hexToUint8Array(publicKey);
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    const message = new TextEncoder().encode(timestamp + body);
    const sig = hexToUint8Array(signature);

    return await crypto.subtle.verify('Ed25519', key, sig, message);
  } catch {
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── Slack ────────────────────────────────────────────────────────────────────
// Slack uses HMAC-SHA256 on "v0:{timestamp}:{body}" with the signing secret.
// Headers: X-Slack-Signature (v0=<hex>), X-Slack-Request-Timestamp

const SLACK_VERSION = 'v0';
const SLACK_MAX_AGE_SECONDS = 5 * 60; // 5 minutes replay window

export function verifySlackSignature(
  headers: Record<string, string | undefined>,
  body: string,
  signingSecret: string,
): boolean {
  const signature = headers['x-slack-signature'];
  const timestamp = headers['x-slack-request-timestamp'];
  if (!signature || !timestamp || !signingSecret) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  const tsNum = Number(timestamp);
  if (isNaN(tsNum)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (age > SLACK_MAX_AGE_SECONDS) return false;

  // Compute HMAC-SHA256
  const sigBaseString = `${SLACK_VERSION}:${timestamp}:${body}`;
  const hmac = createHmac('sha256', signingSecret)
    .update(sigBaseString)
    .digest('hex');
  const expected = `${SLACK_VERSION}=${hmac}`;

  // Constant-time comparison
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}
