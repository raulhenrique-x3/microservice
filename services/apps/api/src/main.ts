import { loadDotEnv, connectRabbit, OutboxRelay } from '@app/shared';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { ProjectionConsumer } from './projection/projection.consumer.js';

loadDotEnv();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const ch = await connectRabbit();
  const outbox = app.get(OutboxRelay);
  outbox.channel = ch;
  outbox.start();
  app.get(ProjectionConsumer).start(ch);
  await app.listen(process.env.PORT ?? 3000);
  console.log('[api] up on', process.env.PORT ?? 3000);
}
await bootstrap();
