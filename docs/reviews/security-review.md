# Security Review Report

**Date:** 2026-03-26
**Scope:** Full codebase — shared, control-plane, agent-runtime, web-console, infra
**Reviewer:** Automated Security Audit

---

## Executive Summary

This review identified **58 findings** across all packages. The most critical issues involve authentication bypass in dev mode, plaintext password storage in the browser, missing webhook signature verification, and broken ABAC tenant isolation in S3. Several findings are defense-in-depth gaps that compound when combined (e.g., missing WAF rules + no app-level rate limiting).

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 12 |
| Medium | 20 |
| Low | 14 |
| Info | 7 |

---

## Critical Findings

### SEC-C01: JWT Verification Bypassed When Cognito Not Configured

**Severity:** Critical
**Package:** control-plane
**File:** `control-plane/src/routes/api/index.ts:57-71`

When `COGNITO_USER_POOL_ID` or `COGNITO_CLIENT_ID` environment variables are not set, the `verifier` is `null` and the code falls back to "dev mode" — it base64-decodes the JWT payload and trusts whatever `sub`, `email`, and `cognito:groups` claims are present without any cryptographic verification. An attacker can forge a JWT with `"cognito:groups": ["clawbot-admins"]` to gain full admin access if the container starts without Cognito env vars (misconfiguration, partial deployment).

**Recommendation:** Refuse to start or return 503 on all API requests when Cognito is not configured. Add a startup health check that validates required env vars.

---

### SEC-C02: Discord PING Webhook Skips Signature Verification

**Severity:** Critical
**Package:** control-plane
**File:** `control-plane/src/webhooks/discord.ts:44-63`

The Discord webhook handler checks `body.type === INTERACTION_PING` **before** performing signature verification (lines 66-88). Anyone can send `{"type": 1}` to the endpoint and get a valid PONG response, plus trigger a database write updating channel health to "connected" without authentication. Discord's documentation mandates that PING requests must also be signature-verified.

**Recommendation:** Move signature verification before the PING check.

---

### SEC-C03: Webhook Signature Verification Silently Skipped When Secret Missing

**Severity:** Critical
**Package:** control-plane
**Files:** `control-plane/src/webhooks/telegram.ts:147-153`, `slack.ts:165`, `discord.ts:75`, `whatsapp.ts:138`

The pattern `if (creds.webhookSecret && !verify(...))` means that if the secret is empty/undefined in Secrets Manager, signature verification is entirely skipped. An attacker who discovers webhook URLs can forge messages to any bot whose secret is missing. This pattern affects Telegram, Slack, Discord, and WhatsApp handlers.

**Recommendation:** Reject requests with 500 when the signing secret is missing. Never silently skip verification.

---

### SEC-C04: Plaintext Password Stored in localStorage

**Severity:** Critical
**Package:** web-console
**File:** `web-console/src/pages/Login.tsx:9-10, 27-28`

The "Remember Me" feature stores the user's plaintext password in `localStorage`:
```typescript
localStorage.setItem('clawbot_saved_pass', password);
```
`localStorage` is accessible to any JavaScript on the same origin, including XSS payloads and browser extensions. Any XSS vulnerability anywhere in the application would immediately compromise user credentials.

**Recommendation:** Remove password storage entirely. Use Cognito's persistent sessions/refresh tokens for "Remember Me" functionality.

---

### SEC-C05: ALB Listener is HTTP-Only (No HTTPS/TLS)

**Severity:** Critical
**Package:** infra
**File:** `infra/lib/control-plane-stack.ts:325-328`

The ALB only has an HTTP (port 80) listener. No HTTPS (443) listener is configured. The ALB is internet-facing, so direct access bypasses any CloudFront TLS termination. The CloudFront-to-ALB origin also uses `HTTP_ONLY` (`frontend-stack.ts:42`), meaning traffic between CloudFront and ALB traverses the network unencrypted. JWT tokens, user data, and webhook payloads are exposed in transit.

**Recommendation:** Add an HTTPS listener with an ACM certificate, or restrict the ALB security group to CloudFront-only IP ranges and add a custom header validation.

---

## High Findings

