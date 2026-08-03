import test from 'node:test';
import assert from 'node:assert/strict';

import { LwwMap, newActorId, type Op } from '../src/db/crdt.ts';
import {
  applySyncMessage,
  buildSyncMessage,
  decodeSyncMessage,
  encodeSyncMessage,
  isConverged,
} from '../src/db/sync.ts';

/** Op with an explicit timestamp, so tests do not race the clock. */
function op(actor: string, seq: number, key: string, value: string | null, ts: number): Op {
  return { actor, seq, key, value, ts };
}

test('actor ids are unique', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i += 1) ids.add(newActorId());
  assert.equal(ids.size, 500);
});

test('local writes read back', () => {
  const db = new LwwMap('alice');
  db.set('colour', 'green');
  db.set('shape', 'square');

  assert.equal(db.get('colour'), 'green');
  assert.equal(db.get('shape'), 'square');
  assert.equal(db.size, 2);
  assert.deepEqual(db.entries(), [
    ['colour', 'green'],
    ['shape', 'square'],
  ]);
});

test('deletes tombstone rather than forget', () => {
  const db = new LwwMap('alice');
  db.set('colour', 'green');
  db.delete('colour');

  assert.equal(db.get('colour'), undefined);
  assert.equal(db.has('colour'), false);
  assert.equal(db.size, 0);
  // The tombstone must still be in the log, or the delete cannot propagate.
  assert.equal(db.allOps().length, 2);
});

test('version vectors count contiguous ops only', () => {
  const db = new LwwMap('local');
  assert.deepEqual(db.versionVector(), {});

  db.set('a', '1');
  db.set('b', '2');
  assert.deepEqual(db.versionVector(), { local: 2 });

  // A gap: op 3 is missing, so the peer must be told we only hold 2.
  db.merge([op('remote', 1, 'x', '1', 100), op('remote', 3, 'z', '3', 300)]);
  assert.deepEqual(db.versionVector(), { local: 2, remote: 1 });

  // Filling the gap advances the vector past it.
  db.merge([op('remote', 2, 'y', '2', 200)]);
  assert.deepEqual(db.versionVector(), { local: 2, remote: 3 });
});

test('an op held ahead of a gap still affects reads', () => {
  const db = new LwwMap('local');
  db.merge([op('remote', 3, 'z', 'visible', 300)]);

  // Conservative for sync, but LWW is order-independent so the value is usable.
  assert.equal(db.get('z'), 'visible');
  assert.deepEqual(db.versionVector(), {});
});

test('merge is idempotent', () => {
  const db = new LwwMap('local');
  const ops = [op('remote', 1, 'a', '1', 100), op('remote', 2, 'b', '2', 200)];

  assert.equal(db.merge(ops), 2);
  assert.equal(db.merge(ops), 0, 'reapplying should be a no-op');
  assert.equal(db.merge(ops), 0);
  assert.equal(db.allOps().length, 2);
});

test('same-millisecond writes from one replica resolve by sequence', () => {
  // Date.now() is millisecond-resolution, so a set/delete pair issued back to
  // back routinely shares both a timestamp and an actor. Sequence must decide.
  const db = new LwwMap('alice');
  db.merge([
    op('alice', 1, 'k', 'first', 1000),
    op('alice', 2, 'k', 'second', 1000),
    op('alice', 3, 'k', null, 1000),
  ]);
  assert.equal(db.get('k'), undefined, 'the delete should have won');

  // And in the other arrival order.
  const reversed = new LwwMap('alice');
  reversed.merge([
    op('alice', 3, 'k', null, 1000),
    op('alice', 2, 'k', 'second', 1000),
    op('alice', 1, 'k', 'first', 1000),
  ]);
  assert.equal(reversed.get('k'), undefined);

  // A later resurrection at the same timestamp must also stick.
  const revived = new LwwMap('alice');
  revived.merge([op('alice', 1, 'k', null, 1000), op('alice', 2, 'k', 'back', 1000)]);
  assert.equal(revived.get('k'), 'back');
});

test('rapid local set/delete cycles land in issue order', () => {
  const db = new LwwMap('alice');
  db.set('k', 'one');
  db.set('k', 'two');
  db.delete('k');
  assert.equal(db.get('k'), undefined);

  db.set('k', 'three');
  assert.equal(db.get('k'), 'three');
});

test('last writer wins by timestamp', () => {
  const db = new LwwMap('local');
  db.merge([
    op('alice', 1, 'k', 'early', 100),
    op('bob', 1, 'k', 'late', 200),
  ]);
  assert.equal(db.get('k'), 'late');

  // Order of arrival must not matter.
  const reversed = new LwwMap('local');
  reversed.merge([
    op('bob', 1, 'k', 'late', 200),
    op('alice', 1, 'k', 'early', 100),
  ]);
  assert.equal(reversed.get('k'), 'late');
});

test('simultaneous writes are broken by actor id, not arrival order', () => {
  const forward = new LwwMap('local');
  forward.merge([op('alice', 1, 'k', 'A', 500), op('bob', 1, 'k', 'B', 500)]);

  const backward = new LwwMap('local');
  backward.merge([op('bob', 1, 'k', 'B', 500), op('alice', 1, 'k', 'A', 500)]);

  assert.equal(forward.get('k'), 'B', 'higher actor id wins the tie');
  assert.equal(forward.get('k'), backward.get('k'), 'replicas disagreed');
});

