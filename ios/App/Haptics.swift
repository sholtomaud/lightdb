import UIKit

/// Haptic feedback for the optical link.
///
/// While aiming the phone you are looking at the *other* device's screen, not
/// your own, so on-screen status is close to useless mid-transfer. Touch is the
/// channel that actually reaches the user here.
///
/// Deliberately a small vocabulary, so each signal stays legible:
///
///   - `lockedOn`  a light tick the moment the first frame decodes: aim is good
///   - `finished`  the success pattern once a payload is merged
///   - `failed`    the error pattern when a transfer is discarded
///
/// No haptic exists for "finished sending". The channel has no back-channel, so
/// a transmitter genuinely cannot know whether anyone received it -- buzzing on
/// some guess would be worse than staying silent.
@MainActor
enum Haptics {
    private static let notifier = UINotificationFeedbackGenerator()
    private static let impact = UIImpactFeedbackGenerator(style: .light)

    /// Warms the Taptic Engine so the first buzz is not late.
    ///
    /// Without this the engine spins up on demand and the feedback lands a
    /// noticeable moment after the event it is meant to mark.
    static func prepare() {
        notifier.prepare()
        impact.prepare()
    }

    /// First frame of a session decoded: the camera is framed correctly.
    static func lockedOn() {
        impact.impactOccurred()
        impact.prepare()
    }

    /// A payload arrived complete and merged.
    static func finished() {
        notifier.notificationOccurred(.success)
        notifier.prepare()
    }

    /// A transfer was discarded, e.g. a checksum mismatch.
    static func failed() {
        notifier.notificationOccurred(.error)
        notifier.prepare()
    }
}
