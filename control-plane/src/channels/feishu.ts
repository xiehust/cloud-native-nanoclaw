// ClawBot Cloud — Feishu/Lark API Client
// Wraps Feishu Open API for sending messages and verifying credentials
// Uses native fetch (raw HTTP calls), following the same pattern as telegram.ts and slack.ts.
// Domain can be "feishu" (open.feishu.cn) or "lark" (open.larksuite.com).

// ── Helpers ─────────────────────────────────────────────────────────────────

export type FeishuDomain = 'feishu' | 'lark';

/**
 * Returns the API base URL for the given domain.
 * "feishu" → https://open.feishu.cn   (China)
 * "lark"   → https://open.larksuite.com (International)
 */
export function getFeishuApiBase(domain: FeishuDomain = 'feishu'): string {
  return domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

// ── Token Cache ───────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // Date.now() ms
}

const tokenCache = new Map<string, CachedToken>();
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Obtains a tenant_access_token via the internal app auth endpoint.
 * POST /open-apis/auth/v3/tenant_access_token/internal/
 *
 * Tokens are cached in-memory by appId+domain. The token is valid for ~2 hours;
 * cache refreshes 5 minutes before expiry to avoid edge-case failures.
 */
export async function getFeishuTenantToken(
  appId: string,
  appSecret: string,
  domain: FeishuDomain = 'feishu',
): Promise<string> {
  const cacheKey = `${appId}:${domain}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/auth/v3/tenant_access_token/internal/`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu tenant_access_token request failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number; // seconds until expiry
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(
      `Feishu tenant_access_token error: code=${data.code} msg=${data.msg}`,
    );
  }

  const expireSec = data.expire ?? 7200; // default 2 hours
  tokenCache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + expireSec * 1000 - TOKEN_SAFETY_MARGIN_MS,
  });

  return data.tenant_access_token;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a plain text message via im.message.create.
 * https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
export async function sendFeishuMessage(
  appId: string,
  appSecret: string,
  chatId: string,
  text: string,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu sendMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu sendMessage error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * Send an Interactive Card (schema 2.0) with markdown body via im.message.create.
 * https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
export async function sendFeishuCardMessage(
  appId: string,
  appSecret: string,
  chatId: string,
  cardContent: Record<string, unknown>,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu sendCardMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu sendCardMessage error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * Reply to a specific message via im.message.reply.
 * https://open.feishu.cn/document/server-docs/im-v1/message/reply
 */
export async function replyFeishuMessage(
  appId: string,
  appSecret: string,
  messageId: string,
  text: string,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu replyMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu replyMessage error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * Verify Feishu app credentials by calling GET /open-apis/bot/v3/info/.
 * Returns bot info on success.
 */
export async function verifyFeishuCredentials(
  appId: string,
  appSecret: string,
  domain: FeishuDomain = 'feishu',
): Promise<{ botOpenId: string; botName: string }> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/bot/v3/info/`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    throw new Error(
      `Feishu verifyCredentials failed: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    bot?: { open_id: string; app_name: string };
  };
  if (data.code !== 0 || !data.bot) {
    throw new Error(
      `Feishu verifyCredentials error: code=${data.code} msg=${data.msg}`,
    );
  }

  return {
    botOpenId: data.bot.open_id,
    botName: data.bot.app_name,
  };
}

// ── File type mapping ──────────────────────────────────────────────────────

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

const MIME_TO_FILE_TYPE: Record<string, FeishuFileType> = {
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt',
};

function getFeishuFileType(mimeType: string): FeishuFileType {
  return MIME_TO_FILE_TYPE[mimeType] || 'stream';
}

// ── File / Image Upload ───────────────────────────────────────────────────

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB — Feishu file upload limit
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB — Feishu image upload limit

/**
 * Upload a file via im/v1/files (multipart/form-data).
 * Returns the file_key to use in file messages.
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create
 */
export async function uploadFeishuFile(
  appId: string,
  appSecret: string,
  file: Buffer,
  fileName: string,
  mimeType: string,
  domain: FeishuDomain = 'feishu',
): Promise<string> {
  if (file.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large for Feishu upload: ${(file.length / 1024 / 1024).toFixed(1)} MB (max 30 MB)`,
    );
  }

  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/files`;

  const form = new FormData();
  form.append('file_type', getFeishuFileType(mimeType));
  form.append('file_name', fileName);
  form.append('file', new Blob([file], { type: mimeType }), fileName);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu uploadFile failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    data?: { file_key: string };
  };
  if (data.code !== 0 || !data.data?.file_key) {
    throw new Error(
      `Feishu uploadFile error: code=${data.code} msg=${data.msg}`,
    );
  }

  return data.data.file_key;
}

/**
 * Upload an image via im/v1/images (multipart/form-data).
 * Returns the image_key to use in image messages.
 * https://open.feishu.cn/document/server-docs/im-v1/image/create
 */
export async function uploadFeishuImage(
  appId: string,
  appSecret: string,
  image: Buffer,
  mimeType: string,
  domain: FeishuDomain = 'feishu',
): Promise<string> {
  if (image.length > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image too large for Feishu upload: ${(image.length / 1024 / 1024).toFixed(1)} MB (max 10 MB)`,
    );
  }

  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/images`;

  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([image], { type: mimeType }), 'image');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu uploadImage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    data?: { image_key: string };
  };
  if (data.code !== 0 || !data.data?.image_key) {
    throw new Error(
      `Feishu uploadImage error: code=${data.code} msg=${data.msg}`,
    );
  }

  return data.data.image_key;
}

