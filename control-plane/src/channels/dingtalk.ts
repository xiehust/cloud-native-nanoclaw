// NanoClaw on Cloud — DingTalk API Client
// Wraps DingTalk Open API (v1.0) for sending messages and verifying credentials
// Uses native fetch (raw HTTP calls), following the same pattern as feishu.ts and slack.ts.

const DINGTALK_API = 'https://api.dingtalk.com';

// ── Token Cache ───────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // Date.now() ms
}

const tokenCache = new Map<string, CachedToken>();
const pendingTokenRequests = new Map<string, Promise<string>>();
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Obtain a DingTalk v1.0 access token via OAuth2.
 * POST /v1.0/oauth2/accessToken
 *
 * Token is cached in-memory and refreshed 5 minutes before expiry.
 * Concurrent requests for the same clientId are deduplicated.
 */
export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Deduplicate concurrent requests for the same clientId
  const pending = pendingTokenRequests.get(clientId);
  if (pending) return pending;

  const promise = fetchAccessToken(clientId, clientSecret).finally(() => {
    pendingTokenRequests.delete(clientId);
  });
  pendingTokenRequests.set(clientId, promise);
  return promise;
}

async function fetchAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const url = `${DINGTALK_API}/v1.0/oauth2/accessToken`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk getAccessToken failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    accessToken?: string;
    expireIn?: number; // seconds
  };
  if (!data.accessToken) {
    throw new Error(`DingTalk getAccessToken error: no accessToken in response`);
  }

  const expireSec = data.expireIn ?? 7200; // default 2 hours
  tokenCache.set(clientId, {
    token: data.accessToken,
    expiresAt: Date.now() + expireSec * 1000 - TOKEN_SAFETY_MARGIN_MS,
  });

  return data.accessToken;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify DingTalk app credentials by obtaining an access token.
 * DingTalk has no direct "get bot info" API — a successful token exchange
 * is sufficient to confirm the credentials are valid.
 */
export async function verifyCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ robotId: string; robotName: string }> {
  await getAccessToken(clientId, clientSecret);
  return { robotId: clientId, robotName: 'DingTalk Bot' };
}

/**
 * Send a plain text message to a 1:1 conversation.
 * POST /v1.0/robot/oToMessages/batchSend
 * Requires userIds (not openConversationId).
 */
