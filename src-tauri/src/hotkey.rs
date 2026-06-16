//! Global hotkey listener via a macOS CGEventTap.
//!
//! We read ONLY the integer keycode from each event — deliberately not
//! converting it to a string. The string-conversion path (what `rdev` does)
//! goes through HIToolbox text-input APIs that assert they run on the main
//! thread and abort the process (SIGTRAP) when called from the tap's background
//! thread. Reading the raw keycode avoids that entirely while still letting us
//! detect a single right-⌘ (keycode 54) or any other key, and powers the
//! "learn a key" capture mode.
//!
//! Needs Accessibility / Input Monitoring permission; without it the tap simply
//! fails to install (logged, no crash).

use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn spawn(app: AppHandle) {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult, EventField,
    };
    use tauri::{Emitter, Manager};

    use crate::state::AppState;

    std::thread::spawn(move || {
        // Held keys, so a repeated key-down / held modifier fires only once.
        let pressed: RefCell<HashSet<i64>> = RefCell::new(HashSet::new());

        let on_press = |keycode: i64| {
            let state = match app.try_state::<Arc<AppState>>() {
                Some(s) => s.inner().clone(),
                None => return,
            };
            // "Learn a key" mode: report the keycode and stop.
            if state.capturing.swap(false, Ordering::SeqCst) {
                let _ = app.emit("hotkey://captured", keycode.to_string());
                return;
            }
            if keycode.to_string() == *state.hotkey.lock() {
                crate::dictation::toggle(&app);
            }
        };

        let installed = CGEventTap::with_enabled(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::KeyDown,
                CGEventType::KeyUp,
                CGEventType::FlagsChanged,
            ],
            |_proxy, etype, event| {
                let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                match etype {
                    CGEventType::KeyDown => {
                        if pressed.borrow_mut().insert(keycode) {
                            on_press(keycode);
                        }
                    }
                    CGEventType::KeyUp => {
                        pressed.borrow_mut().remove(&keycode);
                    }
                    // Modifiers (incl. left/right ⌘) arrive as FlagsChanged with
                    // the modifier's keycode; toggle press/release state.
                    CGEventType::FlagsChanged => {
                        let now_down = !pressed.borrow().contains(&keycode);
                        if now_down {
                            pressed.borrow_mut().insert(keycode);
                            on_press(keycode);
                        } else {
                            pressed.borrow_mut().remove(&keycode);
                        }
                    }
                    _ => {}
                }
                CallbackResult::Keep
            },
            || CFRunLoop::run_current(),
        );

        if installed.is_err() {
            eprintln!(
                "[hotkey] could not install global event tap — grant Orbit \
                 Accessibility / Input Monitoring permission, then restart."
            );
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn(_app: AppHandle) {
    eprintln!("[hotkey] global hotkey listener is only implemented on macOS");
}
