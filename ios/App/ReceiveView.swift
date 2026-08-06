import AVFoundation
import SwiftUI

struct ReceiveView: View {
    @Environment(AppState.self) private var state
    @State private var model: ReceiveModel?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let model {
                    content(model)
                }
            }
            .background(Theme.canvas)
            .navigationTitle("Receive")
            .navigationBarTitleDisplayMode(.large)
        }
        .task {
            if model == nil { model = ReceiveModel(state: state) }
        }
        .onDisappear { model?.stop() }
    }

    private func content(_ model: ReceiveModel) -> some View {
        VStack(spacing: Theme.Space.loose) {
            Card {
                VStack(spacing: Theme.Space.normal) {
                    viewfinder(model)
                    if model.progress > 0 {
                        progress(model)
                    }
                    StatusRow(tone: model.status.tone, message: model.status.message)
                }
            }

            controls(model)
        }
        .padding(Theme.Space.loose)
    }

    private func viewfinder(_ model: ReceiveModel) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .fill(Color.black)

            CameraPreview(session: model.scanner.captureSession)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))

            if !model.isScanning {
                VStack(spacing: Theme.Space.tight) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 44))
                    Text("Camera off")
                        .font(.footnote)
                }
                .foregroundStyle(Color(white: 0.55))
            } else {
                // A frame guide, not a crop: decoding uses the whole image.
                RoundedRectangle(cornerRadius: Theme.Radius.control)
                    .stroke(Theme.accent.opacity(0.9), lineWidth: 2)
                    .padding(28)
                    .allowsHitTesting(false)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .stroke(Theme.stroke, lineWidth: 1)
        )
    }

    private func progress(_ model: ReceiveModel) -> some View {
        VStack(spacing: 6) {
            ProgressView(value: model.progress)
                .tint(Theme.accent)
            HStack {
                Text("\(Int(model.progress * 100))% recovered")
                Spacer()
                Text("\(model.framesSeen) frames")
            }
            .font(.caption)
            .foregroundStyle(Theme.textSecondary)
        }
    }

    private func controls(_ model: ReceiveModel) -> some View {
        VStack(spacing: Theme.Space.normal) {
            if model.isScanning {
                Button("Stop camera") { model.stop() }
                    .buttonStyle(FluentSecondaryButton())
            } else {
                Button("Start camera") { Task { await model.start() } }
                    .buttonStyle(FluentPrimaryButton())
            }
        }
    }
}

/// Thin UIKit bridge for the capture preview layer.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.videoPreviewLayer.session = session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer {
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}

#Preview {
    ReceiveView()
        .environment(AppState())
}
