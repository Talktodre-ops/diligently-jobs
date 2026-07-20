// Offline event queue. Every backend write that fails (network down,
// backend not running, 5xx) gets buffered here. We drain on the next
// successful health check or successful write.
//
// Scope: we only queue *event appends*. Other writes (creating applications,
// updating interviews) are user-facing actions that should fail visibly so
// the user knows. Events are pure audit log — losing one to silent drop is
// worse than briefly dropping the UI feedback.

import { safeLocalStorage } from "../storage";
import type { AppendEventRequest } from "./types";

const QUEUE_KEY = "diligently_backend_event_queue";
const MAX_QUEUE_SIZE = 1000; // bound to avoid runaway localStorage growth

interface QueuedEvent {
  event: AppendEventRequest;
  /** When the event would-have-been-appended, ISO timestamp. Server uses
   *  its own `now()` for `created_at`, so this is a hint for ordering only. */
  queued_at: string;
}

function readQueue(): QueuedEvent[] {
  const raw = safeLocalStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedEvent[]): void {
  // Trim from the front (oldest first) if we hit the cap. Events are
  // append-only so dropping ancient queued events when we're already 1000
  // deep is the lesser evil vs running out of localStorage.
  const trimmed = q.length > MAX_QUEUE_SIZE ? q.slice(-MAX_QUEUE_SIZE) : q;
  safeLocalStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
}

export function enqueueEvent(event: AppendEventRequest): void {
  const q = readQueue();
  q.push({ event, queued_at: new Date().toISOString() });
  writeQueue(q);
}

export function queueSize(): number {
  return readQueue().length;
}

export function peekQueue(): QueuedEvent[] {
  return readQueue();
}

/**
 * Drain the queue, applying `sender` to each. Stops at the first failure
 * so a transient outage doesn't lose more events. Returns the count drained.
 */
export async function drainQueue(
  sender: (event: AppendEventRequest) => Promise<void>
): Promise<{ drained: number; remaining: number }> {
  let q = readQueue();
  let drained = 0;
  while (q.length > 0) {
    const next = q[0];
    try {
      await sender(next.event);
    } catch {
      break;
    }
    q = q.slice(1);
    writeQueue(q);
    drained++;
  }
  return { drained, remaining: q.length };
}

export function clearQueue(): void {
  safeLocalStorage.removeItem(QUEUE_KEY);
}
