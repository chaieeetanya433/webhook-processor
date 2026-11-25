import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { ApiLoggerModule } from './logging/logger.module';
import { EventsController } from './webhooks/events.controller';
import { EventsService } from './webhooks/events.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [ApiLoggerModule, DbModule],
  controllers: [WebhooksController, EventsController],
  providers: [WebhooksService, EventsService],
})
export class ApiModule {}
