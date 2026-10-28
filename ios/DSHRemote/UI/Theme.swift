import SwiftUI

/// Colors and shapes taken from the DSH web UI (ui-theme tokens) so native
/// screens sit seamlessly around the embedded DSH interface.
enum Theme {
    static let accent = Color(red: 0x4d / 255, green: 0x6b / 255, blue: 0xfe / 255)
    static let background = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x15 / 255, green: 0x15 / 255, blue: 0x17 / 255, alpha: 1)
        : UIColor(red: 0xf7 / 255, green: 0xf7 / 255, blue: 0xf8 / 255, alpha: 1) })
    static let panel = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x21 / 255, alpha: 1)
        : UIColor.white })
    static let border = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x2e / 255, green: 0x2e / 255, blue: 0x33 / 255, alpha: 1)
        : UIColor(red: 0xe4 / 255, green: 0xe4 / 255, blue: 0xe7 / 255, alpha: 1) })
    static let radius: CGFloat = 16
    static let ok = Color(red: 0.09, green: 0.64, blue: 0.29)
    static let danger = Color(red: 0.86, green: 0.15, blue: 0.15)
}

struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(Theme.panel)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(Theme.border, lineWidth: 1))
    }
}

extension View {
    func card() -> some View { modifier(CardModifier()) }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct StatusDot: View {
    var color: Color
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
    }
}
