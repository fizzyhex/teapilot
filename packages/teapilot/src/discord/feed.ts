/** Posting and editing through one Discord interaction's webhook, which works until `expires`. */
export interface FeedLink<P> {
  post(payload: P): Promise<string>;
  revise(id: string, payload: P): Promise<void>;
  expires: number;
}

/**
 * Messages sent through Discord interactions, whose webhooks stop working after 15 minutes. Just before then, a running
 * turn's status card is edited to say its updates have paused, with a button to resume them; the turn carries on. What it
 * sends meanwhile waits, and goes out in order through the interaction the button's press brings (`resume`).
 */
export class InteractionFeed<P> {
  private paused = false;
  private held = 0;
  /** Posts made while paused, by the placeholder id they were given. */
  private readonly posts = new Map<string, P>();
  /** The latest edit made while paused to each posted message. */
  private readonly edits = new Map<string, P>();
  /** Placeholder ids of posts that went out on resume, and the ids Discord gave them. */
  private readonly ids = new Map<string, string>();
  /** The status card; `paused` is how it looks while its updates wait, absent once its turn has ended. */
  private card?: { id: string; payload: P; paused?: P };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private link: FeedLink<P>, private readonly options: { log(text: string): void; onCard?(id: string): void }) {
    this.schedule();
  }

  get live(): boolean { return !this.paused; }

  async post(payload: P): Promise<string> {
    if (!this.paused) return await this.link.post(payload);
    const id = `held:${++this.held}`;
    if (!this.card?.paused && !this.posts.size) this.options.log('Discord stops interaction updates after 15 minutes, and this turn has no status card to resume them from: its later messages will not be shown.');
    this.posts.set(id, payload);
    return id;
  }

  async revise(id: string, payload: P): Promise<void> {
    id = this.ids.get(id) ?? id;
    if (this.posts.has(id)) this.posts.set(id, payload);
    else if (this.paused) this.edits.set(id, payload);
    else await this.link.revise(id, payload);
  }

  /** Posts the status card, or with `id` replaces it; `paused` is how it looks while updates wait, if its turn is running. */
  async showCard(payload: P, paused: P | undefined, id?: string): Promise<string> {
    if (id) await this.revise(id, payload); else id = await this.post(payload);
    this.card = { id: this.ids.get(id) ?? id, payload, paused };
    if (!this.card.id.startsWith('held:')) this.options.onCard?.(this.card.id);
    return id;
  }

  /** Carries on through `link`, sending everything that waited; the card loses its pause note. */
  async resume(link: FeedLink<P>): Promise<void> {
    this.link = link;
    this.paused = false;
    clearTimeout(this.timer);
    const posts = [...this.posts];
    const edits = new Map(this.edits);
    this.posts.clear(); this.edits.clear();
    if (this.card && !this.card.id.startsWith('held:')) edits.set(this.card.id, this.card.payload);
    for (const [held, payload] of posts) {
      const id = await link.post(payload);
      this.ids.set(held, id);
      if (this.card?.id === held) { this.card.id = id; this.options.onCard?.(id); }
    }
    for (const [id, payload] of edits) await link.revise(id, payload).catch(error => this.options.log(`could not update a message on resume: ${error instanceof Error ? error.message : String(error)}`));
    this.schedule();
  }

  /** Reposts the latest card and redirects the turn's original id to its new copy. */
  async resend(link: FeedLink<P>, retire: P): Promise<void> {
    if (!this.card) throw new Error('this card is no longer available.');
    await this.resume(link);
    const old = this.card.id;
    const id = await link.post(this.card.payload);
    for (const [alias, current] of this.ids) if (current === old) this.ids.set(alias, id);
    this.ids.set(old, id);
    this.card.id = id;
    this.options.onCard?.(id);
    await link.revise(old, retire).catch(error => this.options.log(`could not retire the old card: ${error instanceof Error ? error.message : String(error)}`));
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.pause(), Math.max(0, this.link.expires - Date.now()));
    this.timer.unref?.();
  }

  private async pause(): Promise<void> {
    const card = this.card;
    if (card?.paused && !card.id.startsWith('held:')) {
      await this.link.revise(card.id, card.paused).then(() => this.options.log('Discord stops interaction updates after 15 minutes: paused the status card until someone presses Resume.'),
        error => this.options.log(`could not pause the status card: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.paused = true;
  }
}
