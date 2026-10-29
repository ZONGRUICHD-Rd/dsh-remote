import SwiftUI

struct HostSettingsView: View {
    @ObservedObject var session: RemoteSession
    var onRemoved: () -> Void
    @EnvironmentObject private var store: HostStore
    @Environment(\.dismiss) private var dismiss

    @State private var profile: HostProfile
    @State private var lanText = ""
    @State private var remotePortText = ""
    @State private var status: BridgeStatus?
    @State private var bridgeSettings: BridgeSettings?
    @State private var devices: [PairedDevice] = []
    @State private var error: String?
    @State private var saving = false
    @State private var confirmRemove = false

    init(session: RemoteSession, onRemoved: @escaping () -> Void) {
        self.session = session
        self.onRemoved = onRemoved
        _profile = State(initialValue: session.host)
        _lanText = State(initialValue: session.host.lanHosts.joined(separator: ", "))
        _remotePortText = State(initialValue: session.host.remotePort.map(String.init) ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(L("本机连接", "This phone")) {
                    Picker(L("连接方式", "Connection"), selection: $profile.mode) {
                        ForEach(ConnectionMode.allCases) { Text($0.title).tag($0) }
                    }
                    Picker(L("界面布局", "Layout"), selection: $profile.layout) {
                        ForEach(LayoutMode.allCases) { Text($0.title).tag($0) }
                    }
                    if profile.layout == .desktop {
                        Stepper(value: $profile.desktopWidth, in: 800...1600, step: 50) {
                            Text(L("桌面宽度 \(profile.desktopWidth)px", "Desktop width \(profile.desktopWidth)px"))
                        }
                    }
                    VStack(alignment: .leading) {
                        Text(L("内网地址（逗号分隔）", "LAN addresses (comma separated)")).font(.caption).foregroundStyle(.secondary)
                        TextField("192.168.1.10", text: $lanText).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    VStack(alignment: .leading) {
                        Text(L("外网地址（DDNS 域名或公网 IP）", "Remote address (DDNS host or public IP)")).font(.caption).foregroundStyle(.secondary)
                        TextField("myhome.duckdns.org", text: Binding(get: { profile.remoteHost ?? "" }, set: { profile.remoteHost = $0.isEmpty ? nil : $0 }))
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    }
                    TextField(L("外网端口（默认 \(profile.port)）", "Remote port (default \(profile.port))"), text: $remotePortText).keyboardType(.numberPad)
                }

                if let status {
                    Section(L("电脑状态", "Computer")) {
                        row(L("名称", "Name"), status.name)
                        row(L("插件版本", "Bridge version"), status.version)
                        row(L("DSH 主机", "DSH host"), status.upstream?.ok == true ? "OK" : (status.upstream?.error ?? "—"))
                        row(L("内网地址", "LAN"), status.lan.map(\.address).joined(separator: "\n"))
                        row(L("公网 IP", "Public IP"), [status.ddns?.publicIPv4, status.ddns?.publicIPv6].compactMap { $0 }.joined(separator: "\n"))
                        row("DDNS", ddnsText(status.ddns))
                        row("UPnP", upnpText(status.upnp))
                    }
                }

                if bridgeSettings != nil {
                    Section {
                        NavigationLink {
                            DDNSSettingsView(session: session, settings: Binding(get: { bridgeSettings! }, set: { bridgeSettings = $0 })) { saved in
                                // Use the new public address on this phone immediately.
                                if !saved.ddns.hostname.isEmpty {
                                    profile.remoteHost = saved.ddns.hostname
                                    if let port = saved.ddns.publicPort { remotePortText = String(port) }
                                }
                            }
                        } label: { Label(L("DDNS 动态域名", "Dynamic DNS"), systemImage: "globe") }
                        Toggle(L("UPnP 自动端口映射", "UPnP port mapping"), isOn: Binding(get: { bridgeSettings!.upnp.enabled }, set: { bridgeSettings!.upnp.enabled = $0 }))
                        Toggle(L("局域网自动发现", "LAN discovery (Bonjour)"), isOn: Binding(get: { bridgeSettings!.mdns }, set: { bridgeSettings!.mdns = $0 }))
                        Button(L("保存电脑端设置", "Save computer settings")) { Task { await saveBridge() } }.disabled(saving)
                    } header: {
                        Text(L("电脑端设置（远程修改）", "Computer settings (remote)"))
                    } footer: {
                        Text(L("外网访问需要：路由器端口映射（或 UPnP）+ DDNS 域名。", "Remote access needs port forwarding (or UPnP) plus a DDNS host name."))
                    }
                }

                if !devices.isEmpty {
                    Section(L("已配对设备", "Paired devices")) {
                        ForEach(devices) { device in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.name + (device.current == true ? L("（本机）", " (this phone)") : ""))
                                Text(device.lastAddress ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                            .swipeActions {
                                if device.current != true {
                                    Button(role: .destructive) { Task { await removeDevice(device) } } label: { Label(L("移除", "Revoke"), systemImage: "trash") }
                                }
                            }
                        }
                    }
                }

                if let error { Section { Text(error).foregroundStyle(Theme.danger) } }

                Section {
                    Button(L("删除这台电脑", "Remove this computer"), role: .destructive) { confirmRemove = true }
                }
            }
            .scrollContentBackground(.hidden)
            .background(GlassBackdrop())
            .navigationTitle(session.host.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("关闭", "Close")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(L("完成", "Done")) { saveLocal(); dismiss() } }
            }
            .task { await refresh() }
            .confirmationDialog(L("删除后需重新扫码配对。", "You will need to pair again."), isPresented: $confirmRemove, titleVisibility: .visible) {
                Button(L("删除", "Remove"), role: .destructive) {
                    let id = session.host.id
                    Task {
                        // Also revoke this phone on the PC when reachable.
                        try? await session.api.removeDevice(session.host.deviceId)
                        store.remove(id)
                        dismiss()
                        onRemoved()
                    }
                }
            }
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value.isEmpty ? "—" : value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .font(.subheadline)
    }

