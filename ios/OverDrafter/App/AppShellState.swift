import Foundation

@MainActor
final class AppShellState: ObservableObject {
    let configuration: AppConfiguration
    let authentication: MobileAuthCoordinator

    @Published var selection: AppDestination = .quotes
    @Published private var destinationURLs: [AppDestination: URL]

    private let pageStates: [AppDestination: WorkspacePageState]

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        authentication = MobileAuthCoordinator(configuration: configuration)
        destinationURLs = Dictionary(
            uniqueKeysWithValues: AppDestination.allCases.map { destination in
                (destination, configuration.workspaceURL(for: destination))
            }
        )
        pageStates = Dictionary(
            uniqueKeysWithValues: AppDestination.allCases.map { destination in
                (destination, WorkspacePageState())
            }
        )
    }

    func pageState(for destination: AppDestination) -> WorkspacePageState {
        guard let pageState = pageStates[destination] else {
            preconditionFailure("Missing web workspace state for \(destination.rawValue)")
        }

        return pageState
    }

    func workspaceURL(for destination: AppDestination) -> URL {
        destinationURLs[destination] ?? configuration.workspaceURL(for: destination)
    }

    func openDeepLink(_ url: URL) {
        guard let target = DeepLinkRouter.target(for: url, configuration: configuration) else {
            return
        }

        var updatedURLs = destinationURLs
        updatedURLs[target.destination] = target.url
        destinationURLs = updatedURLs
        selection = target.destination
    }

    func openAuthenticatedRoute(_ route: String) {
        guard let url = URL(string: route, relativeTo: configuration.baseURL)?.absoluteURL else {
            return
        }
        openDeepLink(url)
    }

    func resetWorkspaceState() {
        destinationURLs = Dictionary(
            uniqueKeysWithValues: AppDestination.allCases.map { destination in
                (destination, configuration.workspaceURL(for: destination))
            }
        )
        for pageState in pageStates.values {
            pageState.resetForNewSession()
        }
        selection = .quotes
    }
}
