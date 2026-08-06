import UIKit

/// Haptic feedback for the optical link.
///
/// While aiming the phone you are looking at the *other* device's screen, not
/// your own, so on-screen status is close to useless mid-transfer. Touch is the
/// channel that actually reaches the user here.
///
/// Deliberately a small vocabulary, so each signal stays legible:
///
///   - `lockedOn`   a light tick the moment the first frame decodes: aim is good
///   - `finished`   the success pattern once a payload is merged
///   - `sendConfirmed` a double tap once the peer proves it holds what we sent
///   - `failed`     the error pattern when a transfer is discarded
///
/// `sendConfirmed` is only meaningful on a duplex link. A transmitter with no
/// camera cannot know whether anything received it, and buzzing on a guess
/// would be worse than staying silent.
@MainActor
enum Haptics {
    private static let notifier = UINotificationFeedbackGenerator()
    private static let impact = UIImpactFeedbackGenerator(style: .light)
    private static let firm = UIImpactFeedbackGenerator(style: .medium)

    /// Warms the Taptic Engine so the first buzz is not late.
    ///
    /// Without this the engine spins up on demand and the feedback lands a
    /// noticeable moment after the event it is meant to mark.
    static func prepare() {
        notifier.prepare()
        impact.prepare()
        firm.prepare()
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

    /// The peer's version vector proves it holds everything we sent.
    ///
    /// A double tap rather than the success pattern, so "they got mine" and
    /// "I got theirs" stay tellable apart without looking at the screen.
    static func sendConfirmed() {
        firm.impactOccurred()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(140))
            firm.impactOccurred()
            firm.prepare()
        }
    }

    /// A transfer was discarded, e.g. a checksum mismatch.
    static func failed() {
        notifier.notificationOccurred(.error)
        notifier.prepare()
    }
}
