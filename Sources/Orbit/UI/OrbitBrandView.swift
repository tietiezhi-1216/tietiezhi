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

/// Geometry of Orbit's animated chat mark, as fractions of the drawing side.
/// Tuned interactively; keep it here so the mark stays consistent everywhere it
/// renders. (The menu-bar `StatusBarIcon` keeps its own hand-tuned values — it's
/// a tiny monochrome template where a hairline ring wouldn't read.)
enum OrbitGeometry {
    static let ringRadius: CGFloat = 0.320   // "O" radius — a touch larger
    static let ringWidth:  CGFloat = 0.095   // stroke weight — bolder, reads at 13–20pt
    static let orbit:      CGFloat = 0.330   // satellite distance from center
    static let satellite:  CGFloat = 0.100   // satellite radius — chunkier dot
    static let clearance:  CGFloat = 0.135   // gap carved out of the ring (fits the dot)
    static let angle:      CGFloat = 0        // 0 = 3 o'clock (radians)
}

/// Orbit's brand mark — the "O" ring broken by a gap with a satellite nestled in
/// it, aimed at the center (the same geometry as the menu-bar mark / app icon).
/// Filled with a dreamy iridescent sweep whose colors flow continuously so the
/// mark is always alive. While a reply is streaming it gains motion on top: the
/// satellite orbits and the whole mark breathes.
struct OrbitMark: View {
    var size: CGFloat = 16
    var active: Bool = false

    @State private var spin: Double = 0        // satellite orbiting the ring
    @State private var hue: Double = 0         // iridescent hue cycling in place
    @State private var breathe: CGFloat = 1    // pulse

    /// A seamless iridescent loop (first == last so the sweep never seams).
    private static let iris: [Color] = [
        Color(red: 0.40, green: 0.52, blue: 1.00),   // periwinkle
        Color(red: 0.62, green: 0.40, blue: 1.00),   // violet
        Color(red: 0.96, green: 0.44, blue: 0.86),   // magenta
        Color(red: 1.00, green: 0.56, blue: 0.52),   // coral
        Color(red: 0.45, green: 0.86, blue: 0.96),   // cyan
        Color(red: 0.44, green: 0.96, blue: 0.76),   // mint
        Color(red: 0.40, green: 0.52, blue: 1.00),   // back to periwinkle
    ]

    var body: some View {
        // The iridescent field, revealed only through the mark's silhouette. The
        // colors flow via a continuous `hueRotation` (cycling in place), so the
        // shimmer is fully independent of the satellite's orbit — the ring can be
        // still while the color keeps moving.
        Rectangle()
            .fill(AngularGradient(gradient: Gradient(colors: Self.iris),
                                  center: .center, angle: .degrees(45)))
            .frame(width: size, height: size)
            .mask {
                OrbitGlyph()
                    .frame(width: size, height: size)
                    .rotationEffect(.degrees(spin))
            }
            .hueRotation(.degrees(hue))
            .scaleEffect(breathe)
            .onAppear {
                // Color always flows — even under a finished reply the mark lives.
                withAnimation(.linear(duration: 3).repeatForever(autoreverses: false)) {
                    hue = 360
                }
                startSpin()                 // always orbiting — slow at rest
                if active { startBreathe() }
            }
            .onChange(of: active) { _, on in
                startSpin()                 // switch orbit speed (slow ↔ fast)
                on ? startBreathe() : stopBreathe()
            }
            .accessibilityHidden(true)
    }

    /// The satellite ALWAYS orbits — a slow drift at rest so the mark never looks
    /// frozen, speeding up while a reply streams. Restarting from the current angle
    /// (`base`) means a speed change never snaps the satellite back.
    private func startSpin() {
        let base = spin.truncatingRemainder(dividingBy: 360)
        spin = base
        withAnimation(.linear(duration: active ? 2.2 : 11).repeatForever(autoreverses: false)) {
            spin = base + 360
        }
    }
    /// Streaming adds a gentle breathing pulse on top of the faster orbit.
    private func startBreathe() {
        withAnimation(.easeInOut(duration: 1.25).repeatForever(autoreverses: true)) { breathe = 1.12 }
    }
    private func stopBreathe() {
        withAnimation(.easeOut(duration: 0.5)) { breathe = 1 }
    }
}

/// The mark's silhouette: an "O" ring with a circular gap carved out and a
/// satellite disc riding in the gap, aimed at the center. Drawn as opaque shapes
/// so it works as an alpha mask; shares `OrbitGeometry` with the menu-bar icon.
private struct OrbitGlyph: View {
    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height)
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let ringR = OrbitGeometry.ringRadius * s
            let ringW = OrbitGeometry.ringWidth * s
            let orbit = OrbitGeometry.orbit * s
            let satR  = OrbitGeometry.satellite * s
            let clr   = OrbitGeometry.clearance * s
            let sat = CGPoint(x: c.x + orbit * cos(OrbitGeometry.angle),
                              y: c.y + orbit * sin(OrbitGeometry.angle))

            // Stroke the ring, but clip out a disc around the satellite first so a
            // clean gap opens up where the satellite rides.
            ctx.drawLayer { layer in
                var clip = Path(CGRect(origin: .zero, size: size))
                clip.addEllipse(in: CGRect(x: sat.x - clr, y: sat.y - clr,
                                           width: clr * 2, height: clr * 2))
                layer.clip(to: clip, style: FillStyle(eoFill: true))
                let ring = Path(ellipseIn: CGRect(x: c.x - ringR, y: c.y - ringR,
                                                  width: ringR * 2, height: ringR * 2))
                layer.stroke(ring, with: .color(.black), lineWidth: ringW)
            }
            // The satellite, nestled in the gap and aimed at the center.
            ctx.fill(Path(ellipseIn: CGRect(x: sat.x - satR, y: sat.y - satR,
                                            width: satR * 2, height: satR * 2)),
                     with: .color(.black))
        }
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