// ── Send file / image messages ────────────────────────────────────────────

/**
 * Send a file message via im.message.create with msg_type='file'.
 */
export async function sendFeishuFileMessage(
  appId: string,
  appSecret: string,
  chatId: string,
  fileKey: string,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu sendFileMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu sendFileMessage error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * Send an image message via im.message.create with msg_type='image'.
 */
export async function sendFeishuImageMessage(
  appId: string,
  appSecret: string,
  chatId: string,
  imageKey: string,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu sendImageMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu sendImageMessage error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * Download a message attachment (image, file, etc.) via im.message.resources.
 * GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=...
 * Returns the raw response body as an ArrayBuffer.
 *
 * @param resourceType - 'file' for file attachments, 'image' for inline images.
 */
export async function downloadFeishuResource(
  appId: string,
  appSecret: string,
  messageId: string,
  fileKey: string,
  domain: FeishuDomain = 'feishu',
  resourceType: 'file' | 'image' = 'file',
): Promise<ArrayBuffer> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${resourceType}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu downloadResource failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  return resp.arrayBuffer();
}

// ── Reactions ─────────────────────────────────────────────────────────────

/**
 * Add an emoji reaction to a message.
 * POST /open-apis/im/v1/messages/:message_id/reactions
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 */
export async function addFeishuReaction(
  appId: string,
  appSecret: string,
  messageId: string,
  emojiType: string,
  domain: FeishuDomain = 'feishu',
): Promise<string | undefined> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reaction_type: { emoji_type: emojiType },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu addReaction failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    data?: { reaction_id: string };
  };
  if (data.code !== 0) {
    throw new Error(
      `Feishu addReaction error: code=${data.code} msg=${data.msg}`,
    );
  }

  return data.data?.reaction_id;
}

/**
 * Remove a specific emoji reaction from a message.
 * DELETE /open-apis/im/v1/messages/:message_id/reactions/:reaction_id
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
 */
export async function removeFeishuReaction(
  appId: string,
  appSecret: string,
  messageId: string,
  reactionId: string,
  domain: FeishuDomain = 'feishu',
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`;

  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu removeReaction failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(
      `Feishu removeReaction error: code=${data.code} msg=${data.msg}`,
    );
  }
}

/**
 * List reactions on a message, optionally filtered by emoji type.
 * GET /open-apis/im/v1/messages/:message_id/reactions?reaction_type=...
 * Returns reaction IDs so we can find and remove our own.
 */
export async function listFeishuReactions(
  appId: string,
  appSecret: string,
  messageId: string,
  emojiType: string,
  domain: FeishuDomain = 'feishu',
): Promise<Array<{ reactionId: string; operatorId: string }>> {
  const token = await getFeishuTenantToken(appId, appSecret, domain);
  const base = getFeishuApiBase(domain);
  const url = `${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions?reaction_type=${encodeURIComponent(emojiType)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Feishu listReactions failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    data?: {
      items?: Array<{
        reaction_id: string;
        operator: { operator_id: string; operator_type: string };
      }>;
    };
  };
  if (data.code !== 0) {
    throw new Error(
      `Feishu listReactions error: code=${data.code} msg=${data.msg}`,
    );
  }

  return (data.data?.items || []).map((item) => ({
    reactionId: item.reaction_id,
    operatorId: item.operator.operator_id,
  }));
}
