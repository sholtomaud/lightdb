import SwiftUI

/// Device provisioning: enter settings for an ESP32, Pi or similar, then send
/// them over light to whatever is holding a camera up.
struct ProvisionView: View {
    @Environment(AppState.self) private var state
    @State private var model: ProvisionModel?
    @FocusState private var focusedField: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let model {
                    content(model)
                }
            }
            .background(Theme.canvas)
            .navigationTitle("Provision")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear") { model?.reset() }
                        .disabled(!(model?.canTransmit ?? false))
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .task {
            if model == nil {
                let created = ProvisionModel(state: state)
                created.loadExisting()
                model = created
            }
        }
    }

    @ViewBuilder
    private func content(_ model: ProvisionModel) -> some View {
        @Bindable var model = model

        VStack(spacing: Theme.Space.loose) {
            if model.isTransmitting {
                transmitPanel(model)
            }

            profileCard(model)

            ForEach(model.config.sections, id: \.self) { section in
                sectionCard(model, section: section)
            }

            actions(model)
        }
        .padding(Theme.Space.loose)
    }

    // MARK: - transmission

    private func transmitPanel(_ model: ProvisionModel) -> some View {
        Card {
            VStack(spacing: Theme.Space.normal) {
                QRFrameView(image: model.frameImage)
                StatusRow(tone: model.status.tone, message: model.status.message)
                Text("Hold steady until the other device reports it is done.")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - form

    private func profileCard(_ model: ProvisionModel) -> some View {
        @Bindable var model = model

        return VStack(alignment: .leading, spacing: Theme.Space.tight) {
            SectionHeader(title: "Profile", detail: "\(model.config.filledCount) set")
            Card(padding: Theme.Space.normal) {
                field(
                    label: "Name",
                    placeholder: "device-1",
                    text: $model.config.profile,
                    id: "__profile"
                )
            }
            Text("Settings are sent as records named cfg/\(model.config.profile)/…")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private func sectionCard(_ model: ProvisionModel, section: String) -> some View {
        @Bindable var model = model

        return VStack(alignment: .leading, spacing: Theme.Space.tight) {
            SectionHeader(title: section)
            Card(padding: Theme.Space.normal) {
                VStack(spacing: 0) {
                    let indices = model.config.fields.indices.filter {
                        model.config.fields[$0].section == section
                    }
                    ForEach(Array(indices.enumerated()), id: \.element) { position, index in
                        if position > 0 {
                            Divider().overlay(Theme.stroke)
                        }
                        fieldRow(model: model, index: index)
                    }
                }
            }
        }
    }

    private func fieldRow(model: ProvisionModel, index: Int) -> some View {
        @Bindable var model = model
        let descriptor = model.config.fields[index]

        return field(
            label: descriptor.label,
            placeholder: descriptor.placeholder,
            text: $model.config.fields[index].value,
            id: descriptor.id,
            isSecure: descriptor.isSecure,
            keyboard: descriptor.keyboard
        )
    }

    /// A label-above-input row, closer to a desktop settings form than to iOS
    /// grouped-list styling.
    private func field(
        label: String,
        placeholder: String,
        text: Binding<String>,
        id: String,
        isSecure: Bool = false,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.textSecondary)

            Group {
                if isSecure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(keyboard)
            .focused($focusedField, equals: id)
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(Theme.layerAlt)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control)
                    .stroke(focusedField == id ? Theme.accent : Theme.stroke, lineWidth: 1)
            )
        }
        .padding(.vertical, 8)
    }

    // MARK: - actions

    private func actions(_ model: ProvisionModel) -> some View {
        VStack(spacing: Theme.Space.normal) {
            if model.isTransmitting {
                Button("Stop transmitting") { model.stop() }
                    .buttonStyle(FluentSecondaryButton())
            } else {
                Button("Transmit settings") { model.transmit() }
                    .buttonStyle(FluentPrimaryButton())
                    .disabled(!model.canTransmit)

                if !model.canTransmit {
                    Text("Fill in at least one setting to transmit.")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(.top, Theme.Space.tight)
    }
}

#Preview {
    ProvisionView()
        .environment(AppState())
}
