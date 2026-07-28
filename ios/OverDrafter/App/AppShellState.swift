import Foundation

@MainActor
final class AppShellState: ObservableObject {
    let configuration: AppConfiguration

    @Published var selection: AppDestination = .parts
    @Published private var destinationURLs: [AppDestination: URL]

    private let pageStates: [AppDestination: WorkspacePageState]

    init(configuration: AppConfiguration) {
        self.configuration = configuration
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
}
