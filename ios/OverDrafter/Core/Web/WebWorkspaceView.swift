import SwiftUI

struct WebWorkspaceView: View {
    let destination: AppDestination
    let initialURL: URL
    let configuration: AppConfiguration

    @ObservedObject var pageState: WorkspacePageState
    @EnvironmentObject private var connectivity: ConnectivityMonitor

    var body: some View {
        ZStack {
            Color.overDrafterCanvas.ignoresSafeArea()

            WorkspaceWebView(
                initialURL: initialURL,
                configuration: configuration,
                pageState: pageState
            )

            if !pageState.hasLoadedContent, pageState.errorMessage == nil {
                initialLoadingView
            }

            if let errorMessage = pageState.errorMessage, !pageState.hasLoadedContent {
                failureView(message: errorMessage)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            statusRegion
        }
        .navigationTitle(destination.title.uppercased())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if pageState.hasLoadedContent, pageState.canGoBack {
                    Button(action: pageState.goBack) {
                        Image(systemName: "chevron.backward")
                    }
                    .accessibilityLabel("Back in \(destination.title)")
                }

                if pageState.hasLoadedContent || pageState.errorMessage != nil {
                    Button(action: pageState.reload) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload \(destination.title)")
                }
            }
        }
        .alert(
            "OverDrafter",
            isPresented: Binding(
                get: { pageState.alertMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        pageState.alertMessage = nil
                    }
                }
            )
        ) {
            Button("OK", role: .cancel) {
                pageState.alertMessage = nil
            }
        } message: {
            Text(pageState.alertMessage ?? "")
        }
    }

    @ViewBuilder
    private var statusRegion: some View {
        VStack(spacing: 0) {
            if !connectivity.isOnline {
                statusBanner(
                    text: "OFFLINE · SAVED CONTENT MAY REMAIN AVAILABLE",
                    systemImage: "wifi.slash"
                )
            } else if let errorMessage = pageState.errorMessage, pageState.hasLoadedContent {
                Button(action: pageState.reload) {
                    statusBanner(
                        text: "LOAD FAILED · TAP TO RETRY · \(errorMessage)",
                        systemImage: "arrow.clockwise"
                    )
                }
                .buttonStyle(.plain)
            }

            if pageState.isLoading {
                ProgressView(value: pageState.progress)
                    .progressViewStyle(.linear)
                    .tint(Color.overDrafterRed)
            }
        }
    }

    private func statusBanner(text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.overDrafterRule)
            .foregroundStyle(Color.overDrafterInk)
    }

    private var initialLoadingView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            Text("OVERDRAFTER")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .tracking(1.4)
                .foregroundStyle(Color.overDrafterRed)

            Text("OPENING \(destination.title.uppercased())")
                .font(.system(size: 25, weight: .semibold, design: .rounded))
                .tracking(-0.5)
                .padding(.top, 8)

            Text("Preparing your manufacturing workspace.")
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Color.overDrafterMuted)
                .padding(.top, 7)

            ProgressView(value: max(pageState.progress, 0.08))
                .progressViewStyle(.linear)
                .tint(Color.overDrafterRed)
                .padding(.top, 22)

            Spacer()
        }
        .frame(maxWidth: 440, alignment: .leading)
        .padding(.horizontal, 28)
        .background(Color.overDrafterCanvas.ignoresSafeArea())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Opening \(destination.title)")
    }

    private func failureView(message: String) -> some View {
        VStack(spacing: 18) {
            Image(systemName: connectivity.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                .font(.system(size: 28, weight: .light))

            Text(connectivity.isOnline ? "WORKSPACE UNAVAILABLE" : "NO NETWORK")
                .font(.system(size: 16, weight: .semibold, design: .monospaced))

            Text(message)
                .font(.system(size: 13, design: .monospaced))
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.overDrafterMuted)

            Button("RETRY", action: pageState.reload)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .buttonStyle(.borderedProminent)
                .tint(Color.overDrafterRed)
                .disabled(!connectivity.isOnline)
        }
        .padding(28)
        .frame(maxWidth: 420)
        .background(Color.overDrafterSurface)
        .overlay {
            Rectangle()
                .stroke(Color.overDrafterRule, lineWidth: 1)
        }
        .padding(24)
    }
}
