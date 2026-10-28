import SwiftUI

/// Add a computer without the QR code: a Bonjour result or a typed address,
/// plus the 6-digit pairing code from `/remote`.
struct ManualAddView: View {
    var nearby: DiscoveredBridge?
    var onLink: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var port = "39090"
    @State private var code = ""
    @State private var tls = true
    @State private var resolving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let nearby {
                    Section(L("附近的电脑", "Nearby computer")) {
                        Label(nearby.name, systemImage: "desktopcomputer")
                    }
                } else {
                    Section {
                        TextField(L("IP 地址或域名", "IP address or host name"), text: $address)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        TextField(L("端口", "Port"), text: $port).keyboardType(.numberPad)
                        Toggle(L("TLS 加密", "TLS"), isOn: $tls)
                    } header: {
                        Text(L("电脑地址", "Computer address"))
                    } footer: {
                        Text(L("局域网 IP（如 192.168.1.10）或 DDNS 域名。电脑上输入 /remote 可查看。", "LAN IP (e.g. 192.168.1.10) or DDNS host name. Type /remote on the PC to see it."))
                    }
                }
                Section {
                    TextField("123456", text: $code)
                        .keyboardType(.numberPad)
                        .font(.system(.title2, design: .monospaced))
                } header: {
                    Text(L("配对码", "Pairing code"))
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.danger) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack { Spacer(); if resolving { ProgressView() } else { Text(L("下一步", "Continue")).bold() }; Spacer() }
                    }
                    .disabled(code.filter(\.isNumber).count != 6 || (nearby == nil && address.trimmingCharacters(in: .whitespaces).isEmpty) || resolving)
                }
            }
            .navigationTitle(L("添加电脑", "Add computer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("取消", "Cancel")) { dismiss() } } }
        }
    }

    private func submit() async {
        error = nil
        let digits = String(code.filter(\.isNumber))
        if let nearby {
            resolving = true
            defer { resolving = false }
            guard let resolved = await resolveService(nearby.endpoint, tls: nearby.tls) else {
                error = L("无法解析这台电脑的地址，请改用手动输入。", "Could not resolve the computer. Enter its address manually.")
                return
            }
            onLink(PairingLink(name: nearby.name, hostId: nearby.hostId, lanHosts: [resolved.host], port: resolved.port, code: digits,
                               fingerprint: nil, tls: nearby.tls, remoteHost: nil, remotePort: nil))
            return
        }
        guard let portNumber = Int(port), (1...65535).contains(portNumber) else {
            error = L("端口无效", "Invalid port")
            return
        }
        var host = address.trimmingCharacters(in: .whitespaces)
        if let url = URL(string: host), let parsed = url.host { host = parsed }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let local = isLocalAddress(host)
        onLink(PairingLink(name: host, hostId: "", lanHosts: local ? [host] : [], port: portNumber, code: digits,
                           fingerprint: nil, tls: tls, remoteHost: local ? nil : host, remotePort: local ? nil : portNumber))
    }
}

/// Private/link-local IPs and mDNS names count as LAN routes.
func isLocalAddress(_ host: String) -> Bool {
    if host.hasSuffix(".local") { return true }
    let parts = host.split(separator: ".").compactMap { Int($0) }
    if parts.count == 4 {
        switch (parts[0], parts[1]) {
        case (10, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        case (100, 64...127): return true // CGNAT / Tailscale
        default: return false
        }
    }
    let lower = host.lowercased()
    return lower.hasPrefix("fe80") || lower.hasPrefix("fd") || lower.hasPrefix("fc")
}
