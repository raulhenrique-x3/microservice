import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BUCKETS,
  ConversionCompleted,
  ConversionRequested,
  ConversionStarted,
  EX,
  MIME_BY_FORMAT,
  MinioClient,
  OutboxRelay,
  connectRabbit,
  loadDotEnv,
  validateConversionRequested,
} from '@app/shared';
import { convert } from './conversion/converters.js';
import { PrismaService } from './services/prisma.service.js';
import { Prisma } from '../prisma/generated/client/index.js';

loadDotEnv(); // before anything reads process.env (MAX_ATTEMPTS / factories)

/** Outbox rows the relay publishes, one route per event kind. */
const WORKER_ROUTES = [
  { kind: 'CONVERSION_STARTED', exchange: EX.EVENTS_EXCHANGE, routingKey: EX.RK_STARTED },
  { kind: 'CONVERSION_COMPLETED', exchange: EX.EVENTS_EXCHANGE, routingKey: EX.RK_COMPLETED },
  { kind: 'CONVERSION_FAILED', exchange: EX.EVENTS_EXCHANGE, routingKey: EX.RK_FAILED },
];

@Module({
  providers: [
    PrismaService,
    {
      provide: MinioClient,
      useFactory: () =>
        new MinioClient({
          endpoint: process.env.MINIO_ENDPOINT || 'localhost',
          port: Number(process.env.MINIO_PORT || 9000),
          accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
          secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
        }),
    },
    {
      provide: OutboxRelay,
      useFactory: (prisma: PrismaService) => new OutboxRelay(prisma, WORKER_ROUTES),
      inject: [PrismaService],
    },
  ],
  exports: [PrismaService, MinioClient, OutboxRelay],
})
export class WorkerModule {}

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);

export async function startWorker() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  const prisma = app.get(PrismaService);
  const minio = app.get(MinioClient);
  const outbox = app.get(OutboxRelay);
  await Promise.all([minio.ensureBucket(BUCKETS.upload), minio.ensureBucket(BUCKETS.converted)]);
  outbox.channel = await connectRabbit();

  outbox.channel!.consume(EX.JOBS_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const r = await handleMessage(msg);
      if (r.ack && r.msg) outbox.channel!.ack(r.msg);
    } catch (e) {
      console.error('[worker] unexpected error:', e);
      await new Promise((r) => setTimeout(r, 2000)); // transient infra failure → requeue
      try { outbox.channel!.nack(msg, false, true); } catch {}
    }
  });
  console.log('[worker] consuming', EX.JOBS_QUEUE);

  async function handleMessage(msg: import('amqplib').ConsumeMessage | null): Promise<{ ack: boolean; msg: typeof msg }> {
    if (!msg) return { ack: false, msg };
    const log = (...a: unknown[]) => console.log('[worker]', ...a);

    // invalid message shape → definitive failure, straight to DLQ
    let payload: ConversionRequested;
    try {
      payload = validateConversionRequested(JSON.parse(msg.content.toString()));
    } catch (e) {
      log('invalid message, dead-lettering:', (e as Error).message);
      outbox.channel!.nack(msg, false, false);
      return { ack: false, msg: null };
    }

    // claim with our own ProcessingJob row (replaces the old API-database claim)
    let claimed: { status: string; attempts: number } | null = null;
    try {
      await prisma.processingJob.create({ data: { jobId: payload.jobId } });
      // first delivery: publish claim event for the API projection
      await prisma.outbox.create({
        data: {
          kind: 'CONVERSION_STARTED',
          payload: JSON.stringify({
            eventId: randomUUID(),
            jobId: payload.jobId,
            startedAt: new Date().toISOString(),
          } satisfies ConversionStarted),
        },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      claimed = await prisma.processingJob.findUnique({ where: { jobId: payload.jobId } });
      if (!claimed) throw e;
      if (claimed.status === 'DONE' || claimed.status === 'ERRORED') {
        log('job', payload.jobId, `${claimed.status} already finalized → ack (idempotent)`);
        return { ack: true, msg };
      }
      log('claiming redelivered job', payload.jobId, 'after crash'); // PROCESSING redelivery is reprocessed in place
    }

    try {
      const original = await minio.downloadUpload(payload.objectKey);
      const result = await convert(payload.sourceType as 'video' | 'audio' | 'image', payload.sourceFormat, payload.targetFormat, original);
      const resultKey = `${payload.jobId}/result.${payload.targetFormat}`;
      await minio.putResult(resultKey, result, MIME_BY_FORMAT[payload.targetFormat as keyof typeof MIME_BY_FORMAT]);

      await prisma.$transaction(async (tx) => {
        await tx.processingJob.update({
          where: { jobId: payload.jobId },
          data: { status: 'DONE', resultKey, errorDetail: null },
        });
        const completed: ConversionCompleted = {
          eventId: randomUUID(),
          jobId: payload.jobId,
          targetFormat: payload.targetFormat,
          resultKey,
          notifyEmail: payload.notifyEmail,
          completedAt: new Date().toISOString(),
        };
        await tx.outbox.create({ data: { kind: 'CONVERSION_COMPLETED', payload: JSON.stringify(completed) } });
      });

      // result is committed — original cleanup is best-effort and must NOT flip DONE to ERRORED
      try {
        await minio.deleteUpload(payload.objectKey);
      } catch (e) {
        console.error('[worker] result committed but original cleanup failed:', (e as Error).message);
      }
      log('job', payload.jobId, `→ CONCLUÍDO (${payload.sourceFormat} → ${payload.targetFormat})`);
      return { ack: true, msg };
    } catch (e) {
      const err = e as Error;
      const row = claimed ?? (await prisma.processingJob.findUnique({ where: { jobId: payload.jobId } }));
      const attempts = (row?.attempts ?? 0) + 1;
      log(`job ${payload.jobId} failed (attempt ${attempts}/${MAX_ATTEMPTS}):`, err.message);
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.$transaction(async (tx) => {
          await tx.processingJob.update({
            where: { jobId: payload.jobId },
            data: { status: 'ERRORED', errorDetail: err.message.slice(0, 500), attempts },
          });
          await tx.outbox.create({
            data: {
              kind: 'CONVERSION_FAILED',
              payload: JSON.stringify({
                eventId: randomUUID(),
                jobId: payload.jobId,
                errorDetail: err.message.slice(0, 500),
                failedAt: new Date().toISOString(),
              }),
            },
          });
        });
        outbox.channel!.nack(msg, false, false); // last attempt: DLQ, original preserved
        log('job', payload.jobId, '→ ERRO (definitive, original preserved, message in DLQ)');
        return { ack: false, msg: null };
      }
      await prisma.processingJob.update({ where: { jobId: payload.jobId }, data: { attempts } });
      await new Promise((r) => setTimeout(r, 2000)); // simple backoff before requeue
      outbox.channel!.nack(msg, false, true); // retryable failure → requeue
      return { ack: false, msg: null };
    }
  }
}

await startWorker();
