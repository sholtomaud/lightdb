import { Store } from '../core/store.ts';
import { LwwMap, newActorId, type Op, type VersionVector } from '../db/crdt.ts';
import { OpStore } from '../db/idb.ts';

export interface AppState {
  ready: boolean;
  actor: string;
  records: [string, string][];
  opCount: number;
  status: string;
}

export const appStore = new Store<AppState>({
  ready: false,
  actor: '',
  records: [],
  opCount: 0,
  status: 'Opening local database…',
});

let db: LwwMap | null = null;
let persistence: OpStore | null = null;
let opening: Promise<void> | null = null;

function publish(status?: string): void {
  if (!db) return;
  appStore.setState({
    ready: true,
    actor: db.actor,
    records: db.entries(),
    opCount: db.allOps().length,
    ...(status !== undefined ? { status } : {}),
  });
}

/** Idempotent: concurrent callers share one open. */
export function initDb(): Promise<void> {
  if (opening) return opening;

  opening = (async () => {
    persistence = await OpStore.open();
    const actor = await persistence.actorId(newActorId);

    db = new LwwMap(actor);
    db.merge(await persistence.loadOps());

    publish('Ready');
  })().catch((error: Error) => {
    appStore.setState({ status: `Database unavailable: ${error.message}` });
    throw error;
  });

  return opening;
}

export function getDb(): LwwMap {
  if (!db) throw new Error('Database not initialised; await initDb() first');
  return db;
}

export function getPersistence(): OpStore {
  if (!persistence) throw new Error('Database not initialised; await initDb() first');
  return persistence;
}

async function commit(ops: Op[], status: string): Promise<void> {
  await getPersistence().appendOps(ops);
  publish(status);
}

export async function setRecord(key: string, value: string): Promise<void> {
  const op = getDb().set(key, value);
  await commit([op], `Wrote "${key}"`);
}

export async function deleteRecord(key: string): Promise<void> {
  const op = getDb().delete(key);
  await commit([op], `Deleted "${key}"`);
}

/** Merge ops received over the optical link and persist them. */
export async function mergeRemoteOps(ops: Op[], peer: string, peerVv: VersionVector): Promise<number> {
  const applied = getDb().merge(ops);
  await getPersistence().appendOps(ops);
  await getPersistence().setPeerVector(peer, peerVv);
  publish(applied > 0 ? `Merged ${applied} new op${applied === 1 ? '' : 's'}` : 'Already up to date');
  return applied;
}

export async function resetAll(): Promise<void> {
  await getPersistence().clear();
  db = new LwwMap(await getPersistence().actorId(newActorId));
  publish('Local database cleared');
}

export function setStatus(status: string): void {
  appStore.setState({ status });
}
