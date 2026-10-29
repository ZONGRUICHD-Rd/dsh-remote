import SwiftUI
import UIKit

/// Full-screen DSH for one computer, with a small draggable status pill.
struct SessionView: View {
    @EnvironmentObject private var store: HostStore
    @EnvironmentObject private var discovery: Discovery
    @Environment(\.dismiss) private var dismiss
    @StateObject private var holder = SessionHolder()
    @StateObject private var web = WebController()
    @State private var showSettings = false
    @State private var pillOffset: CGSize = .zero
    @State private var dragStart: CGSize = .zero
    @State private var webGeneration = 0
    let host: HostProfile

    var body: some View {
        ZStack {
            Color(uiColor: web.pageBackground ?? UIColor(Theme.background)).ignoresSafeArea()
            if let session = holder.session {
                content(session)
            }
        }
        .onAppear {
            if holder.session == nil {
                let session = RemoteSession(host: store.host(host.id) ?? host, store: store, discovery: discovery)
                holder.session = session
                session.start()
            }
        }
        .onDisappear { holder.session?.stop() }
        .statusBarHidden(false)
        .sheet(item: $web.download) { url in ShareSheet(items: [url]) }
    }

    @ViewBuilder private func content(_ session: RemoteSession) -> some View {
        SessionContent(session: session, web: web, generation: webGeneration)
            .overlay(alignment: .topTrailing) {
                sessionControls(session)
                    .offset(pillOffset)
                    .gesture(DragGesture()
                        .onChanged { value in pillOffset = CGSize(width: dragStart.width + value.translation.width, height: dragStart.height + value.translation.height) }
                        .onEnded { _ in dragStart = pillOffset })
                    .padding(.trailing, 10)
                    .padding(.top, 52)
            }
            .sheet(isPresented: $showSettings, onDismiss: {
                let before = session.host
                session.reloadProfile()
                if before.layout != session.host.layout || before.desktopWidth != session.host.desktopWidth {
                    webGeneration += 1 // re-create the web view with the new viewport
                }
            }) {
                HostSettingsView(session: session, onRemoved: { dismiss() })
            }
    }
}

extension SessionView {
    @ViewBuilder fileprivate func sessionControls(_ session: RemoteSession) -> some View {
        if #available(iOS 26.0, *) {
            GlassSessionControls(session: session,
                                 onReload: { web.reload() },
                                 onSettings: { showSettings = true },
                                 onClose: { dismiss() })
        } else {
            StatusPill(session: session, web: web,
                       onReload: { web.reload() },
                       onSettings: { showSettings = true },
                       onClose: { dismiss() })
        }
    }
}

extension RemoteSession {
    var pillColor: Color {
        switch state {
        case .connected(let route, _): return route == .lan ? Theme.ok : .orange
        case .connecting, .idle: return .yellow
        default: return Theme.danger
        }
    }

    var pillLabel: String {
        switch state {
        case .connected(let route, _):
            if let rtt = rttMs { return "\(route.label) \(rtt)ms" }
            return route.label
        case .connecting, .idle: return L("连接中", "Connecting")
        case .unreachable: return L("离线", "Offline")
        case .unauthorized: return L("未授权", "Unauthorized")
        }
    }

    var routeDescription: String {
        if case .connected(let route, let endpoint) = state { return "\(host.name) · \(route.label) · \(endpoint)" }
        return host.name
    }
}

/// iOS 26: a Liquid Glass status capsule floating over DSH that morphs into a
/// row of glass controls (reload, route, connection mode, settings, close).
@available(iOS 26.0, *)
private struct GlassSessionControls: View {
    @ObservedObject var session: RemoteSession
    var onReload: () -> Void
    var onSettings: () -> Void
    var onClose: () -> Void
    @State private var expanded = false
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                if expanded {
                    control("xmark", id: "close", tint: Theme.danger.opacity(0.35)) { onClose() }
                    control("gearshape", id: "settings") { collapse(); onSettings() }
                    Menu {
                        Section(session.routeDescription) {
                            Button { session.resolve() } label: { Label(L("重新选择线路", "Re-pick route"), systemImage: "point.3.connected.trianglepath.dotted") }
                        }
                        Picker(L("连接方式", "Connection"), selection: Binding(get: { session.host.mode }, set: { session.setMode($0) })) {
                            ForEach(ConnectionMode.allCases) { Text($0.title).tag($0) }
                        }
                    } label: {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 40, height: 40)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .glassEffectID("route", in: glass)
                    control("arrow.clockwise", id: "reload") { onReload() }
                }
                Button {
                    withAnimation(.bouncy(duration: 0.35)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        StatusDot(color: session.pillColor)
                        Text(session.pillLabel).font(.caption.weight(.semibold)).monospacedDigit()
                        if expanded { Image(systemName: "chevron.right").font(.caption2.weight(.bold)) }
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.tint(session.pillColor.opacity(0.18)).interactive(), in: .capsule)
                .glassEffectID("pill", in: glass)
            }
        }
        .sensoryFeedback(.selection, trigger: expanded)
    }

    private func control(_ symbol: String, id: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .glassEffect(tint.map { Glass.regular.tint($0).interactive() } ?? Glass.regular.interactive(), in: .circle)
        .glassEffectID(id, in: glass)
    }

    private func collapse() {
        withAnimation(.bouncy(duration: 0.35)) { expanded = false }
    }
}

