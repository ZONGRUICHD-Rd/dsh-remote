import SwiftUI

@main
struct DSHRemoteApp: App {
    @StateObject private var store = HostStore()
    @StateObject private var discovery = Discovery()
    @StateObject private var router = Router()

    var body: some Scene {
        WindowGroup {
            HostListView()
                .environmentObject(store)
                .environmentObject(discovery)
                .environmentObject(router)
                .tint(Theme.accent)
                .onOpenURL { url in
                    // Scanning the admin-page QR with the system camera opens the app here.
                    if let link = PairingLink(url: url) { router.pairing = link }
                }
        }
    }
}

/// App-wide navigation state.
@MainActor
final class Router: ObservableObject {
    @Published var pairing: PairingLink?
    /// Bonjour result the manual-add sheet should prefill.
    @Published var pendingNearby: DiscoveredBridge?
}