### SEC-H01: S3 ListBucket ABAC Prefix Condition Removed — Breaks Tenant Isolation

**Severity:** High
**Package:** infra
**File:** `infra/lib/agent-stack.ts:162-169`

The S3 `ListBucket` permission has **no prefix condition** and a comment states it was "temporarily removed to isolate ABAC tag issue." Any agent can list ALL objects in the data bucket across ALL users and bots, breaking tenant isolation. An agent can enumerate every user's file paths, session states, and memory files.

**Recommendation:** Restore the `s3:prefix` condition scoped to `${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/` immediately.

---

### SEC-H02: WAF Missing AWS Managed Rule Groups

**Severity:** High
**Package:** infra
**File:** `infra/lib/control-plane-stack.ts:330-358`

The WAF only contains a single rate-limiting rule (2000 req/5min per IP). It is missing all AWS Managed Rule Groups: CommonRuleSet (OWASP top 10), KnownBadInputsRuleSet (Log4j, path traversal), SQLiRuleSet, AmazonIpReputationList, and BotControlRuleSet.

**Recommendation:** Add at minimum `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesKnownBadInputsRuleSet`.

---

### SEC-H03: WAF Not Attached to CloudFront Distribution

**Severity:** High
**Package:** infra
**Files:** `infra/lib/frontend-stack.ts`, `infra/lib/control-plane-stack.ts:360-363`

The WAF is `REGIONAL`-scoped and attached only to the ALB. The CloudFront distribution has no WAF. Since CloudFront is the primary entry point, attackers bypass the WAF entirely.

**Recommendation:** Create a `CLOUDFRONT`-scoped WAF and attach it to the distribution.

---

### SEC-H04: Raw Agent Error Messages Sent to Channel Users

**Severity:** High
**Package:** control-plane
**File:** `control-plane/src/sqs/dispatcher.ts:425-436`

When agent invocation fails, the raw error (including AWS ARNs, bucket names, account IDs, internal URLs) is sent directly to the channel user. The code has a TODO acknowledging this: "Sanitize before production."

**Recommendation:** Return a generic "Something went wrong" message to users. Log the detailed error server-side only.

---

### SEC-H05: Environment Variables Leaked in Agent Error Responses

**Severity:** High
**Package:** agent-runtime
**File:** `agent-runtime/src/server.ts:42`

The `/invocations` error response includes `SCOPED_ROLE_ARN`, `SESSION_BUCKET`, and `AWS_REGION` verbatim, revealing AWS account IDs and infrastructure details. This debug scaffolding should not be in production.

**Recommendation:** Remove `envDebug` from error responses. Log server-side only.

---

### SEC-H06: Debug console.log Statements in ABAC Credential Code

**Severity:** High
**Package:** agent-runtime
**File:** `agent-runtime/src/scoped-credentials.ts:35, 53-54, 66, 68, 73, 81, 84`

The `getScopedClients` function contains `console.log` calls prefixed `[ABAC-DEBUG]` that output IAM role ARNs, userId/botId session tags, caller identity ARNs, S3 bucket names, and access test results. These bypass Pino log-level filtering and always appear in CloudWatch Logs.

**Recommendation:** Remove all `console.log` debug statements. Use Pino at `debug` level if diagnostics are needed.

---

### SEC-H07: ReDoS via User-Controlled Trigger Patterns

**Severity:** High
**Package:** control-plane
**Files:** `control-plane/src/webhooks/telegram.ts:89`, `slack.ts:71`, `whatsapp.ts:270`, `discord/message-handler.ts:82`, `feishu/message-handler.ts:129`, `dingtalk/message-handler.ts:107`

Bot owners set a `triggerPattern` compiled directly into `new RegExp(triggerPattern, 'i')` on every incoming message. A malicious pattern like `(a+)+$` can cause catastrophic backtracking (ReDoS), blocking the Node.js event loop for all bots.

**Recommendation:** Validate patterns at creation time with a safe-regex library. Execute with a timeout or use `RE2` for untrusted patterns.

---

### SEC-H08: S3 File Browser Path Traversal

**Severity:** High
**Package:** control-plane
**File:** `control-plane/src/routes/api/files.ts:22-23, 62-63`

