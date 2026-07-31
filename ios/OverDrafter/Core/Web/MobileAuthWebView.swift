import SwiftUI
import WebKit

struct MobileAuthNavigationPolicy {
    let configuration: AppConfiguration
    let allowedRequest: URLRequest

    func allows(_ request: URLRequest, targetIsMainFrame: Bool) -> Bool {
        guard
            targetIsMainFrame,
            let candidateURL = request.url,
            let allowedURL = allowedRequest.url,
            configuration.matchesConfiguredOrigin(candidateURL),
            candidateURL.absoluteString == allowedURL.absoluteString
        else {
            return false
        }

        return normalizedMethod(request.httpMethod) == normalizedMethod(allowedRequest.httpMethod)
    }

    private func normalizedMethod(_ method: String?) -> String {
        method?.uppercased() ?? "GET"
    }
}

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
        context.coordinator.policy = MobileAuthNavigationPolicy(
            configuration: configuration,
            allowedRequest: action.request
        )
        webView.load(action.request)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            actionID: action.id,
            policy: MobileAuthNavigationPolicy(
                configuration: configuration,
                allowedRequest: action.request
            ),
            onNavigationFailure: onNavigationFailure
        )
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var actionID: UUID
        var policy: MobileAuthNavigationPolicy
        private let onNavigationFailure: () -> Void

        init(
            actionID: UUID,
            policy: MobileAuthNavigationPolicy,
            onNavigationFailure: @escaping () -> Void
        ) {
            self.actionID = actionID
            self.policy = policy
            self.onNavigationFailure = onNavigationFailure
        }

        func webView(
            _: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard policy.allows(
                navigationAction.request,
                targetIsMainFrame: navigationAction.targetFrame?.isMainFrame == true
            ) else {
                decisionHandler(.cancel)
                onNavigationFailure()
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _: WKWebView,
            didFailProvisionalNavigation _: WKNavigation?,
            withError _: Error
        ) {
            onNavigationFailure()
        }

        func webView(
            _: WKWebView,
            didFail _: WKNavigation?,
            withError _: Error
        ) {
            onNavigationFailure()
        }
    }
}
