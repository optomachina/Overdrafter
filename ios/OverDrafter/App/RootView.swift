import SwiftUI

struct RootView: View {
    @ObservedObject var appState: AppShellState
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                tabletLayout
            } else {
                phoneLayout
            }
        }
        .background(Color.overDrafterBackground)
        .tint(Color.overDrafterAccent)
        .onOpenURL(perform: appState.openDeepLink)
    }

    private var phoneLayout: some View {
        TabView(selection: $appState.selection) {
            ForEach(AppDestination.allCases) { destination in
                NavigationStack {
                    workspace(for: destination)
                }
                .tabItem {
                    Label(destination.title, systemImage: destination.systemImage)
                }
                .tag(destination)
            }
        }
    }

    private var tabletLayout: some View {
        NavigationSplitView {
            List {
                ForEach(AppDestination.allCases) { destination in
                    Button {
                        appState.selection = destination
                    } label: {
                        HStack {
                            Label(
                                destination.title.uppercased(),
                                systemImage: destination.systemImage
                            )
                            .font(.system(size: 12, weight: .medium, design: .monospaced))

                            Spacer()

                            if appState.selection == destination {
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(
                        appState.selection == destination
                            ? Color.overDrafterAccent
                            : Color.primary
                    )
                    .listRowBackground(
                        appState.selection == destination
                            ? Color.overDrafterAccent.opacity(0.12)
                            : Color.clear
                    )
                }
            }
            .navigationTitle("OVERDRAFTER")
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
            .scrollContentBackground(.hidden)
            .background(Color.overDrafterSurface)
        } detail: {
            ZStack {
                ForEach(AppDestination.allCases) { destination in
                    NavigationStack {
                        workspace(for: destination)
                    }
                    .opacity(appState.selection == destination ? 1 : 0)
                    .allowsHitTesting(appState.selection == destination)
                    .accessibilityHidden(appState.selection != destination)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private func workspace(for destination: AppDestination) -> some View {
        WebWorkspaceView(
            destination: destination,
            initialURL: appState.workspaceURL(for: destination),
            configuration: appState.configuration,
            pageState: appState.pageState(for: destination)
        )
    }
}

private extension Color {
    static let overDrafterBackground = Color(
        red: 242.0 / 255.0,
        green: 239.0 / 255.0,
        blue: 232.0 / 255.0
    )
    static let overDrafterSurface = Color(
        red: 251.0 / 255.0,
        green: 249.0 / 255.0,
        blue: 244.0 / 255.0
    )
    static let overDrafterAccent = Color(
        red: 194.0 / 255.0,
        green: 65.0 / 255.0,
        blue: 12.0 / 255.0
    )
}
