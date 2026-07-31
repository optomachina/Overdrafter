import Foundation

struct MobileAuthRoutes: Equatable {
    static let production = MobileAuthRoutes(
        callbackPath: path("auth", "mobile", "callback"),
        startPath: path("auth", "mobile", "start"),
        bootstrapPath: path("auth", "mobile", "bootstrap"),
        nativeSessionPath: path("auth", "mobile", "native-session"),
        defaultReturnPath: path("quotes")
    )

    let callbackPath: String
    let startPath: String
    let bootstrapPath: String
    let nativeSessionPath: String
    let defaultReturnPath: String

    private static func path(_ components: String...) -> String {
        "/" + components.joined(separator: "/")
    }
}

struct AppConfiguration: Equatable {
    static let productionDefaultURL: URL = {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "overdrafter.vercel.app"
        guard let url = components.url else {
            preconditionFailure("Unable to construct the production OverDrafter URL.")
        }
        return url
    }()

    let baseURL: URL
    let allowsInsecureLocalhost: Bool
    let mobileAuthRoutes: MobileAuthRoutes

    static var current: AppConfiguration {
        load()
    }

    init(
        baseURL: URL,
        allowsInsecureLocalhost: Bool,
        mobileAuthRoutes: MobileAuthRoutes = .production
    ) {
        self.baseURL = baseURL
        self.allowsInsecureLocalhost = allowsInsecureLocalhost
        self.mobileAuthRoutes = mobileAuthRoutes
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

    func mobileAuthStartURL(
        state: String,
        challenge: String,
        returnTo: String
    ) throws -> URL {
        guard var components = originComponents(path: mobileAuthRoutes.startPath) else {
            throw MobileAuthContractError.invalidConfiguration
        }
        components.queryItems = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "return_to", value: returnTo),
        ]
        guard let url = components.url else {
            throw MobileAuthContractError.invalidConfiguration
        }
        return url
    }

    func mobileAuthBootstrapRequest(
        code: String,
        state: String,
        verifier: String
    ) -> URLRequest {
        guard
            let components = originComponents(path: mobileAuthRoutes.bootstrapPath),
            let url = components.url
        else {
            preconditionFailure("Validated OverDrafter auth origin could not be decomposed.")
        }
        var bodyComponents = URLComponents()
        bodyComponents.queryItems = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_verifier", value: verifier),
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 60
        request.setValue(
            "application/x-www-form-urlencoded; charset=utf-8",
            forHTTPHeaderField: "Content-Type"
        )
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        request.setValue("bootstrap-v1", forHTTPHeaderField: "X-OverDrafter-Mobile-Auth")
        request.httpBody = bodyComponents.percentEncodedQuery?.data(using: .utf8)
        return request
    }

    func nativeSessionRequest(action: String) -> URLRequest {
        guard var components = originComponents(path: mobileAuthRoutes.nativeSessionPath) else {
            preconditionFailure("Validated OverDrafter auth origin could not be decomposed.")
        }
        components.queryItems = [
            URLQueryItem(name: "app", value: "ios"),
            URLQueryItem(name: "action", value: action),
        ]
        guard let url = components.url else {
            preconditionFailure("Unable to build the OverDrafter session-control URL.")
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 60
        return request
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

    private func originComponents(path: String) -> URLComponents? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components
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
