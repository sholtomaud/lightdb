import Foundation
import SwiftUI

/// One editable setting in a provisioning profile.
struct ConfigField: Identifiable, Equatable {
    /// Key suffix, e.g. "wifi.ssid". Combined with the profile to form the
    /// record key the other device receives.
    let id: String
    let label: String
    let placeholder: String
    let section: String
    var value: String = ""
    var isSecure = false
    var keyboard: UIKeyboardType = .default
    var autocapitalize = false
}

/// A named set of settings destined for an ESP32, Raspberry Pi or similar.
///
/// Values travel as ordinary CRDT records, not a bespoke message type. That is
/// the whole point of having a mergeable log: provisioning reuses the sync path
/// unchanged, the receiving app lists the keys like any other data, and a
/// half-received profile is a valid state rather than a corrupt one.
struct DeviceConfig {
    var profile: String = "device-1"
    var fields: [ConfigField]

    static let template: [ConfigField] = [
        ConfigField(
            id: "wifi.ssid", label: "SSID", placeholder: "network name",
            section: "Wi-Fi"),
        ConfigField(
            id: "wifi.password", label: "Password", placeholder: "network password",
            section: "Wi-Fi", isSecure: true),
        ConfigField(
            id: "wifi.security", label: "Security", placeholder: "WPA2",
            section: "Wi-Fi"),

        ConfigField(
            id: "device.name", label: "Device name", placeholder: "sensor-kitchen",
            section: "Device"),
        ConfigField(
            id: "device.role", label: "Role", placeholder: "sensor",
            section: "Device"),

        ConfigField(
            id: "mqtt.host", label: "Broker host", placeholder: "192.168.1.10",
            section: "MQTT", keyboard: .URL),
        ConfigField(
            id: "mqtt.port", label: "Port", placeholder: "1883",
            section: "MQTT", keyboard: .numberPad),
        ConfigField(
            id: "mqtt.username", label: "Username", placeholder: "optional",
            section: "MQTT"),
        ConfigField(
            id: "mqtt.password", label: "Password", placeholder: "optional",
            section: "MQTT", isSecure: true),
        ConfigField(
            id: "mqtt.topic", label: "Topic prefix", placeholder: "home/sensors",
            section: "MQTT"),

        ConfigField(
            id: "net.static_ip", label: "Static IP", placeholder: "blank for DHCP",
            section: "Network", keyboard: .decimalPad),
        ConfigField(
            id: "net.gateway", label: "Gateway", placeholder: "192.168.1.1",
            section: "Network", keyboard: .decimalPad),
        ConfigField(
            id: "net.ntp", label: "NTP server", placeholder: "pool.ntp.org",
            section: "Network", keyboard: .URL),
        ConfigField(
            id: "net.timezone", label: "Timezone", placeholder: "UTC",
            section: "Network"),
    ]

    init(profile: String = "device-1", fields: [ConfigField] = DeviceConfig.template) {
        self.profile = profile
        self.fields = fields
    }

    /// Section names in template order, without duplicates.
    var sections: [String] {
        var seen = Set<String>()
        return fields.compactMap { seen.insert($0.section).inserted ? $0.section : nil }
    }

    func fields(in section: String) -> [ConfigField] {
        fields.filter { $0.section == section }
    }

    var filledCount: Int {
        fields.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }

    /// Namespaced records. Empty fields are skipped rather than sent blank, so
    /// a partial profile does not overwrite settings already on the far side.
    func records() -> [(key: String, value: String)] {
        let safeProfile = profile.trimmingCharacters(in: .whitespaces)
        let prefix = safeProfile.isEmpty ? "cfg" : "cfg/\(safeProfile)"

        return fields.compactMap { field in
            let trimmed = field.value.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            return (key: "\(prefix)/\(field.id)", value: trimmed)
        }
    }
}