@MainActor
private final class SessionHolder: ObservableObject {
    @Published var session: RemoteSession?
}

private struct SessionContent: View {
    @ObservedObject var session: RemoteSession
    @ObservedObject var web: WebController
    let generation: Int

    var body: some View {
        ZStack {
            if web.loadedOnce || isConnected {
                DSHWebView(url: session.pageURL, localOrigin: session.tunnel.baseURL, layout: session.host.layout,
                           desktopWidth: session.host.desktopWidth, controller: web)
                    .id(generation)
                    .opacity(web.loadedOnce ? 1 : 0.01)
            }
            overlay
        }
        .onChange(of: isConnected) { connected in
            // Reconnected after a failed initial load: retry it.
            if connected && web.loadError != nil { web.reload() }
        }
    }

    private var isConnected: Bool {
        if case .connected = session.state { return true }
        return false
    }

    @ViewBuilder private var overlay: some View {
        switch session.state {
        case .unauthorized:
            message(icon: "person.crop.circle.badge.xmark",
                    title: L("设备已被移除", "Device removed"),
                    detail: L("这台手机已在电脑上被移除。请在电脑上输入 /remote 并重新扫码配对。", "This phone was removed on the PC. Type /remote on the PC and pair again."),
                    retry: false)
        case .unreachable(let detail):
            if !web.loadedOnce || web.loadError != nil {
                message(icon: "wifi.exclamationmark", title: L("连接不上电脑", "Cannot reach the computer"), detail: detail, retry: true)
            }
        case .idle, .connecting:
            if !web.loadedOnce { loading(L("正在连接…", "Connecting…")) }
        case .connected:
            if let error = web.loadError {
                message(icon: "exclamationmark.triangle", title: L("加载失败", "Failed to load"), detail: error, retry: true)
            } else if !web.loadedOnce {
                loading(L("正在加载 DSH…", "Loading DSH…"))
            }
        }
    }

    private func loading(_ text: String) -> some View {
        VStack(spacing: 14) {
            ProgressView()
            Text(text).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private func message(icon: String, title: String, detail: String, retry: Bool) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 38)).foregroundStyle(Theme.accent)
            Text(title).font(.headline)
            Text(detail).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if retry {
                Button(L("重试", "Retry")) {
                    session.resolve()
                    web.reload()
                }
                .dshProminentButton()
                .frame(maxWidth: 220)
            }
        }
        .padding(24)
        .frame(maxWidth: 420)
        .card()
        .padding(24)
    }
}

/// Compact route + latency indicator with the session menu.
private struct StatusPill: View {
    @ObservedObject var session: RemoteSession
    @ObservedObject var web: WebController
    var onReload: () -> Void
    var onSettings: () -> Void
    var onClose: () -> Void

    var body: some View {
        Menu {
            Section(routeDescription) {
                Button { onReload() } label: { Label(L("重新加载", "Reload"), systemImage: "arrow.clockwise") }
                Button { session.resolve() } label: { Label(L("重新选择线路", "Re-pick route"), systemImage: "point.3.connected.trianglepath.dotted") }
            }
            Picker(L("连接方式", "Connection"), selection: Binding(get: { session.host.mode }, set: { session.setMode($0) })) {
                ForEach(ConnectionMode.allCases) { Text($0.title).tag($0) }
            }
            Button { onSettings() } label: { Label(L("设置 / DDNS", "Settings / DDNS"), systemImage: "gearshape") }
            Button(role: .destructive) { onClose() } label: { Label(L("断开", "Disconnect"), systemImage: "xmark.circle") }
        } label: {
            HStack(spacing: 5) {
                StatusDot(color: dotColor)
                Text(label).font(.caption2.weight(.semibold)).monospacedDigit()
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .dshGlass()
        }
    }

    private var dotColor: Color {
        switch session.state {
        case .connected(let route, _): return route == .lan ? Theme.ok : .orange
        case .connecting, .idle: return .yellow
        default: return Theme.danger
        }
    }

    private var label: String {
        switch session.state {
        case .connected(let route, _):
            if let rtt = session.rttMs { return "\(route.label) \(rtt)ms" }
            return route.label
        case .connecting, .idle: return L("连接中", "Connecting")
        case .unreachable: return L("离线", "Offline")
        case .unauthorized: return L("未授权", "Unauthorized")
        }
    }

    private var routeDescription: String {
        if case .connected(let route, let endpoint) = session.state { return "\(session.host.name) · \(route.label) · \(endpoint)" }
        return session.host.name
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    var items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

extension URL: Identifiable {
    public var id: String { absoluteString }
}
