import SwiftUI

@main
struct LightDBApp: App {
    /// One replica for the whole app. See AppState.
    @State private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
                .tint(Theme.accent)
        }
    }
}

/// Bottom tab navigation, in the shape people already know from Authenticator
/// and the Office apps: a small number of flat destinations, no nesting.
struct RootView: View {
    var body: some View {
        TabView {
            ProvisionView()
                .tabItem { Label("Provision", systemImage: "slider.horizontal.3") }

            ReceiveView()
                .tabItem { Label("Receive", systemImage: "camera.viewfinder") }

            RecordsView()
                .tabItem { Label("Records", systemImage: "list.bullet.rectangle") }
        }
    }
}

#Preview {
    RootView()
        .environment(AppState())
}
