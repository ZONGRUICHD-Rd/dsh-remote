import Foundation

enum ConnectionMode: String, Codable, CaseIterable, Identifiable {
    /// Prefer LAN (Bonjour / last known IPs), fall back to the DDNS address.
    case auto
    case lanOnly
    case remoteOnly

    var id: String { rawValue }
    var title: String {
        switch self {
        case .auto: return L("自动（优先内网）", "Automatic (LAN first)")
        case .lanOnly: return L("仅内网直连", "LAN only")
        case .remoteOnly: return L("仅外网 / DDNS", "Remote / DDNS only")
        }
    }
}

enum LayoutMode: String, Codable, CaseIterable, Identifiable {
    /// DSH at device width (narrow layout, no zoom).
    case mobile
    /// DSH rendered at desktop width and scaled to fit, exactly like the PC window.
    case desktop

    var id: String { rawValue }
    var title: String {
        switch self {
        case .mobile: return L("手机宽度", "Phone width")
        case .desktop: return L("桌面宽度（与电脑完全一致）", "Desktop width (identical to PC)")
        }
    }
}

/// A paired computer. The device token lives in the Keychain, never here.
struct HostProfile: Codable, Identifiable, Hashable {
    var id: String                 // bridge hostId
    var name: String
    var deviceId: String
    var fingerprint: String?       // SHA-256 of the bridge certificate; nil when TLS is off
    var port: Int
    var lanHosts: [String]
    var remoteHost: String?
    var remotePort: Int?
    var mode: ConnectionMode = .auto
    var layout: LayoutMode = .mobile
    var desktopWidth: Int = 1100
    var lastConnectedAt: Date?
    var lastRoute: String?

    var usesTLS: Bool { fingerprint != nil }
    var pin: PinPolicy { fingerprint.map { .fingerprint($0) } ?? .plaintext }

    /// Stable loopback port per host so each PC keeps its own web storage origin.
    var localPort: UInt16 {
        var hash: UInt32 = 2166136261
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
        return UInt16(41000 + hash % 4000)
    }

    var remoteEndpoint: BridgeEndpoint? {
        guard let host = remoteHost, !host.isEmpty else { return nil }
        return .hostPort(host: host, port: remotePort ?? port)
    }
}

func L(_ zh: String, _ en: String) -> String {
    let preferred = Locale.preferredLanguages.first ?? "en"
    return preferred.hasPrefix("zh") ? zh : en
}
