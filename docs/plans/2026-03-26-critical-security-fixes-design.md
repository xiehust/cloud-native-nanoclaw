# Critical Security Fixes Design

**Date:** 2026-03-26
**Scope:** 5 Critical findings from `docs/reviews/security-review.md`
**Status:** Approved

---

## SEC-C01: Remove JWT Dev-Mode Bypass

**File:** `control-plane/src/routes/api/index.ts:57-71`

**Problem:** When Cognito env vars are missing, the auth middleware base64-decodes the JWT payload without cryptographic verification. An attacker can forge admin access.

**Fix:** Remove the dev-mode code path entirely. When `verifier` is null, return HTTP 503 with `"Authentication service not configured"`. Add a startup warning log.

**Rationale:** Local development uses the dev-stage Cognito pool deployed by CDK. No need for an unsafe fallback.

---

## SEC-C02: Discord PING Must Go Through Signature Verification

**File:** `control-plane/src/webhooks/discord.ts:44-63`

**Problem:** PING check happens before signature verification. Anyone can send `{"type": 1}` to get a PONG response + DB write without authentication.

**Fix:** Restructure the handler:
1. Look up Discord channel credentials
2. Verify Ed25519 signature (reject 401 if invalid or if publicKey is missing)
3. Then handle PING/command routing

The credential lookup and verification code already exists at lines 67-88 — move it above the PING check.

---

## SEC-C03: Reject Webhooks When Signing Secret Missing

**Files:** `telegram.ts:147-153`, `slack.ts:109-125`, `discord.ts:75`, `whatsapp.ts:138`

**Problem:** Pattern `if (secret && !verify(...))` silently skips verification when the secret is empty/undefined.

**Fix:** For all 4 channel handlers, reject with HTTP 500 when the signing secret is missing:

```typescript
if (!creds.webhookSecret) {
  logger.error({ botId }, 'Signing secret not configured');
  return reply.status(500).send({ error: 'Webhook not properly configured' });
}
if (!verify(headers, rawBody, creds.webhookSecret)) {
  return reply.status(401).send({ error: 'Invalid signature' });
}
```

Channel-specific secret field names:
- Telegram: `creds.webhookSecret`
- Slack: `creds.signingSecret`
- Discord: `creds.publicKey`
- WhatsApp: `creds.appSecret`

For Slack, signature verification must also move BEFORE `url_verification` challenge processing (SEC-M02 overlap).

---

## SEC-C04: Remove Plaintext Password from localStorage

**File:** `web-console/src/pages/Login.tsx:9-10, 27-28`

**Problem:** "Remember Me" stores the raw password in `localStorage`, accessible to XSS and browser extensions.

**Fix:**
- Remove all `clawbot_saved_pass` reads and writes
- Keep `clawbot_saved_email` for email-only "Remember Me"
- Password state initializes to empty string
- Cognito's persistent sessions handle actual session continuity

---

## SEC-C05: Restrict ALB to CloudFront-Only Access

**Files:** `infra/lib/control-plane-stack.ts:63-69`, `infra/lib/frontend-stack.ts:41-43`, `control-plane/src/index.ts`, `control-plane/src/config.ts`

**Problem:** ALB is HTTP-only and internet-facing. Direct access bypasses CloudFront TLS termination.

**Fix (2 layers):**

### Layer 1: Security Group Restriction
Replace `Peer.anyIpv4()` ingress rules with the AWS-managed CloudFront prefix list:
```typescript
albSg.addIngressRule(
  ec2.Peer.prefixList('pl-3b927c52'), // com.amazonaws.global.cloudfront.origin-facing
  ec2.Port.tcp(80),
  'HTTP from CloudFront only'
);
```
Note: Use `Fn.importValue` or a lookup for the managed prefix list to be region-agnostic.

### Layer 2: Custom Origin Header (Fastify)
- CDK generates a random secret string and passes it as env var `ORIGIN_VERIFY_SECRET` to ECS + as a custom header in CloudFront origin config
- Fastify preHandler hook checks `X-Origin-Verify` header matches the secret
- Webhook and health endpoints also go through CloudFront, so they're covered

---

## Files Changed Summary

| File | Change |
|------|--------|
| `control-plane/src/routes/api/index.ts` | Remove dev-mode JWT bypass |
| `control-plane/src/webhooks/discord.ts` | Move sig verify before PING; reject if publicKey missing |
| `control-plane/src/webhooks/telegram.ts` | Reject if webhookSecret missing |
| `control-plane/src/webhooks/slack.ts` | Move sig verify before url_verification; reject if signingSecret missing |
| `control-plane/src/webhooks/whatsapp.ts` | Reject if appSecret missing |
| `web-console/src/pages/Login.tsx` | Remove password localStorage |
| `infra/lib/control-plane-stack.ts` | Restrict ALB SG to CloudFront prefix list; pass origin secret env var |
| `infra/lib/frontend-stack.ts` | Add custom origin header to ALB origin |
| `control-plane/src/index.ts` | Add X-Origin-Verify preHandler hook |
| `control-plane/src/config.ts` | Add originVerifySecret config |
