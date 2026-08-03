/**
 * Last-writer-wins map CRDT with per-actor operation logs and version vectors.
 *
 * Chosen over a diff-based store because the optical channel cannot support a
 * conversation. Merges here are commutative, associative and idempotent, so:
 *
 *   - frames may arrive in any order,
 *   - the same stream may be scanned twice with no ill effect,
 *   - neither side ever needs to ask "what did you mean by that?".
 *
 * A version vector is a handful of bytes, which is what makes the first pass of
 * the sync protocol fit in a single static QR code.
 */

export interface Op {
  /** Originating replica. */
  actor: string;
  /** Per-actor sequence, starting at 1. */
  seq: number;
  key: string;
  /** null is a tombstone. */
  value: string | null;
  /** Wall clock at write time, for the last-writer-wins comparison. */
  ts: number;
}

export type VersionVector = Record<string, number>;

interface Materialized {
  value: string | null;
  ts: number;
  actor: string;
  seq: number;
}

/**
 * Later timestamp wins, then higher actor id, then higher sequence.
 *
 * The sequence tiebreak is not decoration. `Date.now()` has millisecond
 * resolution, so a write and the delete that follows it routinely share a
 * timestamp -- and being from the same replica, they also share an actor id.
 * Without seq the later op loses to the earlier one and the delete never takes.
 * (actor, seq) is globally unique, so this stays a total order.
 */
function opWins(candidate: Op, incumbent: Materialized): boolean {
  if (candidate.ts !== incumbent.ts) return candidate.ts > incumbent.ts;
  if (candidate.actor !== incumbent.actor) return candidate.actor > incumbent.actor;
  return candidate.seq > incumbent.seq;
}

export function newActorId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class LwwMap {
  readonly actor: string;

  /** Sparse per-actor logs, indexed by seq - 1. Gaps are possible. */
  private log = new Map<string, (Op | undefined)[]>();
  private state = new Map<string, Materialized>();
  private localSeq = 0;

  constructor(actor: string) {
    this.actor = actor;
  }

  // ------------------------------------------------------------ local writes

  set(key: string, value: string): Op {
    return this.appendLocal(key, value);
  }

  delete(key: string): Op {
    return this.appendLocal(key, null);
  }

  private appendLocal(key: string, value: string | null): Op {
    this.localSeq += 1;
    const op: Op = {
      actor: this.actor,
      seq: this.localSeq,
      key,
      value,
      ts: Date.now(),
    };
    this.record(op);
    return op;
  }

  // ------------------------------------------------------------------ reads

  get(key: string): string | undefined {
    const entry = this.state.get(key);
    return entry && entry.value !== null ? entry.value : undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Live keys and values, tombstones excluded. */
  entries(): [string, string][] {
    const out: [string, string][] = [];
    for (const [key, entry] of this.state) {
      if (entry.value !== null) out.push([key, entry.value]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  get size(): number {
    let count = 0;
    for (const entry of this.state.values()) if (entry.value !== null) count += 1;
    return count;
  }

  // -------------------------------------------------------------- versioning

  /**
   * Highest contiguous sequence held per actor.
   *
   * Deliberately conservative: if we hold ops 1,2,4 from a peer we report 2, so
   * the peer resends 3 on the next pass rather than us silently losing it.
   */
  versionVector(): VersionVector {
    const vv: VersionVector = {};
    for (const [actor, ops] of this.log) {
      let contiguous = 0;
      while (contiguous < ops.length && ops[contiguous] !== undefined) {
        contiguous += 1;
      }
      if (contiguous > 0) vv[actor] = contiguous;
    }
    return vv;
  }

  /** Every op this replica holds that `vv` does not account for. */
  changesSince(vv: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [actor, ops] of this.log) {
      const known = vv[actor] ?? 0;
      for (let i = known; i < ops.length; i += 1) {
        const op = ops[i];
        if (op !== undefined) out.push(op);
      }
    }
    return out.sort((a, b) =>
      a.actor === b.actor ? a.seq - b.seq : a.actor < b.actor ? -1 : 1
    );
  }

  // ------------------------------------------------------------------ merge

  /** Apply remote ops. Returns how many were new. Safe to call repeatedly. */
  merge(ops: Iterable<Op>): number {
    let applied = 0;
    for (const op of ops) {
      if (this.record(op)) applied += 1;
    }
    return applied;
  }

  /** All ops held, for persistence. */
  allOps(): Op[] {
    const out: Op[] = [];
    for (const ops of this.log.values()) {
      for (const op of ops) if (op !== undefined) out.push(op);
    }
    return out;
  }

  /** Insert into the log and fold into materialized state. */
  private record(op: Op): boolean {
    if (!Number.isInteger(op.seq) || op.seq < 1) return false;

    let ops = this.log.get(op.actor);
    if (!ops) {
      ops = [];
      this.log.set(op.actor, ops);
    }

    const index = op.seq - 1;
    if (ops[index] !== undefined) return false; // already held

    while (ops.length < index) ops.push(undefined);
    ops[index] = op;

    if (op.actor === this.actor && op.seq > this.localSeq) {
      this.localSeq = op.seq;
    }

    // LWW is order-independent, so fold in even ops ahead of a gap.
    const incumbent = this.state.get(op.key);
    if (!incumbent || opWins(op, incumbent)) {
      this.state.set(op.key, {
        value: op.value,
        ts: op.ts,
        actor: op.actor,
        seq: op.seq,
      });
    }
    return true;
  }
}
