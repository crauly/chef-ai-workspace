// Phase B turn manager: pure, no I/O, no audio.
// Contract (Meta Realtime ENDPOINTING):
// - speechStart(turnId) opens a turn; overlapping turns may coexist.
// - transcript events with final:false are display-only partials for the
//   most recent open turn (partials carry no turnId); same turn overwrites.
// - speechEnd is a boundary only; it never commits a draft update.
// - speechComplete(turnId, text) is the only committed transcript for that
//   turn; duplicates are ignored; a lost turn is never fabricated.
// - Events may arrive out of order; completion wins over later partials.
export type TurnEvent =
  | {type: "speechStart"; turnId: string}
  | {type: "partial"; text: string}
  | {type: "speechEnd"; turnId: string}
  | {type: "speechComplete"; turnId: string; text: string};

export type TurnState = {partial: string; completed: string | null; ended: boolean};

export class VoiceTurnStore {
  private turns = new Map<string, TurnState>();
  private order: string[] = [];
  private lastOpen: string | null = null;
  private pending: Array<{turnId: string; text: string}> = [];

  handle(event: TurnEvent): Array<{turnId: string; text: string}> {
    const fresh: Array<{turnId: string; text: string}> = [];
    if (event.type === "speechStart") {
      if (!event.turnId) return fresh;
      if (!this.turns.has(event.turnId)) {
        this.turns.set(event.turnId, {partial: "", completed: null, ended: false});
        this.order.push(event.turnId);
      }
      this.lastOpen = event.turnId;
    } else if (event.type === "partial") {
      if (!this.lastOpen) return fresh;
      const state = this.turns.get(this.lastOpen);
      if (!state || state.completed !== null) return fresh;
      state.partial = event.text.slice(0, 1000);
    } else if (event.type === "speechEnd") {
      const state = this.turns.get(event.turnId);
      if (state) state.ended = true;
      if (this.lastOpen === event.turnId) {
        // Keep lastOpen for a late speechComplete; new speechStart replaces it.
      }
    } else if (event.type === "speechComplete") {
      const text = event.text.trim().slice(0, 1000);
      if (!event.turnId || !text) return fresh;
      let state = this.turns.get(event.turnId);
      if (!state) {
        state = {partial: "", completed: null, ended: true};
        this.turns.set(event.turnId, state);
        this.order.push(event.turnId);
      }
      if (state.completed !== null) return fresh; // duplicate delivery
      state.completed = text;
      const record = {turnId: event.turnId, text};
      this.pending.push(record);
      fresh.push(record);
    }
    return fresh;
  }

  drain(): Array<{turnId: string; text: string}> {
    const out = [...this.pending];
    this.pending = [];
    return out;
  }

  partial(turnId: string): string {
    return this.turns.get(turnId)?.partial ?? "";
  }

  openTurns(): string[] {
    return this.order.filter(id => this.turns.get(id)?.completed === null);
  }
}
