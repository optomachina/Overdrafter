import AuthenticationServices
import CryptoKit
import XCTest
@testable import OverDrafter

final class MobileAuthContractTests: XCTestCase {
    private let configuration = AppConfiguration(
        baseURL: URL(string: "https://overdrafter.vercel.app")!,
        allowsInsecureLocalhost: false
    )

    func testGeneratedAttemptUsesCanonicalSecretsAndS256Challenge() throws {
        let first = try MobileAuthAttempt.generate()
        let second = try MobileAuthAttempt.generate()

        XCTAssertCanonicalSecret(first.state)
        XCTAssertCanonicalSecret(first.verifier)
        XCTAssertCanonicalSecret(first.challenge)
        XCTAssertNotEqual(first.state, second.state)
        XCTAssertNotEqual(first.verifier, second.verifier)

        let digest = SHA256.hash(data: Data(first.verifier.utf8))
        let expectedChallenge = Data(digest)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(first.challenge, expectedChallenge)
    }

    func testCallbackParserAcceptsExactConfiguredCallback() throws {
        let state = canonicalSecret("s")
        let code = canonicalSecret("c")
        let callback = callbackURL(code: code, state: state)

        XCTAssertEqual(
            try MobileAuthCallbackPayload.parse(
                callback,
                configuration: configuration,
                expectedState: state
            ),
            MobileAuthCallbackPayload(code: code, state: state)
        )
    }

    func testCallbackParserRejectsWrongState() {
        let state = canonicalSecret("s")
        let callback = callbackURL(code: canonicalSecret("c"), state: state)

        XCTAssertThrowsError(
            try MobileAuthCallbackPayload.parse(
                callback,
                configuration: configuration,
                expectedState: canonicalSecret("x")
            )
        ) { error in
            XCTAssertEqual(error as? MobileAuthContractError, .stateMismatch)
        }
    }

    func testCallbackParserRejectsForeignOriginAndUnexpectedQuery() {
        let state = canonicalSecret("s")
        let code = canonicalSecret("c")
        let foreign = URL(
            string: "https://attacker.example/auth/mobile/callback#code=\(code)&state=\(state)"
        )!
        let queried = URL(
            string: "https://overdrafter.vercel.app/auth/mobile/callback?source=browser#code=\(code)&state=\(state)"
        )!

        assertInvalidCallback(foreign, expectedState: state)
        assertInvalidCallback(queried, expectedState: state)
    }

    func testCallbackParserRejectsPercentEncodedPaths() {
        let state = canonicalSecret("s")
        let code = canonicalSecret("c")
        let encodedPaths = [
            "/auth/mobile/%63allback",
            "/auth/mobile/callback%2F",
        ]

        for path in encodedPaths {
            let callback = URL(
                string: "https://overdrafter.vercel.app\(path)#code=\(code)&state=\(state)"
            )!
            assertInvalidCallback(callback, expectedState: state)
        }
    }

    func testCallbackParserRejectsDuplicateFields() {
        let state = canonicalSecret("s")
        let code = canonicalSecret("c")
        let duplicate = URL(
            string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state=\(state)&state=\(state)"
        )!

        assertInvalidCallback(duplicate, expectedState: state)
    }

    func testCallbackParserRejectsPercentEncodedFields() {
        let state = canonicalSecret("s")
        let encodedCode = "%63" + String(repeating: "c", count: 42)
        let encoded = URL(
            string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(encodedCode)&state=\(state)"
        )!

        assertInvalidCallback(encoded, expectedState: state)
    }

    func testCallbackParserRejectsMalformedFragment() {
        let state = canonicalSecret("s")
        let code = canonicalSecret("c")
        let callbacks = [
            URL(
                string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state"
            )!,
            URL(
                string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)"
            )!,
            URL(
                string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state=\(String(repeating: "s", count: 42))"
            )!,
            URL(
                string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state=\(state)&provider=github"
            )!,
        ]

