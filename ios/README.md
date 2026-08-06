# lightdb for iOS

A native receiver: point the phone at a laptop running the web app and watch the
database arrive over light.

```
ios/
├── LightDBKit/          Swift package: the protocol, Foundation-only
│   ├── Sources/         PRNG, protocolLog, soliton, frames, fountain, CRDT
│   └── Tests/           conformance against ../../spec/vectors
├── App/                 SwiftUI app: camera, Vision decoding, UI
└── LightDB.xcodeproj    app target, depends on the local package
```

## Why the split

`LightDBKit` imports nothing but Foundation — no AVFoundation, no Vision, no
SwiftUI. That keeps the protocol testable with plain `swift test`, no simulator
and no Xcode project involved, which is what makes the conformance suite cheap
enough to run on every push.

The camera and the UI live in `App/`, where they cannot be unit tested anyway.

## Running the tests

```sh
make test-ios        # or: cd ios/LightDBKit && swift test
```

This reads `spec/vectors/` — the same files the TypeScript suite reads — and
checks that this implementation agrees on the PRNG, `protocolLog` (bit for
bit), the soliton thresholds, block selection, CRC-32, frame encoding, and
whole recorded transmissions.

**That last one is the real test.** `streams.json` holds complete
fountain-coded transmissions produced by the TypeScript sender; Swift has to
reassemble the original payload from those frames alone. Everything else checks
one function in isolation. This checks the claim.

## Building the app

```sh
make build-ios
```

Needs Xcode with the iOS platform component installed
(Xcode → Settings → Components). The SDK stubs alone are not enough — without
the platform, `xcodebuild` reports no eligible destinations for any iOS
target, simulator included.

## Why native at all

The web app already receives, so this is not about parity. It is about the
ceiling the browser cannot reach:

| | Web | Native |
| --- | --- | --- |
| Decode | zxing-wasm, or `BarcodeDetector` on Chrome only | **Vision**, which handles blur and angle far better |
| Focus | not controllable; autofocus hunts and blurs frames | **AVFoundation** pins focus range and exposure |
| Resolution | whatever `getUserMedia` grants | explicit 1080p capture |

Continuous autofocus hunting is the single biggest cause of dropped frames when
reading an animated stream, and the web camera API gives no way to stop it.

## Scope

Receive-only, deliberately. The phone scans a laptop screen, which is the fast
direction anyway: a large bright display into a good camera sensor. Adding
transmission means a QR generator (`CIQRCodeGenerator` would do), a fountain
*encoder*, and peer version-vector tracking — each one another surface that has
to conform. Worth doing once the receive path is proven on real hardware.

## Changing the protocol

Do not edit the constants here by hand. `spec/PROTOCOL.md` is normative;
regenerate the vectors from the TypeScript implementation with `make vectors`,
bump `PROTOCOL_VERSION` on both sides in the same commit, and let the
conformance suites tell you whether the two still agree.

## Running on a real device

The simulator has no usable camera and cannot display to another device's
camera, so neither half of this app can be demonstrated there. A physical
phone is the only real test.

### First time

1. Open `ios/LightDB.xcodeproj` in Xcode.
2. Select the **LightDB** target → *Signing & Capabilities*.
3. Tick **Automatically manage signing** and pick your Apple ID under *Team*.
   A free personal team is enough; paid membership is not required.
4. Change the bundle identifier to something unique to you —
   `dev.lightdb.LightDB` will collide with anyone else who tries this. Something
   like `com.yourname.lightdb` is fine.
5. Plug the phone in, choose it as the destination, and run.
6. On the phone: *Settings → General → VPN & Device Management* → trust your
   developer certificate. The app will refuse to launch until you do.

Free personal teams expire after **7 days**, after which the app stops opening
and needs rebuilding from Xcode. A paid account extends that to a year.

### From the terminal, after the first run

```sh
xcrun devicectl list devices                  # find the device id
make run-device DEVICE_ID=<id>
```

Wireless install works once the phone has been paired over USB and *Connect via
network* is ticked in Xcode's Devices window.

### What to actually test

The provisioning path is the interesting one, because it exercises the Swift
*encoder* against the browser's decoder:

1. Open the web app on a laptop and go to **receive**.
2. On the phone, fill in a profile under **Provision** and hit transmit.
3. The laptop should show the `cfg/<profile>/...` records arriving.

That direction is proven byte-for-byte in `swiftEncoderReproducesTypeScriptFrames`,
but the optics are not — focus, glare, refresh-rate beating and rolling shutter
only show up on real hardware.
