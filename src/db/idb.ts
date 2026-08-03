/**
 * IndexedDB persistence for the op log.
 *
 * The op log is the source of truth; materialized state is rebuilt from it on
 * load. Ops are immutable and keyed by [actor, seq], so re-persisting an op
 * already stored is a no-op rather than a conflict.
 */

import type { Op, VersionVector } from './crdt.ts';

const DB_NAME = 'lightdb';
const DB_VERSION = 1;
const OPS_STORE = 'ops';
const META_STORE = 'meta';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class OpStore {
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(): Promise<OpStore> {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OPS_STORE)) {
        db.createObjectStore(OPS_STORE, { keyPath: ['actor', 'seq'] });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };

    return new OpStore(await promisify(request));
  }

  async loadOps(): Promise<Op[]> {
    const tx = this.db.transaction(OPS_STORE, 'readonly');
    const ops = await promisify(tx.objectStore(OPS_STORE).getAll() as IDBRequest<Op[]>);
    await transactionDone(tx);
    return ops;
  }

  async appendOps(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const tx = this.db.transaction(OPS_STORE, 'readwrite');
    const store = tx.objectStore(OPS_STORE);
    for (const op of ops) store.put(op);
    await transactionDone(tx);
  }

  private async getMeta<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    const value = await promisify(tx.objectStore(META_STORE).get(key) as IDBRequest<T>);
    await transactionDone(tx);
    return value;
  }

  private async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value, key);
    await transactionDone(tx);
  }

  /** This device's replica id, created and persisted on first run. */
  async actorId(generate: () => string): Promise<string> {
    const existing = await this.getMeta<string>('actorId');
    if (existing) return existing;

    const created = generate();
    await this.setMeta('actorId', created);
    return created;
  }

  /** The last version vector we saw from a peer, for delta sync. */
  async peerVector(peer: string): Promise<VersionVector | undefined> {
    return this.getMeta<VersionVector>(`peer:${peer}`);
  }

  async setPeerVector(peer: string, vv: VersionVector): Promise<void> {
    await this.setMeta(`peer:${peer}`, vv);
  }

  async knownPeers(): Promise<string[]> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    const keys = await promisify(tx.objectStore(META_STORE).getAllKeys());
    await transactionDone(tx);
    return keys
      .filter((k): k is string => typeof k === 'string' && k.startsWith('peer:'))
      .map((k) => k.slice('peer:'.length));
  }

  /** Wipe everything. Used by the reset control on the database page. */
  async clear(): Promise<void> {
    const tx = this.db.transaction([OPS_STORE, META_STORE], 'readwrite');
    tx.objectStore(OPS_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await transactionDone(tx);
  }
}
