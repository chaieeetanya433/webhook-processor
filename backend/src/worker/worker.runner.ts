import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../db/db.module';
import { computeBackoffDelayMs } from './backoff';
import { executeSimulation, parseSimulation } from './simulation';
import { ClaimedEvent, CompletionHooks, WorkerRepository } from './worker.repository';

@Injectable()
export class WorkerRunner implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private wakeResolver: (() => void) | null = null;
  private completionHooks?: CompletionHooks;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repository: WorkerRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerRunner.name);
  }

  setCompletionHooks(hooks: CompletionHooks | undefined): void {
    this.completionHooks = hooks;
  }

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.logger.info(
      {
        workerId: this.config.WORKER_ID,
        concurrency: this.config.WORKER_CONCURRENCY,
        pollIntervalMs: this.config.POLL_INTERVAL_MS,
        leaseMs: this.config.LEASE_MS,
      },
      'Starting webhook worker',
    );
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopping = true;
    this.wake();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    if (this.inFlight.size > 0) {
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), this.config.SHUTDOWN_TIMEOUT_MS),
      );
      await Promise.race([Promise.allSettled(Array.from(this.inFlight)), timeoutPromise]);
    }
    this.running = false;
  }

  private wake(): void {
    if (this.wakeResolver) {
      const resolve = this.wakeResolver;
      this.wakeResolver = null;
      resolve();
    }
  }

  private async sleepPollInterval(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(this.config.POLL_INTERVAL_MS * 0.3)));
    const delay = this.config.POLL_INTERVAL_MS + jitter;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeResolver === onWake) {
          this.wakeResolver = null;
        }
        resolve();
      }, delay);
      const onWake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakeResolver = onWake;
    });
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      let claimedAny = false;
      try {
        while (!this.stopping && this.inFlight.size < this.config.WORKER_CONCURRENCY) {
          const claimed = await this.repository.claimNextEvent(
            this.config.WORKER_ID,
            this.config.LEASE_MS,
          );
          if (!claimed) {
            break;
          }
          claimedAny = true;
          const task = this.processEvent(claimed).finally(() => {
            this.inFlight.delete(task);
            this.wake();
          });
          this.inFlight.add(task);
        }
      } catch (err) {
        this.logger.error(
          { workerId: this.config.WORKER_ID, err },
          'Error in worker poll tick',
        );
      }

      if (!claimedAny || this.inFlight.size >= this.config.WORKER_CONCURRENCY) {
        await this.sleepPollInterval();
      }
    }
  }

  private async processEvent(claimed: ClaimedEvent): Promise<void> {
    const data = claimed.payload.data as { orderId?: string; simulate?: string } | undefined;
    const orderId = typeof data?.orderId === 'string' ? data.orderId : 'unknown-order';
    const directive = parseSimulation(typeof data?.simulate === 'string' ? data.simulate : undefined);

    if (directive.kind === 'ok' && directive.warning) {
      this.logger.warn(
        {
          workerId: this.config.WORKER_ID,
          eventId: claimed.eventId,
          attempt: claimed.attemptCount,
          simulate: data?.simulate,
        },
        directive.warning,
      );
    }

    const abortController = new AbortController();
    const outcome = await executeSimulation(
      directive,
      claimed.attemptCount,
      abortController.signal,
    );

    if (outcome.succeeded) {
      const res = await this.repository.completeSuccess(
        {
          eventId: claimed.eventId,
          orderId,
          workerId: this.config.WORKER_ID,
          attemptNumber: claimed.attemptCount,
          warning: outcome.warning,
        },
        this.completionHooks,
      );
      if (res.fencedOut) {
        this.logger.warn(
          {
            workerId: this.config.WORKER_ID,
            eventId: claimed.eventId,
            attempt: claimed.attemptCount,
          },
          'Fenced out during success completion; stale attempt discarded',
        );
      } else {
        this.logger.info(
          {
            workerId: this.config.WORKER_ID,
            eventId: claimed.eventId,
            attempt: claimed.attemptCount,
            orderId,
          },
          'Processed webhook event successfully',
        );
      }
      return;
    }

    const errorMessage = outcome.error ?? 'Unknown processing failure';
    const backoffMs = computeBackoffDelayMs(
      claimed.attemptsInBudget,
      this.config.BACKOFF_BASE_MS,
      this.config.BACKOFF_MAX_MS,
    );

    const failureRes = await this.repository.completeFailure({
      eventId: claimed.eventId,
      workerId: this.config.WORKER_ID,
      attemptNumber: claimed.attemptCount,
      attemptsInBudget: claimed.attemptsInBudget,
      maxAttempts: this.config.MAX_ATTEMPTS,
      backoffMs,
      errorMessage,
    });

    if (failureRes.fencedOut) {
      this.logger.warn(
        {
          workerId: this.config.WORKER_ID,
          eventId: claimed.eventId,
          attempt: claimed.attemptCount,
        },
        'Fenced out during failure completion; stale attempt discarded',
      );
      return;
    }

    this.logger.warn(
      {
        workerId: this.config.WORKER_ID,
        eventId: claimed.eventId,
        attempt: claimed.attemptCount,
        attemptsInBudget: claimed.attemptsInBudget,
        newStatus: failureRes.newStatus,
        backoffMs: failureRes.newStatus === 'pending' ? backoffMs : undefined,
        error: errorMessage,
      },
      failureRes.newStatus === 'failed_permanent'
        ? 'Event exhausted retry budget and moved to failed_permanent'
        : 'Event failed; scheduled for retry with backoff',
    );
  }
}
