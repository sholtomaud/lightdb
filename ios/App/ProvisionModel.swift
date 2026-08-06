import Foundation
import LightDBKit
import Observation
import SwiftUI

/// Drives the provisioning screen: config in, an endless QR stream out.
@MainActor
@Observable
final class ProvisionModel {
    enum Status: Equatable {
        case idle
        case transmitting(frames: Int, blocks: Int, passes: Double)
        case failed(String)

        var message: String {
            switch self {
            case .idle:
                return "Fill in the settings, then transmit. Point the other device's camera at this screen."
            case .transmitting(let frames, let blocks, let passes):
                return String(
                    format: "%d frames sent · %d blocks · %.1f passes", frames, blocks, passes)
            case .failed(let reason):
                return reason
            }
        }

        var tone: StatusRow.Tone {
            switch self {
            case .idle: return .neutral
            case .transmitting: return .active
            case .failed: return .bad
            }
        }
    }

    var config = DeviceConfig()
    private(set) var status: Status = .idle
    private(set) var frameImage: CGImage?

    /// Frames per second. Above ~15 most phone cameras start dropping frames.
    var fps: Double = 12

    private let state: AppState
    private let renderer = QRRenderer()
    private var transmitter: OpticalTransmitter?
    private var timer: Timer?

    init(state: AppState) {
        self.state = state
    }

    var isTransmitting: Bool { timer != nil }
    var canTransmit: Bool { config.filledCount > 0 }

    /// Commit the profile to the local log, then stream it.
    ///
    /// Writing locally first is deliberate: the phone keeps a record of what it
    /// provisioned, and the values survive the app being closed mid-transfer.
    func transmit() {
        stop()

        let records = config.records()
        guard !records.isEmpty else {
            status = .failed("Nothing to send. Fill in at least one setting.")
            return
        }

        state.set(records)

        do {
            let message = SyncMessage.build(from: state.db, peerVector: nil)
            let payload = try message.encode()

            // Sized so a frame fits a mid-range QR version once base64url has
            // expanded it by a third and the 24-byte header is added.
            let transmitter = try OpticalTransmitter(payload: payload, blockSize: 96)
            self.transmitter = transmitter

            let timer = Timer.scheduledTimer(
                withTimeInterval: 1.0 / max(1, fps), repeats: true
            ) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
            self.timer = timer
            tick()
        } catch {
            status = .failed("Could not start: \(error)")
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        transmitter = nil
        frameImage = nil
        status = .idle
    }

    /// Clear every value but keep the field layout.
    func reset() {
        stop()
        config = DeviceConfig(profile: config.profile)
    }

    /// Reload values already held for this profile, so an edit is a delta
    /// rather than a retype.
    func loadExisting() {
        let existing = state.configValues(profile: config.profile)
        guard !existing.isEmpty else { return }

        for index in config.fields.indices {
            if let value = existing[config.fields[index].id] {
                config.fields[index].value = value
            }
        }
    }

    private func tick() {
        guard let transmitter else { return }

        frameImage = renderer.render(transmitter.nextFrame())
        status = .transmitting(
            frames: transmitter.framesSent,
            blocks: transmitter.numBlocks,
            passes: transmitter.passes
        )
    }
}
