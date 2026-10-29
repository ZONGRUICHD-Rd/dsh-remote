import SwiftUI

struct HostListView: View {
    @EnvironmentObject private var store: HostStore
    @EnvironmentObject private var discovery: Discovery
    @EnvironmentObject private var router: Router
    @State private var showScanner = false
    @State private var showManual = false
    @State private var sessionHost: HostProfile?
    // SwiftUI cannot present a sheet while another is dismissing; queue the next one.
    @State private var queuedLink: PairingLink?
    @State private var queuedSession: HostProfile?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if store.hosts.isEmpty { emptyState }
                    ForEach(store.hosts) { host in
                        Button { sessionHost = host } label: { HostCard(host: host, nearby: discovery.bridge(for: host.id) != nil) }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button(role: .destructive) { store.remove(host.id) } label: { Label(L("删除", "Remove"), systemImage: "trash") }
                            }
                    }
                    let unpaired = discovery.bridges.filter { b in !store.hosts.contains { $0.id == b.hostId } }
                    if !unpaired.isEmpty {
                        Text(L("附近的电脑", "Nearby computers")).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 8)
                        ForEach(unpaired) { bridge in
                            Button { showManual = true; router.pendingNearby = bridge } label: {
                                HStack {
                                    Image(systemName: "desktopcomputer").foregroundStyle(Theme.accent)
                                    Text(bridge.name).foregroundStyle(.primary)
                                    Spacer()
                                    Text(L("配对", "Pair")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                                }
                                .padding(18)
                                .dshGlass(in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous), interactive: true)
                            }.buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
            }
            .background(GlassBackdrop())
            .navigationTitle("DSH Remote")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { showScanner = true } label: { Label(L("扫描二维码", "Scan QR code"), systemImage: "qrcode.viewfinder") }
                        Button { router.pendingNearby = nil; showManual = true } label: { Label(L("手动添加", "Add manually"), systemImage: "keyboard") }
                    } label: { Image(systemName: "plus") }
                }
            }
        }
        .onAppear { discovery.start() }
        .sheet(isPresented: $showScanner, onDismiss: flushQueuedLink) {
            QRScannerSheet { link in
                queuedLink = link
                showScanner = false
            }
        }
        .sheet(isPresented: $showManual, onDismiss: flushQueuedLink) {
            ManualAddView(nearby: router.pendingNearby) { link in
                queuedLink = link
                showManual = false
            }
        }
        .sheet(item: $router.pairing, onDismiss: {
            if let host = queuedSession { queuedSession = nil; sessionHost = host }
        }) { link in
            PairingView(link: link) { host in
                queuedSession = host
                router.pairing = nil
            }
        }
        .fullScreenCover(item: $sessionHost) { host in
            SessionView(host: host)
        }
    }

    private func flushQueuedLink() {
        if let link = queuedLink {
            queuedLink = nil
            router.pairing = link
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 40)).foregroundStyle(Theme.accent)
            Text(L("连接你的电脑", "Connect your computer")).font(.title2.weight(.semibold))
            Text(L("1. 在电脑的 DSH Desktop 中安装 DSH Remote 插件（install.cmd）。\n2. 在 DSH 对话框输入 /remote，打开管理页。\n3. 点右上角 ＋ 扫描二维码。",
                   "1. Install the DSH Remote plugin into DSH Desktop (install.cmd).\n2. Type /remote in DSH and open the admin page.\n3. Tap ＋ and scan the QR code."))
                .font(.subheadline).foregroundStyle(.secondary)
            Button { showScanner = true } label: {
                Label(L("扫描二维码", "Scan QR code"), systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
                .dshProminentButton()
                .padding(.top, 6)
        }
        .card()
    }
}

private struct HostCard: View {
    var host: HostProfile
    var nearby: Bool

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(LinearGradient(colors: [Theme.accent, Theme.accent.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 46, height: 46)
                Image(systemName: "desktopcomputer").font(.title3).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(host.name).font(.headline).foregroundStyle(.primary)
                HStack(spacing: 6) {
                    StatusDot(color: nearby ? Theme.ok : .secondary.opacity(0.5))
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(18)
        .contentShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .dshGlass(in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous), interactive: true)
    }

    private var subtitle: String {
        var parts: [String] = []
        parts.append(nearby ? L("在局域网中", "On this network") : (host.remoteHost.map { L("外网 ", "Remote ") + $0 } ?? (host.lanHosts.first ?? "")))
        parts.append(host.mode.title)
        return parts.joined(separator: " · ")
    }
}
