import SwiftUI

/// Edits the PC's DDNS configuration through the bridge API.
struct DDNSSettingsView: View {
    @ObservedObject var session: RemoteSession
    @Binding var settings: BridgeSettings
    var onSaved: (BridgeSettings) -> Void

    @State private var options: [String: String] = [:]
    @State private var publicPortText = ""
    @State private var saving = false
    @State private var message: String?
    @State private var isError = false

    struct Field { var key: String; var label: String; var secret: Bool = false; var placeholder: String = "" }

    static let providers: [(id: String, name: String)] = [
        ("none", L("不使用", "None")),
        ("duckdns", "DuckDNS"),
        ("cloudflare", "Cloudflare"),
        ("dnspod", L("DNSPod（腾讯云）", "DNSPod (Tencent)")),
        ("aliyun", L("阿里云 DNS", "Aliyun DNS")),
        ("dyndns2", "DynDNS2 (No-IP / Dynu / 花生壳)"),
        ("webhook", "Webhook"),
    ]

    static func fields(_ provider: String) -> [Field] {
        switch provider {
        case "duckdns": return [Field(key: "domains", label: L("子域名", "Domains"), placeholder: "myhome"), Field(key: "token", label: "Token", secret: true)]
        case "cloudflare": return [Field(key: "apiToken", label: "API Token", secret: true), Field(key: "zone", label: "Zone", placeholder: "example.com"), Field(key: "record", label: L("记录", "Record"), placeholder: "home.example.com")]
        case "dnspod": return [Field(key: "tokenId", label: "Token ID"), Field(key: "token", label: "Token", secret: true), Field(key: "domain", label: L("域名", "Domain"), placeholder: "example.com"), Field(key: "subDomain", label: L("主机记录", "Sub domain"), placeholder: "home")]
        case "aliyun": return [Field(key: "accessKeyId", label: "AccessKey ID"), Field(key: "accessKeySecret", label: "AccessKey Secret", secret: true), Field(key: "domain", label: L("域名", "Domain"), placeholder: "example.com"), Field(key: "rr", label: L("主机记录", "RR"), placeholder: "home")]
        case "dyndns2": return [Field(key: "server", label: L("服务器", "Server"), placeholder: "dynupdate.no-ip.com"), Field(key: "username", label: L("用户名", "Username")), Field(key: "password", label: L("密码", "Password"), secret: true), Field(key: "hostname", label: L("主机名", "Hostname"), placeholder: "myhome.ddns.net")]
        case "webhook": return [Field(key: "url", label: "URL", placeholder: "https://…?ip={ip}"), Field(key: "method", label: "Method", placeholder: "GET"), Field(key: "body", label: "Body")]
        default: return []
        }
    }

    var body: some View {
        Form {
            Section {
                Toggle(L("启用 DDNS", "Enable DDNS"), isOn: $settings.ddns.enabled)
                Picker(L("服务商", "Provider"), selection: Binding(get: { settings.ddns.provider }, set: { newValue in
                    settings.ddns.provider = newValue
                    options = [:]
                })) {
                    ForEach(Self.providers, id: \.id) { Text($0.name).tag($0.id) }
                }
            }
            Section {
                ForEach(Self.fields(settings.ddns.provider), id: \.key) { field in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(field.label).font(.caption).foregroundStyle(.secondary)
                        if field.secret {
                            SecureField(options[field.key] == BridgeSettings.secretPlaceholder ? L("已设置（留空不修改）", "Set (leave to keep)") : field.placeholder,
                                        text: Binding(get: { options[field.key] == BridgeSettings.secretPlaceholder ? "" : (options[field.key] ?? "") },
                                                      set: { options[field.key] = $0.isEmpty && settings.ddns.options[field.key]?.value == BridgeSettings.secretPlaceholder ? BridgeSettings.secretPlaceholder : $0 }))
                        } else {
                            TextField(field.placeholder, text: Binding(get: { options[field.key] ?? "" }, set: { options[field.key] = $0 }))
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    }
                }
            } header: {
                Text(L("账号", "Account"))
            }
            Section {
                TextField("myhome.duckdns.org", text: $settings.ddns.hostname).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField(L("外网端口（留空=自动）", "Public port (empty = automatic)"), text: $publicPortText).keyboardType(.numberPad)
                Stepper(value: $settings.ddns.intervalSeconds, in: 60...3600, step: 60) {
                    Text(L("检查间隔 \(settings.ddns.intervalSeconds / 60) 分钟", "Check every \(settings.ddns.intervalSeconds / 60) min"))
                }
                Toggle("IPv6 (AAAA)", isOn: $settings.ddns.ipv6)
            } header: {
                Text(L("App 外网连接地址", "Address used by the app"))
            } footer: {
                Text(L("保存后手机会自动使用该域名作为外网线路。", "After saving, this phone uses the host name as its remote route."))
            }
            if let message {
                Section { Text(message).foregroundStyle(isError ? Theme.danger : Theme.ok) }
            }
            Section {
                Button(L("保存", "Save")) { Task { await save() } }.disabled(saving)
                Button(L("立即更新 DNS", "Update DNS now")) { Task { await updateNow() } }.disabled(saving)
            }
        }
        .navigationTitle("DDNS")
        .onAppear {
            options = settings.ddns.options.mapValues(\.value)
            publicPortText = settings.ddns.publicPort.map(String.init) ?? ""
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var next = settings
        next.ddns.options = options.mapValues { LenientString($0) }
        next.ddns.publicPort = Int(publicPortText)
        do {
            let saved = try await session.api.saveSettings(next)
            settings = saved
            options = saved.ddns.options.mapValues(\.value)
            onSaved(saved)
            isError = false
            message = L("已保存", "Saved")
        } catch {
            isError = true
            message = error.localizedDescription
        }
    }

    private func updateNow() async {
        saving = true
        defer { saving = false }
        do {
            let status = try await session.api.forceDdnsUpdate()
            isError = status.state == "error"
            message = status.state == "error" ? (status.lastError ?? "error") : ([status.message, status.publicIPv4].compactMap { $0 }.joined(separator: " · "))
        } catch {
            isError = true
            message = error.localizedDescription
        }
    }
}
