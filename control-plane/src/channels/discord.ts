// ClawBot Cloud — Discord REST API Client
// Wraps Discord's REST API v10 for sending messages and verifying credentials

const DISCORD_API = 'https://discord.com/api/v10';

export async function sendMessage(
  botToken: string,
  channelId: string,
  text: string,
): Promise<void> {
  const url = `${DISCORD_API}/channels/${channelId}/messages`;

  // Discord has a 2000 character limit per message
  const chunks = splitMessage(text, 2000);

  for (const chunk of chunks) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: chunk }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Discord sendMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
      );
    }
  }
}

export async function verifyCredentials(
  botToken: string,
): Promise<{ id: string; username: string }> {
  const url = `${DISCORD_API}/users/@me`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Discord credential verification failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { id: string; username: string };
  return data;
}

export async function getGatewayBot(
  botToken: string,
): Promise<{ url: string; shards: number }> {
  const url = `${DISCORD_API}/gateway/bot`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Discord getGatewayBot failed: ${resp.status}`);
  }
  return (await resp.json()) as { url: string; shards: number };
}

// Split long messages at line boundaries
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline before the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) {
      // No good newline, split at a space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0) {
      // No good boundary, hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  return chunks;
}
