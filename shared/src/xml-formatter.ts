// Ported from NanoClaw src/router.ts — XML message formatting for agent context

export interface FormattableMessage {
  senderName: string;
  content: string;
  timestamp: string;
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatLocalTime(
  isoTimestamp: string,
  timezone: string,
): string {
  try {
    return new Date(isoTimestamp).toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return isoTimestamp;
  }
}

export function formatMessages(
  messages: FormattableMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.senderName)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}
