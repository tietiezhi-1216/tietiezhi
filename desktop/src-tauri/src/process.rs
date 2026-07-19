use std::ffi::OsStr;

/// Build a standard-library child process for background desktop work.
pub(crate) fn background_command<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    configure_background_command(&mut command);
    command
}

/// Build an asynchronous child process for background desktop work.
pub(crate) fn background_tokio_command<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    configure_background_command(command.as_std_mut());
    command
}

/// A GUI-subsystem executable does not automatically prevent its console
/// children from creating a visible terminal window on Windows.
fn configure_background_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructors_preserve_the_requested_program() {
        let std_command = background_command("tietiezhi-command");
        assert_eq!(std_command.get_program(), "tietiezhi-command");

        let tokio_command = background_tokio_command("tietiezhi-async-command");
        assert_eq!(
            tokio_command.as_std().get_program(),
            "tietiezhi-async-command"
        );
    }
}
