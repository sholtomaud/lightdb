import SwiftUI

@main
struct LightDBApp: App {
    var body: some Scene {
        WindowGroup {
            ReceiveView()
                .preferredColorScheme(.dark)
        }
    }
}