        for callback in callbacks {
            assertInvalidCallback(callback, expectedState: state)
        }
    }

    func testBootstrapRequestKeepsCredentialsInFormBodyOnly() throws {
        let code = canonicalSecret("c")
        let state = canonicalSecret("s")
        let verifier = canonicalSecret("v")

        let request = configuration.mobileAuthBootstrapRequest(
            code: code,
            state: state,
            verifier: verifier
        )

        XCTAssertEqual(
            request.url?.absoluteString,
            "https://overdrafter.vercel.app/auth/mobile/bootstrap"
        )
        XCTAssertNil(request.url?.query)
        XCTAssertFalse(request.url?.absoluteString.contains(code) ?? true)
        XCTAssertFalse(request.url?.absoluteString.contains(state) ?? true)
        XCTAssertFalse(request.url?.absoluteString.contains(verifier) ?? true)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "application/x-www-form-urlencoded; charset=utf-8"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/html")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "X-OverDrafter-Mobile-Auth"),
            "bootstrap-v1"
        )

        let body = try XCTUnwrap(request.httpBody)
        let bodyText = try XCTUnwrap(String(data: body, encoding: .utf8))
        let bodyComponents = try XCTUnwrap(URLComponents(string: "?\(bodyText)"))
        let values = Dictionary(
            uniqueKeysWithValues: (bodyComponents.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
        XCTAssertEqual(
            values,
            [
                "v": "1",
                "code": code,
                "state": state,
                "code_verifier": verifier,
            ]
        )
    }

    func testNativeSessionMessagesRemainCredentialFreeAndVersioned() {
        XCTAssertEqual(
            MobileAuthWebMessage(
                body: [
                    "version": 1,
                    "status": "authenticated",
                ]
            ),
            .authenticated
        )
        XCTAssertEqual(
            MobileAuthWebMessage(
                body: [
                    "version": 1,
                    "status": "error",
                    "code": "mobile_auth_network_failed",
                ]
            ),
            .failure(state: nil, code: .networkFailed, retry: .network)
        )
        XCTAssertNil(
            MobileAuthWebMessage(
                body: [
                    "version": 1,
                    "status": "authenticated",
                    "access_token": "must-not-be-accepted",
                ]
            )
        )
        XCTAssertNil(
            MobileAuthWebMessage(
                body: [
                    "version": 2,
                    "status": "signed_out",
                ]
            )
        )
    }

    func testBootstrapReadyMessageRejectsUnapprovedReturnRoute() {
        XCTAssertNil(
            MobileAuthWebMessage(
                body: [
                    "version": 1,
                    "status": "ready",
                    "state": canonicalSecret("s"),
                    "returnTo": "/admin",
                ]
            )
        )
    }

    private func assertInvalidCallback(
        _ callback: URL,
        expectedState: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try MobileAuthCallbackPayload.parse(
                callback,
                configuration: configuration,
                expectedState: expectedState
            ),
            file: file,
            line: line
        ) { error in
            XCTAssertEqual(
                error as? MobileAuthContractError,
                .invalidCallback,
                file: file,
                line: line
            )
        }
    }

    private func callbackURL(code: String, state: String) -> URL {
        URL(
            string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state=\(state)"
        )!
    }

    private func XCTAssertCanonicalSecret(
        _ value: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(value.utf8.count, 43, file: file, line: line)
        XCTAssertTrue(
            value.unicodeScalars.allSatisfy { scalar in
                scalar.value >= 48 && scalar.value <= 57
                    || scalar.value >= 65 && scalar.value <= 90
                    || scalar.value >= 97 && scalar.value <= 122
                    || scalar == "_"
                    || scalar == "-"
            },
            file: file,
            line: line
        )
    }
}

@MainActor
final class MobileAuthCoordinatorTests: XCTestCase {
    private let configuration = AppConfiguration(
        baseURL: URL(string: "https://overdrafter.vercel.app")!,
        allowsInsecureLocalhost: false
    )

    func testBrowserCancellationReturnsQuietlyToWelcome() async throws {
        let factory = FakeMobileAuthBrowserSessionFactory()
        let coordinator = MobileAuthCoordinator(
            configuration: configuration,
            browserSessionFactory: factory
        )

        coordinator.continueSignIn()
        XCTAssertEqual(coordinator.phase, .authenticating)
        XCTAssertTrue(factory.session.didStart)

        factory.complete(
            error: NSError(
                domain: ASWebAuthenticationSessionErrorDomain,
                code: ASWebAuthenticationSessionError.canceledLogin.rawValue
            )
        )
        await drainMainActor()

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertNil(coordinator.userMessage)
        XCTAssertNil(coordinator.webAction)
    }

