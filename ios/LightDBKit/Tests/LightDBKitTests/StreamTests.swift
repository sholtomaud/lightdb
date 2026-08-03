import Foundation
import Testing

@testable import LightDBKit

/// End-to-end interop: the TypeScript sender encoded these streams, and this
/// Swift receiver has to reassemble them from the frames alone.
///
/// Every other vector file checks one function in isolation. This one is the
/// actual claim -- that a phone pointed at a laptop screen gets the bytes the
/// laptop meant to send.
private struct StreamVectors: Decodable {
    struct Case: Decodable {
        let totalLength: Int
        let blockSize: Int
        let numBlocks: Int
        let checksum: UInt32
        let payloadHex: String
        let frames: [String]
    }
    let protocolVersion: UInt8
    let cases: [Case]
}

private func bytes(fromHex string: String) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(string.count / 2)
    var index = string.startIndex
    while index < string.endIndex,
        let next = string.index(index, offsetBy: 2, limitedBy: string.endIndex)
    {
        out.append(UInt8(string[index..<next], radix: 16) ?? 0)
        index = next
    }
    return out
}

@Test func recordedStreamsReassembleToOriginalPayload() throws {
    let vectors = try Vectors.load("streams.json", as: StreamVectors.self)
    #expect(vectors.protocolVersion == Frame.protocolVersion)
    #expect(!vectors.cases.isEmpty)

    for testCase in vectors.cases {
        let decoder = FountainDecoder(
            numBlocks: testCase.numBlocks,
            blockSize: testCase.blockSize,
            totalLength: testCase.totalLength
        )

        var complete = false
        for text in testCase.frames {
            let raw = try #require(
                Base64URL.decode(text), "frame failed base64url decode")
            let frame = try #require(Frame.decode(raw), "frame failed to parse")

            complete = decoder.addFrame(seed: frame.header.seed, payload: frame.payload)
            if complete { break }
        }

        #expect(complete, "\(testCase.totalLength)B stream never completed")

        let payload = try #require(decoder.result())
        #expect(payload == bytes(fromHex: testCase.payloadHex), "payload mismatch")
        #expect(CRC32.compute(payload) == testCase.checksum, "checksum mismatch")
    }
}

/// The same streams through the full receiver, including session tracking and
/// CRC verification, as the app itself uses it.
@Test func opticalReceiverCompletesRecordedStreams() throws {
    let vectors = try Vectors.load("streams.json", as: StreamVectors.self)

    for testCase in vectors.cases {
        let receiver = OpticalReceiver()
        var completedPayload: [UInt8]?

        for text in testCase.frames {
            switch receiver.ingest(text: text) {
            case .completed(let payload, let header):
                completedPayload = payload
                #expect(header.checksum == testCase.checksum)
            case .checksumMismatch:
                Issue.record("checksum mismatch on \(testCase.totalLength)B stream")
            case .ignored, .progressed:
                continue
            }
            if completedPayload != nil { break }
        }

        let payload = try #require(
            completedPayload, "\(testCase.totalLength)B stream never completed")
        #expect(payload == bytes(fromHex: testCase.payloadHex))
    }
}

@Test func receiverIgnoresForeignAndCorruptInput() {
    let receiver = OpticalReceiver()

    for junk in ["", "not base64url!!!", "AAAA", "////", String(repeating: "A", count: 100)] {
        if case .completed = receiver.ingest(text: junk) {
            Issue.record("completed a transfer from junk input: \(junk)")
        }
    }
}

@Test func duplicateFramesAreHarmless() throws {
    let vectors = try Vectors.load("streams.json", as: StreamVectors.self)
    let testCase = vectors.cases[vectors.cases.count - 1]

    let decoder = FountainDecoder(
        numBlocks: testCase.numBlocks,
        blockSize: testCase.blockSize,
        totalLength: testCase.totalLength
    )

    // Feed everything twice, in reverse. Order and repetition must not matter.
    for text in testCase.frames.reversed() + testCase.frames.reversed() {
        guard let raw = Base64URL.decode(text), let frame = Frame.decode(raw) else { continue }
        _ = decoder.addFrame(seed: frame.header.seed, payload: frame.payload)
    }

    #expect(decoder.isComplete)
    let payload = try #require(decoder.result())
    #expect(payload == bytes(fromHex: testCase.payloadHex))
}
