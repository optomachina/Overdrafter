import Foundation
import WebKit

@MainActor
final class WebWorkspaceSession {
    static let shared = WebWorkspaceSession()
    static let mobileAuthHandlerName = "mobileAuth"

    private let dataStore = WKWebsiteDataStore.default()

    private init() {}

    func makeConfiguration(
        messageHandler: WKScriptMessageHandler? = nil
    ) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.applicationNameForUserAgent = "OverDrafter-iOS/\(applicationVersion)"
        if let messageHandler {
            configuration.userContentController.add(
                messageHandler,
                name: Self.mobileAuthHandlerName
            )
        }
        return configuration
    }

    func clearAppOwnedData() async {
        await withCheckedContinuation { continuation in
            dataStore.removeData(
                ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                modifiedSince: .distantPast
            ) {
                continuation.resume()
            }
        }
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