    func testSuccessfulCallbackBootstrapsThenAuthenticates() async throws {
        let factory = FakeMobileAuthBrowserSessionFactory()
        let coordinator = MobileAuthCoordinator(
            configuration: configuration,
            browserSessionFactory: factory
        )

        coordinator.continueSignIn()
        let startURL = try XCTUnwrap(factory.startURL)
        let state = try XCTUnwrap(queryValue("state", in: startURL))
        let code = canonicalSecret("c")

        factory.complete(url: callbackURL(code: code, state: state))
        await drainMainActor()

        XCTAssertEqual(coordinator.phase, .bootstrapping)
        let action = try XCTUnwrap(coordinator.webAction)
        guard case .bootstrap = action.kind else {
            XCTFail("Expected a bootstrap web action.")
            return
        }
        XCTAssertEqual(
            action.request.url?.absoluteString,
            "https://overdrafter.vercel.app/auth/mobile/bootstrap"
        )
        XCTAssertFalse(action.request.url?.absoluteString.contains(code) ?? true)
        XCTAssertFalse(action.request.url?.absoluteString.contains(state) ?? true)

        coordinator.receive(
            .ready(state: state, returnTo: "/quotes/Q-7K4P9M"),
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .authenticated)
        XCTAssertEqual(coordinator.returnRoute, "/quotes/Q-7K4P9M")
        XCTAssertNil(coordinator.webAction)
    }

