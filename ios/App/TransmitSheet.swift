import SwiftUI

/// The transmitting screen, presented over the form.
///
/// A sheet rather than an inline panel because the action lives at the bottom
/// of a long scrolling form: rendering the result at the top meant tapping
/// "Transmit" and then scrolling back up to find what you had started.
///
/// Two things here are functional, not decorative. Screen brightness goes to
/// full, because contrast is most of what a camera needs to lock onto a dense
/// symbol. And auto-lock is disabled, because a transfer takes longer than the
/// default idle timeout and a phone that sleeps mid-stream just fails.
struct TransmitSheet: View {
    let model: ProvisionModel

    @Environment(\.dismiss) private var dismiss
    @State private var previousBrightness: CGFloat?

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                symbol
                    .frame(height: geometry.size.height * 0.55)

                details
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .presentationBackground(.ultraThinMaterial)
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(false)
        .onAppear(perform: beginBroadcast)
        .onDisappear(perform: endBroadcast)
    }

    // MARK: - top half

    private var symbol: some View {
        VStack(spacing: Theme.Space.normal) {
            ZStack(alignment: .bottomTrailing) {
                QRFrameView(image: model.frameImage)
                    .frame(maxWidth: .infinity)

                // The return channel, small and in the corner: it exists to be
                // aimed, not watched.
                CameraPreview(session: model.scanner.captureSession)
                    .frame(width: 76, height: 76)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.control)
                            .stroke(model.sendConfirmed ? Theme.success : Theme.stroke, lineWidth: 2)
                    )
                    .padding(Theme.Space.normal)
            }
            .padding(.horizontal, Theme.Space.loose)

            if case .transmitting(let frames, let blocks, let passes) = model.status {
                HStack(spacing: Theme.Space.section) {
                    metric(String(frames), "frames")
                    metric(String(blocks), "blocks")
                    metric(String(format: "%.1f", passes), "passes")
                }
            }
        }
        .padding(.top, Theme.Space.section)
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.callout.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    // MARK: - bottom half

    private var details: some View {
        VStack(alignment: .leading, spacing: Theme.Space.loose) {
            VStack(alignment: .leading, spacing: Theme.Space.tight) {
                HStack(spacing: Theme.Space.tight) {
                    Text(model.sendConfirmed ? "Delivered" : "Transmitting")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(model.sendConfirmed ? Theme.success : Theme.text)

                    if model.sendConfirmed {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Theme.success)
                    }
                }

                Text("Profile · \(model.config.profile)")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }

            StatusRow(tone: model.status.tone, message: model.status.message)

            if model.sendConfirmed {
                Text(
                    "The other device sent back proof it holds these settings. "
                        + "Still broadcasting for a moment so it can see you know too, "
                        + "then this stops on its own."
                )
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: Theme.Space.normal) {
                    step(1, "Start a sync on the other device.")
                    step(2, "Hold the two screens facing each other.")
                    step(3, "Wait for the double tap — that means it arrived.")
                }

                Text(
                    "Both directions run at once: the front camera reads their screen "
                        + "while they read yours. Missed frames do not matter."
                )
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            Button(model.sendConfirmed ? "Done" : "Stop transmitting") { dismiss() }
                .buttonStyle(FluentPrimaryButton())
        }
        .padding(Theme.Space.loose)
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Space.normal) {
            Text("\(number)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 20, height: 20)
                .background(Theme.accent)
                .clipShape(Circle())

            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - screen state

    private func beginBroadcast() {
        previousBrightness = UIScreen.main.brightness
        UIScreen.main.brightness = 1.0
        UIApplication.shared.isIdleTimerDisabled = true
    }

    private func endBroadcast() {
        if let previousBrightness {
            UIScreen.main.brightness = previousBrightness
        }
        UIApplication.shared.isIdleTimerDisabled = false
    }
}
