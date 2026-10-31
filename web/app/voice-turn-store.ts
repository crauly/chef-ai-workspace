// Phase B turn manager: pure, no I/O, no audio.
// Contract (Meta Realtime ENDPOINTING):
// - speechStart(turnId) opens a turn; overlapping turns may coexist.
// - transcript events with final:false are display-only partials for the
//   most recent open turn (partials carry no turnId); same turn overwrites.
// - speechEnd is a boundary only; it never commits a draft update.
// - speechComplete(turnId, text) is the only committed transcript for that
//   turn; duplicates are ignored; a lost turn is never fabricated.
// - Events may arrive out of order; completion wins over later partials.
// - Approval epoch is captured at speechStart, never at completion. A turn
//   whose start was never seen commits with startEpoch null so the caller
//   cannot mistake it for a post-review approval. First start wins:
//   duplicate or reordered starts never overwrite the original epoch.
export type TurnEvent =
  | {type: "speechStart"; turnId: string}
  | {type: "partial"; text: string}
  | {type: "speechEnd"; turnId: string}
  | {type: "speechComplete"; turnId: string; text: string};

export type CommittedTurn = {turnId: string; text: string; startEpoch: number | null};

export type TurnState = {partial: string; completed: string | null; ended: boolean; startEpoch: number | null};

export class VoiceTurnStore {
  private turns = new Map<string, TurnState>();
  private order: string[] = [];
  private lastOpen: string | null = null;
  private pending: Array<CommittedTurn> = [];

  handle(event: TurnEvent, startEpoch?: number): Array<CommittedTurn> {
    const fresh: Array<CommittedTurn> = [];
    if (event.type === "speechStart") {
      if (!event.turnId) return fresh;
      if (!this.turns.has(event.turnId)) {
        this.turns.set(event.turnId, {partial: "", completed: null, ended: false,
          startEpoch: typeof startEpoch === "number" ? startEpoch : null});
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
        // Start never seen (lost or reordered): never guess an epoch.
        state = {partial: "", completed: null, ended: true, startEpoch: null};
        this.turns.set(event.turnId, state);
        this.order.push(event.turnId);
      }
      if (state.completed !== null) return fresh; // duplicate delivery
      state.completed = text;
      const record: CommittedTurn = {turnId: event.turnId, text, startEpoch: state.startEpoch};
      this.pending.push(record);
      fresh.push(record);
    }
    return fresh;
  }

  drain(): Array<CommittedTurn> {
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
