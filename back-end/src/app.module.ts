import { Module } from '@nestjs/common';
import { PrismaService } from './services/prisma.service.js';
import { MinioService } from './services/minio.service.js';
import { OutboxRelay } from './queue/outbox.js';
import { JobsController } from './jobs/jobs.controller.js';
import { JobsService } from './jobs/jobs.service.js';

@Module({
  providers: [PrismaService, MinioService, OutboxRelay, JobsService],
  controllers: [JobsController],
  exports: [PrismaService, MinioService, OutboxRelay],
})
export class AppModule {}