    func testProviderErrorReturnsSpecificRetryMessage() async throws {
        let factory = FakeMobileAuthBrowserSessionFactory()
        let coordinator = MobileAuthCoordinator(
            configuration: configuration,
            browserSessionFactory: factory
        )

        coordinator.continueSignIn()
        let state = try XCTUnwrap(queryValue("state", in: XCTUnwrap(factory.startURL)))
        factory.complete(url: callbackURL(code: canonicalSecret("c"), state: state))
        await drainMainActor()

        coordinator.receive(
            .failure(
                state: state,
                code: .providerFailed,
                retry: .restart
            ),
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertEqual(
            coordinator.userMessage,
            "The provider could not complete sign in. Try again or choose another account."
        )
        XCTAssertNil(coordinator.webAction)
    }

    func testRestoreAcceptsAuthenticatedSession() {
        let coordinator = MobileAuthCoordinator(configuration: configuration)

        coordinator.restoreSessionIfNeeded()
        XCTAssertEqual(coordinator.phase, .checkingSession)
        if let action = coordinator.webAction {
            guard case .probe = action.kind else {
                XCTFail("Expected a session probe web action.")
                return
            }
        } else {
            XCTFail("Expected a session probe web action.")
        }

        coordinator.receive(
            .authenticated,
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .authenticated)
        XCTAssertNil(coordinator.webAction)
    }

    func testRestoreRejectsSignedOutSessionAndRotatesGeneration() {
        let coordinator = MobileAuthCoordinator(configuration: configuration)
        let generation = coordinator.sessionGeneration

        coordinator.restoreSessionIfNeeded()
        coordinator.receive(
            .signedOut,
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertNotEqual(coordinator.sessionGeneration, generation)
        XCTAssertNil(coordinator.webAction)
    }

    func testLogoutClearsNativeSessionAndRotatesGeneration() {
        let coordinator = authenticatedCoordinator()
        let generation = coordinator.sessionGeneration

        coordinator.logout()
        XCTAssertEqual(coordinator.phase, .loggingOut)
        if let action = coordinator.webAction {
            guard case .logout = action.kind else {
                XCTFail("Expected a logout web action.")
                return
            }
        } else {
            XCTFail("Expected a logout web action.")
        }
        coordinator.receive(
            .signedOut,
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertNotEqual(coordinator.sessionGeneration, generation)
        XCTAssertNil(coordinator.webAction)
    }

    func testWorkspaceLogoutFailureStillDestroysNativeSession() {
        let coordinator = authenticatedCoordinator()

        coordinator.receive(
            .failure(
                state: nil,
                code: .logoutFailed,
                retry: .restart
            ),
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertEqual(
            coordinator.userMessage,
            "Signed out on this device. Server confirmation was unavailable."
        )
        XCTAssertNil(coordinator.webAction)
    }

    func testLogoutNavigationFailurePurgesAppOwnedWebData() async {
        let websiteDataClearer = FakeMobileAuthWebsiteDataClearer()
        let coordinator = MobileAuthCoordinator(
            configuration: configuration,
            websiteDataClearer: websiteDataClearer
        )
        coordinator.restoreSessionIfNeeded()
        coordinator.receive(
            .authenticated,
            origin: configuration.baseURL,
            isMainFrame: true
        )

        coordinator.logout()
        coordinator.webNavigationFailed()
        await drainMainActor()

        XCTAssertEqual(websiteDataClearer.clearCount, 1)
        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertEqual(
            coordinator.userMessage,
            "Signed out on this device. Server confirmation was unavailable."
        )
        XCTAssertNil(coordinator.webAction)
    }

    func testUseAnotherAccountLogsOutThenStartsEphemeralSession() {
        let factory = FakeMobileAuthBrowserSessionFactory()
        let coordinator = MobileAuthCoordinator(
            configuration: configuration,
            browserSessionFactory: factory
        )
        coordinator.restoreSessionIfNeeded()
        coordinator.receive(
            .authenticated,
            origin: configuration.baseURL,
            isMainFrame: true
        )
        let generation = coordinator.sessionGeneration

        coordinator.useAnotherAccount()
        XCTAssertEqual(coordinator.phase, .loggingOut)
        coordinator.receive(
            .signedOut,
            origin: configuration.baseURL,
            isMainFrame: true
        )

        XCTAssertEqual(coordinator.phase, .authenticating)
        XCTAssertNotEqual(coordinator.sessionGeneration, generation)
        XCTAssertTrue(factory.session.prefersEphemeralWebBrowserSession)
        XCTAssertTrue(factory.session.didStart)
    }

    private func authenticatedCoordinator() -> MobileAuthCoordinator {
        let coordinator = MobileAuthCoordinator(configuration: configuration)
        coordinator.restoreSessionIfNeeded()
        coordinator.receive(
            .authenticated,
            origin: configuration.baseURL,
            isMainFrame: true
        )
        return coordinator
    }

    private func queryValue(_ name: String, in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == name }?
            .value
    }

    private func callbackURL(code: String, state: String) -> URL {
        URL(
            string: "https://overdrafter.vercel.app/auth/mobile/callback#code=\(code)&state=\(state)"
        )!
    }

    private func drainMainActor() async {
        await Task.yield()
        await Task.yield()
    }
}

private final class FakeMobileAuthBrowserSession: MobileAuthBrowserSession {
    weak var presentationContextProvider: ASWebAuthenticationPresentationContextProviding?
    var prefersEphemeralWebBrowserSession = false
    private(set) var didStart = false
    private(set) var didCancel = false

    func start() -> Bool {
        didStart = true
        return true
    }

    func cancel() {
        didCancel = true
    }
}

private final class FakeMobileAuthBrowserSessionFactory: MobileAuthBrowserSessionFactory {
    let session = FakeMobileAuthBrowserSession()
    private(set) var startURL: URL?
    private var completion: ASWebAuthenticationSession.CompletionHandler?

    func makeSession(
        url: URL,
        callback: ASWebAuthenticationSession.Callback,
        completion: @escaping ASWebAuthenticationSession.CompletionHandler
    ) -> MobileAuthBrowserSession {
        startURL = url
        self.completion = completion
        return session
    }

    func complete(url: URL? = nil, error: Error? = nil) {
        completion?(url, error)
    }
}

@MainActor
private final class FakeMobileAuthWebsiteDataClearer: MobileAuthWebsiteDataClearing {
    private(set) var clearCount = 0

    func clearAppOwnedData() async {
        clearCount += 1
    }
}

private func canonicalSecret(_ character: Character) -> String {
    String(repeating: String(character), count: 43)
}
