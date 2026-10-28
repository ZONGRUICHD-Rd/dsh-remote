import Foundation
import Network

struct DiscoveredBridge: Identifiable, Hashable {
    var id: String { hostId.isEmpty ? name : hostId }
    var name: String
    var hostId: String
    var tls: Bool
    var fingerprintPrefix: String
    var endpoint: NWEndpoint
}

/// Browses `_dshremote._tcp` on the local network (Bonjour/mDNS).
@MainActor
final class Discovery: ObservableObject {
    @Published private(set) var bridges: [DiscoveredBridge] = []
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_dshremote._tcp", domain: nil), using: params)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found: [DiscoveredBridge] = results.compactMap { result in
                guard case .service(let name, _, _, _) = result.endpoint else { return nil }
                var txt: [String: String] = [:]
                if case .bonjour(let record) = result.metadata { txt = record.dictionary }
                return DiscoveredBridge(
                    name: name,
                    hostId: txt["id"] ?? "",
                    tls: txt["tls"] != "0",
                    fingerprintPrefix: txt["fp"] ?? "",
                    endpoint: result.endpoint
                )
            }
            Task { @MainActor in self?.bridges = found.sorted { $0.name < $1.name } }
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state {
                Task { @MainActor in
                    self?.browser?.cancel()
                    self?.browser = nil
                }
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    func bridge(for hostId: String) -> DiscoveredBridge? {
        bridges.first { $0.hostId == hostId }
    }
}

/// Resolve a Bonjour service to a concrete IP:port by connecting to it once.
func resolveService(_ endpoint: NWEndpoint, tls: Bool) async -> (host: String, port: Int)? {
    await withCheckedContinuation { continuation in
        let connection = NWConnection(to: endpoint, using: PinnedTLS.parameters(pin: tls ? .record : .plaintext, connectTimeout: 4))
        let once = OnceFlag()
        let finish: @Sendable ((String, Int)?) -> Void = { value in
            guard once.claim() else { return }
            connection.cancel()
            continuation.resume(returning: value.map { (host: $0.0, port: $0.1) })
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint {
                    var text = "\(host)"
                    if let percent = text.firstIndex(of: "%") { text = String(text[..<percent]) }
                    finish((text, Int(port.rawValue)))
                } else {
                    finish(nil)
                }
            case .failed, .cancelled, .waiting:
                finish(nil)
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .userInitiated))
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { connection.cancel() }
    }
}
