import CoreFoundation
import CryptoKit
import Foundation
import Security

enum MobileAuthContractError: Error, Equatable {
    case randomGenerationFailed
    case invalidCallback
    case stateMismatch
    case invalidConfiguration
}

struct MobileAuthAttempt: Equatable {
    let state: String
    let verifier: String
    let challenge: String

    static func generate() throws -> MobileAuthAttempt {
        let stateBytes = try randomBytes(count: 32)
        let verifierBytes = try randomBytes(count: 32)
        let verifier = base64URL(verifierBytes)
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))

        return MobileAuthAttempt(
            state: base64URL(stateBytes),
            verifier: verifier,
            challenge: challenge
        )
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
            throw MobileAuthContractError.randomGenerationFailed
        }
        return Data(bytes)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct MobileAuthCallbackPayload: Equatable {
    let code: String
    let state: String

    static func parse(
        _ url: URL,
        configuration: AppConfiguration,
        expectedState: String
    ) throws -> MobileAuthCallbackPayload {
        guard
            url.scheme?.lowercased() == "https",
            configuration.matchesConfiguredOrigin(url),
            url.path(percentEncoded: true) == configuration.mobileAuthRoutes.callbackPath,
            url.query == nil,
            url.user == nil,
            url.password == nil,
            let fragment = url.fragment,
            fragment.utf8.count <= 128,
            let fields = parseFragment(fragment),
            let code = fields["code"],
            let state = fields["state"],
            isCanonicalSecret(code),
            isCanonicalSecret(state)
        else {
            throw MobileAuthContractError.invalidCallback
        }

        guard timingSafeEqual(state, expectedState) else {
            throw MobileAuthContractError.stateMismatch
        }

        return MobileAuthCallbackPayload(code: code, state: state)
    }

    private static func parseFragment(_ fragment: String) -> [String: String]? {
        guard !fragment.contains("%") else {
            return nil
        }

        var fields: [String: String] = [:]

        for pair in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            let components = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard
                components.count == 2,
                !components[0].isEmpty,
                !components[1].isEmpty
            else {
                return nil
            }

            let name = String(components[0])
            let value = String(components[1])
            guard
                (name == "code" || name == "state"),
                fields[name] == nil
            else {
                return nil
            }
            fields[name] = value
        }

        return fields.count == 2 ? fields : nil
    }
}

enum MobileAuthErrorCode: String, Equatable {
    case cancelled = "mobile_auth_cancelled"
    case invalidRequest = "mobile_auth_invalid_request"
    case providerFailed = "mobile_auth_provider_failed"
    case networkFailed = "mobile_auth_network_failed"
    case stateMismatch = "mobile_auth_state_mismatch"
    case expired = "mobile_auth_expired"
    case replayed = "mobile_auth_replayed"
    case pkceFailed = "mobile_auth_pkce_failed"
    case sessionInvalid = "mobile_auth_session_invalid"
    case bootstrapFailed = "mobile_auth_bootstrap_failed"
    case logoutFailed = "mobile_auth_logout_failed"
    case rateLimited = "mobile_auth_rate_limited"
    case serviceUnavailable = "mobile_auth_service_unavailable"
}

enum MobileAuthRetryInstruction: String, Equatable {
    case none
    case network
    case restart
    case later
}

enum MobileAuthWebMessage: Equatable {
    case authenticated
    case signedOut
    case ready(state: String, returnTo: String)
    case failure(state: String?, code: MobileAuthErrorCode, retry: MobileAuthRetryInstruction)

    init?(body: Any) {
        guard
            let object = body as? [String: Any],
            let version = object["version"] as? NSNumber,
            CFGetTypeID(version) != CFBooleanGetTypeID(),
            version.doubleValue == 1,
            let status = object["status"] as? String
        else {
            return nil
        }

        switch status {
        case "authenticated":
            guard object.count == 2 else { return nil }
            self = .authenticated
        case "signed_out":
            guard object.count == 2 else { return nil }
            self = .signedOut
        case "ready":
            guard
                object.count == 4,
                let state = object["state"] as? String,
                let returnTo = object["returnTo"] as? String,
                isCanonicalSecret(state),
                isAllowedReturnRoute(returnTo)
            else {
                return nil
            }
            self = .ready(state: state, returnTo: returnTo)
        case "error":
            guard
                let rawCode = object["code"] as? String,
                let code = MobileAuthErrorCode(rawValue: rawCode)
            else {
                return nil
            }

            if object.count == 3 {
                guard
                    code == .networkFailed
                        || code == .sessionInvalid
                        || code == .logoutFailed
                else {
                    return nil
                }
                let retry: MobileAuthRetryInstruction = code == .networkFailed
                    ? .network
                    : .restart
                self = .failure(state: nil, code: code, retry: retry)
                return
            }

            guard
                object.count == 5,
                let rawRetry = object["retry"] as? String,
                let retry = MobileAuthRetryInstruction(rawValue: rawRetry),
                let state = object["state"] as? String,
                isCanonicalSecret(state)
            else {
                return nil
            }
            self = .failure(state: state, code: code, retry: retry)
        default:
            return nil
        }
    }
}

private func isCanonicalSecret(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return bytes.count == 43 && bytes.allSatisfy { byte in
        (48...57).contains(byte)
            || (65...90).contains(byte)
            || (97...122).contains(byte)
            || byte == 45
            || byte == 95
    }
}

private func isAllowedReturnRoute(_ value: String) -> Bool {
    guard
        !value.contains("%"),
        !value.contains("\\"),
        value.utf8.count <= 256
    else {
        return false
    }

    let components = value.split(separator: "/", omittingEmptySubsequences: false)
    guard components.first == "" else {
        return false
    }

    if components.count == 2 {
        return ["parts", "quotes", "search"].contains(String(components[1]))
    }

    guard
        components.count == 3,
        ["parts", "quotes", "projects"].contains(String(components[1]))
    else {
        return false
    }

    let resourceIdentifier = components[2]
    guard
        !resourceIdentifier.isEmpty,
        resourceIdentifier.utf8.count <= 128,
        let first = resourceIdentifier.utf8.first,
        (48...57).contains(first)
            || (65...90).contains(first)
            || (97...122).contains(first)
    else {
        return false
    }

    return resourceIdentifier.utf8.allSatisfy { byte in
        (48...57).contains(byte)
            || (65...90).contains(byte)
            || (97...122).contains(byte)
            || byte == 45
            || byte == 95
    }
}

func timingSafeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    var difference = UInt8(truncatingIfNeeded: left.count ^ right.count)
    let maximumCount = max(left.count, right.count)

    for index in 0..<maximumCount {
        let leftByte = index < left.count ? left[index] : 0
        let rightByte = index < right.count ? right[index] : 0
        difference |= leftByte ^ rightByte
    }

    return difference == 0
}
