import Foundation

struct AppConfiguration: Equatable {
    static let productionDefaultURL = URL(string: "https://overdrafter.vercel.app")!

    let baseURL: URL
    let allowsInsecureLocalhost: Bool

    static var current: AppConfiguration {
        load()
    }

    init(baseURL: URL, allowsInsecureLocalhost: Bool) {
        self.baseURL = baseURL
        self.allowsInsecureLocalhost = allowsInsecureLocalhost
    }

    func workspaceURL(for destination: AppDestination) -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            preconditionFailure("Validated OverDrafter base URL could not be decomposed.")
        }

        let basePath = components.path
            .split(separator: "/")
            .map(String.init)
            .joined(separator: "/")
        let destinationPath = destination.routePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/\([basePath, destinationPath].filter { !$0.isEmpty }.joined(separator: "/"))"

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "app" }
        queryItems.append(URLQueryItem(name: "app", value: "ios"))
        components.queryItems = queryItems
        components.fragment = nil

        guard let url = components.url else {
            preconditionFailure("Unable to build URL for \(destination.rawValue).")
        }

        return url
    }

    func matchesConfiguredOrigin(_ url: URL) -> Bool {
        guard
            let configuredScheme = baseURL.scheme?.lowercased(),
            let configuredHost = baseURL.host?.lowercased(),
            let candidateScheme = url.scheme?.lowercased(),
            let candidateHost = url.host?.lowercased()
        else {
            return false
        }

        return configuredScheme == candidateScheme
            && configuredHost == candidateHost
            && effectivePort(for: baseURL) == effectivePort(for: url)
    }

    static func load(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppConfiguration {
        let allowsInsecureLocalhost: Bool
#if DEBUG
        allowsInsecureLocalhost = true
#else
        allowsInsecureLocalhost = false
#endif

        let candidates = [
            environment["OVERDRAFTER_BASE_URL"],
            bundle.object(forInfoDictionaryKey: "OverDrafterBaseURL") as? String,
            productionDefaultURL.absoluteString,
        ]

        for candidate in candidates {
            guard
                let candidate,
                let url = URL(string: candidate.trimmingCharacters(in: .whitespacesAndNewlines)),
                isAllowedBaseURL(url, allowsInsecureLocalhost: allowsInsecureLocalhost)
            else {
                continue
            }

            return AppConfiguration(
                baseURL: url,
                allowsInsecureLocalhost: allowsInsecureLocalhost
            )
        }

        return AppConfiguration(
            baseURL: productionDefaultURL,
            allowsInsecureLocalhost: allowsInsecureLocalhost
        )
    }

    private static func isAllowedBaseURL(
        _ url: URL,
        allowsInsecureLocalhost: Bool
    ) -> Bool {
        guard let scheme = url.scheme?.lowercased(), url.host != nil else {
            return false
        }

        if scheme == "https" {
            return true
        }

        return scheme == "http"
            && allowsInsecureLocalhost
            && url.isLocalDevelopmentURL
    }

    private func effectivePort(for url: URL) -> Int? {
        if let port = url.port {
            return port
        }

        switch url.scheme?.lowercased() {
        case "https":
            return 443
        case "http":
            return 80
        default:
            return nil
        }
    }
}

extension URL {
    var isLocalDevelopmentURL: Bool {
        guard let host = host?.lowercased() else {
            return false
        }

        return host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
    }
}
