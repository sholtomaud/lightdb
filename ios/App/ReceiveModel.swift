import Foundation
import LightDBKit
import Observation

/// Drives a receive session: camera payloads in, merged records out.
@MainActor
@Observable
final class ReceiveModel {
    enum Status: Equatable {
        case idle
        case scanning
        case receiving(blocks: Int, of: Int, frames: Int)
        case merged(ops: Int, peer: String)
        case failed(String)

        var message: String {
            switch self {
            case .idle:
                return "Point the camera at the sending screen."
            case .scanning:
                return "Scanning…"
            case .receiving(let blocks, let total, let frames):
                return "Recovering \(blocks)/\(total) blocks · \(frames) frames seen"
            case .merged(let ops, let peer):
                return ops > 0
                    ? "Merged \(ops) op\(ops == 1 ? "" : "s") from \(peer.prefix(8)). Flip and send back."
                    : "Already up to date with \(peer.prefix(8))."
            case .failed(let reason):
                return reason
            }
        }
    }

    private(set) var status: Status = .idle
    private(set) var progress: Double = 0
    private(set) var records: [(key: String, value: String)] = []
    private(set) var framesSeen = 0

    let scanner = CameraScanner()

    private let receiver = OpticalReceiver()
    private let db: LWWMap
    private let store = RecordStore()

    init() {
        db = LWWMap(actor: store.actorId())
        db.merge(store.loadOps())
        records = db.entries()

        scanner.onPayload = { [weak self] payload in
            self?.ingest(payload)
        }
    }

    var recordCount: Int { db.count }
    var actorId: String { db.actor }

    func start() async {
        status = .scanning
        await scanner.start()

        switch scanner.state {
        case .denied:
            status = .failed("Camera access denied. Enable it in Settings.")
        case .failed(let reason):
            status = .failed(reason)
        default:
            break
        }
    }

    func stop() {
        scanner.stop()
        status = .idle
    }

    /// Exposed so tests and a paste fallback can drive the same path.
    func ingest(_ payload: String) {
        switch receiver.ingest(text: payload) {
        case .ignored:
            return

        case .progressed(let update):
            framesSeen = update.framesSeen
            progress = update.fraction
            status = .receiving(
                blocks: update.blocksSolved, of: update.numBlocks, frames: update.framesSeen)

        case .checksumMismatch:
            progress = 0
            status = .failed("Checksum mismatch. Restarting.")

        case .completed(let payload, let header):
            progress = 1
            merge(payload: payload, header: header)
        }
    }

    private func merge(payload: [UInt8], header: FrameHeader) {
        do {
            let gzipped = header.flags & Frame.flagGzip != 0
            let message = try SyncMessage.decode(payload, gzipped: gzipped)

            let applied = db.merge(message.ops)
            store.append(message.ops)
            store.setPeerVector(message.vv, for: message.peer)

            records = db.entries()
            status = .merged(ops: applied, peer: message.peer)
        } catch {
            status = .failed("Could not merge: \(error)")
        }
    }
}

/// Minimal on-disk persistence for the op log.
///
/// A JSON file rather than Core Data or SwiftData: ops are immutable and
/// append-only, and the whole log is small enough to rewrite. Worth revisiting
/// if this ever holds more than a few thousand records.
private struct RecordStore {
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

    func setPeerVector(_ vv: VersionVector, for peer: String) {
        var meta = loadMeta()
        meta.peers[peer] = vv
        saveMeta(meta)
    }
}
