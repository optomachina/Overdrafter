import SwiftUI

struct RootView: View {
    @ObservedObject var appState: AppShellState
    @ObservedObject private var authentication: MobileAuthCoordinator
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(appState: AppShellState) {
        self.appState = appState
        authentication = appState.authentication
    }

    var body: some View {
        ZStack {
            Group {
                switch authentication.phase {
                case .authenticated:
                    authenticatedLayout
                        .id(authentication.sessionGeneration)
                case .signedOut:
                    welcomeView
                case .authenticating:
                    progressView(
                        title: "SIGNING IN",
                        detail: "Complete sign in in the secure browser window.",
                        allowsCancellation: true
                    )
                case .checkingSession:
                    progressView(
                        title: "RESTORING SESSION",
                        detail: "Checking this device for an existing OverDrafter session."
                    )
                case .bootstrapping:
                    progressView(
                        title: "FINISHING SIGN IN",
                        detail: "Preparing your secure workspace."
                    )
                case .loggingOut:
                    progressView(
                        title: "SIGNING OUT",
                        detail: "Clearing this app's OverDrafter session."
                    )
                }
            }

            if let action = authentication.webAction {
                MobileAuthWebView(
                    action: action,
                    configuration: appState.configuration,
                    messageHandler: authentication,
                    onNavigationFailure: authentication.webNavigationFailed
                )
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .accessibilityHidden(true)
            }
        }
        .background(Color.overDrafterBackground)
        .tint(Color.overDrafterAccent)
        .onOpenURL(perform: appState.openDeepLink)
        .task {
            authentication.restoreSessionIfNeeded()
        }
        .onChange(of: authentication.returnRoute) { _, route in
            appState.openAuthenticatedRoute(route)
        }
        .onChange(of: authentication.sessionGeneration) { _, _ in
            appState.resetWorkspaceState()
        }
    }

    @ViewBuilder
    private var authenticatedLayout: some View {
        if horizontalSizeClass == .regular {
            tabletLayout
        } else {
            phoneLayout
        }
    }

    private var phoneLayout: some View {
        TabView(selection: $appState.selection) {
            ForEach(AppDestination.allCases) { destination in
                NavigationStack {
                    workspace(for: destination)
                        .toolbar {
                            accountToolbar
                        }
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
                            : Color.overDrafterInk
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
                            .toolbar {
                                accountToolbar
                            }
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
            mobileAuthHandler: authentication,
            pageState: appState.pageState(for: destination)
        )
    }

    @ToolbarContentBuilder
    private var accountToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button {
                    authentication.useAnotherAccount()
                } label: {
                    Label("Use Another Account", systemImage: "person.2")
                }

                Button(role: .destructive) {
                    authentication.logout()
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Image(systemName: "person.crop.circle")
            }
            .accessibilityLabel("Account")
        }
    }

    private var welcomeView: some View {
        VStack(spacing: 28) {
            Spacer()

            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 76, weight: .ultraLight))
                .foregroundStyle(Color.overDrafterAccent)
                .accessibilityHidden(true)

            VStack(spacing: 10) {
                Text("OVERDRAFTER")
                    .font(.system(size: 25, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Color.overDrafterInk)

                Text("Upload parts, compare quotes, and move manufacturing forward.")
                    .font(.system(size: 15))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.overDrafterMuted)
                    .frame(maxWidth: 340)
            }

            if let message = authentication.userMessage {
                Text(message)
                    .font(.system(size: 13, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.overDrafterAccent)
                    .frame(maxWidth: 360)
                    .accessibilityIdentifier("mobile-auth-error")
            }

            Spacer()

            Button {
                authentication.continueSignIn()
            } label: {
                Text("CONTINUE")
                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 28)
            .accessibilityIdentifier("mobile-auth-continue")

            Text("Sign in opens OverDrafter's secure website. Your password is never entered into this app.")
                .font(.system(size: 11, design: .monospaced))
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.overDrafterMuted)
                .padding(.horizontal, 32)
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.overDrafterBackground)
    }

    private func progressView(
        title: String,
        detail: String,
        allowsCancellation: Bool = false
    ) -> some View {
        VStack(spacing: 20) {
            ProgressView()
                .controlSize(.large)

            Text(title)
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.overDrafterInk)

            Text(detail)
                .font(.system(size: 13))
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.overDrafterMuted)
                .frame(maxWidth: 340)

            if allowsCancellation {
                Button("CANCEL", action: authentication.cancelSignIn)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .buttonStyle(.bordered)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.overDrafterBackground)
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
    static let overDrafterInk = Color(
        red: 28.0 / 255.0,
        green: 27.0 / 255.0,
        blue: 25.0 / 255.0
    )
    static let overDrafterMuted = Color(
        red: 107.0 / 255.0,
        green: 102.0 / 255.0,
        blue: 92.0 / 255.0
    )
}
