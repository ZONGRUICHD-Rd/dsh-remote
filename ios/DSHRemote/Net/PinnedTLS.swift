import CryptoKit
import Foundation
import Network
import Security

/// How a TLS connection authenticates the bridge certificate.
enum PinPolicy: Equatable {
    /// Accept only a certificate whose SHA-256 fingerprint matches (paired hosts, QR codes).
    case fingerprint(String)
    /// Accept any certificate and record its fingerprint (manual first contact; the user confirms it).
    case record
    /// Plain TCP (the bridge has TLS disabled).
    case plaintext
}

/// Thread-safe holder for the fingerprint observed during a `.record` handshake.
final class FingerprintBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    var fingerprint: String? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

enum PinnedTLS {
    private static let verifyQueue = DispatchQueue(label: "dshremote.tls.verify")

    static func fingerprint(of certificate: SecCertificate) -> String {
        let der = SecCertificateCopyData(certificate) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return fingerprint(of: leaf)
    }

    /// Network.framework parameters for a low-latency (TCP_NODELAY) connection to the bridge.
    static func parameters(pin: PinPolicy, observed: FingerprintBox? = nil, connectTimeout: Int = 6) -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 30
        tcp.connectionTimeout = connectTimeout
        let params: NWParameters
        switch pin {
        case .plaintext:
            params = NWParameters(tls: nil, tcp: tcp)
        case .fingerprint, .record:
            let tls = NWProtocolTLS.Options()
            let sec = tls.securityProtocolOptions
            sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
            sec_protocol_options_add_tls_application_protocol(sec, "http/1.1")
            sec_protocol_options_set_verify_block(sec, { _, secTrust, complete in
                let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
                let presented = leafFingerprint(trust)
                switch pin {
                case .fingerprint(let expected):
                    complete(presented != nil && presented == expected.lowercased())
                case .record:
                    observed?.fingerprint = presented
                    complete(presented != nil)
                case .plaintext:
                    complete(false)
                }
            }, verifyQueue)
            params = NWParameters(tls: tls, tcp: tcp)
        }
        params.serviceClass = .responsiveData
        return params
    }
}

/// A bridge address: a resolved host/port or a Bonjour service.
enum BridgeEndpoint: Hashable, CustomStringConvertible {
    case hostPort(host: String, port: Int)
    case bonjour(NWEndpoint)

    var nwEndpoint: NWEndpoint {
        switch self {
        case .hostPort(let host, let port):
            return .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? 39090)
        case .bonjour(let endpoint):
            return endpoint
        }
    }

    var description: String {
        switch self {
        case .hostPort(let host, let port):
            return host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
        case .bonjour(let endpoint):
            if case .service(let name, _, _, _) = endpoint { return "\(name) (Bonjour)" }
            return "\(endpoint)"
        }
    }
}

/// One-shot flag usable from `@Sendable` callbacks.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    /// True exactly once.
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
