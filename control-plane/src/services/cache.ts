// ClawBot Cloud — In-process TTL Cache
// Simple time-based cache to reduce DynamoDB reads for hot paths

import { config } from '../config.js';
import type { Bot, Session } from '@clawbot/shared';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    // Purge expired entries on size check
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
      }
    }
    return this.map.size;
  }
}

// Pre-configured caches for hot paths
export const botCache = new TtlCache<Bot>(config.cacheTtlMs);
export const channelCredentialCache = new TtlCache<Record<string, string>>(
  config.cacheTtlMs,
);
export const sessionCache = new TtlCache<Session>(config.cacheTtlMs);
