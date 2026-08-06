import SwiftUI

/// A restrained, Fluent-influenced palette.
///
/// Deliberately not iOS-default: flatter surfaces, tighter corner radii (4pt
/// for controls, 8pt for cards rather than the usual 12-16), a single
/// communication-blue accent, and neutral greys that sit still. The reference
/// points are Microsoft Authenticator and the Office apps on iOS -- native
/// enough to feel right, plain enough to read as a tool rather than a toy.
///
/// Every colour is dynamic, so light and dark both work without a second
/// definition at each call site.
enum Theme {
    // MARK: - surfaces

    /// Page background, behind everything.
    static let canvas = dynamic(light: 0xF5F5F5, dark: 0x141414)
    /// Cards and grouped rows.
    static let layer = dynamic(light: 0xFFFFFF, dark: 0x1F1F1F)
    /// Raised elements on a card: field backgrounds, chips.
    static let layerAlt = dynamic(light: 0xF0F0F0, dark: 0x292929)
    /// Hairlines and card borders.
    static let stroke = dynamic(light: 0xE0E0E0, dark: 0x333333)

    // MARK: - text

    static let text = dynamic(light: 0x242424, dark: 0xFFFFFF)
    static let textSecondary = dynamic(light: 0x616161, dark: 0xADADAD)
    static let textDisabled = dynamic(light: 0xBDBDBD, dark: 0x5C5C5C)

    // MARK: - semantic

    static let accent = dynamic(light: 0x0F6CBD, dark: 0x479EF5)
    static let accentPressed = dynamic(light: 0x115EA3, dark: 0x62ABF5)
    static let success = dynamic(light: 0x0E700E, dark: 0x54B054)
    static let warning = dynamic(light: 0xBC4B09, dark: 0xDB7500)
    static let danger = dynamic(light: 0xC50F1F, dark: 0xDC626D)

    // MARK: - metrics

    enum Radius {
        static let control: CGFloat = 4
        static let card: CGFloat = 8
    }

    enum Space {
        static let tight: CGFloat = 8
        static let normal: CGFloat = 12
        static let loose: CGFloat = 16
        static let section: CGFloat = 24
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(hex: dark) : UIColor(hex: light)
            })
    }
}

extension UIColor {
    fileprivate convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - components

/// A bordered surface. Flat by default; Fluent leans on borders, not shadows.
struct Card<Content: View>: View {
    var padding: CGFloat = Theme.Space.loose
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.layer)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.card)
                    .stroke(Theme.stroke, lineWidth: 1)
            )
    }
}

struct SectionHeader: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .kerning(0.6)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }
}

struct FluentPrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? Color.white : Theme.textDisabled)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(background(pressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
    }

    private func background(pressed: Bool) -> Color {
        guard isEnabled else { return Theme.layerAlt }
        return pressed ? Theme.accentPressed : Theme.accent
    }
}

struct FluentSecondaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(isEnabled ? Theme.text : Theme.textDisabled)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(configuration.isPressed ? Theme.layerAlt : Theme.layer)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control)
                    .stroke(Theme.stroke, lineWidth: 1)
            )
    }
}

/// Status pill: a colour-coded dot plus a line of text.
struct StatusRow: View {
    enum Tone {
        case neutral, active, good, bad

        var color: Color {
            switch self {
            case .neutral: return Theme.textSecondary
            case .active: return Theme.accent
            case .good: return Theme.success
            case .bad: return Theme.danger
            }
        }
    }

    let tone: Tone
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.tight) {
            Circle()
                .fill(tone.color)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            Text(message)
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
