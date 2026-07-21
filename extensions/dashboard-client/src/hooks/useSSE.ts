/**
 * dashboard-client/src/hooks/useSSE.ts — Server-Sent Events hook.
 *
 * Connects to /api/events, provides real-time event stream.
 * SPRINT-B1: basic connection. SPRINT-D1: reconnect with backoff.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SseEvent } from '../../../dashboard-server/api-contracts';

export type SseStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseSSEResult {
  events: SseEvent[];
  status: SseStatus;
  eventCount: number;
  lastEventAt: number | null;
}

export interface UseSSEOptions {
  /** Max events to keep in memory (ring buffer). */
  maxEvents?: number;
  /** Max reconnect attempts before giving up. */
  maxReconnects?: number;
}

// SPRINT-D1-REMAINING: exponential backoff (1s → 2s → 4s → max 30s).
// SPRINT-D1-REMAINING: after 5 failures, set status='disconnected'.

export function useSSE(options: UseSSEOptions = {}): UseSSEResult {
  const { maxEvents = 500, maxReconnects = 5 } = options;
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [status, setStatus] = useState<SseStatus>('connecting');
  const [eventCount, setEventCount] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const reconnectCount = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
    }
    setStatus('connecting');
    const source = new EventSource('/api/events');
    sourceRef.current = source;

    source.onopen = () => {
      setStatus('connected');
      reconnectCount.current = 0;
    };

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as SseEvent;
        setEvents(prev => {
          const next = [...prev, parsed];
          return next.length > maxEvents ? next.slice(-maxEvents) : next;
        });
        setEventCount(c => c + 1);
        setLastEventAt(Date.now());
      } catch {
        // non-fatal: skip malformed events
      }
    };

    source.onerror = () => {
      source.close();
      if (reconnectCount.current < maxReconnects) {
        reconnectCount.current += 1;
        setStatus('connecting');
        // SPRINT-D1: use exponential backoff instead of fixed delay
        setTimeout(connect, 1000);
      } else {
        setStatus('disconnected');
      }
    };
  }, [maxEvents, maxReconnects]);

  useEffect(() => {
    connect();
    return () => {
      sourceRef.current?.close();
    };
  }, [connect]);

  return { events, status, eventCount, lastEventAt };
}