export async function sendMessage(
  accessToken: string,
  userIds: string[],
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgParam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk sendMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Send a markdown message to a 1:1 conversation.
 * POST /v1.0/robot/oToMessages/batchSend
 * Requires userIds (not openConversationId).
 */
export async function sendMarkdownMessage(
  accessToken: string,
  userIds: string[],
  title: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgParam: JSON.stringify({ title, text }),
      msgKey: 'sampleMarkdown',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk sendMarkdownMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Reply with plain text to a group conversation.
 * POST /v1.0/robot/groupMessages/send
 */
export async function replyGroupMessage(
  accessToken: string,
  openConversationId: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      msgParam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
      openConversationId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk replyGroupMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Reply with markdown to a group conversation.
 * POST /v1.0/robot/groupMessages/send
 */
export async function replyGroupMarkdownMessage(
  accessToken: string,
  openConversationId: string,
  title: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      msgParam: JSON.stringify({ title, text }),
      msgKey: 'sampleMarkdown',
      openConversationId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk replyGroupMarkdownMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

// ── Old API Token (required for media upload) ──────────────────────────────

const oldTokenCache = new Map<string, CachedToken>();
const pendingOldTokenRequests = new Map<string, Promise<string>>();

/**
 * Get an old-style access_token via oapi.dingtalk.com/gettoken.
 * Required for media upload which is only available on the old API.
 *
 * Token is cached in-memory and refreshed 5 minutes before expiry.
 * Concurrent requests for the same appKey are deduplicated.
 */
async function getOldAccessToken(appKey: string, appSecret: string): Promise<string> {
  const cached = oldTokenCache.get(appKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Deduplicate concurrent requests for the same appKey
  const pending = pendingOldTokenRequests.get(appKey);
  if (pending) return pending;

  const promise = fetchOldAccessToken(appKey, appSecret).finally(() => {
    pendingOldTokenRequests.delete(appKey);
  });
  pendingOldTokenRequests.set(appKey, promise);
  return promise;
}

async function fetchOldAccessToken(appKey: string, appSecret: string): Promise<string> {
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DingTalk getOldAccessToken failed: ${resp.status} — ${body}`);
  }

  const data = (await resp.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`DingTalk getOldAccessToken error: ${data.errcode} ${data.errmsg}`);
  }
  if (!data.access_token) {
    throw new Error('DingTalk getOldAccessToken: no access_token in response');
  }

  const expireSec = data.expires_in ?? 7200;
  oldTokenCache.set(appKey, {
    token: data.access_token,
    expiresAt: Date.now() + expireSec * 1000 - TOKEN_SAFETY_MARGIN_MS,
  });

  return data.access_token;
}

// ── Media Upload ────────────────────────────────────────────────────────────

/**
 * Upload a file to DingTalk and receive a media_id for later sending.
 * Uses the old API: POST https://oapi.dingtalk.com/media/upload
 * (The v1.0 /robot/messageFiles/upload endpoint does not exist.)
 *
 * @param mediaType - 'image' | 'file' | 'voice' | 'video'
 * @returns media_id string
 */
export async function uploadMedia(
  clientId: string,
  clientSecret: string,
  file: Buffer,
  fileName: string,
  mediaType: 'image' | 'file' | 'audio' | 'video',
): Promise<string> {
  // Old API uses 'voice' instead of 'audio'
  const oldMediaType = mediaType === 'audio' ? 'voice' : mediaType;

  // DingTalk file size limits (same as Feishu)
  const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

  const sizeLimit = mediaType === 'image' ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
  if (file.length > sizeLimit) {
    throw new Error(
      `DingTalk uploadMedia: file too large (${(file.length / 1024 / 1024).toFixed(1)} MB, max ${sizeLimit / 1024 / 1024} MB)`,
    );
  }

  // Old oapi endpoint requires old-style access_token
  const oldToken = await getOldAccessToken(clientId, clientSecret);

  const url = `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(oldToken)}&type=${oldMediaType}`;

  const form = new FormData();
  form.append('media', new Blob([file]), fileName);

  const resp = await fetch(url, {
    method: 'POST',
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk uploadMedia failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    errcode?: number;
    errmsg?: string;
    media_id?: string;
    type?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`DingTalk uploadMedia errcode ${data.errcode}: ${data.errmsg}`);
  }

  if (!data.media_id) {
    throw new Error('DingTalk uploadMedia error: no media_id in response');
  }

  return data.media_id;
}

/**
 * Send a media message (file, image, audio, video) using a previously uploaded mediaId.
 * Routes to oToMessages/batchSend (DM) or groupMessages/send (group) based on target.
 */
export async function sendMediaMessage(
  accessToken: string,
  target: { userIds?: string[]; openConversationId?: string },
  mediaId: string,
  msgKey: 'sampleFile' | 'sampleImageMsg' | 'sampleAudio' | 'sampleVideo',
  robotCode: string,
  fileName?: string,
): Promise<void> {
  // Build msgParam based on msgKey type
  let msgParam: string;
  if (msgKey === 'sampleImageMsg') {
    msgParam = JSON.stringify({ photoURL: mediaId });
  } else if (msgKey === 'sampleFile') {
    // sampleFile requires fileName to display correctly (otherwise shows #fileName#)
    msgParam = JSON.stringify({ mediaId, fileName: fileName || 'file', fileType: fileName?.split('.').pop() || 'file' });
  } else {
    // sampleAudio / sampleVideo
    msgParam = JSON.stringify({ mediaId });
  }

  let url: string;
  let body: Record<string, unknown>;

  if (target.userIds) {
    // DM: oToMessages/batchSend
    url = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
    body = { robotCode, userIds: target.userIds, msgParam, msgKey };
  } else if (target.openConversationId) {
    // Group: groupMessages/send
    url = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
    body = { robotCode, openConversationId: target.openConversationId, msgParam, msgKey };
  } else {
    throw new Error('sendMediaMessage requires either userIds or openConversationId');
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    throw new Error(
      `DingTalk sendMediaMessage failed: ${resp.status} ${resp.statusText} — ${respBody}`,
    );
  }
}

/**
 * Download media from a DingTalk message using downloadCode (two-step process).
 * Step 1: POST /v1.0/robot/messageFiles/download → get presigned downloadUrl
 * Step 2: GET downloadUrl → get file bytes
 *
 * @returns { data: ArrayBuffer, contentType: string } or null if download fails
 */
export async function downloadMedia(
  accessToken: string,
  robotCode: string,
  downloadCode: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  // Step 1: Get download URL from DingTalk API
  const url = `${DINGTALK_API}/v1.0/robot/messageFiles/download`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ downloadCode, robotCode }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DingTalk downloadMedia failed: ${resp.status} ${resp.statusText} — ${body}`);
  }

  const result = (await resp.json()) as { downloadUrl?: string };
  if (!result.downloadUrl) {
    throw new Error('DingTalk downloadMedia: no downloadUrl in response');
  }

  // DingTalk OSS URLs may use HTTP — upgrade to HTTPS
  let downloadUrl = result.downloadUrl;
  if (downloadUrl.startsWith('http://')) {
    downloadUrl = 'https://' + downloadUrl.slice(7);
  }

  // Step 2: Download the actual file
  const fileResp = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!fileResp.ok) {
    throw new Error(`DingTalk media download failed: ${fileResp.status} ${fileResp.statusText}`);
  }

  // Guard against oversized downloads before reading into memory
  const contentLength = Number(fileResp.headers.get('content-length') || 0);
  const MAX_DOWNLOAD_SIZE = 30 * 1024 * 1024; // 30 MB
  if (contentLength > MAX_DOWNLOAD_SIZE) {
    throw new Error(`DingTalk media too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_DOWNLOAD_SIZE / 1024 / 1024} MB)`);
  }

  const contentType = fileResp.headers.get('content-type') || 'application/octet-stream';
  const data = await fileResp.arrayBuffer();

  // Post-read size guard: Content-Length may be absent (e.g. presigned URL redirects),
  // so validate actual bytes read to prevent unbounded memory consumption.
  if (data.byteLength > MAX_DOWNLOAD_SIZE) {
    throw new Error(
      `DingTalk media too large: ${(data.byteLength / 1024 / 1024).toFixed(1)} MB actual (max ${MAX_DOWNLOAD_SIZE / 1024 / 1024} MB)`,
    );
  }

  // Infer content type from URL if response type is generic
  let resolvedContentType = contentType;
  if (contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
    const urlPath = downloadUrl.split('?')[0].toLowerCase();
    if (urlPath.endsWith('.jpg') || urlPath.endsWith('.jpeg')) resolvedContentType = 'image/jpeg';
    else if (urlPath.endsWith('.png')) resolvedContentType = 'image/png';
    else if (urlPath.endsWith('.gif')) resolvedContentType = 'image/gif';
    else if (urlPath.endsWith('.webp')) resolvedContentType = 'image/webp';
    else if (urlPath.endsWith('.mp4')) resolvedContentType = 'video/mp4';
    else if (urlPath.endsWith('.mp3')) resolvedContentType = 'audio/mpeg';
    else if (urlPath.endsWith('.pdf')) resolvedContentType = 'application/pdf';
    else if (urlPath.endsWith('.docx')) resolvedContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  return { data, contentType: resolvedContentType };
}
