// swift-tools-version: 6.0
import PackageDescription

// LightDBKit is deliberately Foundation-only: no AVFoundation, no Vision, no
// SwiftUI. That keeps the protocol implementation testable with `swift test`
// on any platform, and keeps the conformance suite runnable without a
// simulator. Camera and UI live in the app target instead.
let package = Package(
    name: "LightDBKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LightDBKit", targets: ["LightDBKit"])
    ],
    targets: [
        .target(name: "LightDBKit"),
        .testTarget(name: "LightDBKitTests", dependencies: ["LightDBKit"]),
    ]
)