`relativePrefix` and `key` from query parameters are concatenated directly into S3 key paths without sanitization. A user could supply `prefix=../../otherUserId/otherBotId/` to list or read another user's files.

**Recommendation:** Validate that relative paths don't contain `..` sequences. Normalize and verify the final key starts with the expected user/bot prefix.

---

### SEC-H09: CORS Origin Defaults to Wildcard

**Severity:** High
**Package:** control-plane
**Files:** `control-plane/src/config.ts:49`, `control-plane/src/index.ts:28`

`corsOrigin` defaults to `'*'` when `CORS_ORIGIN` is not set. Combined with JWT Bearer auth, this allows any website to make cross-origin requests with a obtained JWT token.

**Recommendation:** Require `CORS_ORIGIN` to be explicitly set. Default to the CloudFront domain.

---

### SEC-H10: No Input Validation on /invocations Endpoint

**Severity:** High
**Package:** agent-runtime
**File:** `agent-runtime/src/server.ts:32-34`

The `/invocations` endpoint accepts `request.body` with only a TypeScript type annotation — zero runtime validation. Missing `userId` would cause STS AssumeRole with empty session tags; crafted `sessionPath` could cause unintended S3 operations.

**Recommendation:** Add a Zod schema for `InvocationPayload` and validate at the top of the handler.

---

### SEC-H11: Cognito OAuth Implicit Grant Flow Enabled

**Severity:** High
**Package:** infra
**File:** `infra/lib/auth-stack.ts:48-54`

The implicit grant flow is enabled; OAuth 2.1 explicitly recommends against this because tokens are exposed in URL fragments. Additionally, callback/logout URLs are hardcoded to `http://localhost:5173`.

**Recommendation:** Switch to authorization code grant with PKCE. Add production CloudFront URLs to callback lists.

---

### SEC-H12: Deploy Script Logs Admin Password to Console

**Severity:** High
**Package:** scripts
**File:** `scripts/deploy.sh:497-498`

The deploy script prints the admin password in plaintext to console output. This can end up in CI/CD logs and terminal scrollback.

**Recommendation:** Never log the password. Instruct the user to check their email or reference the env var.

---

### SEC-H13: S3 Data Bucket Missing enforceSSL

**Severity:** High
**Package:** infra
**File:** `infra/lib/foundation-stack.ts:54-70`

Neither the data bucket nor the frontend bucket sets `enforceSSL: true`. Objects could be accessed over unencrypted HTTP.

**Recommendation:** Add `enforceSSL: true` to both S3 buckets.

---

## Medium Findings

### SEC-M01: SQS Message Body Parsed Without Schema Validation

**Package:** control-plane
**File:** `control-plane/src/sqs/dispatcher.ts:256`, `reply-consumer.ts:57`

`JSON.parse(sqsMessage.Body!)` with no schema validation — the result is trusted and cast directly. A compromised SQS queue could inject payloads with arbitrary userId/botId values.

**Recommendation:** Add Zod schema validation for SQS message payloads.

---

### SEC-M02: Slack url_verification Processed Without Signature Check

**Package:** control-plane
**File:** `control-plane/src/webhooks/slack.ts:109-125`

The Slack `url_verification` challenge is processed (including a DB write marking channel as "connected") before signature verification occurs.

**Recommendation:** Verify signature before processing any request type.

---

### SEC-M03: Group Update Route Lacks Input Validation

**Package:** control-plane
**File:** `control-plane/src/routes/api/groups.ts:46-47`

PUT `/:groupJid` casts `request.body` directly with no Zod validation. Arbitrary fields could be stored.

**Recommendation:** Add a Zod schema for group update payloads.

---

### SEC-M04: Attachment Filenames Not Sanitized (Telegram, Discord, Slack)

**Package:** control-plane
**File:** `control-plane/src/services/attachments.ts:27`

File names from Telegram, Discord, and Slack are used directly in S3 keys without sanitization. Unlike the Feishu handler which has `sanitizeFileName()`, these handlers have no path traversal protection.

**Recommendation:** Apply `sanitizeFileName()` consistently across all channel handlers.

---

