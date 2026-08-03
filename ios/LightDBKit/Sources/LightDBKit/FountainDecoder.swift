import Foundation

/// Peeling decoder for LT-coded frames.
///
/// Receive-only: this implementation never encodes. The phone scans a laptop
/// screen, which is the fast direction anyway -- a big bright display into a
/// good camera sensor.
public final class FountainDecoder {
    public let numBlocks: Int
    public let blockSize: Int
    public let totalLength: Int

    private var solved: [[UInt8]?]
    private var solvedCount = 0
    private var pending: [(indices: Set<Int>, data: [UInt8])] = []
    private let thresholds: [UInt32]

    public private(set) var framesSeen = 0

    public init(numBlocks: Int, blockSize: Int, totalLength: Int) {
        self.numBlocks = numBlocks
        self.blockSize = blockSize
        self.totalLength = totalLength
        self.solved = [[UInt8]?](repeating: nil, count: numBlocks)
        self.thresholds = Soliton.thresholds(k: numBlocks)
    }

    public var isComplete: Bool { solvedCount == numBlocks }

    /// Fraction of blocks recovered, 0...1.
    public var progress: Double {
        numBlocks == 0 ? 1 : Double(solvedCount) / Double(numBlocks)
    }

    public var blocksSolved: Int { solvedCount }

    /// Feed one frame. Returns true once the payload is fully recovered.
    @discardableResult
    public func addFrame(seed: UInt32, payload: [UInt8]) -> Bool {
        framesSeen += 1
        if isComplete { return true }
        guard payload.count == blockSize else { return false }

        var indices = Set(
            Soliton.selectBlocks(seed: seed, numBlocks: numBlocks, thresholds: thresholds)
        )
        var data = payload

        substituteKnown(&indices, &data)
        if indices.isEmpty { return isComplete }  // redundant frame

        if indices.count > 1 {
            pending.append((indices, data))
            return isComplete
        }

        var queue = [Int]()
        solve(indices, data, &queue)

        while let justSolved = queue.popLast() {
            guard let known = solved[justSolved] else { continue }
            var stillPending: [(indices: Set<Int>, data: [UInt8])] = []

            for var candidate in pending {
                if candidate.indices.contains(justSolved) {
                    xorInto(&candidate.data, known)
                    candidate.indices.remove(justSolved)
                }
                if candidate.indices.count == 1 {
                    solve(candidate.indices, candidate.data, &queue)
                } else if candidate.indices.count > 1 {
                    stillPending.append(candidate)
                }
                // count 0 means redundant; drop it
            }
            pending = stillPending
        }

        return isComplete
    }

    /// The recovered payload, or nil if still incomplete.
    public func result() -> [UInt8]? {
        guard isComplete else { return nil }

        var out = [UInt8](repeating: 0, count: totalLength)
        for i in 0..<numBlocks {
            guard let block = solved[i] else { return nil }
            let offset = i * blockSize
            let take = min(blockSize, totalLength - offset)
            if take > 0 {
                for j in 0..<take { out[offset + j] = block[j] }
            }
        }
        return out
    }

    // MARK: - private

    private func substituteKnown(_ indices: inout Set<Int>, _ data: inout [UInt8]) {
        for index in indices {
            if let known = solved[index] {
                xorInto(&data, known)
                indices.remove(index)
            }
        }
    }

    private func solve(_ indices: Set<Int>, _ data: [UInt8], _ queue: inout [Int]) {
        guard let index = indices.first, solved[index] == nil else { return }
        solved[index] = data
        solvedCount += 1
        queue.append(index)
    }

    private func xorInto(_ target: inout [UInt8], _ source: [UInt8]) {
        for i in 0..<target.count { target[i] ^= source[i] }
    }
}

/// Reassembles a stream of scanned QR payloads into a complete transfer.
///
/// Mirrors the browser scanner's `ingest`: base64url, frame parse, session
/// tracking, fountain decode, CRC verification.
public final class OpticalReceiver {
    private var decoder: FountainDecoder?
    private var header: FrameHeader?

    public init() {}

    public struct Progress: Sendable {
        public let header: FrameHeader
        public let blocksSolved: Int
        public let numBlocks: Int
        public let framesSeen: Int
        public let fraction: Double
    }

    public enum Outcome: Sendable {
        case ignored
        case progressed(Progress)
        case completed(payload: [UInt8], header: FrameHeader)
        case checksumMismatch
    }

    public func reset() {
        decoder = nil
        header = nil
    }

    /// Feed one decoded QR payload.
    public func ingest(text: String) -> Outcome {
        guard let bytes = Base64URL.decode(text) else { return .ignored }
        guard let frame = Frame.decode(bytes) else { return .ignored }

        // A different session means the sender restarted; follow it.
        if let current = header, !current.sameSession(as: frame.header) {
            reset()
        }

        if decoder == nil || header == nil {
            header = frame.header
            decoder = FountainDecoder(
                numBlocks: Int(frame.header.numBlocks),
                blockSize: Int(frame.header.blockSize),
                totalLength: Int(frame.header.totalLength)
            )
        }

        guard let decoder, let header else { return .ignored }

        let complete = decoder.addFrame(seed: frame.header.seed, payload: frame.payload)
        let progress = Progress(
            header: header,
            blocksSolved: decoder.blocksSolved,
            numBlocks: decoder.numBlocks,
            framesSeen: decoder.framesSeen,
            fraction: decoder.progress
        )

        guard complete, let payload = decoder.result() else {
            return .progressed(progress)
        }

        guard CRC32.compute(payload) == header.checksum else {
            reset()
            return .checksumMismatch
        }

        let completedHeader = header
        reset()
        return .completed(payload: payload, header: completedHeader)
    }
}
