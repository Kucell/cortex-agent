// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PermitWitnessMacOS",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "permit-witness-macos", targets: ["WitnessHelper"])],
    targets: [
        .target(name: "WitnessTransport"),
        .executableTarget(name: "WitnessHelper", dependencies: ["WitnessTransport"]),
        .testTarget(name: "WitnessTransportTests", dependencies: ["WitnessTransport"])
    ],
    swiftLanguageModes: [.v6]
)
