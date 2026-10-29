import SwiftUI

/// Colors taken from the DSH web UI (ui-theme tokens) so native screens sit
/// seamlessly around the embedded DSH interface. Native chrome uses iOS 26
/// Liquid Glass; older systems fall back to materials.
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
    static let radius: CGFloat = 22
    static let ok = Color(red: 0.09, green: 0.64, blue: 0.29)
    static let danger = Color(red: 0.86, green: 0.15, blue: 0.15)
}

/// Soft DSH-blue backdrop that gives Liquid Glass surfaces something to refract.
struct GlassBackdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Theme.background
            Circle()
                .fill(Theme.accent.opacity(scheme == .dark ? 0.45 : 0.28))
                .frame(width: 420, height: 420)
                .blur(radius: 90)
                .offset(x: -140, y: -260)
            Circle()
                .fill(Color(red: 0.55, green: 0.36, blue: 0.98).opacity(scheme == .dark ? 0.32 : 0.18))
                .frame(width: 360, height: 360)
                .blur(radius: 90)
                .offset(x: 160, y: 120)
            Circle()
                .fill(Color(red: 0.2, green: 0.75, blue: 0.95).opacity(scheme == .dark ? 0.22 : 0.14))
                .frame(width: 300, height: 300)
                .blur(radius: 80)
                .offset(x: -120, y: 380)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// Liquid Glass in `shape` (iOS 26), or a thin material on older systems.
    @ViewBuilder
    func dshGlass<S: Shape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.makeGlass(tint: tint, interactive: interactive), in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Theme.border.opacity(0.7), lineWidth: 0.5))
        }
    }

    func dshGlass(tint: Color? = nil, interactive: Bool = false) -> some View {
        dshGlass(in: Capsule(), tint: tint, interactive: interactive)
    }

    @available(iOS 26.0, *)
    private static func makeGlass(tint: Color?, interactive: Bool) -> Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }

    /// Content card: a Liquid Glass panel.
    func card() -> some View {
        padding(18).dshGlass(in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }

    /// Full-width primary action: `.glassProminent` tinted with the DSH accent.
    @ViewBuilder
    func dshProminentButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent).controlSize(.large).tint(Theme.accent)
        } else {
            self.buttonStyle(PrimaryButtonStyle())
        }
    }

    /// Secondary action: `.glass`.
    @ViewBuilder
    func dshGlassButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass).controlSize(.large)
        } else {
            self.buttonStyle(.bordered).controlSize(.large)
        }
    }
}

/// Pre-iOS 26 primary button.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct StatusDot: View {
    var color: Color
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
            .shadow(color: color.opacity(0.6), radius: 3)
    }
}
