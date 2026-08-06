import Foundation

public enum FountainError: Error, CustomStringConvertible {
    case emptyPayload
    case invalidBlockSize(Int)

    public var description: String {
        switch self {
        case .emptyPayload: return "payload is empty"
        case .invalidBlockSize(let size): return "block size must be positive, got \(size)"
        }
    }
}

/// Sending half of the fountain codec.
///
/// Mirrors the TypeScript encoder exactly -- it has to, since a browser has to
/// decode what this produces. `StreamTests` proves that byte for byte by
/// re-encoding the recorded transmissions in `spec/vectors/streams.json` and
/// comparing against frames the TypeScript sender actually emitted.
public final class FountainEncoder {
    public let numBlocks: Int
    public let blockSize: Int
    public let totalLength: Int

    private let blocks: [[UInt8]]
    private let thresholds: [UInt32]

    public init(payload: [UInt8], blockSize: Int) throws {
        guard blockSize >= 1 else { throw FountainError.invalidBlockSize(blockSize) }
        guard !payload.isEmpty else { throw FountainError.emptyPayload }

        self.blockSize = blockSize
        self.totalLength = payload.count
        self.numBlocks = (payload.count + blockSize - 1) / blockSize

        // The final block is zero-padded; totalLength tells the receiver where
        // to cut.
        var built = [[UInt8]]()
        built.reserveCapacity(numBlocks)
        for i in 0..<numBlocks {
            var block = [UInt8](repeating: 0, count: blockSize)
            let start = i * blockSize
            let end = min(start + blockSize, payload.count)
            for j in start..<end { block[j - start] = payload[j] }
            built.append(block)
        }

        self.blocks = built
        self.thresholds = Soliton.thresholds(k: numBlocks)
    }

    /// The coded block for this seed: XOR of the selected source blocks.
    public func encode(seed: UInt32) -> [UInt8] {
        let indices = Soliton.selectBlocks(
            seed: seed, numBlocks: numBlocks, thresholds: thresholds
        )

        var out = [UInt8](repeating: 0, count: blockSize)
        for index in indices {
            let block = blocks[index]
            for i in 0..<blockSize { out[i] ^= block[i] }
        }
        return out
    }
}

/// Turns a payload into an endless stream of base64url frames.
///
/// The stream never ends on its own: there is no back-channel, so the sender
/// cannot know when the receiver has enough. A human stops it.
public final class OpticalTransmitter {
    public let header: FrameHeader
    public let numBlocks: Int

    private let encoder: FountainEncoder
    private var seed: UInt32 = 1

    public private(set) var framesSent = 0

    public init(payload: [UInt8], blockSize: Int, flags: UInt8 = 0) throws {
        self.encoder = try FountainEncoder(payload: payload, blockSize: blockSize)
        self.numBlocks = encoder.numBlocks
        self.header = FrameHeader(
            flags: flags,
            sessionId: UInt32.random(in: 1...UInt32.max),
            totalLength: UInt32(payload.count),
            blockSize: UInt16(blockSize),
            numBlocks: UInt16(encoder.numBlocks),
            seed: 0,
            checksum: CRC32.compute(payload)
        )
    }

    /// Next frame, as the base64url text that goes into a QR symbol.
    public func nextFrame() -> String {
        // Seed 0 is a xorshift32 fixed point, so the sequence starts at 1.
        let current = seed
        seed = seed == UInt32.max ? 1 : seed &+ 1

        var frameHeader = header
        frameHeader.seed = current

        let payload = encoder.encode(seed: current)
        framesSent += 1

        return Base64URL.encode(Frame.encode(header: frameHeader, payload: payload))
    }

    /// Frames emitted divided by blocks needed. 1.0 is one full pass.
    public var passes: Double {
        numBlocks == 0 ? 0 : Double(framesSent) / Double(numBlocks)
    }
}
