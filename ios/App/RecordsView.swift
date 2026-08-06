import SwiftUI

/// Everything this replica holds, whatever screen put it there.
struct RecordsView: View {
    @Environment(AppState.self) private var state
    @State private var query = ""

    private var filtered: [Record] {
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !trimmed.isEmpty else { return state.records }
        return state.records.filter {
            $0.key.lowercased().contains(trimmed) || $0.value.lowercased().contains(trimmed)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Space.loose) {
                    summary

                    if state.records.isEmpty {
                        empty
                    } else {
                        recordList
                    }
                }
                .padding(Theme.Space.loose)
            }
            .background(Theme.canvas)
            .navigationTitle("Records")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "Filter records")
        }
    }

    private var summary: some View {
        Card(padding: Theme.Space.normal) {
            HStack(spacing: 0) {
                stat(value: "\(state.recordCount)", label: "records")
                divider
                stat(value: "\(state.opCount)", label: "operations")
                divider
                stat(value: String(state.actorId.prefix(6)), label: "replica")
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Theme.stroke)
            .frame(width: 1, height: 32)
    }

    private func stat(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
            Text(label)
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var empty: some View {
        Card {
            VStack(spacing: Theme.Space.tight) {
                Image(systemName: "tray")
                    .font(.system(size: 32))
                    .foregroundStyle(Theme.textSecondary)
                Text("No records yet")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Theme.text)
                Text("Provision a device, or receive a sync from the web app.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.normal)
        }
    }

    private var recordList: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(filtered.enumerated()), id: \.offset) { index, record in
                    if index > 0 {
                        Divider().overlay(Theme.stroke)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(record.key)
                            .font(.caption.monospaced())
                            .foregroundStyle(Theme.accent)
                        Text(record.value)
                            .font(.callout)
                            .foregroundStyle(Theme.text)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Space.normal)
                }
            }
        }
    }
}

#Preview {
    RecordsView()
        .environment(AppState())
}