### SEC-M05: Credential Cache Unbounded and Stores Plaintext Secrets

**Package:** control-plane
**File:** `control-plane/src/services/cache.ts:12-55`

Channel credentials (bot tokens, signing secrets, API keys) are cached in plaintext on the Node.js heap with no size bound. Core dumps would expose all cached credentials.

**Recommendation:** Add LRU eviction. Consider encrypting cached values or reducing TTL.

---

### SEC-M06: WhatsApp Verify Token Non-Constant-Time Comparison

**Package:** control-plane
**File:** `control-plane/src/webhooks/whatsapp.ts:94`

Token compared with `!==` instead of `timingSafeEqual`. Timing side-channel could leak the token.

**Recommendation:** Use `crypto.timingSafeEqual` for all secret comparisons.

---

### SEC-M07: Memory/Files S3 Key Uses Unsanitized groupJid

**Package:** control-plane
**File:** `control-plane/src/routes/api/memory.ts:107`

The group memory endpoint constructs S3 keys using URL parameter `groupJid` directly without path traversal validation.

**Recommendation:** Validate `groupJid` does not contain `../` or other traversal sequences.

---

### SEC-M08: No Application-Level Rate Limiting

**Package:** control-plane
**File:** `control-plane/src/index.ts`

No application-level rate limiting on any route. Relies entirely on WAF which can be bypassed (direct ALB access, misconfiguration).

**Recommendation:** Add Fastify rate-limiting plugin as defense-in-depth.

---

### SEC-M09: DingTalk Stream Messages Lack Per-Message Authentication

**Package:** control-plane
**File:** `control-plane/src/dingtalk/gateway-manager.ts:397-423`

Messages over the DingTalk WebSocket have no per-message signature verification beyond the initial connection authentication.

**Recommendation:** Document as accepted risk or add message-level validation if DingTalk supports it.

---

### SEC-M10: Anthropic API Key Fallback to Direct Env Var Injection

**Package:** agent-runtime
**File:** `agent-runtime/src/agent.ts:234-235`

When the credential proxy fails, the API key is set directly as an environment variable — visible in `/proc/<pid>/environ` and accessible to the agent via `Bash` tool.

**Recommendation:** Make the credential proxy mandatory for `anthropic-api` mode. Fail the invocation if proxy can't start.

---

### SEC-M11: PreToolUse Whitelist Hook Conditionally Installed

**Package:** agent-runtime
**File:** `agent-runtime/src/agent.ts:398-401`

The PreToolUse hook is only installed when `toolWhitelist` flags are truthy. A manipulated payload omitting `toolWhitelist` bypasses restrictions entirely.

**Recommendation:** Always install the hook. Make it a no-op when whitelist is not configured.

---

### SEC-M12: Agent Runs with bypassPermissions (Accepted Risk)

**Package:** agent-runtime
**File:** `agent-runtime/src/agent.ts:370-371`

The Claude Agent SDK is configured with `permissionMode: 'bypassPermissions'`. The agent can execute arbitrary bash commands including `curl` for data exfiltration and `env` to read credentials. The MANAGED_CLAUDE.md policy is enforced only by LLM instruction-following.

**Recommendation:** Document in threat model. Add network egress controls at VPC/security group level.

---

### SEC-M13: Credential Proxy SSRF Potential

**Package:** agent-runtime
**File:** `agent-runtime/src/credential-proxy.ts:52-114`

The proxy forwards requests to any target URL in the rules without validation against private IP ranges or cloud metadata endpoints (169.254.169.254).

**Recommendation:** Add URL validation rejecting private IPs and metadata endpoints. Add request timeouts.

---

### SEC-M14: DynamoDB ABAC LeadingKeys Uses Wildcard Suffix

**Package:** infra
**File:** `infra/lib/agent-stack.ts:185-203`

The condition `${aws:PrincipalTag/botId}*` means bot `bot_A` can access keys like `bot_AB`. If bot IDs share prefixes, data leaks across tenants.

**Recommendation:** Use delimiter-based pattern like `${aws:PrincipalTag/botId}#*`.

---

### SEC-M15: Bedrock InvokeModel on Wildcard Resource

