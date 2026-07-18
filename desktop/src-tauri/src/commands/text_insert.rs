//! Deliver the polished text into whatever app has focus: put the text on the
//! clipboard, and — if there's an editable field focused and we're trusted for
//! Accessibility — synthesize ⌘V so it lands at the caret. Otherwise the text
//! stays on the clipboard and the caller shows a copy card.
//!
//! The caller hides the capsule window *before* invoking this, so the user's
//! target app is frontmost and its focused element is the real field.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverResult {
    /// True when an editable field was focused and a paste was synthesized.
    pub inserted: bool,
    /// True when macOS Accessibility permission is missing (auto-insert blocked).
    pub needs_accessibility: bool,
}

fn set_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板不可用：{e}"))?;
    clipboard
        .set_text(text.to_owned())
        .map_err(|e| format!("写入剪贴板失败：{e}"))
}

/// Put `text` on the clipboard, then auto-insert at the caret when possible.
#[tauri::command]
pub fn deliver_text(text: String) -> Result<DeliverResult, String> {
    if text.trim().is_empty() {
        return Ok(DeliverResult {
            inserted: false,
            needs_accessibility: false,
        });
    }
    set_clipboard(&text)?;

    #[cfg(target_os = "macos")]
    {
        if !mac::is_process_trusted() {
            return Ok(DeliverResult {
                inserted: false,
                needs_accessibility: true,
            });
        }
        if mac::is_editable_focus() {
            // Give focus/clipboard a beat to settle, then paste off the main
            // thread so the command returns promptly.
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(90));
                mac::paste_cmd_v();
            });
            return Ok(DeliverResult {
                inserted: true,
                needs_accessibility: false,
            });
        }
        return Ok(DeliverResult {
            inserted: false,
            needs_accessibility: false,
        });
    }

    #[cfg(not(target_os = "macos"))]
    Ok(DeliverResult {
        inserted: false,
        needs_accessibility: false,
    })
}

/// Whether macOS Accessibility is granted (auto-insert needs it).
#[tauri::command]
pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::is_process_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::base::{CFRelease, CFTypeRef};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::ptr;

    type AXUIElementRef = *const std::ffi::c_void;
    type AXError = i32;
    const AX_SUCCESS: AXError = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementIsAttributeSettable(
            element: AXUIElementRef,
            attribute: CFStringRef,
            settable: *mut u8,
        ) -> AXError;
    }

    pub fn is_process_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Copy an AX attribute; returns the raw CFTypeRef (caller must CFRelease) or
    /// null.
    unsafe fn copy_attr(element: AXUIElementRef, name: &str) -> CFTypeRef {
        let attr = CFString::new(name);
        let mut out: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out);
        if err == AX_SUCCESS {
            out
        } else {
            ptr::null()
        }
    }

    /// Whether the system-wide focused element is an editable text field — i.e.
    /// there is a caret to paste into.
    pub fn is_editable_focus() -> bool {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return false;
            }
            let focused = copy_attr(system, "AXFocusedUIElement");
            CFRelease(system as CFTypeRef);
            if focused.is_null() {
                return false;
            }
            let focused_el = focused as AXUIElementRef;

            let mut editable = false;
            let role_ref = copy_attr(focused_el, "AXRole");
            if !role_ref.is_null() {
                let role = CFString::wrap_under_create_rule(role_ref as CFStringRef).to_string();
                editable = matches!(
                    role.as_str(),
                    "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
                );
            }
            if !editable {
                // Generic role: accept only if the value is settable (contentEditable /
                // web editors expose this even without a text-entry role).
                let attr = CFString::new("AXValue");
                let mut settable: u8 = 0;
                let err = AXUIElementIsAttributeSettable(
                    focused_el,
                    attr.as_concrete_TypeRef(),
                    &mut settable,
                );
                editable = err == AX_SUCCESS && settable != 0;
            }
            CFRelease(focused);
            editable
        }
    }

    /// Synthesize a ⌘V keystroke at the HID level.
    pub fn paste_cmd_v() {
        let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
            return;
        };
        let v_key: CGKeyCode = 9; // ANSI 'v'
        if let Ok(down) = CGEvent::new_keyboard_event(source.clone(), v_key, true) {
            down.set_flags(CGEventFlags::CGEventFlagCommand);
            down.post(CGEventTapLocation::HID);
        }
        if let Ok(up) = CGEvent::new_keyboard_event(source, v_key, false) {
            up.set_flags(CGEventFlags::CGEventFlagCommand);
            up.post(CGEventTapLocation::HID);
        }
    }
}
