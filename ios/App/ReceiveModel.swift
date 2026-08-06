import Foundation
import LightDBKit
import Observation
import SwiftUI  // StatusRow.Tone

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
                    ? "Merged \(ops) record\(ops == 1 ? "" : "s") from \(peer.prefix(8))."
                    : "Already up to date with \(peer.prefix(8))."
            case .failed(let reason):
                return reason
            }
        }

        var tone: StatusRow.Tone {
            switch self {
            case .idle: return .neutral
            case .scanning, .receiving: return .active
            case .merged: return .good
            case .failed: return .bad
            }
        }
    }

    private(set) var status: Status = .idle
    private(set) var progress: Double = 0
    private(set) var framesSeen = 0

    /// One lock-on tick per session, not one per frame.
    private var hasSignalledLockOn = false

    let scanner = CameraScanner()

    private let state: AppState
    private let receiver = OpticalReceiver()

    init(state: AppState) {
        self.state = state

        scanner.onPayload = { [weak self] payload in
            self?.ingest(payload)
        }
    }

    var isScanning: Bool { scanner.state == .running }

    func start() async {
        status = .scanning
        hasSignalledLockOn = false

        // Warm the Taptic Engine now, so the first buzz is not late.
        Haptics.prepare()

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

            // The camera is aimed correctly. Worth knowing without looking,
            // since the phone's own screen is facing away from you.
            if !hasSignalledLockOn {
                hasSignalledLockOn = true
                Haptics.lockedOn()
            }

        case .checksumMismatch:
            progress = 0
            hasSignalledLockOn = false
            status = .failed("Checksum mismatch. Restarting.")
            Haptics.failed()

        case .completed(let payload, let header):
            progress = 1
            hasSignalledLockOn = false
            merge(payload: payload, header: header)
        }
    }

    private func merge(payload: [UInt8], header: FrameHeader) {
        do {
            let gzipped = header.flags & Frame.flagGzip != 0
            let message = try SyncMessage.decode(payload, gzipped: gzipped)
            let applied = state.merge(message)
            status = .merged(ops: applied, peer: message.peer)

            // The signal the user is actually waiting for: they can lower the
            // phone now. Fires even when nothing was new, because "already up
            // to date" is just as much an answer as "merged 12 records".
            Haptics.finished()
        } catch {
            status = .failed("Could not merge: \(error)")
            Haptics.failed()
        }
    }
}
