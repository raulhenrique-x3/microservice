import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { PrismaService } from './services/prisma.service.js';
import { MinioService } from './services/minio.service.js';
import { OutboxRelay } from './queue/outbox.js';
import { connectRabbit } from './queue/rabbit.js';
import { ConversionCompleted, EX } from './queue/contracts.js';


@Module({ providers: [PrismaService, MinioService, OutboxRelay], exports: [PrismaService, MinioService, OutboxRelay] })
export class NotifierModule {}

export async function startNotifier() {
  const app = await NestFactory.createApplicationContext(NotifierModule, { logger: ['log', 'warn', 'error'] });
  const prisma = app.get(PrismaService);
  const minio = app.get(MinioService);
  const outbox = app.get(OutboxRelay);
  outbox.channel = await connectRabbit();

  const mail = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  outbox.channel!.consume(EX.EVENTS_QUEUE, async (msg) => {
    if (!msg) return;
    const log = (...a: unknown[]) => console.log('[notifier]', ...a);
    try {
      const { jobId }: ConversionCompleted = JSON.parse(msg.content.toString());
      if (!jobId) throw new Error('invalid completion event');

      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) { log('unknown job', jobId, '→ DLQ'); outbox.channel!.nack(msg, false, false); return; }

      // duplicate-prevention: conditional update wins only once
      const claimed = await prisma.job.updateMany({ where: { id: jobId, notifiedAt: null }, data: { notifiedAt: new Date() } });
      if (claimed.count === 0) {
        log('job', jobId, 'already notified → ack (idempotent)');
        outbox.channel!.ack(msg);
        return;
      }

      const link = await minio.presignResult(job.resultKey!);
      const subject = `Sua conversão ${job.targetFormat.toUpperCase()} foi concluída`;
      const text = `Seu arquivo foi processado.\nBaixe em: ${link}\nO link expira em 30 minutos.`;
      try {
        await mail.sendMail({
          from: 'conversor@local',
          to: job.notifyEmail,
          subject,
          text,
          html: `<p>Seu arquivo foi processado.</p><p><a href="${link}">Baixar arquivo convertido</a></p><p><em>O link expira em 30 minutos.</em></p>`,
        });
        log('e-mail enviado para', job.notifyEmail, 'job', jobId);
        outbox.channel!.ack(msg);
      } catch (e) {
        // reset the claim so a redelivery can retry the send
        await prisma.job.updateMany({ where: { id: jobId, notifiedAt: { not: null } }, data: { notifiedAt: null } });
        // only ONE requeue: a redelivery means the send already failed once;
        // most SMTP failures here are permanent (bad recipient) → dead-letter
        if (msg.fields.redelivered) { console.error('[notifier] permanent failure → DLQ:', (e as Error).message); outbox.channel!.nack(msg, false, false); return; }
        throw e;
      }
    } catch (e) {
      console.error('[notifier] error:', (e as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
      try { outbox.channel!.nack(msg, false, true); } catch {} // retryable → requeue
    }
  });
  console.log('[notifier] consuming', EX.EVENTS_QUEUE);
}

await startNotifier();