test('changesSince returns exactly the delta', () => {
  const db = new LwwMap('local');
  db.set('a', '1');
  db.set('b', '2');
  db.set('c', '3');

  assert.equal(db.changesSince({}).length, 3);
  assert.equal(db.changesSince({ local: 1 }).length, 2);
  assert.equal(db.changesSince({ local: 3 }).length, 0);
  assert.equal(db.changesSince({ local: 99 }).length, 0, 'a peer ahead of us needs nothing');
});

// ------------------------------------------------------------- the protocol

test('two passes converge two divergent replicas', () => {
  const alice = new LwwMap('alice');
  const bob = new LwwMap('bob');

  alice.set('from-alice', '1');
  alice.set('shared', 'alice-version');
  bob.set('from-bob', '2');

  // Pass 1: alice -> bob. No history, so the full log goes.
  const pass1 = buildSyncMessage(alice, null);
  const bobResult = applySyncMessage(bob, pass1);
  assert.equal(bobResult.applied, 2);

  // Pass 2: bob replies with exactly what alice lacks.
  const aliceResult = applySyncMessage(alice, bobResult.reply);
  assert.equal(aliceResult.applied, 1, 'alice should only need bob\'s single op');

  assert.deepEqual(alice.entries(), bob.entries(), 'replicas did not converge');
  assert.equal(alice.get('from-bob'), '2');
  assert.equal(bob.get('from-alice'), '1');
  assert.equal(alice.get('shared'), 'alice-version');
});

test('a second sync sends only the new delta', () => {
  const alice = new LwwMap('alice');
  const bob = new LwwMap('bob');

  const first = buildSyncMessage(alice, null);
  const bobResult = applySyncMessage(bob, first);
  applySyncMessage(alice, bobResult.reply);

  // Remembered vectors from round one.
  const aliceKnowsBob = bobResult.reply.vv;

  alice.set('new', 'value');
  const second = buildSyncMessage(alice, aliceKnowsBob);

  assert.equal(second.ops.length, 1, 'should send only the one new op');
  assert.equal(second.ops[0].key, 'new');
});

test('replaying a pass changes nothing', () => {
  const alice = new LwwMap('alice');
  const bob = new LwwMap('bob');
  alice.set('k', 'v');

  const message = buildSyncMessage(alice, null);
  assert.equal(applySyncMessage(bob, message).applied, 1);
  assert.equal(applySyncMessage(bob, message).applied, 0, 'replay must be a no-op');
  assert.equal(applySyncMessage(bob, message).applied, 0);
  assert.deepEqual(bob.entries(), [['k', 'v']]);
});

test('convergence holds under a three-way exchange', () => {
  const replicas = [new LwwMap('aaa'), new LwwMap('bbb'), new LwwMap('ccc')];

  replicas[0].set('x', 'from-a');
  replicas[1].set('y', 'from-b');
  replicas[2].set('z', 'from-c');
  replicas[0].set('shared', 'a');
  replicas[2].set('shared', 'c');

  // Gossip every pair in both directions, twice.
  for (let round = 0; round < 2; round += 1) {
    for (const from of replicas) {
      for (const to of replicas) {
        if (from !== to) applySyncMessage(to, buildSyncMessage(from, null));
      }
    }
  }

  assert.deepEqual(replicas[0].entries(), replicas[1].entries());
  assert.deepEqual(replicas[1].entries(), replicas[2].entries());
  assert.equal(replicas[0].size, 4);
});

test('isConverged reports honestly', () => {
  const alice = new LwwMap('alice');
  const bob = new LwwMap('bob');
  alice.set('k', 'v');

  assert.equal(isConverged(alice, bob.versionVector()), false);
  applySyncMessage(bob, buildSyncMessage(alice, null));
  assert.equal(isConverged(alice, bob.versionVector()), true);
});

test('sync messages survive the encode/decode hop', async () => {
  const alice = new LwwMap('alice');
  for (let i = 0; i < 200; i += 1) alice.set(`key-${i}`, `value-${i}`);

  const message = buildSyncMessage(alice, null);
  const { bytes, gzipped } = await encodeSyncMessage(message);
  const returned = await decodeSyncMessage(bytes, gzipped);

  assert.deepEqual(returned, message);

  const bob = new LwwMap('bob');
  assert.equal(applySyncMessage(bob, returned).applied, 200);
  assert.deepEqual(bob.entries(), alice.entries());
});

test('a repetitive op log compresses', async () => {
  const alice = new LwwMap('alice');
  for (let i = 0; i < 500; i += 1) alice.set(`key-${i}`, 'a fairly repetitive value');

  const message = buildSyncMessage(alice, null);
  const raw = new TextEncoder().encode(JSON.stringify(message));
  const { bytes, gzipped } = await encodeSyncMessage(message);

  assert.equal(gzipped, true, 'a 500-op log should compress');
  assert.ok(bytes.length < raw.length / 2, `gzip only reached ${bytes.length}/${raw.length}`);
});

test('an unknown protocol version is refused', () => {
  const db = new LwwMap('local');
  assert.throws(
    () => applySyncMessage(db, { v: 99, peer: 'x', vv: {}, ops: [] }),
    /Unsupported sync protocol/
  );
});
