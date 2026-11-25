import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { ApiLoggerModule } from './logging/logger.module';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [ApiLoggerModule, DbModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class ApiModule {}
