//  ScreenCapturer.swift
//  ScreenCaptureKit wrapper: freeze a whole display into a CGImage (the overlay
//  then crops selections out of that frozen frame, so the capture UI itself
//  never appears in the shot), plus the on-screen window list used for
//  hover-snap selection. macOS 14+ — SCScreenshotManager replaces the removed
//  CGWindowListCreateImage / CGDisplayCreateImage APIs.

import AppKit
import CoreImage
import ScreenCaptureKit

/// Shared CoreImage context for the image-adjust (亮度/对比度/饱和度) slider — one
/// GPU context reused across the interactive slider drags.
private let sharedCIContext = CIContext(options: [.useSoftwareRenderer: false])

/// One on-screen window, for hover-highlight / click-to-select. `frame` is in
/// the OVERLAY VIEW's coordinate space (top-left origin of the target screen,
/// y down) so the selection UI can use it directly.
struct SnapWindow {
    let frame: CGRect
    let title: String
    /// Owning app's pid — used to query its Accessibility node tree for element snap.
    let pid: pid_t
}

/// Race an async operation against a timeout. If the operation wedges (a real
/// ScreenCaptureKit failure mode on a half-applied TCC grant), the timeout wins,
/// the caller's `starting`/reentrancy state unwinds, and an error surfaces
/// instead of the capture silently dying. The leaked hung task is acceptable.
func withCaptureTimeout<T>(seconds: Double, _ operation: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw OrbitError("截图超时——屏幕录制权限可能未完全生效，请在系统设置里关闭再重新打开 Orbit 的屏幕录制授权，然后重启 Orbit。")
        }
        guard let first = try await group.next() else {
            throw OrbitError("截图失败。")
        }
        group.cancelAll()
        return first
    }
}

enum ScreenCapturer {

