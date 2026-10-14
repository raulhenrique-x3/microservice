import amqplib from 'amqplib';
import { EX } from './contracts.js';

export type Channel = amqplib.Channel;

/**
 * shortcut: no internal reconnect loop — processes exit on connection loss and
 * rely on `restart: unless-stopped` (compose) / supervisor restart.
 */
export async function connectRabbit(url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'): Promise<Channel> {
  const conn = await amqplib.connect(url);
  conn.on('error', (e) => { console.error('[rabbit] connection lost:', e.message); process.exit(1); });
  conn.on('close', () => process.exit(1));
  const ch = await conn.createChannel();
  await ch.prefetch(1);
  await assertTopology(ch);
  return ch;
}

export async function assertTopology(ch: Channel) {
  await ch.assertExchange(EX.JOBS_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(EX.JOBS_DLX, 'direct', { durable: true });
  await ch.assertQueue(EX.JOBS_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EX.JOBS_DLX, 'x-dead-letter-routing-key': EX.RK_DEAD },
  });
  await ch.bindQueue(EX.JOBS_QUEUE, EX.JOBS_EXCHANGE, EX.RK_CONVERT);
  await ch.assertQueue(EX.JOBS_DLQ, { durable: true });
  await ch.bindQueue(EX.JOBS_DLQ, EX.JOBS_DLX, EX.RK_DEAD);

  await ch.assertExchange(EX.EVENTS_EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue(EX.NOTIFIER_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EX.JOBS_DLX, 'x-dead-letter-routing-key': EX.RK_DEAD },
  });
  await ch.bindQueue(EX.NOTIFIER_QUEUE, EX.EVENTS_EXCHANGE, EX.RK_COMPLETED);
  await ch.assertQueue(EX.PROJECTION_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EX.JOBS_DLX, 'x-dead-letter-routing-key': EX.RK_DEAD },
  });
  await ch.bindQueue(EX.PROJECTION_QUEUE, EX.EVENTS_EXCHANGE, '#');
}

export function publishJson(ch: Channel, exchange: string, routingKey: string, payload: object) {
  ch.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
}

export interface OutboxRoute {
  kind: string;
  exchange: string;
  routingKey: string;
}

/** Minimal structural view of a service Prisma client (DRY across services). */
export interface OutboxStore {
  outbox: {
    findMany(args: object): Promise<Array<{ id: string; kind: string; payload: string }>>;
    update(args: object): Promise<unknown>;
  };
}

/**
 * Transactional Outbox relay. Each service keeps its OWN outbox table in its
 * OWN database; appending the row inside the SAME transaction as the domain
 * change guarantees the message eventually exists if the commit succeeded —
 * closing the "saved but never published" gap of a direct Rabbit publish.
 * Publication happens after (at-least-once); consumers are idempotent.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  channel?: Channel;

  constructor(
    private store: OutboxStore,
    private routes: OutboxRoute[],
  ) {}

  start(intervalMs = 1500) {
    this.timer = setInterval(() => this.drain(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain() {
    try {
      const rows = await this.store.outbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const row of rows) {
        const route = this.routes.find((r) => r.kind === row.kind);
        if (!route) {
          await this.store.outbox.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
          continue;
        }
        publishJson(this.channel!, route.exchange, route.routingKey, JSON.parse(row.payload));
        await this.store.outbox.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
      }
    } catch (e) {
      console.error('[outbox] drain failed:', (e as Error).message);
    }
  }
}
