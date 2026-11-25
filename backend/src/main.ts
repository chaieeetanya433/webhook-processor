import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ApiModule } from './api.module';
import { APP_CONFIG } from './db/db.module';
import { AppConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableCors({
    origin: config.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  app.enableShutdownHooks();

  await app.listen(config.PORT);
  logger.log(`Webhook API listening on port ${config.PORT}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal API bootstrap error:', err);
  process.exit(1);
});