**Package:** infra
**File:** `infra/lib/agent-stack.ts:47-54`

`bedrock:InvokeModel` uses `resources: ['*']` — any model in the account can be invoked.

**Recommendation:** Scope to specific model ARN patterns.

---

### SEC-M16: S3 Data Bucket Uses SSE-S3 Instead of SSE-KMS

**Package:** infra
**File:** `infra/lib/foundation-stack.ts:57`

Data bucket uses S3-managed encryption rather than KMS. Lacks key rotation audit trail and revocation capability.

**Recommendation:** Switch to SSE-KMS for the data bucket.

---

### SEC-M17: DynamoDB Tables Missing Point-in-Time Recovery

**Package:** infra
**File:** `infra/lib/foundation-stack.ts:103-174`

Only 1 of 8 tables has PITR enabled. Accidental deletion or corruption of user data is unrecoverable.

**Recommendation:** Enable PITR on all tables.

---

### SEC-M18: Cognito Missing MFA and Advanced Security

**Package:** infra
**File:** `infra/lib/auth-stack.ts:20-38`

No MFA, no advanced security mode (adaptive auth, compromised credential detection, brute-force protection).

**Recommendation:** Enable MFA (at least `OPTIONAL`) and advanced security mode.

---

### SEC-M19: CloudFront Missing Security Response Headers

**Package:** infra
**File:** `infra/lib/frontend-stack.ts:54-99`

No `ResponseHeadersPolicy` — missing HSTS, X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy.

**Recommendation:** Attach the CloudFront managed `SECURITY_HEADERS` policy.

---

### SEC-M20: SQS Queues Missing Encryption

**Package:** infra
**File:** `infra/lib/foundation-stack.ts:78-100`

Three SQS queues contain user conversations and agent responses but have no encryption configured.

**Recommendation:** Enable SSE-SQS or SSE-KMS.

---

## Low Findings

### SEC-L01: Admin Route Guard is Client-Side Only

**Package:** web-console | **File:** `web-console/src/App.tsx:38-43`

Admin routes guarded by client-side `user.isAdmin` check only. Attackers can manipulate React state. Mitigated if server-side admin checks exist on `/admin/*` API endpoints.

### SEC-L02: Server Error Messages Propagated to UI

**Package:** web-console | **File:** `web-console/src/lib/api.ts:21-24`

Backend error messages shown to users without sanitization. Could leak internal details.

### SEC-L03: Cognito IDs in .env Files with Possible .gitignore Bug

**Package:** web-console | **File:** `web-console/.env.production`

Cognito Pool ID and Client ID committed to repo. The `.gitignore` line 18 may have a concatenation bug preventing exclusion.

### SEC-L04: USER_PASSWORD_AUTH Used Instead of SRP

**Package:** web-console | **File:** `web-console/src/lib/auth.ts:63-67`

Password sent in cleartext to Cognito (over HTTPS). SRP would provide defense-in-depth.

### SEC-L05: No Client-Side Form Input Validation

**Package:** web-console | **Files:** Multiple pages

Form inputs have minimal validation. `triggerPattern`, `groupJid`, `prompt`, and admin fields lack format checks.

### SEC-L06: Credential Secret ARN Logged in Error Messages

**Package:** control-plane | **File:** `control-plane/src/dingtalk/gateway-manager.ts:462`

Error messages include secret ARNs, revealing AWS account ID and naming convention.

### SEC-L07: Health Endpoint Exposes Process Uptime

**Package:** control-plane | **File:** `control-plane/src/routes/health.ts:9`

`/health` returns `process.uptime()`. Minor information disclosure.

### SEC-L08: Webhook Error Handlers Swallow Errors (Messages Lost)

**Package:** control-plane | **File:** `control-plane/src/webhooks/telegram.ts:290-293` (and others)

All webhook handlers return HTTP 200 on error. Persistent failures are silently swallowed with no dead-letter mechanism.

### SEC-L09: Feishu Gateway Missing Leader Election

**Package:** control-plane | **File:** `control-plane/src/feishu/gateway-manager.ts`

Unlike Discord and DingTalk, Feishu has no leader election. Multiple ECS tasks could cause duplicate message processing.

