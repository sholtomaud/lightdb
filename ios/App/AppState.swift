import Foundation
import LightDBKit
import Observation

/// A materialised record. A named struct rather than the kit's tuple, because
/// SwiftUI's `ForEach` and `List` want a stable `Identifiable` element and key
/// paths into tuple labels are awkward at best.
struct Record: Identifiable, Equatable {
    let key: String
    let value: String

    var id: String { key }
}

/// The device's single replica, shared by every screen.
///
/// One `LWWMap` per device, not per screen. Two instances would mean two actor
/// ids on one phone, and the version vectors would never converge -- each half
/// would keep resending changes the other already had.
@MainActor
@Observable
final class AppState {
    private(set) var records: [Record] = []
    private(set) var opCount = 0

    let db: LWWMap
    let store: RecordStore

    init(store: RecordStore = RecordStore()) {
        self.store = store
        self.db = LWWMap(actor: store.actorId())
        db.merge(store.loadOps())
        refresh()
    }

    var actorId: String { db.actor }
    var recordCount: Int { db.count }

    /// Write locally and persist. Returns the ops so a caller can transmit them.
    @discardableResult
    func set(_ entries: [(key: String, value: String)]) -> [Op] {
        let ops = entries.map { db.set($0.key, $0.value) }
        store.append(ops)
        refresh()
        return ops
    }

    /// Merge ops that arrived over the optical link.
    @discardableResult
    func merge(_ message: SyncMessage) -> Int {
        let applied = db.merge(message.ops)
        store.append(message.ops)
        store.setPeerVector(message.vv, for: message.peer)
        refresh()
        return applied
    }

    func peerVector(for peer: String) -> VersionVector? {
        store.peerVector(for: peer)
    }

    /// Records under a provisioning profile, keyed by field id.
    func configValues(profile: String) -> [String: String] {
        let prefix = "cfg/\(profile)/"
        var out: [String: String] = [:]
        for record in records where record.key.hasPrefix(prefix) {
            out[String(record.key.dropFirst(prefix.count))] = record.value
        }
        return out
    }

    private func refresh() {
        records = db.entries().map { Record(key: $0.key, value: $0.value) }
        opCount = db.allOps().count
    }
}

/// Minimal on-disk persistence for the op log.
///
/// A JSON file rather than Core Data or SwiftData: ops are immutable and
/// append-only, and the whole log is small enough to rewrite. Worth revisiting
/// if this ever holds more than a few thousand records.
struct RecordStore {
    private var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }
    private var opsURL: URL { directory.appendingPathComponent("lightdb-ops.json") }
    private var metaURL: URL { directory.appendingPathComponent("lightdb-meta.json") }

    private struct Meta: Codable {
        var actorId: String
        var peers: [String: VersionVector]
    }

    private func loadMeta() -> Meta {
        if let data = try? Data(contentsOf: metaURL),
            let meta = try? JSONDecoder().decode(Meta.self, from: data)
        {
            return meta
        }
        return Meta(actorId: Self.newActorId(), peers: [:])
    }

    private func saveMeta(_ meta: Meta) {
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        try? JSONEncoder().encode(meta).write(to: metaURL)
    }

    private static func newActorId() -> String {
        (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    func actorId() -> String {
        let meta = loadMeta()
        saveMeta(meta)
        return meta.actorId
    }

    func loadOps() -> [Op] {
        guard let data = try? Data(contentsOf: opsURL),
            let ops = try? JSONDecoder().decode([Op].self, from: data)
        else { return [] }
        return ops
    }

    func append(_ ops: [Op]) {
        guard !ops.isEmpty else { return }

        // Ops are immutable and keyed by (actor, seq), so union is safe.
        var existing = loadOps()
        var seen = Set(existing.map { "\($0.actor):\($0.seq)" })
        for op in ops where seen.insert("\(op.actor):\(op.seq)").inserted {
            existing.append(op)
        }

        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        try? JSONEncoder().encode(existing).write(to: opsURL)
    }

    func peerVector(for peer: String) -> VersionVector? {
        loadMeta().peers[peer]
    }

    func setPeerVector(_ vv: VersionVector, for peer: String) {
        var meta = loadMeta()
        meta.peers[peer] = vv
        saveMeta(meta)
    }
}
