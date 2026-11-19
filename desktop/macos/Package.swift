// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CatttHost", platforms: [.macOS(.v14)], products: [
    .library(name: "HostCore", targets: ["HostCore"]),
    .executable(name: "CatttHost", targets: ["CatttHost"])
], targets: [.target(name: "HostCore"), .executableTarget(name: "CatttHost", dependencies: ["HostCore"]),
             .testTarget(name: "HostCoreTests", dependencies: ["HostCore"])])
