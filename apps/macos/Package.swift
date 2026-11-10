// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WeComLocal",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "WeComLocal", targets: ["WeComLocal"])],
    targets: [
        .executableTarget(name: "WeComLocal"),
        .testTarget(name: "WeComLocalTests", dependencies: ["WeComLocal"]),
    ]
)
