'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';

type EventStatus = 'pending' | 'processing' | 'succeeded' | 'failed_permanent';
type AttemptResult = 'success' | 'failure' | 'abandoned';

interface EventSummary {
  eventId: string;
  type: string;
  status: EventStatus;
  attemptCount: number;
  attemptsInBudget: number;
  lastError: string | null;
  lockedBy: string | null;
  nextRunAt: string;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  duplicateCount: number;
  conflictingPayloadCount: number;
}

interface EventAttemptItem {
  id: number;
  eventId: string;
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  result: AttemptResult | null;
  error: string | null;
}

interface EventDetailResponse {
  event: EventSummary & { payload: Record<string, unknown> };
  attempts: EventAttemptItem[];
  processedOrder: {
    orderId: string;
    eventId: string;
    processedAt: string;
  } | null;
}

interface StatsResponse {
  countsByStatus: Record<EventStatus, number>;
  totalEvents: number;
  processedOrdersCount: number;
}

interface EventsListResponse {
  items: EventSummary[];
  total: number;
  limit: number;
  offset: number;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function OpsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [eventsData, setEventsData] = useState<EventsListResponse>({
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<EventDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const fetchDetail = useCallback(async (eventId: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`${API_BASE_URL}/events/${encodeURIComponent(eventId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch event details (${res.status})`);
      }
      const data = (await res.json()) as EventDetailResponse;
      setExpandedDetail(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load event detail');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (statusFilter) {
        params.set('status', statusFilter);
      }

      const [statsRes, eventsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/stats`, { cache: 'no-store' }),
        fetch(`${API_BASE_URL}/events?${params.toString()}`, { cache: 'no-store' }),
      ]);

      if (!statsRes.ok || !eventsRes.ok) {
        throw new Error(`API returned ${statsRes.status}/${eventsRes.status}`);
      }

      const [statsJson, eventsJson] = await Promise.all([
        statsRes.json() as Promise<StatsResponse>,
        eventsRes.json() as Promise<EventsListResponse>,
      ]);

      setStats(statsJson);
      setEventsData(eventsJson);
      setErrorMsg(null);
      setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));

      if (expandedEventId) {
        void fetchDetail(expandedEventId);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to reach webhook API');
    }
  }, [page, statusFilter, expandedEventId, fetchDetail]);

  useEffect(() => {
    void fetchDashboard();
    const timer = setInterval(() => {
      void fetchDashboard();
    }, 2000);
    return () => clearInterval(timer);
  }, [fetchDashboard]);

  const handleToggleExpand = (eventId: string) => {
    if (expandedEventId === eventId) {
      setExpandedEventId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedEventId(eventId);
    setExpandedDetail(null);
    void fetchDetail(eventId);
  };

  const handleRetry = async (eventId: string) => {
    setRetryingId(eventId);
    try {
      const res = await fetch(`${API_BASE_URL}/events/${encodeURIComponent(eventId)}/retry`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Retry failed (${res.status})`);
      }
      await fetchDashboard();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Manual retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(eventsData.total / PAGE_SIZE));

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1>Reliable Webhook Processor</h1>
          <div className="muted">
            API: <span className="mono">{API_BASE_URL}</span> · Polling every 2s
            {lastUpdated ? ` · Last refresh: ${lastUpdated}` : ''}
          </div>
        </div>
        <button type="button" onClick={() => void fetchDashboard()}>
          Refresh Now
        </button>
      </header>

      {errorMsg && <div className="error-banner">Error: {errorMsg}</div>}

