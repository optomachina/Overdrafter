import Foundation

struct DeepLinkTarget: Equatable {
    let destination: AppDestination
    let url: URL
}

enum DeepLinkRouter {
    static func target(
        for url: URL,
        configuration: AppConfiguration
    ) -> DeepLinkTarget? {
        let scheme = url.scheme?.lowercased()

        if scheme == "overdrafter" {
            return customSchemeTarget(for: url, configuration: configuration)
        }

        guard
            (scheme == "https" || scheme == "http"),
            configuration.matchesConfiguredOrigin(url),
            let destination = firstDestination(in: url.path)
        else {
            return nil
        }

        return DeepLinkTarget(
            destination: destination,
            url: addingIOSMarker(to: url)
        )
    }

    static func destination(
        for url: URL,
        configuration: AppConfiguration
    ) -> AppDestination? {
        target(for: url, configuration: configuration)?.destination
    }

    private static func customSchemeTarget(
        for url: URL,
        configuration: AppConfiguration
    ) -> DeepLinkTarget? {
        var routeComponents: [String] = []

        if let host = url.host, !host.isEmpty {
            routeComponents.append(host)
        }
        routeComponents.append(contentsOf: url.path.split(separator: "/").map(String.init))

        guard
            let destinationIndex = routeComponents.firstIndex(where: {
                AppDestination(routeComponent: $0) != nil
            }),
            let destination = AppDestination(routeComponent: routeComponents[destinationIndex])
        else {
            return nil
        }

        guard var components = URLComponents(
            url: configuration.baseURL,
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }

        let basePath = components.path
            .split(separator: "/")
            .map(String.init)
        let destinationPath = Array(routeComponents[destinationIndex...])
        components.path = "/\((basePath + destinationPath).joined(separator: "/"))"

        var queryItems = components.queryItems ?? []
        queryItems.append(contentsOf: URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        )?.queryItems ?? [])
        queryItems.removeAll { $0.name == "app" }
        queryItems.append(URLQueryItem(name: "app", value: "ios"))
        components.queryItems = queryItems
        components.fragment = url.fragment

        guard let targetURL = components.url else {
            return nil
        }

        return DeepLinkTarget(destination: destination, url: targetURL)
    }

    private static func addingIOSMarker(to url: URL) -> URL {
        guard var components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ) else {
            return url
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "app" }
        queryItems.append(URLQueryItem(name: "app", value: "ios"))
        components.queryItems = queryItems
        return components.url ?? url
    }

    private static func firstDestination(in path: String) -> AppDestination? {
        for component in path.split(separator: "/") {
            if let destination = AppDestination(routeComponent: String(component)) {
                return destination
            }
        }

        return nil
    }
}
