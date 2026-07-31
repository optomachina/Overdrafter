import SwiftUI
import WebKit

struct MobileAuthWebView: UIViewRepresentable {
    let action: MobileAuthWebAction
    let configuration: AppConfiguration
    let messageHandler: WKScriptMessageHandler
    let onNavigationFailure: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(
            frame: .zero,
            configuration: WebWorkspaceSession.shared.makeConfiguration(
                messageHandler: messageHandler
            )
        )
        webView.navigationDelegate = context.coordinator
        webView.load(action.request)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.actionID != action.id else { return }
        context.coordinator.actionID = action.id
        webView.load(action.request)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            actionID: action.id,
            configuration: configuration,
            onNavigationFailure: onNavigationFailure
        )
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var actionID: UUID
        private let configuration: AppConfiguration
        private let onNavigationFailure: () -> Void

        init(
            actionID: UUID,
            configuration: AppConfiguration,
            onNavigationFailure: @escaping () -> Void
        ) {
            self.actionID = actionID
            self.configuration = configuration
            self.onNavigationFailure = onNavigationFailure
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard
                let url = navigationAction.request.url,
                configuration.matchesConfiguredOrigin(url)
            else {
                decisionHandler(.cancel)
                onNavigationFailure()
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            onNavigationFailure()
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            onNavigationFailure()
        }
    }
}
