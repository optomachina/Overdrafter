import SwiftUI
import WebKit

struct WorkspaceWebView: UIViewRepresentable {
    let initialURL: URL
    let configuration: AppConfiguration
    let pageState: WorkspacePageState

    func makeCoordinator() -> Coordinator {
        Coordinator(
            initialURL: initialURL,
            configuration: configuration,
            pageState: pageState
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(
            frame: .zero,
            configuration: WebWorkspaceSession.shared.makeConfiguration()
        )
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.alwaysBounceVertical = true

        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(
            context.coordinator,
            action: #selector(Coordinator.refresh(_:)),
            for: .valueChanged
        )
        webView.scrollView.refreshControl = refreshControl

        context.coordinator.installObservers(on: webView)
        pageState.attach(webView: webView)
        context.coordinator.loadInitialPage(in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.updateInitialURL(initialURL, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.teardown()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    // Sonar S7485 reviewed: every navigation action and response is checked below.
    // Main-frame content is confined to the configured origin; other HTTPS links
    // leave the app, and unsupported schemes are blocked.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIDocumentPickerDelegate { // NOSONAR
        private var initialURL: URL
        private let policy: NavigationPolicy
        private let pageState: WorkspacePageState

        private weak var webView: WKWebView?
        private var observations: [NSKeyValueObservation] = []
        private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]
        private var downloadDestinations: [ObjectIdentifier: URL] = [:]
        private weak var exportPicker: UIDocumentPickerViewController?
        private var exportedTemporaryURLs: [URL] = []

        init(
            initialURL: URL,
            configuration: AppConfiguration,
            pageState: WorkspacePageState
        ) {
            self.initialURL = initialURL
            policy = NavigationPolicy(configuration: configuration)
            self.pageState = pageState
        }

        func installObservers(on webView: WKWebView) {
            self.webView = webView
            observations = [
                webView.observe(\.estimatedProgress, options: [.new]) { [weak self, weak webView] _, _ in
                    DispatchQueue.main.async {
                        self?.publishState(from: webView)
                    }
                },
                webView.observe(\.isLoading, options: [.new]) { [weak self, weak webView] _, _ in
                    DispatchQueue.main.async {
                        self?.publishState(from: webView)
                    }
                },
                webView.observe(\.canGoBack, options: [.new]) { [weak self, weak webView] _, _ in
                    DispatchQueue.main.async {
                        self?.publishState(from: webView)
                    }
                },
            ]
        }

        func loadInitialPage(in webView: WKWebView) {
            guard webView.url == nil else {
                return
            }

            webView.load(
                URLRequest(
                    url: initialURL,
                    cachePolicy: .useProtocolCachePolicy,
                    timeoutInterval: 60
                )
            )
        }

        func updateInitialURL(_ url: URL, in webView: WKWebView) {
            guard url != initialURL else {
                return
            }

            initialURL = url
            webView.load(URLRequest(url: url, timeoutInterval: 60))
        }

        func teardown() {
            observations.removeAll()
            cleanupExportedFiles()
            for download in activeDownloads.values {
                download.delegate = nil
                download.cancel { _ in }
            }
            for destination in downloadDestinations.values {
                try? FileManager.default.removeItem(at: destination)
            }
            activeDownloads.removeAll()
            downloadDestinations.removeAll()
        }

        @objc func refresh(_ sender: UIRefreshControl) {
            guard let webView else {
                sender.endRefreshing()
                return
            }

            webView.reload()
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
            pageState.navigationStarted()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            webView.scrollView.refreshControl?.endRefreshing()
            pageState.navigationFinished()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            webView.scrollView.refreshControl?.endRefreshing()
            pageState.navigationFailed(error)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            webView.scrollView.refreshControl?.endRefreshing()
            pageState.navigationFailed(error)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            if navigationAction.targetFrame?.isMainFrame == false {
                if policy.allowsEmbeddedNavigation(to: url) {
                    decisionHandler(.allow)
                } else {
                    decisionHandler(.cancel)
                    pageState.alertMessage = "Blocked an unsafe embedded link."
                }
                return
            }

            switch policy.disposition(for: url) {
            case .inApp:
                if navigationAction.shouldPerformDownload {
                    decisionHandler(.download)
                } else {
                    decisionHandler(.allow)
                }
            case .external:
                decisionHandler(.cancel)
                openExternalURL(url)
            case .blocked:
                decisionHandler(.cancel)
                pageState.alertMessage = "Blocked an unsafe or unsupported link: \(url.absoluteString)"
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            guard let url = navigationResponse.response.url else {
                decisionHandler(.cancel)
                return
            }

            if !navigationResponse.isForMainFrame {
                if policy.allowsEmbeddedNavigation(to: url), navigationResponse.canShowMIMEType {
                    decisionHandler(.allow)
                } else {
                    decisionHandler(.cancel)
                }
                return
            }

            switch policy.disposition(for: url) {
            case .inApp:
                decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
            case .external:
                decisionHandler(.cancel)
                openExternalURL(url)
            case .blocked:
                decisionHandler(.cancel)
                pageState.alertMessage = "Blocked an unsafe or unsupported response."
            }
        }

        func webView(
            _ webView: WKWebView,
            navigationAction: WKNavigationAction,
            didBecome download: WKDownload
        ) {
            retain(download)
        }

        func webView(
            _ webView: WKWebView,
            navigationResponse: WKNavigationResponse,
            didBecome download: WKDownload
        ) {
            retain(download)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard let url = navigationAction.request.url else {
                return nil
            }

            switch policy.disposition(for: url) {
            case .inApp:
                webView.load(navigationAction.request)
            case .external:
                openExternalURL(url)
            case .blocked:
                pageState.alertMessage = "Blocked an unsafe or unsupported link: \(url.absoluteString)"
            }

            return nil
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping (URL?) -> Void
        ) {
            let identifier = ObjectIdentifier(download)
            let safeName = sanitizedFilename(suggestedFilename)
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("OverDrafterDownloads", isDirectory: true)

            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                let destination = directory.appendingPathComponent(
                    "\(UUID().uuidString)-\(safeName)"
                )
                downloadDestinations[identifier] = destination
                completionHandler(destination)
            } catch {
                release(download)
                completionHandler(nil)
                pageState.alertMessage = "The download could not be prepared."
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            let identifier = ObjectIdentifier(download)
            guard let destination = downloadDestinations.removeValue(forKey: identifier) else {
                release(download)
                return
            }

            release(download)
            presentExporter(for: destination)
        }

        func download(
            _ download: WKDownload,
            didFailWithError error: Error,
            resumeData: Data?
        ) {
            let identifier = ObjectIdentifier(download)
            if let destination = downloadDestinations.removeValue(forKey: identifier) {
                try? FileManager.default.removeItem(at: destination)
            }
            release(download)
            pageState.alertMessage = "Download failed: \(error.localizedDescription)"
        }

        func documentPicker(
            _ controller: UIDocumentPickerViewController,
            didPickDocumentsAt urls: [URL]
        ) {
            if controller === exportPicker {
                exportPicker = nil
                cleanupExportedFiles()
            }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            if controller === exportPicker {
                exportPicker = nil
                cleanupExportedFiles()
            }
        }

        private func publishState(from webView: WKWebView?) {
            guard let webView else {
                return
            }

            pageState.update(
                isLoading: webView.isLoading,
                progress: webView.estimatedProgress,
                canGoBack: webView.canGoBack
            )
        }

        private func retain(_ download: WKDownload) {
            download.delegate = self
            activeDownloads[ObjectIdentifier(download)] = download
        }

        private func release(_ download: WKDownload) {
            activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        }

        private func presentExporter(for url: URL) {
            exportedTemporaryURLs = [url]
            let picker = UIDocumentPickerViewController(
                forExporting: [url],
                asCopy: true
            )
            picker.delegate = self
            exportPicker = picker

            guard present(picker) else {
                exportPicker = nil
                cleanupExportedFiles()
                pageState.alertMessage = "The downloaded file could not be exported."
                return
            }
        }

        private func cleanupExportedFiles() {
            for url in exportedTemporaryURLs {
                try? FileManager.default.removeItem(at: url)
            }
            exportedTemporaryURLs.removeAll()
        }

        private func openExternalURL(_ url: URL) {
            UIApplication.shared.open(url, options: [:]) { [weak self] opened in
                if !opened {
                    self?.pageState.alertMessage = "The external link could not be opened."
                }
            }
        }

        private func present(_ controller: UIViewController) -> Bool {
            guard
                let root = webView?.window?.rootViewController,
                let presenter = topViewController(from: root)
            else {
                return false
            }

            presenter.present(controller, animated: true)
            return true
        }

        private func topViewController(from root: UIViewController) -> UIViewController? {
            if let presented = root.presentedViewController {
                return topViewController(from: presented)
            }

            if let navigation = root as? UINavigationController {
                return navigation.visibleViewController.flatMap(topViewController(from:))
            }

            if let tab = root as? UITabBarController {
                return tab.selectedViewController.flatMap(topViewController(from:))
            }

            return root
        }

        private func sanitizedFilename(_ filename: String) -> String {
            let sanitized = filename
                .replacingOccurrences(of: "/", with: "-")
                .replacingOccurrences(of: "\\", with: "-")
                .replacingOccurrences(of: "..", with: "-")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            return sanitized.isEmpty ? "OverDrafter-download" : sanitized
        }
    }
}
