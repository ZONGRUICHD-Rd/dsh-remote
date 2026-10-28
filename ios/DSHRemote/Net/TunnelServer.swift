import Foundation
import Network

/// Loopback HTTP entry point for WKWebView and URLSession.
///
/// Every accepted local connection gets its own pinned TLS connection to the
/// bridge; the device credential is written as a single preamble line and the
/// remaining bytes are piped verbatim in both directions. The web view thus
/// talks plain `http://127.0.0.1:<port>` while the wire is TLS-pinned and
/// authenticated, with no extra round trip.
final class TunnelServer: @unchecked Sendable {
    struct Stats { var active = 0; var opened = 0; var failed = 0; var lastError: String? }

    let localPort: UInt16
    private let queue = DispatchQueue(label: "dshremote.tunnel", qos: .userInteractive)
    private var listener: NWListener?
    private let lock = NSLock()
    private var _endpoint: BridgeEndpoint?
    private var _pin: PinPolicy
    private var _preamble: Data?
    private var _stats = Stats()
    private var pipes = Set<Pipe>()
    let observed = FingerprintBox()
    var onUnauthorized: (() -> Void)?
    var onStateChange: ((NWListener.State) -> Void)?

    init(localPort: UInt16, pin: PinPolicy, preamble: String?) {
        self.localPort = localPort
        self._pin = pin
        self._preamble = preamble.map { Data($0.utf8) }
    }

    var endpoint: BridgeEndpoint? {
        get { lock.lock(); defer { lock.unlock() }; return _endpoint }
        set { lock.lock(); _endpoint = newValue; lock.unlock() }
    }

    var pin: PinPolicy {
        get { lock.lock(); defer { lock.unlock() }; return _pin }
        set { lock.lock(); _pin = newValue; lock.unlock() }
    }

    var stats: Stats { lock.lock(); defer { lock.unlock() }; return _stats }

    var isRunning: Bool {
        if case .ready = listener?.state { return true }
        return false
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(localPort)")! }

    func start() throws {
        if let listener, case .ready = listener.state { return }
        listener?.cancel()
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        params.acceptLocalOnly = true
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: localPort)!)
        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.listener?.cancel() }
            self?.onStateChange?(state)
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    /// Wait (briefly) until the listener accepts connections.
    func waitUntilReady(timeout: TimeInterval = 3) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isRunning { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return isRunning
    }

    func stop() {
        listener?.cancel()
        listener = nil
        lock.lock()
        let all = pipes
        pipes.removeAll()
        lock.unlock()
        all.forEach { $0.close() }
    }

    /// Drop every open tunnel (e.g. after switching LAN ↔ remote) so new requests use the new route.
    func resetConnections() {
        lock.lock()
        let all = pipes
        pipes.removeAll()
        lock.unlock()
        all.forEach { $0.close() }
    }

    private func accept(_ local: NWConnection) {
        guard let endpoint = endpoint else {
            local.cancel()
            return
        }
        let remote = NWConnection(to: endpoint.nwEndpoint, using: PinnedTLS.parameters(pin: pin, observed: observed))
        let pipe = Pipe(local: local, remote: remote, queue: queue)
        lock.lock()
        pipes.insert(pipe)
        _stats.active = pipes.count
        _stats.opened += 1
        let preamble = _preamble
        lock.unlock()
        pipe.onClose = { [weak self, weak pipe] error in
            guard let self, let pipe else { return }
            self.lock.lock()
            self.pipes.remove(pipe)
            self._stats.active = self.pipes.count
            if let error { self._stats.failed += 1; self._stats.lastError = "\(error)" }
            self.lock.unlock()
        }
        pipe.onUnauthorized = { [weak self] in self?.onUnauthorized?() }
        pipe.start(preamble: preamble)
    }
}

/// One local ↔ remote byte pipe.
private final class Pipe: Hashable, @unchecked Sendable {
    let local: NWConnection
    let remote: NWConnection
    let queue: DispatchQueue
    var onClose: ((Error?) -> Void)?
    var onUnauthorized: (() -> Void)?
    private var closed = false
    private var sniffed = false

    init(local: NWConnection, remote: NWConnection, queue: DispatchQueue) {
        self.local = local
        self.remote = remote
        self.queue = queue
    }

    static func == (lhs: Pipe, rhs: Pipe) -> Bool { lhs === rhs }
    func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }

    func start(preamble: Data?) {
        remote.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(let error): self?.close(error)
            case .waiting(let error): self?.close(error)
            case .cancelled: self?.close()
            default: break
            }
        }
        local.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(let error): self?.close(error)
            case .cancelled: self?.close()
            default: break
            }
        }
        remote.start(queue: queue)
        local.start(queue: queue)
        // Sends issued before `.ready` are queued and flushed with the handshake.
        if let preamble { remote.send(content: preamble, completion: .idempotent) }
        pump(from: local, to: remote, upstream: true)
        pump(from: remote, to: local, upstream: false)
    }

    private func pump(from source: NWConnection, to sink: NWConnection, upstream: Bool) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self, !self.closed else { return }
            if let data, !data.isEmpty {
                if !upstream && !self.sniffed {
                    self.sniffed = true
                    if let head = String(data: data.prefix(160), encoding: .utf8), head.contains("x-dsh-remote-error: device-revoked") {
                        self.onUnauthorized?()
                    }
                }
                sink.send(content: data, completion: .contentProcessed { [weak self] sendError in
                    guard let self else { return }
                    if let sendError { self.close(sendError); return }
                    if isComplete { self.finish(sink) } else { self.pump(from: source, to: sink, upstream: upstream) }
                })
                return
            }
            if let error { self.close(error); return }
            if isComplete { self.finish(sink) } else { self.pump(from: source, to: sink, upstream: upstream) }
        }
    }

    /// Half-close: forward EOF, then tear down once the other side is done too.
    private var finishedSides = 0
    private func finish(_ sink: NWConnection) {
        sink.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
            guard let self else { return }
            self.finishedSides += 1
            if self.finishedSides >= 2 { self.close() }
        })
        // Some peers never half-close; bound the lingering pipe.
        queue.asyncAfter(deadline: .now() + 30) { [weak self] in self?.close() }
    }

    /// Safe from any thread: teardown always runs on the pipe's queue.
    func close(_ error: Error? = nil) {
        queue.async { [self] in
            if closed { return }
            closed = true
            local.cancel()
            remote.cancel()
            onClose?(error)
        }
    }
}
