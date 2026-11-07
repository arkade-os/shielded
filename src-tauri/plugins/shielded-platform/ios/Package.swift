// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-shielded-platform",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-shielded-platform", type: .static, targets: ["tauri-plugin-shielded-platform"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-shielded-platform", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
