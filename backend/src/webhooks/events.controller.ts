import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { listEventsQuerySchema } from './dto';
import {
  EventDetailResponse,
  EventsListResponse,
  EventsService,
  StatsResponse,
} from './events.service';

@Controller()
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get('events')
  async list(@Query() rawQuery: Record<string, unknown>): Promise<EventsListResponse> {
    const parsed = listEventsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid query parameters',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.eventsService.listEvents(parsed.data);
  }

  @Get('events/:eventId')
  async detail(@Param('eventId') eventId: string): Promise<EventDetailResponse> {
    return this.eventsService.getEventDetail(eventId);
  }

  @Post('events/:eventId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param('eventId') eventId: string): Promise<{ eventId: string; status: 'pending' }> {
    return this.eventsService.retryEvent(eventId);
  }

  @Get('stats')
  async stats(): Promise<StatsResponse> {
    return this.eventsService.getStats();
  }

  @Get('health')
  async health(): Promise<{ status: 'ok'; db: 'connected' }> {
    return this.eventsService.checkHealth();
  }
}
