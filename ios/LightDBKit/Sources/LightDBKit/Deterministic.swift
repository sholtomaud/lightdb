import Foundation

/// xorshift32, matching `makeRng` in the TypeScript implementation.
///
/// Sender and receiver never exchange which blocks a frame combines -- both
/// derive it from the frame's 32-bit seed. Every operation here has to produce
/// the same bits as its JavaScript counterpart or nothing interoperates.
public struct XorShift32 {
    private var state: UInt32

    public init(seed: UInt32) {
        // Zero is a fixed point of raw xorshift32.
        state = seed == 0 ? 0x9E37_79B9 : seed
    }

    public mutating func next() -> UInt32 {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return state
    }
}

public enum ProtocolMathError: Error, CustomStringConvertible {
    case domain(Double)

    public var description: String {
        switch self {
        case .domain(let x): return "protocolLog domain error: \(x)"
        }
    }
}

public enum ProtocolMath {
    /// ln(2) as IEEE-754 double 0x3FE62E42FEFA39EF.
    public static let ln2 = 0.6931471805599453

    /// Fixed so the result cannot vary by platform.
    static let logTerms = 20

    /// Natural log, specified by the protocol rather than taken from libm.
    ///
    /// `Foundation.log` and JavaScript's `Math.log` are both
    /// implementation-defined in their last ULP -- neither IEEE-754 nor the C
    /// standard requires correct rounding. Where that difference crosses a
    /// distribution boundary, Swift and JavaScript pick different block subsets
    /// from the same seed, and every transfer between them fails while both
    /// test suites stay green.
    ///
    /// Range reduction by powers of two is exact, and the series uses only
    /// IEEE-754 add, subtract, multiply and divide, which *are* correctly
    /// rounded. See spec/PROTOCOL.md section 3.
    public static func log(_ x: Double) throws -> Double {
        guard x.isFinite, x > 0 else { throw ProtocolMathError.domain(x) }

        var exponent = 0.0
        var mantissa = x
        while mantissa >= 2 {
            mantissa /= 2
            exponent += 1
        }
        while mantissa < 1 {
            mantissa *= 2
            exponent -= 1
        }

        // ln(m) = 2 * atanh(z), z = (m-1)/(m+1), so |z| < 1/3 here.
        let z = (mantissa - 1) / (mantissa + 1)
        let zSquared = z * z

        var term = z
        var sum = z
        for i in 1..<logTerms {
            term *= zSquared
            sum += term / Double(2 * i + 1)
        }

        return exponent * ln2 + 2 * sum
    }
}

public enum Soliton {
    /// Robust soliton distribution as cumulative 32-bit thresholds.
    ///
    /// Quantising here confines every floating-point decision to table
    /// construction; the per-frame sampling step is then pure integer
    /// comparison. See spec/PROTOCOL.md section 4.
    public static func thresholds(
        k: Int,
        c: Double = 0.05,
        delta: Double = 0.05
    ) -> [UInt32] {
        precondition(k >= 1, "block count must be positive")

        var probabilities = [Double](repeating: 0, count: k + 1)

        // Ideal soliton.
        probabilities[1] = 1 / Double(k)
        if k >= 2 {
            for i in 2...k {
                probabilities[i] = 1 / Double(i * (i - 1))
            }
        }

        // Robust component. squareRoot() is correctly rounded by IEEE-754, so
        // unlike log it is safe to use directly.
        // swiftlint:disable:next force_try
        let r = c * (try! ProtocolMath.log(Double(k) / delta)) * Double(k).squareRoot()
        let pivot = max(1, Int((Double(k) / r).rounded(.down)))

        var i = 1
        while i < pivot && i <= k {
            probabilities[i] += r / Double(i * k)
            i += 1
        }
        if pivot <= k {
            // swiftlint:disable:next force_try
            probabilities[pivot] += (r * (try! ProtocolMath.log(r / delta))) / Double(k)
        }

        // Accumulation order matters: it must match the JavaScript loop.
        var total = 0.0
        for i in 1...k { total += probabilities[i] }

        var thresholds = [UInt32](repeating: 0, count: k + 1)
        var running = 0.0
        for i in 1...k {
            running += probabilities[i] / total
            // Values are non-negative, so away-from-zero matches Math.round.
            let scaled = (running * Double(UInt32.max)).rounded(.toNearestOrAwayFromZero)
            let clamped = min(Double(UInt32.max), max(Double(thresholds[i - 1]), scaled))
            thresholds[i] = UInt32(clamped)
        }
        // Saturate, so no draw can fall past the last degree.
        thresholds[k] = UInt32.max

        return thresholds
    }

    /// First degree whose cumulative threshold covers the draw.
    public static func sampleDegree(
        _ rng: inout XorShift32,
        _ thresholds: [UInt32]
    ) -> Int {
        let u = rng.next()
        for i in 1..<thresholds.count where u <= thresholds[i] {
            return i
        }
        return thresholds.count - 1
    }

    /// Block indices a frame with this seed combines, ascending.
    ///
    /// Sorted rather than in insertion order, so agreement does not depend on
    /// two languages iterating a hash set alike.
    public static func selectBlocks(
        seed: UInt32,
        numBlocks: Int,
        thresholds: [UInt32]
    ) -> [Int] {
        var rng = XorShift32(seed: seed)
        let degree = min(sampleDegree(&rng, thresholds), numBlocks)

        var picked = Set<Int>()
        // Bounded so a pathological seed cannot spin forever.
        var remaining = degree * 64 + 64
        while picked.count < degree && remaining > 0 {
            // Multiply-shift, not modulo: no bias toward low indices, and the
            // 64-bit product is exact on both sides.
            let draw = UInt64(rng.next()) * UInt64(numBlocks)
            picked.insert(Int(draw / 0x1_0000_0000))
            remaining -= 1
        }

        var fill = 0
        while picked.count < degree {
            picked.insert(fill % numBlocks)
            fill += 1
        }

        return picked.sorted()
    }
}
