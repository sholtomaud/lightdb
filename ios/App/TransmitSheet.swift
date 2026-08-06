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
            QRFrameView(image: model.frameImage)
                .frame(maxWidth: .infinity)
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
                Text("Transmitting")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text)

                Text("Profile · \(model.config.profile)")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }

            VStack(alignment: .leading, spacing: Theme.Space.normal) {
                step(1, "Open the receiving device and start its camera.")
                step(2, "Point it at this screen, filling most of the frame.")
                step(3, "Hold steady. The stream loops until you stop it.")
            }

            Text(
                "Frames repeat forever, so it does not matter if some are missed — "
                    + "the receiver only needs enough of them, in any order."
            )
            .font(.caption)
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)

            Button("Stop transmitting") { dismiss() }
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
