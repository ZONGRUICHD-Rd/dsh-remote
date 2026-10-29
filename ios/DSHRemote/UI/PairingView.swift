import SwiftUI
import UIKit

/// Contacts the bridge through a temporary pinned tunnel, confirms the
/// certificate when it did not come from a QR code, and exchanges the
/// pairing code for a device token.
struct PairingView: View {
    let link: PairingLink
    var onPaired: (HostProfile) -> Void

    @EnvironmentObject private var store: HostStore
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .connecting
    @State private var tunnel: TunnelServer?
    @State private var route: RouteCandidate?

    enum Phase: Equatable {
        case connecting
        case confirm(fingerprint: String, name: String)
        case pairing
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "desktopcomputer.and.arrow.down")
                    .font(.system(size: 40, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 92, height: 92)
                    .dshGlass(in: Circle())
                    .padding(.top, 30)
                Text(link.name).font(.title2.weight(.semibold))
                content
                Spacer()
            }
            .padding(20)
            .frame(maxWidth: .infinity)
            .background(GlassBackdrop())
            .navigationTitle(L("配对", "Pairing"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("取消", "Cancel")) { dismiss() } } }
        }
        .task { await connect() }
        .onDisappear { tunnel?.stop() }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .connecting:
            ProgressView(L("正在连接电脑…", "Connecting to the computer…"))
        case .pairing:
            ProgressView(L("正在配对…", "Pairing…"))
        case .confirm(let fingerprint, let name):
            VStack(alignment: .leading, spacing: 12) {
                Text(L("首次连接，请核对证书指纹", "First connection: verify the certificate")).font(.headline)
                Text(L("请确认与电脑上 /remote 或管理页显示的指纹一致（\(name)）：", "Make sure it matches the fingerprint shown by /remote or the admin page (\(name)):"))
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(groups(fingerprint)).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                Button { Task { await pair(fingerprint: fingerprint) } } label: {
                    Text(L("指纹一致，继续配对", "It matches — pair")).frame(maxWidth: .infinity)
                }
                .dshProminentButton()
            }
            .card()
        case .failed(let message):
            VStack(spacing: 14) {
                Text(message).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
                Button { Task { await connect() } } label: { Text(L("重试", "Retry")).frame(maxWidth: .infinity) }
                    .dshProminentButton()
            }
            .card()
        }
    }

    private func groups(_ fp: String) -> String {
        stride(from: 0, to: fp.count, by: 4).map { i -> String in
            let start = fp.index(fp.startIndex, offsetBy: i)
            return String(fp[start..<fp.index(start, offsetBy: min(4, fp.count - i))])
        }.joined(separator: " ")
    }

    private var pin: PinPolicy {
        if let fp = link.fingerprint { return .fingerprint(fp) }
        return link.tls ? .record : .plaintext
    }

    private func connect() async {
        phase = .connecting
        tunnel?.stop()
        var candidates = link.lanHosts.map { RouteCandidate(endpoint: .hostPort(host: $0, port: link.port), kind: .lan, delay: 0, timeout: 3) }
        if let remote = link.remoteHost {
            candidates.append(RouteCandidate(endpoint: .hostPort(host: remote, port: link.remotePort ?? link.port), kind: .remote, delay: candidates.isEmpty ? 0 : 0.4, timeout: 8))
        }
        guard let result = await EndpointProber.race(candidates, pin: pin) else {
            phase = .failed(L("连接不上电脑。请确认手机与电脑在同一 Wi-Fi、DSH Desktop 已运行，且防火墙已放行端口 \(link.port)。",
                              "Could not reach the computer. Check that both are on the same Wi-Fi, DSH Desktop is running and port \(link.port) is allowed by the firewall."))
            return
        }
        route = result.candidate
        let tunnel = TunnelServer(localPort: UInt16.random(in: 46000...47999), pin: pin, preamble: nil)
        tunnel.endpoint = result.candidate.endpoint
        do {
            try tunnel.start()
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        self.tunnel = tunnel
        _ = await tunnel.waitUntilReady()
        do {
            let info = try await BridgeAPI(baseURL: tunnel.baseURL).info()
            guard info.app == "dsh-remote" else { throw BridgeError.invalidResponse }
            switch pin {
            case .fingerprint(let expected):
                guard info.fingerprint?.lowercased() == expected else { throw BridgeError.http(0, L("证书指纹不匹配。", "Certificate fingerprint mismatch.")) }
                await pair(fingerprint: expected)
            case .record:
                guard let observed = tunnel.observed.fingerprint, observed == info.fingerprint?.lowercased() else {
                    throw BridgeError.http(0, L("证书指纹不一致，可能存在中间人。", "Certificate mismatch — possible interception."))
                }
                tunnel.pin = .fingerprint(observed)
                phase = .confirm(fingerprint: observed, name: info.name)
            case .plaintext:
                await pair(fingerprint: nil)
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func pair(fingerprint: String?) async {
        guard let tunnel else { return }
        phase = .pairing
        do {
            let result = try await BridgeAPI(baseURL: tunnel.baseURL).pair(code: link.code, deviceName: UIDevice.current.name)
            var lan = result.lan.filter { !$0.contains(":") }
            if case .hostPort(let host, _) = route?.endpoint, route?.kind == .lan {
                lan.removeAll { $0 == host }
                lan.insert(host, at: 0)
            }
            let remoteHost = result.remote?.host ?? link.remoteHost
            var profile = HostProfile(
                id: result.hostId,
                name: result.name,
                deviceId: result.deviceId,
                fingerprint: fingerprint ?? result.fingerprint,
                port: result.port,
                lanHosts: Array(lan.prefix(4)),
                remoteHost: remoteHost,
                remotePort: result.remote?.port ?? link.remotePort,
                lastConnectedAt: Date()
            )
            if let existing = store.host(result.hostId) {
                // Re-pairing keeps the per-PC preferences.
                profile.mode = existing.mode
                profile.layout = existing.layout
                profile.desktopWidth = existing.desktopWidth
            }
            store.upsert(profile, token: result.token)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            tunnel.stop()
            onPaired(profile)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
