// Views are mounted one at a time: overlapping mounts would orphan a frame. When several draws pile
// up (a background refresh and a new answer, say), only the newest one still waiting runs; the
// ones it replaces are skipped, so a stale view can never land on top of a newer one.
export class LatestQueue {
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;

  /** Runs task after the current one, unless a newer task is queued before its turn. Resolves either way. */
  run(task: () => Promise<void>): Promise<void> {
    const mine = ++this.seq;
    const next = this.tail.then(() => (mine === this.seq ? task() : undefined));
    this.tail = next.catch(() => undefined);
    return next;
  }
}
