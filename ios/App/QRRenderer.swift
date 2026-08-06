import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Renders frame text as a QR symbol.
///
/// CoreImage rather than a hand-written generator: the Swift side only ever
/// *sends*, and `CIQRCodeGenerator` is already in the OS. The web app carries
/// its own encoder because browsers have no QR generation API at all.
///
/// Version is not pinnable through CoreImage, but it does not need to be --
/// every frame in a stream is the same byte length, so the chosen version is
/// stable for the whole transmission.
@MainActor
final class QRRenderer {
    /// Shared: constructing a CIContext per frame is expensive enough to show
    /// up as dropped frames at 12fps.
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private let filter = CIFilter.qrCodeGenerator()

    /// - Parameter correction: L is right for a screen-to-camera stream. The
    ///   fountain code already handles loss, so spending symbol capacity on
    ///   error correction just makes every frame carry less.
    func render(_ text: String, correction: String = "L", scale: CGFloat = 8) -> CGImage? {
        filter.message = Data(text.utf8)
        filter.correctionLevel = correction

        guard let output = filter.outputImage else { return nil }

        // Nearest-neighbour upscale keeps module edges hard. Smoothing here
        // directly costs decode rate at the far end.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return context.createCGImage(scaled, from: scaled.extent)
    }
}

/// Displays a QR frame, or a placeholder when idle.
struct QRFrameView: View {
    let image: CGImage?

    var body: some View {
        ZStack {
            // A white quiet zone is part of the symbol, not decoration: without
            // it many decoders will not lock on.
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .fill(.white)

            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.none)
                    .aspectRatio(contentMode: .fit)
                    .padding(16)
            } else {
                VStack(spacing: Theme.Space.tight) {
                    Image(systemName: "qrcode")
                        .font(.system(size: 44))
                    Text("Idle")
                        .font(.footnote)
                }
                .foregroundStyle(Color(white: 0.72))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .stroke(Theme.stroke, lineWidth: 1)
        )
    }
}
