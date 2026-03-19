// ClawBot Cloud — S3 File Browser API
// List and read files under a bot's S3 prefix

import type { FastifyPluginAsync } from 'fastify';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../config.js';
import { getBot } from '../../services/dynamo.js';

const s3 = new S3Client({ region: config.region });

export const filesRoutes: FastifyPluginAsync = async (app) => {
  // List files/folders under a bot's S3 prefix
  app.get<{ Params: { botId: string }; Querystring: { prefix?: string } }>(
    '/',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot) return reply.status(404).send({ error: 'Bot not found' });

      const bucket = config.s3Bucket;
      const basePrefix = `${request.userId}/${botId}/`;
      const relativePrefix = request.query.prefix || '';
      const fullPrefix = basePrefix + relativePrefix;

      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: fullPrefix,
        Delimiter: '/',
      }));

      const folders = (result.CommonPrefixes || []).map(p => ({
        key: p.Prefix!.slice(basePrefix.length),
        name: p.Prefix!.slice(fullPrefix.length).replace(/\/$/, ''),
        isFolder: true,
      }));

      const files = (result.Contents || [])
        .filter(obj => obj.Key !== fullPrefix)
        .map(obj => ({
          key: obj.Key!.slice(basePrefix.length),
          name: obj.Key!.slice(fullPrefix.length),
          isFolder: false,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
        }));

      return { entries: [...folders, ...files] };
    },
  );

  // Get file content
  app.get<{ Params: { botId: string }; Querystring: { key: string } }>(
    '/content',
    async (request, reply) => {
      const { botId } = request.params;
      const key = request.query.key;
      if (!key) return reply.status(400).send({ error: 'key query param required' });

      const bot = await getBot(request.userId, botId);
      if (!bot) return reply.status(404).send({ error: 'Bot not found' });

      const bucket = config.s3Bucket;
      const fullKey = `${request.userId}/${botId}/${key}`;

      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey }));
        const body = await result.Body?.transformToString();
        return {
          content: body || '',
          size: result.ContentLength || 0,
          lastModified: result.LastModified?.toISOString(),
          contentType: result.ContentType,
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'NoSuchKey') {
          return reply.status(404).send({ error: 'File not found' });
        }
        throw err;
      }
    },
  );
};
