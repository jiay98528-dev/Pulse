use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    Manager,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

/// Managed state holding the Python backend child process.
struct BackendProcess(Mutex<Option<Child>>);

/// Determine the Pulse project root directory.
///
/// In development `env!("CARGO_MANIFEST_DIR")` resolves to `src-tauri/`,
/// so the project root is its parent (verified by checking for `backend/`
/// and `frontend/` directories).
///
/// Falls back to walking up from the current working directory.
fn get_project_root() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest_dir.parent() {
            if parent.join("backend").exists() && parent.join("frontend").exists() {
                return parent.to_path_buf();
            }
        }
    }

    // Walk up from CWD looking for known project markers
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd.clone();
        loop {
            if dir.join("backend").exists()
                && dir.join("frontend").exists()
                && dir.join("src-tauri").exists()
            {
                return dir;
            }
            if !dir.pop() {
                break;
            }
        }
    }

    // Last resort
    std::env::current_dir().unwrap_or_default()
}

/// Spawn the Python backend script and store the child handle in app state.
fn spawn_backend(app: &tauri::App) {
    let project_root = get_project_root();

    #[cfg(target_os = "windows")]
    let script_name = "start-backend.bat";
    #[cfg(not(target_os = "windows"))]
    let script_name = "start-backend.sh";

    let script_path = project_root
        .join("src-tauri")
        .join("scripts")
        .join(script_name);

    let mut cmd = Command::new(&script_path);
    cmd.current_dir(&project_root);

    // On Windows, hide the console window so the backend runs silently
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match cmd.spawn() {
        Ok(child) => {
            app.manage(BackendProcess(Mutex::new(Some(child))));
            println!(
                "[Pulse] Backend started via {}",
                script_path.display()
            );
        }
        Err(e) => {
            eprintln!(
                "[Pulse] Failed to start Python backend: {} (script: {})",
                e,
                script_path.display()
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init())
        .plugin(tauri_plugin_updater::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            spawn_backend(app);

            // --- System Tray ---
            let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 Pulse").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("Tray icon missing — place a 32x32 PNG at src-tauri/icons/icon.png");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Pulse Dashboard")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Clean up backend before exit
                            if let Some(state) = app.try_state::<BackendProcess>() {
                                if let Ok(mut guard) = state.0.lock() {
                                    if let Some(mut child) = guard.take() {
                                        let _ = child.kill();
                                        let _ = child.wait();
                                    }
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, .. } = event {
                        if button == MouseButton::Left {
                            if let Some(app) = tray.app_handle() {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_event(|app_handle, event| {
            match event {
                tauri::RunEvent::CloseRequested { api, .. } => {
                    // Hide window to tray instead of closing
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    api.prevent_close();
                }
                tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<BackendProcess>() {
                        if let Ok(mut guard) = state.0.lock() {
                            // Take the child out so it is killed only once
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                                let _ = child.wait();
                                println!("[Pulse] Backend process terminated");
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Open a URL in the system default browser.
fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd").args(["/c", "start", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}