    private func ddnsText(_ ddns: DdnsStatus?) -> String {
        guard let ddns else { return "—" }
        switch ddns.state {
        case "ok": return ddns.message ?? "OK"
        case "error": return ddns.lastError ?? "error"
        case "disabled": return L("未启用", "Disabled")
        default: return ddns.state ?? "—"
        }
    }

    private func upnpText(_ upnp: UpnpStatus?) -> String {
        guard let upnp else { return "—" }
        switch upnp.state {
        case "mapped": return "\(upnp.externalPort ?? 0) → \(upnp.internalPort ?? 0)"
        case "error": return upnp.error ?? "error"
        default: return L("未启用", "Disabled")
        }
    }

    private func refresh() async {
        guard case .connected = session.state else { return }
        do {
            async let s = session.api.status()
            async let b = session.api.settings()
            async let d = session.api.devices()
            let (fetchedStatus, fetchedSettings, fetchedDevices) = try await (s, b, d)
            status = fetchedStatus
            bridgeSettings = fetchedSettings
            devices = fetchedDevices
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveLocal() {
        profile.lanHosts = lanText.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
        profile.remotePort = Int(remotePortText)
        let updated = profile
        let routeChanged = updated.mode != session.host.mode || updated.lanHosts != session.host.lanHosts
            || updated.remoteHost != session.host.remoteHost || updated.remotePort != session.host.remotePort
        store.update(updated.id) { $0 = updated }
        session.reloadProfile()
        if routeChanged { session.setMode(updated.mode) }
    }

    private func saveBridge() async {
        guard let settings = bridgeSettings else { return }
        saving = true
        defer { saving = false }
        do {
            bridgeSettings = try await session.api.saveSettings(settings)
            status = try? await session.api.status()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func removeDevice(_ device: PairedDevice) async {
        do {
            try await session.api.removeDevice(device.id)
            devices.removeAll { $0.id == device.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
