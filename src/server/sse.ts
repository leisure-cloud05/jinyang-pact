/**
 * Server-sent events per session (PLAN §11): engine progress as player-safe messages (phase changes, pauses,
 * decisions, the player's-scene narration, interrupts, terminal, run outcome, control-state changes). Each message
 * has a per-session id; a ring buffer lets a reconnecting client resume with `Last-Event-ID` / `?since=`.
 * Payloads are built by the controller from player-visible data only and pass the leak guard at send time.
 */
export interface SseMessage {
  id: number;
  type: string;
  data: unknown;
}

type Listener = (message: SseMessage) => void;

const BUFFER = 500;

export class SseHub {
  private readonly buffers = new Map<string, SseMessage[]>();
  private readonly seqs = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(sessionId: string, type: string, data: unknown): SseMessage {
    const id = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, id);
    const message: SseMessage = { id, type, data };
    const buffer = this.buffers.get(sessionId) ?? [];
    buffer.push(message);
    if (buffer.length > BUFFER) buffer.splice(0, buffer.length - BUFFER);
    this.buffers.set(sessionId, buffer);
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(message);
      } catch {
        /* a broken connection must not stop the engine */
      }
    }
    return message;
  }

  /** Subscribes; buffered messages with an id greater than `since` are delivered first. */
  subscribe(sessionId: string, listener: Listener, since: number | null = null): () => void {
    if (since !== null) {
      for (const m of this.buffers.get(sessionId) ?? []) if (m.id > since) listener(m);
    }
    const set = this.listeners.get(sessionId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
    };
  }

  lastId(sessionId: string): number {
    return this.seqs.get(sessionId) ?? 0;
  }

  recent(sessionId: string): SseMessage[] {
    return [...(this.buffers.get(sessionId) ?? [])];
  }
}