### SEC-L10: SQS Reply Queue Uses Unscoped Credentials

**Package:** agent-runtime | **File:** `agent-runtime/src/mcp-tools.ts:72, 140`

Reply queue operations use runtime credentials, not ABAC-scoped ones. No IAM-level enforcement preventing cross-bot message injection. Mitigated by AgentCore microVM isolation.

### SEC-L11: Symlink Allowlist Includes Full /home/node/

**Package:** agent-runtime | **File:** `agent-runtime/src/session.ts:248-249`

S3 upload follows symlinks under `/home/node/`. Agent could symlink sensitive dotfiles for exfiltration.

### SEC-L12: S3 Data Bucket Missing Explicit blockPublicAccess

**Package:** infra | **File:** `infra/lib/foundation-stack.ts:54-70`

While CDK defaults to blocking public access, it should be explicit for a data bucket.

### SEC-L13: ALB Missing Deletion Protection, Access Logging, dropInvalidHeaderFields

**Package:** infra | **File:** `infra/lib/control-plane-stack.ts:79-85`

Three missing ALB security configurations: deletion protection, access logging, and invalid header dropping.

### SEC-L14: VPC Missing Flow Logs

**Package:** infra | **File:** `infra/lib/foundation-stack.ts:36-51`

No VPC Flow Logs for security incident investigation or compliance.

---

## Informational / Positive Findings

| ID | Finding |
|----|---------|
| SEC-I01 | No `dangerouslySetInnerHTML` or raw HTML injection anywhere in web-console |
| SEC-I02 | All `target="_blank"` links correctly use `rel="noopener noreferrer"` |
| SEC-I03 | URL parameters properly encoded with `encodeURIComponent()` |
| SEC-I04 | XML formatter correctly escapes `&`, `<`, `>`, `"` (minor: `'` not escaped) |
| SEC-I05 | `stripInternalTags` regex is safe for current (non-HTML) use case |
| SEC-I06 | ABAC credential scoping design is architecturally sound |
| SEC-I07 | Agent `disallowedTools` correctly blocks CronCreate/CronDelete/CronList |

---

## Remediation Priority

### Immediate (Before Next Deploy)

1. **SEC-C01** — Remove JWT dev-mode bypass or gate behind explicit `DEV_MODE=true` env var
2. **SEC-C04** — Remove plaintext password from localStorage
3. **SEC-H01** — Restore S3 ListBucket ABAC prefix condition
4. **SEC-C03** — Reject webhook requests when signing secret is missing
5. **SEC-C02** — Move Discord signature verification before PING check
6. **SEC-H04/H05** — Sanitize error messages sent to users and remove env debug from responses
7. **SEC-H12** — Stop logging admin password in deploy script

### Short-Term (Next Sprint)

8. **SEC-C05** — Add HTTPS listener to ALB or restrict to CloudFront IPs
9. **SEC-H02/H03** — Add WAF managed rule groups and CloudFront WAF
10. **SEC-H07** — Validate trigger patterns with safe-regex
11. **SEC-H08** — Add path traversal protection to file browser
12. **SEC-H10** — Add Zod validation on /invocations endpoint
13. **SEC-H11** — Switch Cognito to authorization code grant with PKCE
14. **SEC-H13** — Add enforceSSL to S3 buckets

### Medium-Term (Next Month)

15. **SEC-M08** — Add application-level rate limiting
16. **SEC-M13** — SSRF protection in credential proxy
17. **SEC-M14** — Fix DynamoDB ABAC wildcard pattern
18. **SEC-M18** — Enable Cognito MFA
19. **SEC-M19** — Add CloudFront security headers
20. **SEC-M20** — Enable SQS encryption

---

## Methodology

Each package was audited by reading source code directly. No automated scanning tools were used. Findings were classified using a 4-tier severity scale:

- **Critical:** Directly exploitable vulnerability that could lead to full system compromise, data breach, or authentication bypass
- **High:** Significant security weakness that could be exploited with some effort or in combination with other issues
- **Medium:** Defense-in-depth gap or hardening issue that increases attack surface
- **Low:** Minor issue, informational disclosure, or best-practice deviation with limited practical impact
