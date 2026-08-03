import AVFoundation
import SwiftUI

struct ReceiveView: View {
    @State private var model = ReceiveModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                viewfinder
                progressBar
                Text(model.status.message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, alignment: .leading)

                controls
                recordList
            }
            .padding()
            .navigationTitle("lightdb")
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(Color(red: 0.2, green: 1, blue: 0.2))
    }

    private var viewfinder: some View {
        ZStack {
            CameraPreview(session: model.scanner.captureSession)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 12))

            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(red: 0.12, green: 0.62, blue: 0.12), lineWidth: 2)
                .padding(28)
                .allowsHitTesting(false)
        }
    }

    private var progressBar: some View {
        ProgressView(value: model.progress)
            .tint(Color(red: 0.2, green: 1, blue: 0.2))
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Button("start camera") { Task { await model.start() } }
                .buttonStyle(.borderedProminent)
                .disabled(model.scanner.state == .running)

            Button("stop") { model.stop() }
                .buttonStyle(.bordered)
                .disabled(model.scanner.state != .running)
        }
        .monospaced()
    }

    private var recordList: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("records (\(model.recordCount))")
                    .font(.headline)
                    .monospaced()
                Spacer()
                Text(model.actorId.prefix(8))
                    .font(.caption)
                    .monospaced()
                    .foregroundStyle(.secondary)
            }

            if model.records.isEmpty {
                Text("Nothing yet. Receive a sync from the web app.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                List(model.records, id: \.key) { record in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(record.key)
                            .font(.caption)
                            .monospaced()
                            .foregroundStyle(Color(red: 0.2, green: 1, blue: 0.2))
                        Text(record.value)
                            .font(.callout)
                    }
                }
                .listStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Thin UIKit bridge for the capture preview layer.
private struct CameraPreview: UIViewRepresentable {
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
        .preferredColorScheme(.dark)
}