      <section className="stats-grid" aria-label="Queue statistics">
        <div className="stat-card">
          <div className="stat-label">Pending</div>
          <div className="stat-value">{stats?.countsByStatus.pending ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Processing</div>
          <div className="stat-value">{stats?.countsByStatus.processing ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Succeeded</div>
          <div className="stat-value">{stats?.countsByStatus.succeeded ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Failed Permanent</div>
          <div className="stat-value">{stats?.countsByStatus.failed_permanent ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Processed Orders</div>
          <div className="stat-value">{stats?.processedOrdersCount ?? '—'}</div>
        </div>
      </section>

      <section className="controls">
        <div className="controls-group">
          <label htmlFor="status-filter">Status:</label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All ({stats?.totalEvents ?? 0})</option>
            <option value="pending">pending</option>
            <option value="processing">processing</option>
            <option value="succeeded">succeeded</option>
            <option value="failed_permanent">failed_permanent</option>
          </select>
        </div>

        <div className="controls-group">
          <span className="muted">
            Showing {eventsData.items.length} of {eventsData.total} (Page {page + 1} / {totalPages})
          </span>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </section>

      <section className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Event ID</th>
              <th>Type</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Locked By</th>
              <th>Next Run</th>
              <th>Received</th>
              <th>Duplicates</th>
              <th>Last Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {eventsData.items.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  No webhook events found.
                </td>
              </tr>
            ) : (
              eventsData.items.map((ev) => {
                const isExpanded = expandedEventId === ev.eventId;
                return (
                  <Fragment key={ev.eventId}>
                    <tr>
                      <td>
                        <button type="button" onClick={() => handleToggleExpand(ev.eventId)}>
                          {isExpanded ? 'Hide' : 'Details'}
                        </button>
                      </td>
                      <td className="mono">{ev.eventId}</td>
                      <td className="mono">{ev.type}</td>
                      <td>
                        <span className={`badge badge-${ev.status}`}>{ev.status}</span>
                      </td>
                      <td className="mono">
                        {ev.attemptCount} (budget {ev.attemptsInBudget})
                      </td>
                      <td className="mono">{ev.lockedBy ?? '—'}</td>
                      <td className="mono">{formatDate(ev.nextRunAt)}</td>
                      <td className="mono">{formatDate(ev.receivedAt)}</td>
                      <td className="mono">
                        {ev.duplicateCount}
                        {ev.conflictingPayloadCount > 0
                          ? ` (${ev.conflictingPayloadCount} conflict)`
                          : ''}
                      </td>
                      <td className="truncate" title={ev.lastError ?? undefined}>
                        {ev.lastError ?? '—'}
                      </td>
                      <td>
                        {ev.status === 'failed_permanent' ? (
                          <button
                            type="button"
                            className="retry-btn"
                            disabled={retryingId === ev.eventId}
                            onClick={() => void handleRetry(ev.eventId)}
                          >
                            {retryingId === ev.eventId ? 'Retrying...' : 'Retry'}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="detail-row">
                        <td colSpan={11}>
                          {loadingDetail && !expandedDetail ? (
                            <span className="muted">Loading attempt history...</span>
                          ) : expandedDetail && expandedDetail.event.eventId === ev.eventId ? (
                            <div>
                              <div className="muted" style={{ marginBottom: 8 }}>
                                Processed Order:{' '}
                                {expandedDetail.processedOrder ? (
                                  <span className="mono">
                                    {expandedDetail.processedOrder.orderId} at{' '}
                                    {expandedDetail.processedOrder.processedAt}
                                  </span>
                                ) : (
                                  'None'
                                )}
                              </div>
                              <table>
                                <thead>
                                  <tr>
                                    <th>Attempt #</th>
                                    <th>Worker</th>
                                    <th>Started</th>
                                    <th>Finished</th>
                                    <th>Result</th>
                                    <th>Error / Note</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {expandedDetail.attempts.length === 0 ? (
                                    <tr>
                                      <td colSpan={6} className="muted">
                                        No attempts recorded yet.
                                      </td>
                                    </tr>
                                  ) : (
                                    expandedDetail.attempts.map((attempt) => (
                                      <tr key={attempt.id}>
                                        <td className="mono">{attempt.attemptNumber}</td>
                                        <td className="mono">{attempt.workerId}</td>
                                        <td className="mono">{formatDate(attempt.startedAt)}</td>
                                        <td className="mono">{formatDate(attempt.finishedAt)}</td>
                                        <td>
                                          {attempt.result ? (
                                            <span className={`badge badge-${attempt.result}`}>
                                              {attempt.result}
                                            </span>
                                          ) : (
                                            <span className="badge badge-processing">
                                              in_flight
                                            </span>
                                          )}
                                        </td>
                                        <td>{attempt.error ?? '—'}</td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <span className="muted">No detail loaded.</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
