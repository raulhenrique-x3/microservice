import { Module } from '@nestjs/common';
import { MinioClient, OutboxRelay, EX } from '@app/shared';
import { PrismaService } from './services/prisma.service.js';
import { JobsController } from './jobs/jobs.controller.js';
import { JobsService } from './jobs/jobs.service.js';
import { ProjectionConsumer } from './projection/projection.consumer.js';

@Module({
  providers: [
    PrismaService,
    {
      // API's scoped S3 identity: writes uploads and presigns converted reads
      provide: MinioClient,
      useFactory: () =>
        new MinioClient({
          endpoint: process.env.MINIO_ENDPOINT || 'localhost',
          port: Number(process.env.MINIO_PORT || 9000),
          accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
          secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
          presignHost: process.env.MINIO_PRESIGN_HOST,
        }),
    },
    {
      provide: OutboxRelay,
      useFactory: (prisma: PrismaService) =>
        new OutboxRelay(prisma, [{ kind: 'CONVERSION_REQUESTED', exchange: EX.JOBS_EXCHANGE, routingKey: EX.RK_CONVERT }]),
      inject: [PrismaService],
    },
    JobsService,
    ProjectionConsumer,
  ],
  controllers: [JobsController],
  exports: [PrismaService, MinioClient, OutboxRelay, ProjectionConsumer],
})
export class AppModule {}
