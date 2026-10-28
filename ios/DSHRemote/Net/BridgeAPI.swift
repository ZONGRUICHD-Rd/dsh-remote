import Foundation

struct BridgeInfo: Decodable {
    var app: String
    var `protocol`: Int
    var version: String
    var name: String
    var hostId: String
    var tls: Bool
    var fingerprint: String?
}

struct RemoteEndpointInfo: Decodable {
    var host: String?
    var port: Int?
    var ip: String?
}

struct PairResult: Decodable {
    var name: String
    var hostId: String
    var fingerprint: String?
    var deviceId: String
    var token: String
    var port: Int
    var lan: [String]
    var remote: RemoteEndpointInfo?
}

struct UpstreamStatus: Decodable { var ok: Bool; var error: String? }

struct DdnsStatus: Decodable {
    var state: String?
    var publicIPv4: String?
    var publicIPv6: String?
    var lastUpdate: String?
    var lastError: String?
    var message: String?
}

struct UpnpStatus: Decodable {
    var state: String?
    var externalPort: Int?
    var internalPort: Int?
    var externalIp: String?
    var error: String?
}

struct LanAddress: Decodable, Hashable { var address: String; var interface: String? }

struct BridgeStatus: Decodable {
    var name: String
    var hostId: String
    var version: String
    var port: Int
    var tls: Bool
    var fingerprint: String?
    var listening: Bool?
    var lan: [LanAddress]
    var mdns: Bool?
    var upnp: UpnpStatus?
    var ddns: DdnsStatus?
    var remote: RemoteEndpointInfo?
    var devices: Int?
    var upstream: UpstreamStatus?
}

/// Accepts strings, booleans and numbers for free-form DDNS provider options.
struct LenientString: Codable, Hashable {
    var value: String
    init(_ value: String) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let b = try? c.decode(Bool.self) { value = b ? "true" : "false" }
        else if let d = try? c.decode(Double.self) { value = String(d) }
        else { value = "" }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

struct BridgeSettings: Codable {
    struct Upnp: Codable {
        var enabled: Bool
        var externalPort: Int?
        var leaseSeconds: Int

        // Encode nil as JSON null so clearing a field reaches the bridge.
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(enabled, forKey: .enabled)
            try c.encode(externalPort, forKey: .externalPort)
            try c.encode(leaseSeconds, forKey: .leaseSeconds)
        }
    }
    struct Ddns: Codable {
        var enabled: Bool
        var provider: String
        var hostname: String
        var publicPort: Int?
        var intervalSeconds: Int
        var ipv6: Bool
        var options: [String: LenientString]

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(enabled, forKey: .enabled)
            try c.encode(provider, forKey: .provider)
            try c.encode(hostname, forKey: .hostname)
            try c.encode(publicPort, forKey: .publicPort)
            try c.encode(intervalSeconds, forKey: .intervalSeconds)
            try c.encode(ipv6, forKey: .ipv6)
            try c.encode(options, forKey: .options)
        }
    }
    var name: String
    var port: Int
    var tls: Bool
    var mdns: Bool
    var upnp: Upnp
    var ddns: Ddns

    static let secretPlaceholder = "__dsh_remote_secret_unchanged__"
}

struct PairedDevice: Decodable, Identifiable {
    var id: String
    var name: String
    var createdAt: String?
    var lastSeenAt: String?
    var lastAddress: String?
    var current: Bool?
}

enum BridgeError: LocalizedError {
    case http(Int, String)
    case unauthorized
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .http(let code, let message): return message.isEmpty ? "HTTP \(code)" : message
        case .unauthorized: return L("此设备已被电脑移除，请重新配对。", "This device was removed on the PC. Pair again.")
        case .invalidResponse: return L("电脑返回了无法识别的响应。", "Unexpected response from the PC.")
        }
    }
}

/// JSON API of the bridge, reached through a local `TunnelServer`.
struct BridgeAPI {
    let baseURL: URL
    var session: URLSession = BridgeAPI.sharedSession

    static let sharedSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12
        config.httpMaximumConnectionsPerHost = 4
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private func request<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil, as: T.Type) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent("__dsh_remote").appendingPathComponent(path))
        req.httpMethod = method
        if let body {
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.invalidResponse }
        if http.statusCode == 401 { throw BridgeError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw BridgeError.http(http.statusCode, message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw BridgeError.invalidResponse
        }
    }

    func info() async throws -> BridgeInfo { try await request("GET", "info", as: BridgeInfo.self) }

    func pair(code: String, deviceName: String) async throws -> PairResult {
        try await request("POST", "pair", body: ["code": code, "deviceName": deviceName], as: PairResult.self)
    }

    func status() async throws -> BridgeStatus { try await request("GET", "api/status", as: BridgeStatus.self) }

    /// Round-trip time of a tiny authenticated request over the live route.
    func ping() async throws -> TimeInterval {
        let start = Date()
        struct Pong: Decodable { var t: Double }
        _ = try await request("GET", "api/ping", as: Pong.self)
        return Date().timeIntervalSince(start)
    }

    func settings() async throws -> BridgeSettings { try await request("GET", "api/settings", as: BridgeSettings.self) }

    func saveSettings(_ settings: BridgeSettings) async throws -> BridgeSettings {
        struct Saved: Decodable { var settings: BridgeSettings }
        return try await request("PUT", "api/settings", body: settings, as: Saved.self).settings
    }

    func forceDdnsUpdate() async throws -> DdnsStatus { try await request("POST", "api/ddns/update", as: DdnsStatus.self) }

    func devices() async throws -> [PairedDevice] { try await request("GET", "api/devices", as: [PairedDevice].self) }

    func removeDevice(_ id: String) async throws {
        struct Removed: Decodable { var removed: Bool }
        _ = try await request("DELETE", "api/devices/\(id)", as: Removed.self)
    }
}

private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
