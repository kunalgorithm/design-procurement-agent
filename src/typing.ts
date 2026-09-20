/** Best-effort presence; failures must never prevent a reply. */
export class TypingSession {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private lastRefresh = 0;
  constructor(private readonly signal: (active: boolean) => Promise<void>,
    private readonly isActive: () => Promise<boolean>, private readonly onError: (error: unknown) => void,
    private readonly refreshMs = 60_000, private readonly pollMs = 1000) {}

  private enqueue(action: () => Promise<void>) {
    this.queue = this.queue.then(action).catch(this.onError);
    return this.queue;
  }
  private async update(active: boolean) {
    try { await this.signal(active); } catch (error) { this.onError(error); }
  }
  private async check(force: boolean) {
    if (this.stopped) return;
    if (!await this.isActive()) {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      await this.update(false);
      return;
    }
    if (this.stopped) return;
    if (force || Date.now() - this.lastRefresh >= this.refreshMs) {
      await this.update(true);
      this.lastRefresh = Date.now();
    }
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.check(false)).then(() => this.schedule());
    }, this.pollMs).unref();
  }
  async start() {
    await this.refresh();
    this.schedule();
  }
  // Sending a message clears iMessage typing; restart it before the next text/render.
  refresh() { return this.enqueue(() => this.check(true)); }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.queue;
    await this.update(false);
  }
}
