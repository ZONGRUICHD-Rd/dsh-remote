import Foundation
import Network

enum RouteKind: String {
    case lan
    case remote

    var label: String { self == .lan ? L("内网直连", "LAN") : L("外网", "Remote") }
}

struct RouteCandidate: Hashable {
    var endpoint: BridgeEndpoint
    var kind: RouteKind
    /// Head start the LAN gets before remote candidates are tried (Happy Eyeballs style).
    var delay: TimeInterval
    var timeout: TimeInterval
}

struct ProbeResult {
    var candidate: RouteCandidate
    var handshake: TimeInterval
}

/// Races TLS handshakes (with the pinned certificate) against every candidate
/// address and returns the first that completes, preferring the LAN.
enum EndpointProber {
    static func race(_ candidates: [RouteCandidate], pin: PinPolicy) async -> ProbeResult? {
        guard !candidates.isEmpty else { return nil }
        return await withTaskGroup(of: ProbeResult?.self) { group in
            for candidate in candidates {
                group.addTask { await probe(candidate, pin: pin) }
            }
            var best: ProbeResult?
            for await result in group {
                guard let result else { continue }
                best = result
                group.cancelAll()
                break
            }
            return best
        }
    }

    static func probe(_ candidate: RouteCandidate, pin: PinPolicy) async -> ProbeResult? {
        if candidate.delay > 0 {
            try? await Task.sleep(nanoseconds: UInt64(candidate.delay * 1_000_000_000))
            if Task.isCancelled { return nil }
        }
        let connection = NWConnection(
            to: candidate.endpoint.nwEndpoint,
            using: PinnedTLS.parameters(pin: pin, connectTimeout: max(1, Int(candidate.timeout.rounded(.up))))
        )
        let start = Date()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<ProbeResult?, Never>) in
                let once = OnceFlag()
                let resume: @Sendable (ProbeResult?) -> Void = { value in
                    guard once.claim() else { return }
                    connection.cancel()
                    continuation.resume(returning: value)
                }
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        resume(ProbeResult(candidate: candidate, handshake: Date().timeIntervalSince(start)))
                    case .failed, .cancelled:
                        resume(nil)
                    case .waiting:
                        // No route right now (wrong subnet, offline): give up on this candidate.
                        resume(nil)
                    default:
                        break
                    }
                }
                connection.start(queue: .global(qos: .userInitiated))
                DispatchQueue.global().asyncAfter(deadline: .now() + candidate.timeout) { resume(nil) }
            }
        } onCancel: {
            connection.cancel()
        }
    }
}
