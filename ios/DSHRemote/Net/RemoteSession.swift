import Foundation
import Network
import UIKit

/// Live connection to one paired PC: chooses the route, runs the local
/// tunnel the web view loads from, and keeps measuring latency.
@MainActor
final class RemoteSession: ObservableObject {
    enum State: Equatable {
        case idle
        case connecting
        case connected(route: RouteKind, endpoint: String)
        case unreachable(String)
        case unauthorized
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var rttMs: Int?
    @Published private(set) var host: HostProfile

    let tunnel: TunnelServer
    private let store: HostStore
    private let discovery: Discovery
    private var pathMonitor: NWPathMonitor?
    private var pingTask: Task<Void, Never>?
    private var resolveTask: Task<Void, Never>?
    private var lastPath: NWPath.Status?
    private var foregroundObserver: NSObjectProtocol?

    var api: BridgeAPI { BridgeAPI(baseURL: tunnel.baseURL) }
    var pageURL: URL { tunnel.baseURL.appendingPathComponent("/") }

    init(host: HostProfile, store: HostStore, discovery: Discovery) {
        self.host = host
        self.store = store
        self.discovery = discovery
        let token = Keychain.get(host.id) ?? ""
        tunnel = TunnelServer(localPort: host.localPort, pin: host.pin, preamble: "DSHR/1 \(host.deviceId) \(token)\r\n")
        tunnel.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.state = .unauthorized }
        }
    }

    func start() {
        do {
            try tunnel.start()
        } catch {
            state = .unreachable(L("无法启动本地通道：", "Local tunnel failed: ") + error.localizedDescription)
            return
        }
        discovery.start()
        resolve()
        startPathMonitor()
        startPinging()
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.wake() }
        }
    }

    func stop() {
        pingTask?.cancel()
        resolveTask?.cancel()
        pathMonitor?.cancel()
        pathMonitor = nil
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        foregroundObserver = nil
        tunnel.stop()
        state = .idle
    }

    /// App returned to the foreground: iOS may have torn down sockets and the listener.
    func wake() {
        if !tunnel.isRunning { try? tunnel.start() }
        resolve()
    }

    func setMode(_ mode: ConnectionMode) {
        store.update(host.id) { $0.mode = mode }
        if let updated = store.host(host.id) { host = updated }
        tunnel.resetConnections()
        resolve()
    }

    func reloadProfile() {
        if let updated = store.host(host.id) { host = updated }
    }

    private func candidates() -> [RouteCandidate] {
        var list: [RouteCandidate] = []
        if host.mode != .remoteOnly {
            if let bonjour = discovery.bridge(for: host.id) {
                list.append(RouteCandidate(endpoint: .bonjour(bonjour.endpoint), kind: .lan, delay: 0, timeout: 2.5))
            }
            for ip in host.lanHosts {
                list.append(RouteCandidate(endpoint: .hostPort(host: ip, port: host.port), kind: .lan, delay: 0, timeout: 2.5))
            }
        }
        if host.mode != .lanOnly, let remote = host.remoteEndpoint {
            list.append(RouteCandidate(endpoint: remote, kind: .remote, delay: host.mode == .remoteOnly ? 0 : 0.35, timeout: 8))
        }
        return list
    }

    func resolve() {
        resolveTask?.cancel()
        resolveTask = Task { [weak self] in
            guard let self else { return }
            if case .connected = self.state {} else { self.state = .connecting }
            // Give Bonjour a moment on a cold start so a moved DHCP address is still found.
            if self.discovery.bridge(for: self.host.id) == nil && self.host.mode != .remoteOnly {
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
            var result = await EndpointProber.race(self.candidates(), pin: self.host.pin)
            if result == nil && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                result = await EndpointProber.race(self.candidates(), pin: self.host.pin)
            }
            if Task.isCancelled { return }
            guard let result else {
                self.tunnel.endpoint = nil
                self.state = .unreachable(self.unreachableMessage())
                return
            }
            let previous = self.tunnel.endpoint
            self.tunnel.endpoint = result.candidate.endpoint
            if previous != nil && previous != result.candidate.endpoint { self.tunnel.resetConnections() }
            self.state = .connected(route: result.candidate.kind, endpoint: result.candidate.endpoint.description)
            self.rttMs = Int(result.handshake * 1000 / 2)
            await self.learnLanAddress(result.candidate)
            self.store.update(self.host.id) {
                $0.lastConnectedAt = Date()
                $0.lastRoute = result.candidate.kind.rawValue
            }
        }
    }

    private func unreachableMessage() -> String {
        switch host.mode {
        case .lanOnly:
            return L("局域网内找不到这台电脑。请确认手机和电脑在同一网络，且 DSH Desktop 正在运行。", "The PC was not found on this network. Check Wi-Fi and that DSH Desktop is running.")
        case .remoteOnly where host.remoteEndpoint == nil:
            return L("尚未配置外网地址（DDNS）。", "No remote (DDNS) address is configured.")
        default:
            return L("无法连接到电脑。请确认 DSH Desktop 正在运行，外网访问需配置 DDNS 和端口映射。", "Cannot reach the PC. Make sure DSH Desktop is running; remote access needs DDNS and port forwarding.")
        }
    }

    /// Remember the IP Bonjour resolved so the next cold start can connect without waiting.
    private func learnLanAddress(_ candidate: RouteCandidate) async {
        guard candidate.kind == .lan, case .bonjour(let endpoint) = candidate.endpoint else { return }
        guard let resolved = await resolveService(endpoint, tls: host.usesTLS) else { return }
        store.update(host.id) { profile in
            profile.lanHosts.removeAll { $0 == resolved.host }
            profile.lanHosts.insert(resolved.host, at: 0)
            profile.lanHosts = Array(profile.lanHosts.prefix(4))
            profile.port = resolved.port
        }
        reloadProfile()
    }

    private func startPathMonitor() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                // Wi-Fi ↔ cellular or a new network: pick the best route again.
                if self.lastPath != nil { self.tunnel.resetConnections(); self.resolve() }
                self.lastPath = path.status
            }
        }
        monitor.start(queue: .global(qos: .utility))
        pathMonitor = monitor
    }

    private func startPinging() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, !Task.isCancelled else { return }
                guard case .connected = self.state else { continue }
                do {
                    let rtt = try await self.api.ping()
                    self.rttMs = Int(rtt * 1000)
                } catch BridgeError.unauthorized {
                    self.state = .unauthorized
                } catch {
                    self.resolve()
                }
            }
        }
    }
}
