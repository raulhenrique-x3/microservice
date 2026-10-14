import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { connectRabbit } from './queue/rabbit.js';
import { OutboxRelay } from './queue/outbox.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const ch = await connectRabbit();
  const outbox = app.get(OutboxRelay);
  outbox.channel = ch;
  await app.listen(process.env.PORT ?? 3000);
  console.log('[api] up on', process.env.PORT ?? 3000);
}
await bootstrap();
