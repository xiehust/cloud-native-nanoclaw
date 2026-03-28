// DingTalk Gateway Manager
// Manages DingTalk Stream (WebSocket long-connection) for all DingTalk-connected bots.
// Uses dingtalk-stream SDK's DWClient which handles reconnection automatically.
//
// Pattern: follows feishu/gateway-manager.ts for connection lifecycle.

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { DWClientDownStream } from 'dingtalk-stream';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type pino from 'pino';
import type { ChannelConfig } from '@clawbot/shared';
import { config } from '../config.js';
import { getChannelsByType } from '../services/dynamo.js';
import { handleDingTalkMessage } from './message-handler.js';
import { parseDingTalkMessage } from './message-handler.js';

// -- Clients ------------------------------------------------------------------

const secretsMgr = new SecretsManagerClient({ region: config.region });

// -- Types --------------------------------------------------------------------

interface DingTalkBotConnection {
  channel: ChannelConfig;
  client: DWClient;
}

// -- DingTalkGatewayManager ---------------------------------------------------

export class DingTalkGatewayManager {
  private logger: pino.Logger;
  private connections = new Map<string, DingTalkBotConnection>();
  private stopped = false;

  constructor(parentLogger: pino.Logger) {
    this.logger = parentLogger.child({ component: 'dingtalk-gateway' });
  }

  // -- Lifecycle --------------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    const channels = await this.discoverDingTalkChannels();
    if (channels.length === 0) {
      this.logger.info('No DingTalk channels configured, gateway idle');
      return;
    }
    this.logger.info({ channelCount: channels.length }, 'Starting DingTalk stream connections');
    for (const ch of channels) {
      try {
        await this.connectBot(ch);
      } catch (err) {
        this.logger.error({ err, botId: ch.botId }, 'Failed to start DingTalk stream client');
      }
    }
  }

  /**
   * Graceful shutdown: disconnect all stream clients.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    for (const [botId, conn] of this.connections) {
      try {
        conn.client.disconnect();
      } catch (err) {
        this.logger.error({ err, botId }, 'Error disconnecting DingTalk client');
      }
    }
    this.connections.clear();
    this.logger.info('All DingTalk stream connections stopped');
  }

  /**
   * Dynamically add a new bot connection (called when a new dingtalk channel is created).
   */
  async addBot(botId: string): Promise<void> {
    if (this.stopped) {
      this.logger.debug({ botId }, 'DingTalk gateway stopped, skipping addBot');
      return;
    }
    if (this.connections.has(botId)) {
      this.logger.info({ botId }, 'DingTalk bot already connected, skipping');
      return;
    }

    const channels = await this.discoverDingTalkChannels();
    const ch = channels.find((c) => c.botId === botId);
    if (!ch) {
      this.logger.warn({ botId }, 'No DingTalk channel found for bot');
      return;
    }

    try {
      await this.connectBot(ch);
      this.logger.info({ botId }, 'DingTalk stream client added dynamically');
    } catch (err) {
      this.logger.error({ err, botId }, 'Failed to add DingTalk stream client');
    }
  }

  /**
   * Remove a bot connection (called when a dingtalk channel is deleted).
   */
  removeBot(botId: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;

    try {
      conn.client.disconnect();
    } catch (err) {
      this.logger.error({ err, botId }, 'Error disconnecting DingTalk stream client');
    }

    this.connections.delete(botId);
    this.logger.info({ botId }, 'DingTalk stream client removed');
  }

  /**
   * Check if the manager has any active connections.
   */
  get isActive(): boolean {
    return this.connections.size > 0;
  }

  // -- Private ----------------------------------------------------------------

  private async connectBot(ch: ChannelConfig): Promise<void> {
    const creds = await this.loadCredentials(ch.credentialSecretArn);
    const clientId = creds.clientId;
    const clientSecret = creds.clientSecret;

    if (!clientId || !clientSecret) {
      this.logger.warn(
        { botId: ch.botId },
        'Missing clientId or clientSecret in DingTalk credentials, skipping',
      );
      return;
    }

    const botId = ch.botId;
    const logger = this.logger;

    const dwClient = new DWClient({
      clientId,
      clientSecret,
    });

    // Register callback for robot messages.
    // The callback type is synchronous ((v) => void) so we handle the async
    // message processing via a fire-and-forget IIFE and acknowledge
    // receipt immediately to prevent server-side retries (60s timeout).
    dwClient.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      // Acknowledge receipt immediately
      try {
        dwClient.socketCallBackResponse(res.headers.messageId, {
          response: {
            statusLine: { code: 200, reasonPhrase: 'OK' },
            headers: {},
            body: '',
          },
        });
      } catch (ackErr) {
        logger.warn({ err: ackErr, botId }, 'Failed to acknowledge DingTalk message');
      }

      // Process message asynchronously
      void (async () => {
        try {
          const data = parseDingTalkMessage(res.data);
          await handleDingTalkMessage(botId, data.senderStaffId, data, logger);
        } catch (err) {
          logger.error(
            { err, botId },
            'Error handling DingTalk message from stream',
          );
        }
      })();
    });

    await dwClient.connect();

    this.connections.set(botId, {
      channel: ch,
      client: dwClient,
    });

    this.logger.info({ botId }, 'DingTalk stream client connected');
  }

  // PERF-C2: Use GSI query instead of full table scan
  private async discoverDingTalkChannels(): Promise<ChannelConfig[]> {
    return getChannelsByType('dingtalk');
  }

  private async loadCredentials(
    secretArn: string,
  ): Promise<Record<string, string>> {
    const res = await secretsMgr.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!res.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString (binary secret or empty)`);
    }
    try {
      return JSON.parse(res.SecretString);
    } catch (err) {
      throw new Error(`Secret ${secretArn} contains invalid JSON: ${(err as Error).message}`);
    }
  }
}

// -- Singleton ----------------------------------------------------------------

let _manager: DingTalkGatewayManager | null = null;

export function getDingTalkGatewayManager(): DingTalkGatewayManager | null {
  return _manager;
}

export function initDingTalkGatewayManager(
  logger: pino.Logger,
): DingTalkGatewayManager {
  _manager = new DingTalkGatewayManager(logger);
  return _manager;
}
