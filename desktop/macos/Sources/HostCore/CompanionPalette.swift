import SwiftUI

public enum CompanionPalette {
    public static let page = Color(hex: 0xF5F5F3)
    public static let panel = Color(hex: 0xFFFFFF)
    public static let ink = Color(hex: 0x29312F)
    public static let secondary = Color(hex: 0x626B68)
    public static let rule = Color(hex: 0xEBECEC)
    public static let accent = Color(hex: 0xB45138)
    public static let userBubble = Color(hex: 0xFBF4EC)
}

extension Color {
    fileprivate init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}
