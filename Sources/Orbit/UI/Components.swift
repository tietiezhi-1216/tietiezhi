//  Components.swift
//  Small shared SwiftUI pieces used across the settings sections.

import SwiftUI

/// A secure text field with an eye toggle to reveal the value (for API keys).
struct RevealableSecureField: View {
    let title: String
    @Binding var text: String
    @State private var reveal = false

    var body: some View {
        // The reveal toggle lives INSIDE the field's trailing edge, so the field
        // is the same width as the plain fields around it.
        Group {
            if reveal {
                TextField(title, text: $text)
            } else {
                SecureField(title, text: $text)
            }
        }
        .textFieldStyle(.roundedBorder)
        .overlay(alignment: .trailing) {
            Button {
                reveal.toggle()
            } label: {
                Image(systemName: reveal ? "eye.slash" : "eye")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(reveal ? "隐藏" : "显示")
        }
    }
}
