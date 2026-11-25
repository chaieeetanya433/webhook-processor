import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { webhookBodySchema } from './dto';
import { IngestResult, WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Body() rawBody: unknown): Promise<IngestResult> {
    const parsed = webhookBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid webhook payload',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.webhooksService.ingestWebhook(parsed.data);
  }
}
