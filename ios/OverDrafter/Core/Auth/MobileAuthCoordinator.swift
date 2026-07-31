import AuthenticationServices
import Foundation
import UIKit
import WebKit

protocol MobileAuthBrowserSession: AnyObject {
    var presentationContextProvider: ASWebAuthenticationPresentationContextProviding? { get set }
    var prefersEphemeralWebBrowserSession: Bool { get set }
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: MobileAuthBrowserSession {}

protocol MobileAuthBrowserSessionFactory {
    func makeSession(
        url: URL,
        callback: ASWebAuthenticationSession.Callback,
        completion: @escaping ASWebAuthenticationSession.CompletionHandler
    ) -> MobileAuthBrowserSession
}

@MainActor
protocol MobileAuthWebsiteDataClearing {
    func clearAppOwnedData() async
}

extension WebWorkspaceSession: MobileAuthWebsiteDataClearing {}

struct SystemMobileAuthBrowserSessionFactory: MobileAuthBrowserSessionFactory {
    func makeSession(
        url: URL,
        callback: ASWebAuthenticationSession.Callback,
        completion: @escaping ASWebAuthenticationSession.CompletionHandler
    ) -> MobileAuthBrowserSession {
        ASWebAuthenticationSession(url: url, callback: callback, completionHandler: completion)
    }
}

enum MobileAuthPhase: Equatable {
    case checkingSession
    case signedOut
    case authenticating
    case bootstrapping
    case loggingOut
    case authenticated
}

struct MobileAuthWebAction: Identifiable {
    enum Kind {
        case probe
        case bootstrap
        case logout
    }

    let id = UUID()
    let kind: Kind
    let request: URLRequest
}

@MainActor
final class MobileAuthCoordinator: NSObject, ObservableObject {
    @Published private(set) var phase: MobileAuthPhase = .checkingSession
    @Published private(set) var webAction: MobileAuthWebAction?
    @Published private(set) var userMessage: String?
    @Published private(set) var sessionGeneration = UUID()
    @Published private(set) var returnRoute: String

    private let configuration: AppConfiguration
    private let browserSessionFactory: MobileAuthBrowserSessionFactory
    private let websiteDataClearer: MobileAuthWebsiteDataClearing
    private var browserSession: MobileAuthBrowserSession?
    private var activeAttempt: MobileAuthAttempt?
    private var hasStartedInitialProbe = false
    private var shouldStartEphemeralAfterLogout = false

    init(
        configuration: AppConfiguration,
        browserSessionFactory: MobileAuthBrowserSessionFactory = SystemMobileAuthBrowserSessionFactory(),
        websiteDataClearer: MobileAuthWebsiteDataClearing? = nil
    ) {
        self.configuration = configuration
        self.browserSessionFactory = browserSessionFactory
        self.websiteDataClearer = websiteDataClearer ?? WebWorkspaceSession.shared
        self.returnRoute = configuration.mobileAuthRoutes.defaultReturnPath
    }

    func restoreSessionIfNeeded() {
        guard !hasStartedInitialProbe else { return }
        hasStartedInitialProbe = true
        beginWebAction(.probe, request: configuration.nativeSessionRequest(action: "probe"))
        phase = .checkingSession
    }

