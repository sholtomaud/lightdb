import Foundation

/// One operation in a replica's log. Wire-compatible with the TypeScript `Op`.
public struct Op: Codable, Equatable, Sendable {
    public let actor: String
    public let seq: Int
    public let key: String
    /// nil is a tombstone.
    public let value: String?
    public let ts: Double

    public init(actor: String, seq: Int, key: String, value: String?, ts: Double) {
        self.actor = actor
        self.seq = seq
        self.key = key
        self.value = value
        self.ts = ts
    }
}

public typealias VersionVector = [String: Int]

/// Last-writer-wins map with per-actor operation logs and version vectors.
///
/// Merges are commutative, associative and idempotent, which is what makes a
/// one-way optical channel survivable: frames may arrive in any order, and the
/// same stream may be scanned twice with no ill effect.
public final class LWWMap {
    public let actor: String

    private struct Materialized {
        var value: String?
        var ts: Double
        var actor: String
        var seq: Int
    }

    /// Sparse per-actor logs indexed by seq - 1. Gaps are possible.
    private var log: [String: [Op?]] = [:]
    private var state: [String: Materialized] = [:]
    private var localSeq = 0

    public init(actor: String) {
        self.actor = actor
    }

    // MARK: - reads

    public func get(_ key: String) -> String? {
        guard let entry = state[key], let value = entry.value else { return nil }
        return value
    }

    /// Live keys and values, tombstones excluded, sorted by key.
    public func entries() -> [(key: String, value: String)] {
        state.compactMap { key, entry in
            entry.value.map { (key: key, value: $0) }
        }
        .sorted { $0.key < $1.key }
    }

    public var count: Int {
        state.values.reduce(0) { $0 + ($1.value != nil ? 1 : 0) }
    }

    public func allOps() -> [Op] {
        log.values.flatMap { $0.compactMap { $0 } }
    }

    // MARK: - local writes

    @discardableResult
    public func set(_ key: String, _ value: String) -> Op {
        appendLocal(key: key, value: value)
    }

    @discardableResult
    public func delete(_ key: String) -> Op {
        appendLocal(key: key, value: nil)
    }

    private func appendLocal(key: String, value: String?) -> Op {
        localSeq += 1
        let op = Op(
            actor: actor,
            seq: localSeq,
            key: key,
            value: value,
            // Milliseconds, matching JavaScript's Date.now().
            ts: (Date().timeIntervalSince1970 * 1000).rounded(.down)
        )
        _ = record(op)
        return op
    }

    // MARK: - versioning

    /// Highest *contiguous* sequence per actor.
    ///
    /// Deliberately conservative: holding ops 1, 2, 4 from a peer reports 2, so
    /// the peer resends 3 rather than us silently losing it.
    public func versionVector() -> VersionVector {
        var vv: VersionVector = [:]
        for (actor, ops) in log {
            var contiguous = 0
            while contiguous < ops.count && ops[contiguous] != nil {
                contiguous += 1
            }
            if contiguous > 0 { vv[actor] = contiguous }
        }
        return vv
    }

    /// Every op this replica holds that `vv` does not account for.
    public func changesSince(_ vv: VersionVector) -> [Op] {
        var out = [Op]()
        for (actor, ops) in log {
            let known = vv[actor] ?? 0
            var i = known
            while i < ops.count {
                if let op = ops[i] { out.append(op) }
                i += 1
            }
        }
        return out.sorted { a, b in
            a.actor == b.actor ? a.seq < b.seq : a.actor < b.actor
        }
    }

    // MARK: - merge

    /// Apply remote ops. Returns how many were new. Safe to call repeatedly.
    @discardableResult
    public func merge<S: Sequence>(_ ops: S) -> Int where S.Element == Op {
        ops.reduce(0) { $0 + (record($1) ? 1 : 0) }
    }

    /// Later timestamp wins, then higher actor id, then higher sequence.
    ///
    /// The sequence tiebreak is load-bearing: millisecond timestamps mean a
    /// write and the delete that follows it routinely share both a timestamp
    /// and an actor. Without it the later op loses and the delete never takes.
    private func wins(_ candidate: Op, over incumbent: Materialized) -> Bool {
        if candidate.ts != incumbent.ts { return candidate.ts > incumbent.ts }
        if candidate.actor != incumbent.actor { return candidate.actor > incumbent.actor }
        return candidate.seq > incumbent.seq
    }

    @discardableResult
    private func record(_ op: Op) -> Bool {
        guard op.seq >= 1 else { return false }

        var ops = log[op.actor] ?? []
        let index = op.seq - 1
        if index < ops.count, ops[index] != nil { return false }  // already held

        while ops.count <= index { ops.append(nil) }
        ops[index] = op
        log[op.actor] = ops

        if op.actor == actor && op.seq > localSeq { localSeq = op.seq }

        // LWW is order-independent, so fold in even ops ahead of a gap.
        if let incumbent = state[op.key], !wins(op, over: incumbent) { return true }
        state[op.key] = Materialized(
            value: op.value, ts: op.ts, actor: op.actor, seq: op.seq
        )
        return true
    }
}

/// A sync message, wire-compatible with the TypeScript `SyncMessage`.
public struct SyncMessage: Codable, Sendable {
    public let v: Int
    public let peer: String
    public let vv: VersionVector
    public let ops: [Op]

    public static let protocolVersion = 1

    public init(v: Int = SyncMessage.protocolVersion, peer: String, vv: VersionVector, ops: [Op]) {
        self.v = v
        self.peer = peer
        self.vv = vv
        self.ops = ops
    }

    public static func decode(_ bytes: [UInt8], gzipped: Bool) throws -> SyncMessage {
        let data = gzipped ? try Gzip.inflate(Data(bytes)) : Data(bytes)
        return try JSONDecoder().decode(SyncMessage.self, from: data)
    }
}
