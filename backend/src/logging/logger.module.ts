import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: {
          service: 'webhook-api',
        },
        autoLogging: {
          ignore: (req) => req.url === '/health',
        },
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class ApiLoggerModule {}
