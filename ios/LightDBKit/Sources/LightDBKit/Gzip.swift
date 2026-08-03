import Foundation

#if canImport(Compression)
    import Compression
#endif

public enum GzipError: Error, CustomStringConvertible {
    case notGzip
    case truncated
    case unsupportedMethod(UInt8)
    case inflateFailed
    case unavailable

    public var description: String {
        switch self {
        case .notGzip: return "not a gzip stream"
        case .truncated: return "gzip stream is truncated"
        case .unsupportedMethod(let m): return "unsupported compression method \(m)"
        case .inflateFailed: return "gzip inflate failed"
        case .unavailable: return "no gzip implementation on this platform"
        }
    }
}

/// Gzip inflate, for sync messages the web side compressed with
/// `CompressionStream('gzip')`.
///
/// Apple's `Compression` framework speaks raw DEFLATE (RFC 1951), while gzip is
/// that same stream wrapped in an RFC 1952 header and trailer. So the wrapper
/// is parsed here and only the DEFLATE body is handed over.
public enum Gzip {
    public static func inflate(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 18 else { throw GzipError.truncated }
        guard bytes[0] == 0x1F, bytes[1] == 0x8B else { throw GzipError.notGzip }
        guard bytes[2] == 0x08 else { throw GzipError.unsupportedMethod(bytes[2]) }

        let flags = bytes[3]
        var offset = 10

        // FEXTRA
        if flags & 0x04 != 0 {
            guard offset + 2 <= bytes.count else { throw GzipError.truncated }
            let extraLength = Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
            offset += 2 + extraLength
        }
        // FNAME, FCOMMENT: NUL-terminated strings
        for mask in [UInt8(0x08), UInt8(0x10)] where flags & mask != 0 {
            while offset < bytes.count && bytes[offset] != 0 { offset += 1 }
            offset += 1
        }
        // FHCRC
        if flags & 0x02 != 0 { offset += 2 }

        guard offset < bytes.count - 8 else { throw GzipError.truncated }

        let deflateBody = Array(bytes[offset..<(bytes.count - 8)])

        // Trailer: CRC-32 then uncompressed size, both little-endian.
        let trailer = bytes.suffix(8)
        let expectedCrc = UInt32(trailer[trailer.startIndex])
            | (UInt32(trailer[trailer.startIndex + 1]) << 8)
            | (UInt32(trailer[trailer.startIndex + 2]) << 16)
            | (UInt32(trailer[trailer.startIndex + 3]) << 24)
        let expectedSize = Int(
            UInt32(trailer[trailer.startIndex + 4])
                | (UInt32(trailer[trailer.startIndex + 5]) << 8)
                | (UInt32(trailer[trailer.startIndex + 6]) << 16)
                | (UInt32(trailer[trailer.startIndex + 7]) << 24)
        )

        let inflated = try rawInflate(deflateBody, expectedSize: expectedSize)

        guard CRC32.compute([UInt8](inflated)) == expectedCrc else {
            throw GzipError.inflateFailed
        }
        return inflated
    }

    #if canImport(Compression)
        private static func rawInflate(_ body: [UInt8], expectedSize: Int) throws -> Data {
            // ISIZE is modulo 2^32, so treat it as a hint and keep headroom.
            var capacity = max(expectedSize, body.count * 4, 1024)

            for _ in 0..<8 {
                var output = Data(count: capacity)
                let written = output.withUnsafeMutableBytes { destination -> Int in
                    guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress
                    else { return 0 }
                    return body.withUnsafeBufferPointer { source -> Int in
                        guard let sourceBase = source.baseAddress else { return 0 }
                        return compression_decode_buffer(
                            destinationBase, capacity,
                            sourceBase, body.count,
                            nil, COMPRESSION_ZLIB
                        )
                    }
                }

                if written > 0 && written < capacity {
                    return output.prefix(written)
                }
                // Filled the buffer exactly, or failed: retry with more room.
                if written == capacity && capacity >= expectedSize {
                    return output.prefix(written)
                }
                capacity *= 2
            }
            throw GzipError.inflateFailed
        }
    #else
        private static func rawInflate(_ body: [UInt8], expectedSize: Int) throws -> Data {
            throw GzipError.unavailable
        }
    #endif
}
