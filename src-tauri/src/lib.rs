#[cfg(not(debug_assertions))]
use std::fs;
#[cfg(debug_assertions)]
use std::path::PathBuf;
#[cfg(debug_assertions)]
use std::process::{Child, Command};
use std::sync::Mutex;

#[cfg(all(target_os = "windows", debug_assertions))]
use std::os::windows::process::CommandExt;

use tauri::{
    AppHandle, Manager, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};

/// Managed state holding the Python backend child process.
enum BackendChild {
    #[cfg(debug_assertions)]
    Dev(Child),
    #[cfg(not(debug_assertions))]
    Sidecar(CommandChild),
}

struct BackendProcess(Mutex<Option<BackendChild>>);

/// Determine the Pulse project root directory.
///
/// In development `env!("CARGO_MANIFEST_DIR")` resolves to `src-tauri/`,
/// so the project root is its parent (verified by checking for `backend/`
/// and `frontend/` directories).
///
/// Falls back to walking up from the current working directory.
#[cfg(debug_assertions)]
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
    #[cfg(debug_assertions)]
    spawn_dev_backend(app);

    #[cfg(not(debug_assertions))]
    spawn_release_backend(app);
}

#[cfg(debug_assertions)]
fn spawn_dev_backend(app: &tauri::App) {
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
            app.manage(BackendProcess(Mutex::new(Some(BackendChild::Dev(child)))));
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

#[cfg(not(debug_assertions))]
fn spawn_release_backend(app: &tauri::App) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(path) => path.join("Pulse"),
        Err(e) => {
            eprintln!("[Pulse] Failed to resolve app data directory: {e}");
            return;
        }
    };

    if let Err(e) = fs::create_dir_all(&app_data_dir) {
        eprintln!(
            "[Pulse] Failed to create backend data directory {}: {}",
            app_data_dir.display(),
            e
        );
        return;
    }

    let command = match app.shell().sidecar("pulse-backend") {
        Ok(command) => command
            .env("PULSE_DATA_DIR", app_data_dir.as_os_str())
            .env("PULSE_HOST", "127.0.0.1")
            .env("PULSE_PORT", "8080"),
        Err(e) => {
            eprintln!("[Pulse] Failed to resolve backend sidecar: {e}");
            return;
        }
    };

    match command.spawn() {
        Ok((mut rx, child)) => {
            let pid = child.pid();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            print!("[Pulse backend] {}", text);
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            eprint!("[Pulse backend] {}", text);
                        }
                        CommandEvent::Error(error) => {
                            eprintln!("[Pulse backend] {error}");
                        }
                        CommandEvent::Terminated(payload) => {
                            println!(
                                "[Pulse backend] terminated code={:?} signal={:?}",
                                payload.code, payload.signal
                            );
                        }
                        _ => {}
                    }
                }
            });
            app.manage(BackendProcess(Mutex::new(Some(BackendChild::Sidecar(child)))));
            println!(
                "[Pulse] Backend sidecar started pid={} data_dir={}",
                pid,
                app_data_dir.display()
            );
        }
        Err(e) => {
            eprintln!("[Pulse] Failed to start backend sidecar: {e}");
        }
    }
}

fn cleanup_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                kill_backend_child(child);
            }
        }
    }
}

fn kill_backend_child(child: BackendChild) {
    match child {
        #[cfg(debug_assertions)]
        BackendChild::Dev(mut child) => {
            // Kill entire process tree on Windows so python.exe isn't orphaned.
            #[cfg(target_os = "windows")]
            {
                let pid = child.id();
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(0x08000000)
                    .spawn();
            }
            let _ = child.kill();
            let _ = child.wait();
            println!("[Pulse] Backend process terminated");
        }
        #[cfg(not(debug_assertions))]
        BackendChild::Sidecar(child) => {
            let pid = child.pid();
            let _ = child.kill();
            println!("[Pulse] Backend sidecar terminated pid={pid}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            #[cfg(debug_assertions)]
            {
                window.open_devtools();
            }

            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = close_window.hide();
                    api.prevent_close();
                }
            });

            spawn_backend(app);

            // --- System Tray ---
            let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 Pulse").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            let icon = tauri::image::Image::new(include_bytes!("../icons/icon.rgba"), 32, 32);

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
                            cleanup_backend(app);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, .. } = event {
                        if button == MouseButton::Left {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            cleanup_backend(app_handle);
        }
    });
}
