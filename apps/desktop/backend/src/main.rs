// This is a stdio service. Electron starts it with windowsHide and owns its lifetime.
#[tokio::main]
async fn main() {
    if let Err(error) = dssh_lib::runtime::run().await {
        eprintln!("dssh backend: {error}");
        std::process::exit(1);
    }
}
