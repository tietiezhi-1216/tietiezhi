fn main() {
    if !tietiezhi_agent_sandbox::run_windows_sandbox_wrapper_if_requested() {
        std::process::exit(2);
    }
}
