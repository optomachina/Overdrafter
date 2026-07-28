import Foundation
import WebKit

@MainActor
final class WebWorkspaceSession {
    static let shared = WebWorkspaceSession()

    private let dataStore = WKWebsiteDataStore.default()

    private init() {}

    func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.applicationNameForUserAgent = "OverDrafter-iOS/\(applicationVersion)"
        return configuration
    }

    private var applicationVersion: String {
        guard
            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String,
            !version.isEmpty
        else {
            return "unknown"
        }

        return version
    }
}
