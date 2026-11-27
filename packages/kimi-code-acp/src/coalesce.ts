/**
 * Text coalescing (ADR 0001, Decision 4).
 *
 * The client re-renders a message block per chunk, so the adapter batches
 * deltas instead of forwarding one update per model token. The thresholds are
 * deliberately dumb: a size floor plus a maximum age, no sentence detection —
 * punctuation heuristics produced a notification every few tokens for
 * code-heavy reasoning.
 */
const MIN_CHARS = 32;
const MAX_AGE_MS = 100;

export class TextCoalescer {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly flush: (text: string) => void) {}

  push(delta: string): void {
    if (delta.length === 0) return;
    this.buffer += delta;
    if (this.buffer.length >= MIN_CHARS) {
      this.flushNow();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, MAX_AGE_MS);
    this.timer.unref?.();
  }

  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const text = this.buffer;
    if (text.length === 0) return;
    this.buffer = '';
    this.flush(text);
  }

  /** Drop anything buffered without sending it — for a cancelled turn. */
  reset(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.buffer = '';
  }
}
