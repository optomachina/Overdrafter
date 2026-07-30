import XCTest
@testable import OverDrafter

final class RoutingTests: XCTestCase {
    private let production = AppConfiguration(
        baseURL: URL(string: "https://overdrafter.vercel.app")!,
        allowsInsecureLocalhost: false
    )

    func testWorkspaceURLsUseDestinationAndIOSMarker() {
        XCTAssertEqual(
            production.workspaceURL(for: .parts).absoluteString,
            "https://overdrafter.vercel.app/parts?app=ios"
        )
        XCTAssertEqual(
            production.workspaceURL(for: .quotes).absoluteString,
            "https://overdrafter.vercel.app/quotes?app=ios"
        )
        XCTAssertEqual(
            production.workspaceURL(for: .search).absoluteString,
            "https://overdrafter.vercel.app/search?app=ios"
        )
    }

    func testConfigurationLoaderPrefersAValidSecureEnvironmentOverride() {
        let configuration = AppConfiguration.load(
            environment: [
                "OVERDRAFTER_BASE_URL": "https://preview.overdrafter.example/base"
            ]
        )

        XCTAssertEqual(
            configuration.baseURL.absoluteString,
            "https://preview.overdrafter.example/base"
        )
    }

    func testConfigurationLoaderRejectsUnsafeEnvironmentOverrides() {
        let configuration = AppConfiguration.load(
            environment: [
                "OVERDRAFTER_BASE_URL": "javascript:alert(1)"
            ]
        )

        XCTAssertEqual(configuration.baseURL.scheme, "https")
        XCTAssertNotEqual(configuration.baseURL.scheme, "javascript")
    }

#if DEBUG
    func testConfigurationLoaderAllowsExplicitLocalDebugOrigin() {
        let configuration = AppConfiguration.load(
            environment: [
                "OVERDRAFTER_BASE_URL": "http://localhost:8080"
            ]
        )

        XCTAssertEqual(
            configuration.baseURL.absoluteString,
            "http://localhost:8080"
        )
        XCTAssertTrue(configuration.allowsInsecureLocalhost)
    }
#endif

    @MainActor
    func testWebWorkspaceUserAgentUsesBundleMarketingVersion() {
        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String

        XCTAssertEqual(
            WebWorkspaceSession.shared.makeConfiguration().applicationNameForUserAgent,
            "OverDrafter-iOS/\(version ?? "unknown")"
        )
    }

    func testConfiguredHTTPSHostStaysInsideApp() {
        let policy = NavigationPolicy(configuration: production)

        XCTAssertEqual(
            policy.disposition(for: URL(string: "https://overdrafter.vercel.app/quotes/7K4P9M")!),
            .inApp
        )
    }

    func testExternalHTTPSHostLeavesApp() {
        let policy = NavigationPolicy(configuration: production)

        XCTAssertEqual(
            policy.disposition(for: URL(string: "https://supplier.example/quote/42")!),
            .external
        )
    }

    func testEmbeddedNavigationAllowsSecureThirdPartyFramesButBlocksUnsafeSchemes() {
        let policy = NavigationPolicy(configuration: production)

        XCTAssertTrue(
            policy.allowsEmbeddedNavigation(
                to: URL(string: "https://js.stripe.com/v3/elements-inner-card.html")!
            )
        )
        XCTAssertTrue(
            policy.allowsEmbeddedNavigation(
                to: URL(string: "blob:https://js.stripe.com/4b3887f5-25ff-4b7a-83f0-a9836d17d9b8")!
            )
        )
        XCTAssertFalse(
            policy.allowsEmbeddedNavigation(to: URL(string: "javascript:alert(1)")!)
        )
        XCTAssertFalse(
            policy.allowsEmbeddedNavigation(to: URL(string: "file:///tmp/private")!)
        )
    }

    func testUnsafeSchemesAreBlocked() {
        let policy = NavigationPolicy(configuration: production)

        XCTAssertEqual(
            policy.disposition(for: URL(string: "http://overdrafter.vercel.app/parts")!),
            .blocked
        )
        XCTAssertEqual(
            policy.disposition(for: URL(string: "javascript:alert(1)")!),
            .blocked
        )
        XCTAssertEqual(
            policy.disposition(for: URL(string: "file:///tmp/private")!),
            .blocked
        )
    }

    func testExplicitLocalDebugOriginCanUseHTTP() {
        let local = AppConfiguration(
            baseURL: URL(string: "http://localhost:8080")!,
            allowsInsecureLocalhost: true
        )
        let policy = NavigationPolicy(configuration: local)

        XCTAssertEqual(
            policy.disposition(for: URL(string: "http://localhost:8080/search?app=ios")!),
            .inApp
        )
        XCTAssertEqual(
            policy.disposition(for: URL(string: "http://127.0.0.1:8080/search?app=ios")!),
            .blocked
        )
    }

    func testCustomSchemeRoutesDestinations() {
        XCTAssertEqual(
            DeepLinkRouter.destination(
                for: URL(string: "overdrafter://parts")!,
                configuration: production
            ),
            .parts
        )
        XCTAssertEqual(
            DeepLinkRouter.destination(
                for: URL(string: "overdrafter:///quotes/7K4P9M")!,
                configuration: production
            ),
            .quotes
        )
        XCTAssertEqual(
            DeepLinkRouter.destination(
                for: URL(string: "overdrafter://search")!,
                configuration: production
            ),
            .search
        )
    }

    func testCustomSchemePreservesDetailQueryAndFragment() {
        let target = DeepLinkRouter.target(
            for: URL(string: "overdrafter:///quotes/7K4P9M?source=email#offers")!,
            configuration: production
        )

        XCTAssertEqual(target?.destination, .quotes)
        XCTAssertEqual(
            target?.url.absoluteString,
            "https://overdrafter.vercel.app/quotes/7K4P9M?source=email&app=ios#offers"
        )
    }

    func testConfiguredHTTPSDeepLinkPreservesDetailAndReplacesAppMarker() {
        let target = DeepLinkRouter.target(
            for: URL(
                string: "https://overdrafter.vercel.app/quotes/7K4P9M?source=email&app=web#offers"
            )!,
            configuration: production
        )

        XCTAssertEqual(target?.destination, .quotes)
        XCTAssertEqual(
            target?.url.absoluteString,
            "https://overdrafter.vercel.app/quotes/7K4P9M?source=email&app=ios#offers"
        )
    }

    @MainActor
    func testShellStateNavigatesSelectedWorkspaceToDeepLinkTarget() {
        let state = AppShellState(configuration: production)

        state.openDeepLink(
            URL(string: "overdrafter://search?q=17-4%20PH")!
        )

        XCTAssertEqual(state.selection, .search)
        XCTAssertEqual(
            state.workspaceURL(for: .search).absoluteString,
            "https://overdrafter.vercel.app/search?q=17-4%20PH&app=ios"
        )
    }

    func testConfiguredHTTPSDeepLinksRouteAndForeignHostsDoNot() {
        XCTAssertEqual(
            DeepLinkRouter.destination(
                for: URL(string: "https://overdrafter.vercel.app/quotes/7K4P9M")!,
                configuration: production
            ),
            .quotes
        )
        XCTAssertNil(
            DeepLinkRouter.destination(
                for: URL(string: "https://supplier.example/quotes/7K4P9M")!,
                configuration: production
            )
        )
    }
}
