// swift-tools-version:5.10
// Sherit Mail for macOS: a native shell around the web client at mail.yourdomain.example. Build with./build.sh.
import PackageDescription

let package = Package(
    name: "SheritMail",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "SheritMail", path: "Sources/SheritMail")   // tools 5.10 = Swift 5 language mode
    ]
)
