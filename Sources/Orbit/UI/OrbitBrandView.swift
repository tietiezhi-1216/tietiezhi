//  OrbitBrandView.swift
//  Shared brand header pieces that use the real bundled app icon instead of an
//  emoji placeholder.

import SwiftUI
import AppKit

struct OrbitAppIconView: View {
    var size: CGFloat = 20

    private var icon: NSImage? { OrbitAppIconView.loadIcon() }

    var body: some View {
        Group {
            if let icon {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "circle")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .stroke(.white.opacity(0.18), lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }

    private static func loadIcon() -> NSImage? {
        if let url = Bundle.main.url(forResource: "Orbit", withExtension: "icns"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        return NSImage(named: NSImage.applicationIconName)
    }
}

/// The assistant avatar: Orbit's "O" ring with a satellite riding on it — the
/// same brand geometry as the menu-bar mark. The satellite orbits while a reply
/// is streaming (a small "thinking" motion), and rests at 3 o'clock otherwise.
struct OrbitAvatar: View {
    var size: CGFloat = 22
    var spinning: Bool = false
    var color: Color = .accentColor

    @State private var angle: Double = 0

    private var ringDiameter: CGFloat { size * 0.72 }
    private var satelliteSize: CGFloat { size * 0.22 }

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(color.opacity(0.85), lineWidth: max(1.4, size * 0.1))
                .frame(width: ringDiameter, height: ringDiameter)

            // Satellite offset onto the ring; rotate the whole layer so it orbits.
            ZStack {
                Circle()
                    .fill(color)
                    .frame(width: satelliteSize, height: satelliteSize)
                    .offset(x: ringDiameter / 2)
            }
            .frame(width: size, height: size)
            .rotationEffect(.degrees(angle))
        }
        .frame(width: size, height: size)
        .onAppear { if spinning { startSpin() } }
        .onChange(of: spinning) { _, on in on ? startSpin() : stopSpin() }
        .accessibilityHidden(true)
    }

    private func startSpin() {
        angle = 0
        withAnimation(.linear(duration: 3).repeatForever(autoreverses: false)) { angle = 360 }
    }
    private func stopSpin() {
        withAnimation(.easeOut(duration: 0.3)) { angle = 0 }
    }
}

struct OrbitBrandTitle: View {
    var iconSize: CGFloat = 20
    var fontSize: CGFloat = 15

    var body: some View {
        HStack(spacing: 8) {
            OrbitAppIconView(size: iconSize)
            Text("Orbit")
                .font(.system(size: fontSize, weight: .semibold, design: .rounded))
                .kerning(0.1)
                .foregroundStyle(.primary)
        }
    }
}
