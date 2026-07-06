//  Permissions.swift
//  Microphone + Accessibility permission state and prompts. Dictation needs
//  Microphone (to record) and Accessibility (for the global hotkey tap and to
//  paste the result into the focused app).

import AVFoundation
import AppKit
import ApplicationServices
import IOKit.hid

enum PermissionState {
    case granted, denied, notDetermined
}

enum Permissions {

    // MARK: Microphone

    static var microphone: PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    /// Triggers the system mic prompt if not yet determined.
    static func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async { completion(ok) }
        }
    }

    // MARK: Accessibility (global hotkey + synthetic paste)

    static var accessibility: PermissionState {
        AXIsProcessTrusted() ? .granted : .notDetermined
    }

    /// Shows the system "grant Accessibility" prompt (opens System Settings).
    @discardableResult
    static func promptAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    // MARK: Input Monitoring (global hotkey event tap)

    /// The listen-only CGEventTap behind the global hotkey needs Input Monitoring
    /// — a SEPARATE grant from Accessibility. Recording can work while pasting
    /// can't (and vice-versa), so we track and surface them independently.
    static var inputMonitoring: PermissionState {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return .granted
        case kIOHIDAccessTypeDenied:  return .denied
        default:                      return .notDetermined
        }
    }

    /// Triggers the system Input Monitoring prompt if not yet determined.
    @discardableResult
    static func requestInputMonitoring() -> Bool {
        IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    }

    // MARK: Screen Recording (screenshot / capture)

    /// Screenshots and (later) screen recording both sit behind the same
    /// "屏幕录制" TCC grant. `CGPreflightScreenCaptureAccess` answers without
    /// prompting; macOS offers no "denied vs. not asked" distinction here, so
    /// anything but granted reads as `notDetermined`.
    static var screenRecording: PermissionState {
        CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
    }

    /// Shows the system screen-recording prompt (first time) — afterwards macOS
    /// only registers the app in System Settings, so pair this with the deep
    /// link below when the user needs to flip the switch by hand.
    @discardableResult
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    // MARK: Deep links into System Settings

    static func openScreenRecordingSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    static func openMicrophoneSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    static func openAccessibilitySettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    static func openInputMonitoringSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
    }

    private static func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }
}
