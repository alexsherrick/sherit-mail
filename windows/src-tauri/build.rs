fn main() {
    // The page may call exactly these app commands (capabilities/hub.json grants them to the hub's origin only).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["badge", "opened"])))
        .expect("tauri build");
}
