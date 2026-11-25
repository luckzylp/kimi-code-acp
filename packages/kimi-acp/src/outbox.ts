/**
 * One ordered outbox per session (ADR 0001, Decision 5).
 *
 * Every `session/update` goes through a single FIFO chain, so the client never
 * sees a later update before an earlier one. There is deliberately **no**
 * per-message timeout: a write that never settles is a broken transport, and
 * dropping updates to keep the chain moving is how the patched adapter ended up
 * telling the client a different story than the engine did.
 */
export type UpdateSender = (notification: unknown) => Promise<void> | void;

export class Outbox {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly send: UpdateSender) {}

  /** Queue one notification; resolves when it has been written (or failed and been logged). */
  push(notification: unknown): Promise<void> {
    const next = this.chain.then(() => {
      try {
        return Promise.resolve(this.send(notification)).catch((error: unknown) => {
          this.onFailure(notification, error);
        });
      } catch (error) {
        this.onFailure(notification, error);
        return undefined;
      }
    });
    this.chain = next;
    return next;
  }

  /** Await every queued write — used before a prompt response and on shutdown. */
  async drain(): Promise<void> {
    await this.chain;
  }

  private onFailure(notification: unknown, error: unknown): void {
    // A failed write loses this update only; the chain keeps its order.
    const kind = (notification as { update?: { sessionUpdate?: string } } | null)?.update?.sessionUpdate;
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: 'session/update write failed',
        sessionUpdate: kind,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}
