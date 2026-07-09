//
//  Generated file. Do not edit.
//

import FlutterMacOS
import Foundation

import hotkey_manager_macos
import record_darwin
import screen_capturer_macos
import shared_preferences_foundation

func RegisterGeneratedPlugins(registry: FlutterPluginRegistry) {
  HotkeyManagerMacosPlugin.register(with: registry.registrar(forPlugin: "HotkeyManagerMacosPlugin"))
  RecordPlugin.register(with: registry.registrar(forPlugin: "RecordPlugin"))
  ScreenCapturerMacosPlugin.register(with: registry.registrar(forPlugin: "ScreenCapturerMacosPlugin"))
  SharedPreferencesPlugin.register(with: registry.registrar(forPlugin: "SharedPreferencesPlugin"))
}
