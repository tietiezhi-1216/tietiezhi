//  main.swift
//  Entry point. Orbit is chat-first: the delegate opens a Chat window and
//  promotes the app to a regular Dock app (.regular). It starts as .accessory
//  here so the menu-bar status item + background dictation exist even before any
//  window; the settings window and the floating recording pill are secondary.

import AppKit

// Top-level code is the program entry and already runs on the main thread;
// assume main-actor isolation so we can construct the @MainActor AppDelegate.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
