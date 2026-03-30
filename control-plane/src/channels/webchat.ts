// NanoClaw on Cloud — Web Channel Client
// Web is an internal websocket channel backed by the control plane.
// No external platform API to call. Credential verification is a no-op.

/**
 * Verify web channel "credentials". Since the web channel is internal
 * (authenticated via Cognito JWT), there are no external credentials to verify.
 * Returns a stable internal channel identifier.
 */
export async function verifyCredentials(
  _credentials: Record<string, string>,
): Promise<{ webChannelId: string }> {
  return { webChannelId: 'web' };
}
