import Foundation
import Testing

@testable import LightDBKit

/// Conformance against spec/vectors/ -- the same files the TypeScript suite
/// reads.
///
/// This is the only thing that actually guarantees a phone and a laptop can
/// talk. Everything else verifies that each implementation is self-consistent,
/// which is exactly the failure mode to worry about: two internally coherent
/// implementations that disagree about what a seed means.
enum Vectors {
    static let directory: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // LightDBKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // LightDBKit
        .deletingLastPathComponent()  // ios
        .deletingLastPathComponent()  // repo root
        .appendingPathComponent("spec/vectors")

    static func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Big-endian bit pattern of a binary64, so a mismatch is unambiguous rather
/// than an argument about decimal rounding.
private func doubleBits(_ value: Double) -> String {
    let pattern = value.bitPattern.bigEndian
    return withUnsafeBytes(of: pattern) { buffer in
        buffer.map { String(format: "%02x", $0) }.joined()
    }
}

private func hex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

private func bytes(fromHex string: String) -> [UInt8] {
    var out = [UInt8]()
    var index = string.startIndex
    while index < string.endIndex,
        let next = string.index(index, offsetBy: 2, limitedBy: string.endIndex)
    {
        out.append(UInt8(string[index..<next], radix: 16) ?? 0)
        index = next
    }
    return out
}

// MARK: - PRNG

private struct PrngVectors: Decodable {
    struct Case: Decodable {
        let seed: UInt32
        let outputs: [UInt32]
    }
    let cases: [Case]
}

@Test func prngMatchesVectors() throws {
    let vectors = try Vectors.load("prng.json", as: PrngVectors.self)
    #expect(!vectors.cases.isEmpty)

    for testCase in vectors.cases {
        var rng = XorShift32(seed: testCase.seed)
        let actual = testCase.outputs.map { _ in rng.next() }
        #expect(actual == testCase.outputs, "seed \(testCase.seed)")
    }
}

// MARK: - protocolLog

private struct LogVectors: Decodable {
    struct Case: Decodable {
        let inputBits: String
        let input: Double
        let outputBits: String
    }
    let ln2Bits: String
    let cases: [Case]
}

@Test func protocolLogMatchesVectorsBitForBit() throws {
    let vectors = try Vectors.load("log.json", as: LogVectors.self)
    #expect(doubleBits(ProtocolMath.ln2) == vectors.ln2Bits)

    for testCase in vectors.cases {
        #expect(
            doubleBits(testCase.input) == testCase.inputBits,
            "input \(testCase.input) is not the stored double"
        )
        let actual = try ProtocolMath.log(testCase.input)
        #expect(
            doubleBits(actual) == testCase.outputBits,
            "protocolLog(\(testCase.input)) = \(actual), bits \(doubleBits(actual))"
        )
    }
}

@Test func protocolLogRejectsDomainErrors() {
    #expect(throws: ProtocolMathError.self) { try ProtocolMath.log(0) }
    #expect(throws: ProtocolMathError.self) { try ProtocolMath.log(-1) }
    #expect(throws: ProtocolMathError.self) { try ProtocolMath.log(.nan) }
    #expect(throws: ProtocolMathError.self) { try ProtocolMath.log(.infinity) }
}

// MARK: - thresholds

private struct ThresholdVectors: Decodable {
    struct Case: Decodable {
        let k: Int
        let thresholds: [UInt32]
    }
    let cases: [Case]
}

@Test func solitonThresholdsMatchVectors() throws {
    let vectors = try Vectors.load("thresholds.json", as: ThresholdVectors.self)
    #expect(!vectors.cases.isEmpty)

    for testCase in vectors.cases {
        let actual = Soliton.thresholds(k: testCase.k)
        #expect(actual == testCase.thresholds, "k=\(testCase.k)")
    }
}

// MARK: - block selection

private struct SelectionVectors: Decodable {
    struct Case: Decodable {
        let numBlocks: Int
        let seed: UInt32
        let indices: [Int]
    }
    let cases: [Case]
}

@Test func blockSelectionMatchesVectors() throws {
    let vectors = try Vectors.load("selection.json", as: SelectionVectors.self)
    #expect(vectors.cases.count > 100, "expected a dense selection vector set")

    var tables = [Int: [UInt32]]()
    for testCase in vectors.cases {
        let thresholds: [UInt32]
        if let cached = tables[testCase.numBlocks] {
            thresholds = cached
        } else {
            thresholds = Soliton.thresholds(k: testCase.numBlocks)
            tables[testCase.numBlocks] = thresholds
        }

        let actual = Soliton.selectBlocks(
            seed: testCase.seed,
            numBlocks: testCase.numBlocks,
            thresholds: thresholds
        )
        #expect(
            actual == testCase.indices,
            "numBlocks=\(testCase.numBlocks) seed=\(testCase.seed)"
        )
    }
}

// MARK: - CRC-32

private struct Crc32Vectors: Decodable {
    struct TextCase: Decodable {
        let text: String
        let crc: UInt32
    }
    struct ByteCase: Decodable {
        let bytesHex: String
        let crc: UInt32
    }
    let cases: [TextCase]
    let byteCases: [ByteCase]
}

@Test func crc32MatchesVectors() throws {
    let vectors = try Vectors.load("crc32.json", as: Crc32Vectors.self)

    for testCase in vectors.cases {
        let data = [UInt8](testCase.text.utf8)
        #expect(CRC32.compute(data) == testCase.crc, "text \(testCase.text)")
    }
    for testCase in vectors.byteCases {
        #expect(
            CRC32.compute(bytes(fromHex: testCase.bytesHex)) == testCase.crc,
            "bytes \(testCase.bytesHex.prefix(16))"
        )
    }
}

// MARK: - frames

private struct FrameVectors: Decodable {
    struct Header: Decodable {
        let protocolVersion: UInt8
        let flags: UInt8
        let sessionId: UInt32
        let totalLength: UInt32
        let blockSize: UInt16
        let numBlocks: UInt16
        let seed: UInt32
        let checksum: UInt32
    }
    struct Case: Decodable {
        let header: Header
        let payloadHex: String
        let encodedHex: String
        let encodedBase64Url: String
    }
    let protocolVersion: UInt8
    let cases: [Case]
}

@Test func frameEncodingMatchesVectors() throws {
    let vectors = try Vectors.load("frames.json", as: FrameVectors.self)
    #expect(
        vectors.protocolVersion == Frame.protocolVersion,
        "vectors are stale: regenerate with `make vectors`"
    )

    for testCase in vectors.cases {
        let header = FrameHeader(
            protocolVersion: testCase.header.protocolVersion,
            flags: testCase.header.flags,
            sessionId: testCase.header.sessionId,
            totalLength: testCase.header.totalLength,
            blockSize: testCase.header.blockSize,
            numBlocks: testCase.header.numBlocks,
            seed: testCase.header.seed,
            checksum: testCase.header.checksum
        )
        let payload = bytes(fromHex: testCase.payloadHex)
        let encoded = Frame.encode(header: header, payload: payload)

        #expect(hex(encoded) == testCase.encodedHex, "session \(header.sessionId)")
        #expect(
            Base64URL.encode(encoded) == testCase.encodedBase64Url,
            "session \(header.sessionId)"
        )

        // And the round trip back through the parser.
        let decoded = try #require(Frame.decode(encoded))
        #expect(decoded.header == header)
        #expect(decoded.payload == payload)

        let viaText = try #require(Base64URL.decode(testCase.encodedBase64Url))
        #expect(viaText == encoded)
    }
}
