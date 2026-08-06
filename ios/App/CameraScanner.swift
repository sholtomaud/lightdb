import AVFoundation
import Foundation
import Vision

/// Camera capture plus Vision QR decoding.
///
/// This is the half that justifies a native app. The browser's camera API
/// cannot lock focus or exposure, so autofocus hunts continuously and blurs
/// exactly the dense frames we care about. AVFoundation can pin both, and
/// Vision decodes blurred, angled symbols far better than a WASM decoder.
@Observable
public final class CameraScanner: NSObject, @unchecked Sendable {
    public enum State: Equatable {
        case idle
        case denied
        case running
        case failed(String)
    }

    public private(set) var state: State = .idle

    /// Which camera to use.
    ///
    /// `.front` is what makes duplex possible: the front lens and the screen
    /// face the same way, so this device can read another screen while its own
    /// is being read. `.back` points away from the display and forces a flip.
    public var position: AVCaptureDevice.Position = .back

    /// Called on the main actor for every decoded QR payload.
    public var onPayload: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "lightdb.camera", qos: .userInitiated)
    private var request: VNDetectBarcodesRequest?

    public var captureSession: AVCaptureSession { session }

    public func start() async {
        guard state != .running else { return }

        let granted = await Self.requestAccess()
        guard granted else {
            await MainActor.run { self.state = .denied }
            return
        }

        do {
            try configure()
            queue.async { [session] in
                if !session.isRunning { session.startRunning() }
            }
            await MainActor.run { self.state = .running }
        } catch {
            await MainActor.run { self.state = .failed(error.localizedDescription) }
        }
    }

    public func stop() {
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        state = .idle
    }

    private static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    private enum ConfigurationError: LocalizedError {
        case noCamera
        case cannotAddInput
        case cannotAddOutput

        var errorDescription: String? {
            switch self {
            case .noCamera: return "No camera available on that side"
            case .cannotAddInput: return "Could not attach the camera"
            case .cannotAddOutput: return "Could not attach video output"
            }
        }
    }

    private func configure() throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // High resolution matters: a version-14 symbol is 73 modules across,
        // and we want several pixels per module after the lens.
        session.sessionPreset = .hd1920x1080

        guard
            let device = AVCaptureDevice.default(
                .builtInWideAngleCamera, for: .video, position: position)
        else { throw ConfigurationError.noCamera }

        try lockForStreaming(device)

        session.inputs.forEach(session.removeInput)
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw ConfigurationError.cannotAddInput }
        session.addInput(input)

        session.outputs.forEach(session.removeOutput)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw ConfigurationError.cannotAddOutput }
        session.addOutput(output)

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        self.request = request
    }

    /// Pin focus and exposure at a close working distance.
    ///
    /// Continuous autofocus is the single biggest cause of dropped frames when
    /// reading an animated stream: the lens hunts, and every frame during the
    /// hunt is unreadable.
    private func lockForStreaming(_ device: AVCaptureDevice) throws {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }

        if device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusMode = .continuousAutoFocus
        }
        if device.isAutoFocusRangeRestrictionSupported {
            device.autoFocusRangeRestriction = .near
        }
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
        }
        // Reading a bright screen: bias down so the symbol does not blow out.
        let bias = max(device.minExposureTargetBias, -1.0)
        device.setExposureTargetBias(bias)
    }
}

extension CameraScanner: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let request,
            let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right)
        do {
            try handler.perform([request])
        } catch {
            return
        }

        guard let results = request.results else { return }
        let payloads = results.compactMap(\.payloadStringValue)
        guard !payloads.isEmpty else { return }

        DispatchQueue.main.async { [onPayload] in
            payloads.forEach { onPayload?($0) }
        }
    }
}
