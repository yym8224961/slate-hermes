// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SlateQuotaCollector",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "slate-quota-collector", targets: ["SlateQuotaCollector"])],
    targets: [
        .executableTarget(
            name: "SlateQuotaCollector",
            path: "Sources/SlateQuotaCollector",
            linkerSettings: [.linkedFramework("Security"), .linkedFramework("AppKit")]
        ),
        .testTarget(
            name: "SlateQuotaCollectorTests",
            dependencies: ["SlateQuotaCollector"],
            path: "Tests/SlateQuotaCollectorTests"
        ),
    ]
)