    /// Capture one display at native (Retina) resolution, without the cursor.
    static func freeze(screen: NSScreen) async throws -> CGImage {
        guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
            throw OrbitError("无法识别目标显示器。")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw OrbitError("未找到目标显示器（屏幕录制权限可能未生效）。")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        let scale = screen.backingScaleFactor
        config.width = Int(CGFloat(display.width) * scale)
        config.height = Int(CGFloat(display.height) * scale)
        config.showsCursor = false
        config.captureResolution = .best
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    /// Front-to-back list of normal windows overlapping `screen`, excluding our
    /// own, with frames converted into the overlay view's coordinate space.
    /// Uses CGWindowListCopyWindowInfo (still supported — only the *image*
    /// functions were removed) because SCShareableContent omits window layers.
    static func snapWindows(on screen: NSScreen) -> [SnapWindow] {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return [] }

        // CG global coords: origin at the top-left of the PRIMARY display, y
        // down. The primary display is the NSScreen whose Cocoa frame origin is
        // (0,0); its height anchors the flip between the two systems.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let ourPID = ProcessInfo.processInfo.processIdentifier

        var out: [SnapWindow] = []
        for info in list {
            // CGWindowList stores pid as a CFNumber — `as? pid_t` (Int32) never
            // bridges, so read via NSNumber.int32Value.
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  pid != 0, pid != ourPID,
                  (info[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let b = info[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"],
                  w > 40, h > 40
            else { continue }

            // CG global → Cocoa global → overlay view (top-left of target screen).
            let cocoaY = primaryHeight - (y + h)
            let global = CGRect(x: x, y: cocoaY, width: w, height: h)
            guard global.intersects(screen.frame) else { continue }
            let view = CGRect(x: global.minX - screen.frame.minX,
                              y: screen.frame.maxY - global.maxY,
                              width: w, height: h)
            out.append(SnapWindow(frame: view,
                                  title: info[kCGWindowOwnerName as String] as? String ?? "",
                                  pid: pid))
        }
        return out
    }
}

// MARK: - CGImage utilities (crop / sample / pixelate)

extension CGImage {

    /// Crop by a rect given in POINTS (top-left origin) against a frozen frame
    /// captured at `scale`. Clamped to the image bounds.
    func cropping(toPointRect rect: CGRect, scale: CGFloat) -> CGImage? {
        let px = CGRect(x: rect.minX * scale, y: rect.minY * scale,
                        width: rect.width * scale, height: rect.height * scale)
            .integral
            .intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !px.isEmpty else { return nil }
        return cropping(to: px)
    }

    /// The color of the pixel at a POINT coordinate (top-left origin).
    func pixelColor(atPoint p: CGPoint, scale: CGFloat) -> NSColor? {
        let x = Int(p.x * scale), y = Int(p.y * scale)
        guard x >= 0, y >= 0, x < width, y < height else { return nil }
        var rgba = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(
            data: &rgba, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(self, in: CGRect(x: -x, y: y - height + 1, width: width, height: height))
        return NSColor(red: CGFloat(rgba[0]) / 255, green: CGFloat(rgba[1]) / 255,
                       blue: CGFloat(rgba[2]) / 255, alpha: 1)
    }

    /// A blocky (nearest-neighbour) copy for the 马赛克 tool: downscale so one
    /// block covers ~`blockPoints` points, then upscale with no interpolation.
    /// Generated once per capture; mosaic rects just clip-draw this image.
    func pixelated(scale: CGFloat, blockPoints: CGFloat = 10) -> CGImage? {
        let block = max(2, Int(blockPoints * scale))
        let smallW = max(1, width / block), smallH = max(1, height / block)
        guard let small = CGContext(
            data: nil, width: smallW, height: smallH, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        small.interpolationQuality = .low
        small.draw(self, in: CGRect(x: 0, y: 0, width: smallW, height: smallH))
        guard let shrunk = small.makeImage() else { return nil }

        guard let big = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        big.interpolationQuality = .none
        big.draw(shrunk, in: CGRect(x: 0, y: 0, width: width, height: height))
        return big.makeImage()
    }

    /// Downscale (if needed) so the long side is ≤ `maxSide` pixels — keeps the
    /// vision-model payload small. Returns self when already small enough.
    func downscaled(maxSide: Int) -> CGImage {
        let long = max(width, height)
        guard long > maxSide else { return self }
        let k = CGFloat(maxSide) / CGFloat(long)
        let w = Int(CGFloat(width) * k), h = Int(CGFloat(height) * k)
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return self }
        ctx.interpolationQuality = .high
        ctx.draw(self, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? self
    }

    /// A 90°-clockwise rotated copy (width/height swap). `.oriented(.right)` is
    /// verified to rotate CW — the source's left edge becomes the top edge.
    func rotated90CW() -> CGImage? {
        let rotated = CIImage(cgImage: self).oriented(.right)
        return sharedCIContext.createCGImage(rotated, from: rotated.extent)
    }

    /// A mirrored copy — horizontal (`.upMirrored`, left↔right) or vertical
    /// (`.downMirrored`, top↔bottom). Both verified against a 2×2 probe.
    func flipped(horizontal: Bool) -> CGImage? {
        let f = CIImage(cgImage: self).oriented(horizontal ? .upMirrored : .downMirrored)
        return sharedCIContext.createCGImage(f, from: f.extent)
    }

    /// Brightness / contrast / saturation adjusted copy (CIColorControls). The
    /// three defaults (0 / 1 / 1) return an image identical to the original.
    func adjusted(brightness: Double, contrast: Double, saturation: Double) -> CGImage? {
        let input = CIImage(cgImage: self)
        guard let filter = CIFilter(name: "CIColorControls") else { return nil }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(brightness, forKey: kCIInputBrightnessKey)
        filter.setValue(contrast, forKey: kCIInputContrastKey)
        filter.setValue(saturation, forKey: kCIInputSaturationKey)
        guard let output = filter.outputImage else { return nil }
        return sharedCIContext.createCGImage(output, from: input.extent)
    }

    /// PNG-encode to a file URL.
    func writePNG(to url: URL) throws {
        let rep = NSBitmapImageRep(cgImage: self)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw OrbitError("PNG 编码失败。")
        }
        try data.write(to: url, options: .atomic)
    }
}
