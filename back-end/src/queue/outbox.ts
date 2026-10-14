import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service.js';
import { publishJson } from './rabbit.js';

const KIND_ROUTES: Record<string, { exchange: string; routingKey: string }> = {
  CONVERSION_REQUESTED: { exchange: 'media.jobs', routingKey: 'convert' },
  CONVERSION_COMPLETED: { exchange: 'media.events', routingKey: 'completed' },
};

/**
 * Transactional Outbox relay.
 *
 * Purpose: appending the outbox row inside the SAME database transaction as the
 * domain change (e.g. creating the job) guarantees the message eventually
 * exists if the commit succeeded — closing the "saved but never published" gap
 * of a direct Rabbit publish. Publication happens after (at-least-once).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private prisma: PrismaService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.drain(), 1500);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async append(kind: string, payload: object) {
    await this.prisma.outbox.create({ data: { kind, payload: JSON.stringify(payload) } });
  }

  private async drain() {
    try {
      const rows = await this.prisma.outbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const row of rows) {
        const route = KIND_ROUTES[row.kind];
        if (!route) { await this.prisma.outbox.update({ where: { id: row.id }, data: { publishedAt: new Date() } }); continue; }
        publishJson(this.channel!, route.exchange, route.routingKey, JSON.parse(row.payload));
        await this.prisma.outbox.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
      }
    } catch (e) {
      console.error('[outbox] drain failed:', (e as Error).message);
    }
  }

  channel: import('amqplib').Channel | undefined;
}
