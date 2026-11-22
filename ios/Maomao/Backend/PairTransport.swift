import Foundation
import Security

enum PairingError: LocalizedError {
    case unavailable, invalidLink, invalidAddress, certificate, storage
    var errorDescription: String? {
        switch self {
        case .unavailable: return "团子在家里的电脑上"
        case .invalidLink: return "配对或邀请链接不完整，或版本不支持，请在电脑上重新生成"
        case .invalidAddress: return "请填写电脑地址和八位配对码"
        case .certificate: return "电脑证书与配对指纹不一致，未发送配对码"
        case .storage: return "没能安全保存配对信息，请重试"
        }
    }
}

final class PairTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let fingerprint: String?
    private let lock = NSLock()
    private var captured: String?
    var capturedFingerprint: String? { lock.lock(); defer { lock.unlock() }; return captured }
    init(fingerprint: String?) { self.fingerprint = fingerprint }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard let fingerprint else {
            // 探测只读取证书并中断握手，不发送 HTTP 请求或配对码。
            if let ca = chain.last {
                lock.lock(); captured = PairFingerprint.digest(SecCertificateCopyData(ca) as Data); lock.unlock()
            }
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard let anchor = chain.first(where: { PairFingerprint.matches(SecCertificateCopyData($0) as Data, pin: fingerprint) }),
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // A reconnecting byte stream can receive its server-trust challenge at the task level.
        urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum PairTransport {
    private static let lock = NSLock()
    private static var sessions: [String: URLSession] = [:]
    static func session(fingerprint: String) -> URLSession {
        lock.lock(); defer { lock.unlock() }
        if let existing = sessions[fingerprint] { return existing }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: configuration, delegate: PairTrustDelegate(fingerprint: fingerprint), delegateQueue: nil)
        sessions[fingerprint] = session
        return session
    }
    static func probe(host: String, port: Int) async throws -> String {
        let delegate = PairTrustDelegate(fingerprint: nil)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let placeholder = PairedHost(hosts: [host], port: port, fingerprint: "", deviceID: "", deviceToken: "", accountID: "")
        var request = URLRequest(url: placeholder.url(host: host).appending(path: "healthz"))
        request.timeoutInterval = 4
        _ = try? await session.data(for: request)
        guard let fingerprint = delegate.capturedFingerprint else { throw PairingError.unavailable }
        return fingerprint
    }
    static func select(hosts: [String], port: Int, fingerprint: String) async throws -> URL {
        let session = session(fingerprint: fingerprint)
        let placeholder = PairedHost(hosts: hosts, port: port, fingerprint: fingerprint, deviceID: "", deviceToken: "", accountID: "")
        for host in hosts {
            try Task.checkCancellation()
            let url = placeholder.url(host: host)
            var request = URLRequest(url: url.appending(path: "healthz")); request.timeoutInterval = 4
            if let (_, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 { return url }
        }
        throw PairingError.unavailable
    }
}

extension Notification.Name { static let pairedConnectionFailed = Notification.Name("pairedConnectionFailed") }
