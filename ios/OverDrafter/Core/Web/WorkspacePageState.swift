import Foundation
import WebKit

@MainActor
final class WorkspacePageState: ObservableObject {
    @Published private(set) var isLoading = true
    @Published private(set) var progress = 0.0
    @Published private(set) var canGoBack = false
    @Published private(set) var hasLoadedContent = false
    @Published var errorMessage: String?
    @Published var alertMessage: String?

    private weak var webView: WKWebView?

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    func update(isLoading: Bool, progress: Double, canGoBack: Bool) {
        self.isLoading = isLoading
        self.progress = progress
        self.canGoBack = canGoBack
    }

    func navigationStarted() {
        isLoading = true
        errorMessage = nil
    }

    func navigationFinished() {
        isLoading = false
        progress = 1
        hasLoadedContent = true
        errorMessage = nil
        canGoBack = webView?.canGoBack ?? false
    }

    func navigationFailed(_ error: Error) {
        let nsError = error as NSError
        guard nsError.code != NSURLErrorCancelled else {
            return
        }

        isLoading = false
        errorMessage = nsError.localizedDescription
    }

    func reload() {
        errorMessage = nil
        webView?.reload()
    }

    func goBack() {
        guard webView?.canGoBack == true else {
            return
        }

        webView?.goBack()
    }
}
