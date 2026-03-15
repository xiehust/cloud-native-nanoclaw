// ClawBot Cloud — Slack Web API Client
// Wraps Slack's Web API for sending messages and verifying credentials

const SLACK_API = 'https://slack.com/api';

export async function sendMessage(
  botToken: string,
  channelId: string,
  text: string,
): Promise<void> {
  const url = `${SLACK_API}/chat.postMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      text,
      // Slack renders mrkdwn by default
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Slack chat.postMessage HTTP error: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  }
}

export async function authTest(
  botToken: string,
): Promise<{ userId: string; teamId: string; botId: string }> {
  const url = `${SLACK_API}/auth.test`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Slack auth.test HTTP error: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    ok: boolean;
    user_id?: string;
    team_id?: string;
    bot_id?: string;
    error?: string;
  };
  if (!data.ok) {
    throw new Error(`Slack auth.test failed: ${data.error}`);
  }

  return {
    userId: data.user_id || '',
    teamId: data.team_id || '',
    botId: data.bot_id || '',
  };
}

export async function sendReply(
  botToken: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const url = `${SLACK_API}/chat.postMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      thread_ts: threadTs,
      text,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Slack thread reply HTTP error: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack thread reply failed: ${data.error}`);
  }
}