    func continueSignIn(useAnotherAccount: Bool = false) {
        browserSession?.cancel()
        webAction = nil
        userMessage = nil

        do {
            let attempt = try MobileAuthAttempt.generate()
            let startURL = try configuration.mobileAuthStartURL(
                state: attempt.state,
                challenge: attempt.challenge,
                returnTo: configuration.mobileAuthRoutes.defaultReturnPath
            )
            guard let host = configuration.baseURL.host else {
                throw MobileAuthContractError.invalidConfiguration
            }

            activeAttempt = attempt
            phase = .authenticating
            let callback = ASWebAuthenticationSession.Callback.https(
                host: host,
                path: configuration.mobileAuthRoutes.callbackPath
            )
            let session = browserSessionFactory.makeSession(
                url: startURL,
                callback: callback
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.completeBrowserAuthentication(callbackURL: callbackURL, error: error)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = useAnotherAccount
            browserSession = session

            if !session.start() {
                failToWelcome(message: "Sign in could not be opened. Please try again.")
            }
        } catch {
            failToWelcome(message: "Sign in could not be prepared. Please try again.")
        }
    }

    func cancelSignIn() {
        browserSession?.cancel()
        discardAttempt()
        phase = .signedOut
        userMessage = nil
    }

    func logout() {
        shouldStartEphemeralAfterLogout = false
        phase = .loggingOut
        beginWebAction(.logout, request: configuration.nativeSessionRequest(action: "logout"))
    }

    func useAnotherAccount() {
        shouldStartEphemeralAfterLogout = true
        phase = .loggingOut
        beginWebAction(.logout, request: configuration.nativeSessionRequest(action: "logout"))
    }

    func webNavigationFailed() {
        guard webAction != nil else {
            return
        }

        if phase == .loggingOut {
            webAction = nil
            Task { @MainActor [weak self, websiteDataClearer] in
                await websiteDataClearer.clearAppOwnedData()
                guard let self, self.phase == .loggingOut else {
                    return
                }
                self.finishSignedOut(
                    message: "Signed out on this device. Server confirmation was unavailable."
                )
            }
            return
        }

        failToWelcome(message: "Check your connection and try again.")
    }

    func receive(
        _ message: MobileAuthWebMessage,
        origin: URL,
        isMainFrame: Bool
    ) {
        guard isMainFrame, configuration.matchesConfiguredOrigin(origin) else {
            return
        }

        switch message {
        case .authenticated where phase == .checkingSession:
            webAction = nil
            phase = .authenticated
        case .signedOut:
            finishSignedOut()
        case let .ready(state, returnTo) where phase == .bootstrapping:
            guard
                let attempt = activeAttempt,
                timingSafeEqual(state, attempt.state)
            else {
                failToWelcome(message: "Sign in expired. Please start again.")
                return
            }
            returnRoute = returnTo
            discardAttempt()
            webAction = nil
            phase = .authenticated
        case let .failure(state, code, retry):
            if let state, let attempt = activeAttempt, !timingSafeEqual(state, attempt.state) {
                failToWelcome(message: "Sign in expired. Please start again.")
                return
            }
            handleFailure(code: code, retry: retry)
        default:
            break
        }
    }

    private func completeBrowserAuthentication(callbackURL: URL?, error: Error?) {
        browserSession = nil

        if let nsError = error as NSError?,
           nsError.domain == ASWebAuthenticationSessionErrorDomain,
           nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
            discardAttempt()
            phase = .signedOut
            userMessage = nil
            return
        }

        guard let callbackURL, let attempt = activeAttempt else {
            failToWelcome(message: "Sign in did not complete. Please try again.")
            return
        }

        do {
            let payload = try MobileAuthCallbackPayload.parse(
                callbackURL,
                configuration: configuration,
                expectedState: attempt.state
            )
            phase = .bootstrapping
            beginWebAction(
                .bootstrap,
                request: configuration.mobileAuthBootstrapRequest(
                    code: payload.code,
                    state: payload.state,
                    verifier: attempt.verifier
                )
            )
        } catch MobileAuthContractError.stateMismatch {
            failToWelcome(message: "Sign in expired. Please start again.")
        } catch {
            failToWelcome(message: "The sign-in response was invalid. Please start again.")
        }
    }

    private func handleFailure(
        code: MobileAuthErrorCode,
        retry: MobileAuthRetryInstruction
    ) {
        if phase == .loggingOut || code == .logoutFailed {
            finishSignedOut(
                message: code == .logoutFailed
                    ? "Signed out on this device. Server confirmation was unavailable."
                    : nil
            )
            return
        }

        let message: String
        switch retry {
        case .network:
            message = "Check your connection and try again."
        case .later:
            message = "Sign in is temporarily unavailable. Try again later."
        case .restart:
            message = code == .providerFailed
                ? "The provider could not complete sign in. Try again or choose another account."
                : "Sign in expired. Please start again."
        case .none:
            message = "Sign in could not be completed."
        }
        failToWelcome(message: message)
    }

    private func finishSignedOut(message: String? = nil) {
        discardAttempt()
        webAction = nil
        sessionGeneration = UUID()
        phase = .signedOut
        userMessage = message

        if shouldStartEphemeralAfterLogout {
            shouldStartEphemeralAfterLogout = false
            continueSignIn(useAnotherAccount: true)
        }
    }

    private func failToWelcome(message: String) {
        discardAttempt()
        webAction = nil
        phase = .signedOut
        userMessage = message
    }

    private func discardAttempt() {
        activeAttempt = nil
        browserSession = nil
    }

    private func beginWebAction(_ kind: MobileAuthWebAction.Kind, request: URLRequest) {
        webAction = MobileAuthWebAction(kind: kind, request: request)
    }
}

extension MobileAuthCoordinator: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let foregroundScene = scenes.first { $0.activationState == .foregroundActive }
        let window = foregroundScene?.windows.first { $0.isKeyWindow }
            ?? foregroundScene?.windows.first
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
    }
}

extension MobileAuthCoordinator: WKScriptMessageHandler {
    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            message.name == WebWorkspaceSession.mobileAuthHandlerName,
            let parsed = MobileAuthWebMessage(body: message.body),
            let origin = mobileAuthOrigin(from: message.frameInfo.securityOrigin)
        else {
            return
        }

        receive(parsed, origin: origin, isMainFrame: message.frameInfo.isMainFrame)
    }
}

private func mobileAuthOrigin(from securityOrigin: WKSecurityOrigin) -> URL? {
    var components = URLComponents()
    components.scheme = securityOrigin.protocol
    components.host = securityOrigin.host
    if securityOrigin.port != 0 {
        components.port = securityOrigin.port
    }
    return components.url
}
