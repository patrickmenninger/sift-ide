export type EventHandler = (payload: unknown) => Promise<void> | void;

/** In-process publish/subscribe. */
export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload);
    }
  }
}
