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

fn replace_clipboard(text: &str) -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板不可用：{e}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(text.to_owned())
        .map_err(|e| format!("写入剪贴板失败：{e}"))?;
    Ok(previous)
}

fn restore_clipboard_if_unchanged(previous: Option<String>, inserted: &str) {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return;
    };
    if clipboard.get_text().ok().as_deref() != Some(inserted) {
        return;
    }
    match previous {
        Some(text) => {
            let _ = clipboard.set_text(text);
        }
        None => {
            let _ = clipboard.clear();
        }
    }
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
    let previous_clipboard = replace_clipboard(&text)?;

    #[cfg(target_os = "macos")]
    {
        if !mac::is_process_trusted(false) {
            return Ok(DeliverResult {
                inserted: false,
                needs_accessibility: true,
            });
        }
        if mac::is_editable_focus() {
            let inserted_text = text.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(90));
                mac::paste_cmd_v();
                std::thread::sleep(std::time::Duration::from_millis(600));
                restore_clipboard_if_unchanged(previous_clipboard, &inserted_text);
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

    #[cfg(target_os = "windows")]
    {
        if win::paste_ctrl_v() {
            let inserted_text = text.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                restore_clipboard_if_unchanged(previous_clipboard, &inserted_text);
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

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok(DeliverResult {
        inserted: false,
        needs_accessibility: false,
    })
}

/// Whether macOS Accessibility is granted (auto-insert needs it). When
/// `prompt` is true, macOS displays its standard permission prompt.
#[tauri::command]
pub fn accessibility_trusted(prompt: Option<bool>) -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::is_process_trusted(prompt.unwrap_or(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const VK_CONTROL: u16 = 0x11;
    const VK_V: u16 = 0x56;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeybdInput {
        virtual_key: u16,
        scan_code: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    union InputData {
        keyboard: KeybdInput,
        // INPUT's union is sized for MOUSEINPUT. The desktop release target is
        // Windows x64, where that union occupies 32 bytes.
        padding: [u64; 4],
    }

    #[repr(C)]
    struct Input {
        kind: u32,
        data: InputData,
    }

    const _: [(); 40] = [(); std::mem::size_of::<Input>()];

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn SendInput(count: u32, inputs: *const Input, input_size: i32) -> u32;
    }

    fn key(virtual_key: u16, flags: u32) -> Input {
        Input {
            kind: INPUT_KEYBOARD,
            data: InputData {
                keyboard: KeybdInput {
                    virtual_key,
                    scan_code: 0,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        }
    }

    pub fn paste_ctrl_v() -> bool {
        if unsafe { GetForegroundWindow() }.is_null() {
            return false;
        }
        let inputs = [
            key(VK_CONTROL, 0),
            key(VK_V, 0),
            key(VK_V, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            ) == inputs.len() as u32
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::base::{CFRelease, CFTypeRef};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
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
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
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

    pub fn is_process_trusted(prompt: bool) -> bool {
        if !prompt {
            return unsafe { AXIsProcessTrusted() };
        }
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
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
