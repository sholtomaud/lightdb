import Foundation

/// CRC-32 (IEEE 802.3), reflected polynomial 0xEDB88320.
public enum CRC32 {
    private static let table: [UInt32] = {
        (0..<256).map { i -> UInt32 in
            var c = UInt32(i)
            for _ in 0..<8 {
                c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1
            }
            return c
        }
    }()

    public static func compute(_ data: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
    }
}

/// Unpadded base64url.
///
/// Native decoding could hand us raw bytes, but the web implementation cannot:
/// browser QR decoders return strings with a platform-dependent charset. Both
/// sides therefore encode base64url, or they do not interoperate.
public enum Base64URL {
    private static let alphabet = Array(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )

    private static let reverse: [Int8] = {
        var table = [Int8](repeating: -1, count: 128)
        for (index, character) in alphabet.enumerated() {
            table[Int(character.asciiValue!)] = Int8(index)
        }
        return table
    }()

    public static func encode(_ bytes: [UInt8]) -> String {
        var out = ""
        out.reserveCapacity((bytes.count * 4 + 2) / 3)

        var i = 0
        while i + 2 < bytes.count {
            let n = (Int(bytes[i]) << 16) | (Int(bytes[i + 1]) << 8) | Int(bytes[i + 2])
            out.append(alphabet[(n >> 18) & 63])
            out.append(alphabet[(n >> 12) & 63])
            out.append(alphabet[(n >> 6) & 63])
            out.append(alphabet[n & 63])
            i += 3
        }

        switch bytes.count - i {
        case 1:
            let n = Int(bytes[i]) << 16
            out.append(alphabet[(n >> 18) & 63])
            out.append(alphabet[(n >> 12) & 63])
        case 2:
            let n = (Int(bytes[i]) << 16) | (Int(bytes[i + 1]) << 8)
            out.append(alphabet[(n >> 18) & 63])
            out.append(alphabet[(n >> 12) & 63])
            out.append(alphabet[(n >> 6) & 63])
        default:
            break
        }

        return out
    }

    /// Returns nil on any character outside the alphabet, rather than guessing.
    public static func decode(_ text: String) -> [UInt8]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count % 4 == 1 { return nil }

        var out = [UInt8]()
        out.reserveCapacity(trimmed.count * 3 / 4)

        var accumulator = 0
        var bits = 0

        for character in trimmed.unicodeScalars {
            guard character.value < 128 else { return nil }
            let value = reverse[Int(character.value)]
            guard value >= 0 else { return nil }

            accumulator = (accumulator << 6) | Int(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((accumulator >> bits) & 0xFF))
            }
        }

        return out
    }
}

public struct FrameHeader: Equatable, Sendable {
    public var protocolVersion: UInt8
    public var flags: UInt8
    public var sessionId: UInt32
    public var totalLength: UInt32
    public var blockSize: UInt16
    public var numBlocks: UInt16
    public var seed: UInt32
    public var checksum: UInt32

    public init(
        protocolVersion: UInt8 = Frame.protocolVersion,
        flags: UInt8 = 0,
        sessionId: UInt32,
        totalLength: UInt32,
        blockSize: UInt16,
        numBlocks: UInt16,
        seed: UInt32,
        checksum: UInt32
    ) {
        self.protocolVersion = protocolVersion
        self.flags = flags
        self.sessionId = sessionId
        self.totalLength = totalLength
        self.blockSize = blockSize
        self.numBlocks = numBlocks
        self.seed = seed
        self.checksum = checksum
    }

    /// Two frames belong to the same transfer. The per-frame seed is excluded.
    public func sameSession(as other: FrameHeader) -> Bool {
        sessionId == other.sessionId
            && totalLength == other.totalLength
            && blockSize == other.blockSize
            && numBlocks == other.numBlocks
            && checksum == other.checksum
    }
}

public struct Frame: Sendable {
    public static let headerSize = 24
    public static let magic0: UInt8 = 0x4C  // 'L'
    public static let magic1: UInt8 = 0x44  // 'D'
    public static let protocolVersion: UInt8 = 2

    /// Payload was gzipped before block splitting.
    public static let flagGzip: UInt8 = 1 << 0

    public let header: FrameHeader
    public let payload: [UInt8]

    public init(header: FrameHeader, payload: [UInt8]) {
        self.header = header
        self.payload = payload
    }

    public static func encode(header: FrameHeader, payload: [UInt8]) -> [UInt8] {
        precondition(
            payload.count == Int(header.blockSize),
            "payload is \(payload.count) bytes, expected \(header.blockSize)"
        )

        var out = [UInt8]()
        out.reserveCapacity(headerSize + payload.count)

        out.append(magic0)
        out.append(magic1)
        out.append(header.protocolVersion)
        out.append(header.flags)
        out.append(contentsOf: bigEndian(header.sessionId))
        out.append(contentsOf: bigEndian(header.totalLength))
        out.append(contentsOf: bigEndian(header.blockSize))
        out.append(contentsOf: bigEndian(header.numBlocks))
        out.append(contentsOf: bigEndian(header.seed))
        out.append(contentsOf: bigEndian(header.checksum))
        out.append(contentsOf: payload)

        return out
    }

    /// Parse a frame, or nil if it is not one of ours.
    public static func decode(_ bytes: [UInt8]) -> Frame? {
        guard bytes.count >= headerSize else { return nil }
        guard bytes[0] == magic0, bytes[1] == magic1 else { return nil }
        guard bytes[2] == protocolVersion else { return nil }

        let blockSize = readUInt16(bytes, 12)
        let numBlocks = readUInt16(bytes, 14)
        guard blockSize > 0, numBlocks > 0 else { return nil }
        guard bytes.count >= headerSize + Int(blockSize) else { return nil }

        let header = FrameHeader(
            protocolVersion: bytes[2],
            flags: bytes[3],
            sessionId: readUInt32(bytes, 4),
            totalLength: readUInt32(bytes, 8),
            blockSize: blockSize,
            numBlocks: numBlocks,
            seed: readUInt32(bytes, 16),
            checksum: readUInt32(bytes, 20)
        )

        let payload = Array(bytes[headerSize..<(headerSize + Int(blockSize))])
        return Frame(header: header, payload: payload)
    }

    // MARK: - byte order

    private static func bigEndian(_ value: UInt32) -> [UInt8] {
        [
            UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF),
            UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF),
        ]
    }

    private static func bigEndian(_ value: UInt16) -> [UInt8] {
        [UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)]
    }

    private static func readUInt32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        (UInt32(bytes[offset]) << 24) | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8) | UInt32(bytes[offset + 3])
    }

    private static func readUInt16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
    }
}
