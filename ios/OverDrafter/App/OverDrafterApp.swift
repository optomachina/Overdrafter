import SwiftUI

@main
struct OverDrafterApp: App {
    @StateObject private var appState = AppShellState(configuration: .current)
    @StateObject private var connectivity = ConnectivityMonitor()

    var body: some Scene {
        WindowGroup {
            RootView(appState: appState)
                .environmentObject(connectivity)
        }
    }
}
