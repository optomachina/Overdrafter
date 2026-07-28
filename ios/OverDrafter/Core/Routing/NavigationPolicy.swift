import Foundation

enum WebNavigationDisposition: Equatable {
    case inApp
    case external
    case blocked
}

struct NavigationPolicy {
    let configuration: AppConfiguration

    func allowsEmbeddedNavigation(to url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else {
            return false
        }

        if scheme == "https" {
            return true
        }

        if scheme == "about" {
            return url.absoluteString == "about:blank"
        }

        if scheme == "blob" {
            let embeddedValue = String(url.absoluteString.dropFirst("blob:".count))
            guard let embeddedURL = URL(string: embeddedValue) else {
                return false
            }

            return allowsEmbeddedNavigation(to: embeddedURL)
        }

        return scheme == "http"
            && configuration.allowsInsecureLocalhost
            && url.isLocalDevelopmentURL
    }

    func disposition(for url: URL) -> WebNavigationDisposition {
        guard let scheme = url.scheme?.lowercased() else {
            return .blocked
        }

        if scheme == "about", url.absoluteString == "about:blank" {
            return .inApp
        }

        if scheme == "blob" {
            let embeddedValue = String(url.absoluteString.dropFirst("blob:".count))
            guard
                let embeddedURL = URL(string: embeddedValue),
                disposition(for: embeddedURL) == .inApp
            else {
                return .blocked
            }

            return .inApp
        }

        if scheme == "https" {
            return configuration.matchesConfiguredOrigin(url) ? .inApp : .external
        }

        if scheme == "http",
           configuration.allowsInsecureLocalhost,
           url.isLocalDevelopmentURL,
           configuration.matchesConfiguredOrigin(url) {
            return .inApp
        }

        return .blocked
    }
}
