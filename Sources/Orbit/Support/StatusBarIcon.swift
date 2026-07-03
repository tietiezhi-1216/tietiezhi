//  StatusBarIcon.swift
//  The menu-bar mark, drawn in code from the brand geometry (planet + tilted
//  orbit ring + satellite — same composition as Orbit.icns) instead of a stock
//  SF Symbol. Rendered as a template image so macOS tints it correctly for
//  light/dark menu bars and the selected state.

import AppKit

enum StatusBarIcon {

    /// 18×18 pt template image sized for the menu bar.
    static func make() -> NSImage {
        let side: CGFloat = 18
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
            draw(side: side, scale: 1)
            return true
        }
        image.isTemplate = true   // let the menu bar tint it (white on dark, etc.)
        return image
    }

    /// Shared drawing so previews render the exact production geometry.
    /// The mark: Orbit's "O" as a bold ring, broken up-right where a satellite
    /// rides in the gap — geometric, legible at 18 pt, and echoes the app icon.
    static func draw(side: CGFloat, scale: CGFloat) {
        let center = NSPoint(x: side / 2, y: side / 2)
        let ringRadius = 5.6 * scale
        let ringWidth = 2.4 * scale
        let satelliteAngle: CGFloat = .pi / 4          // up-right, like the icns
        let satelliteOrbit = 6.6 * scale               // slightly outside the ring
        let satelliteRadius = 1.9 * scale
        let satelliteClearance = 3.2 * scale           // gap carved out of the ring
        NSColor.black.setFill()
        NSColor.black.setStroke()

        let satellite = NSPoint(
            x: center.x + satelliteOrbit * cos(satelliteAngle),
            y: center.y + satelliteOrbit * sin(satelliteAngle))

        // The O ring, with a breathing gap punched out around the satellite.
        NSGraphicsContext.saveGraphicsState()
        let keepOut = NSBezierPath(rect: NSRect(x: 0, y: 0, width: side, height: side))
        keepOut.appendOval(in: NSRect(
            x: satellite.x - satelliteClearance, y: satellite.y - satelliteClearance,
            width: satelliteClearance * 2, height: satelliteClearance * 2))
        keepOut.windingRule = .evenOdd
        keepOut.addClip()

        let ring = NSBezierPath(ovalIn: NSRect(
            x: center.x - ringRadius, y: center.y - ringRadius,
            width: ringRadius * 2, height: ringRadius * 2))
        ring.lineWidth = ringWidth
        ring.stroke()
        NSGraphicsContext.restoreGraphicsState()

        // The satellite riding in the gap.
        NSBezierPath(ovalIn: NSRect(
            x: satellite.x - satelliteRadius, y: satellite.y - satelliteRadius,
            width: satelliteRadius * 2, height: satelliteRadius * 2)).fill()
    }
}
