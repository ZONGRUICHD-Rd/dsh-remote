import Foundation

/// Contents of the `dshremote://pair?...` QR code shown on the PC admin page.
struct PairingLink: Equatable, Identifiable {
    var id: String { "\(hostId)-\(code)" }
    var name: String
    var hostId: String
    var lanHosts: [String]
    var port: Int
    var code: String
    var fingerprint: String?
    var tls: Bool
    var remoteHost: String?
    var remotePort: Int?

    init?(url: URL) {
        guard url.scheme?.lowercased() == "dshremote",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var q: [String: String] = [:]
        for item in components.queryItems ?? [] { q[item.name] = item.value ?? "" }
        guard let id = q["id"], !id.isEmpty, let code = q["c"], code.count == 6,
              let portText = q["p"], let port = Int(portText) else { return nil }
        hostId = id
        name = q["n"].flatMap { $0.isEmpty ? nil : $0 } ?? "DSH"
        lanHosts = (q["h"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        self.port = port
        self.code = code
        tls = q["tls"] != "0"
        fingerprint = q["fp"].flatMap { $0.count == 64 ? $0.lowercased() : nil }
        if tls && fingerprint == nil { return nil }
        remoteHost = q["r"].flatMap { $0.isEmpty ? nil : $0 }
        remotePort = q["rp"].flatMap(Int.init)
    }

    init(name: String, hostId: String, lanHosts: [String], port: Int, code: String, fingerprint: String?, tls: Bool, remoteHost: String?, remotePort: Int?) {
        self.name = name
        self.hostId = hostId
        self.lanHosts = lanHosts
        self.port = port
        self.code = code
        self.fingerprint = fingerprint
        self.tls = tls
        self.remoteHost = remoteHost
        self.remotePort = remotePort
    }
}
