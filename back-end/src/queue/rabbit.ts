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

  await ch.assertExchange(EX.EVENTS_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(EX.EVENTS_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EX.JOBS_DLX, 'x-dead-letter-routing-key': EX.RK_DEAD },
  });
  await ch.bindQueue(EX.EVENTS_QUEUE, EX.EVENTS_EXCHANGE, EX.RK_COMPLETED);
}

export function publishJson(ch: Channel, exchange: string, routingKey: string, payload: object) {
  ch.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
}
