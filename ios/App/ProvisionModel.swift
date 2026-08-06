import Foundation
import LightDBKit
import Observation
import SwiftUI

/// Drives the provisioning screen: config in, a QR stream out, and the peer's
/// reply back in through the front camera.
///
/// The front camera is the whole trick. It faces the same way as the screen, so
/// the phone can read the other device while the other device reads the phone.
/// Without it a transmitter is talking into a void -- it cannot know whether
/// anything arrived, which is why there was no "sent" signal before.
@MainActor
@Observable
final class ProvisionModel {
    enum Status: Equatable {
        case idle
        case transmitting(frames: Int, blocks: Int, passes: Double)
        case receiving(blocks: Int, of: Int)
        case confirmed(peer: String, merged: Int)
        case failed(String)

        var message: String {
            switch self {
            case .idle:
                return "Fill in the settings, then transmit. Hold the devices screen to screen."
            case .transmitting(let frames, let blocks, let passes):
                return String(
                    format: "%d frames sent · %d blocks · %.1f passes", frames, blocks, passes)
            case .receiving(let blocks, let total):
                return "Reading reply · \(blocks)/\(total) blocks"
            case .confirmed(let peer, let merged):
                return merged > 0
                    ? "\(peer.prefix(8)) has your settings, and sent back \(merged) record\(merged == 1 ? "" : "s")."
                    : "\(peer.prefix(8)) has your settings."
            case .failed(let reason):
                return reason
            }
        }

        var tone: StatusRow.Tone {
            switch self {
            case .idle: return .neutral
            case .transmitting, .receiving: return .active
            case .confirmed: return .good
            case .failed: return .bad
            }
        }
    }

    var config = DeviceConfig()
    private(set) var status: Status = .idle
    private(set) var frameImage: CGImage?
    private(set) var isTransmitting = false

    /// True once a decoded peer vector accounts for everything we sent.
    private(set) var sendConfirmed = false
    private(set) var peer: String?

    /// Frames per second. Above ~15 most phone cameras start dropping frames.
    var fps: Double = 12

    /// Kept running briefly after confirmation so the peer can also learn it is
    /// converged. Neither side can prove the other knows -- someone has to stop
    /// first -- so this trades a couple of seconds for the peer almost always
    /// finding out.
    private static let graceSeconds: TimeInterval = 3

    let scanner = CameraScanner()

    private let state: AppState
    private let renderer = QRRenderer()
    private let receiver = OpticalReceiver()
    private var transmitter: OpticalTransmitter?
    private var timer: Timer?
    private var graceTask: Task<Void, Never>?
    private var peerVector: VersionVector?
    private var encoding = false

    init(state: AppState) {
        self.state = state
        scanner.position = .front
        scanner.onPayload = { [weak self] payload in
            self?.absorb(payload)
        }
    }

    var canTransmit: Bool { config.filledCount > 0 }

    /// Commit the profile locally, start streaming it, and open the camera for
    /// the reply.
    func transmit() {
        stop()

        let records = config.records()
        guard !records.isEmpty else {
            status = .failed("Nothing to send. Fill in at least one setting.")
            return
        }

        state.set(records)
        Haptics.prepare()

        guard restartStream() else { return }
        isTransmitting = true

        // Transmission is useful even if the camera is refused, so this is
        // started after and treated as degrading rather than failing.
        Task { await scanner.start() }
    }

    func stop() {
        graceTask?.cancel()
        graceTask = nil
        timer?.invalidate()
        timer = nil
        transmitter = nil
        frameImage = nil
        isTransmitting = false
        sendConfirmed = false
        peer = nil
        peerVector = nil
        receiver.reset()
        scanner.stop()
        status = .idle
    }

    func reset() {
        stop()
        config = DeviceConfig(profile: config.profile)
    }

    func loadExisting() {
        let existing = state.configValues(profile: config.profile)
        guard !existing.isEmpty else { return }

        for index in config.fields.indices {
            if let value = existing[config.fields[index].id] {
                config.fields[index].value = value
            }
        }
    }

    // MARK: - outgoing

    /// Encode the delta the peer is missing and restart the stream.
    ///
    /// Swapping payload mid-flight is safe: a fresh session id fails the
    /// receiver's `sameSession` check, so it resets rather than mixing frames
    /// from two different payloads.
    @discardableResult
    private func restartStream() -> Bool {
        guard !encoding else { return false }
        encoding = true
        defer { encoding = false }

        timer?.invalidate()

        do {
            let message = SyncMessage.build(from: state.db, peerVector: peerVector)
            let payload = try message.encode()
            let transmitter = try OpticalTransmitter(payload: payload, blockSize: 96)
            self.transmitter = transmitter

            let timer = Timer.scheduledTimer(
                withTimeInterval: 1.0 / max(1, fps), repeats: true
            ) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
            self.timer = timer
            tick()
            return true
        } catch {
            status = .failed("Could not start: \(error)")
            return false
        }
    }

    private func tick() {
        guard let transmitter else { return }

        frameImage = renderer.render(transmitter.nextFrame())

        // Once confirmed the status belongs to the confirmation, not the
        // frame counter that is still ticking behind it.
        if !sendConfirmed {
            status = .transmitting(
                frames: transmitter.framesSent,
                blocks: transmitter.numBlocks,
                passes: transmitter.passes
            )
        }
    }

    // MARK: - incoming

    private func absorb(_ payload: String) {
        switch receiver.ingest(text: payload) {
        case .ignored:
            return

        case .progressed(let update):
            if !sendConfirmed {
                status = .receiving(blocks: update.blocksSolved, of: update.numBlocks)
            }

        case .checksumMismatch:
            status = .failed("Checksum mismatch. Still transmitting.")
            Haptics.failed()

        case .completed(let bytes, let header):
            merge(bytes, gzipped: header.flags & Frame.flagGzip != 0)
        }
    }

    private func merge(_ bytes: [UInt8], gzipped: Bool) {
        do {
            let message = try SyncMessage.decode(bytes, gzipped: gzipped)
            let applied = state.merge(message)

            peer = message.peer
            peerVector = message.vv

            // The acknowledgement: their vector accounts for everything we
            // hold, so the settings are definitively on the other device.
            let confirmed = state.db.changesSince(message.vv).isEmpty

            if confirmed && !sendConfirmed {
                sendConfirmed = true
                status = .confirmed(peer: message.peer, merged: applied)
                Haptics.sendConfirmed()
                beginGrace()
            } else if !confirmed {
                // They replied but still lack some of ours; narrow the delta
                // and keep going.
                restartStream()
            }
        } catch {
            status = .failed("Could not merge reply: \(error)")
            Haptics.failed()
        }
    }

    /// Keep transmitting the (now tiny) vector for a moment, then stop.
    private func beginGrace() {
        restartStream()

        graceTask?.cancel()
        graceTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.graceSeconds))
            guard !Task.isCancelled else { return }

            await MainActor.run {
                guard let self, self.sendConfirmed else { return }
                let outcome = self.status
                self.stop()
                self.status = outcome
            }
        }
    }
}
