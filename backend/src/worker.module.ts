import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { DbModule } from '../db/db.module';
import { WorkerRepository } from './worker.repository';
import { WorkerRunner } from './worker.runner';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: {
          service: 'webhook-worker',
          workerId: process.env.WORKER_ID ?? 'worker-1',
        },
      },
    }),
    DbModule,
  ],
  providers: [WorkerRepository, WorkerRunner],
  exports: [WorkerRepository, WorkerRunner],
})
export class WorkerModule {}
