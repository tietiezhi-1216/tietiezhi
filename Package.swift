// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Orbit",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Official MCP client SDK (stdio + HTTP transports). The dependency
        // builds in its own (Swift 6) language mode; our target stays v5.
        .package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", from: "0.10.0"),
        // Mainstream SwiftUI Markdown renderer + multi-language code highlighting
        // (highlight.js) for the chat transcript.
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", from: "2.4.1"),
        .package(url: "https://github.com/raspu/Highlightr.git", from: "2.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "Orbit",
            dependencies: [
                .product(name: "MCP", package: "swift-sdk"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Highlightr", package: "Highlightr"),
            ],
            path: "Sources/Orbit"
        )
    ],
    // Use the Swift 5 language mode: this is a UI app full of AppKit / SwiftUI
    // callbacks, and the strict Swift 6 concurrency checking buys us little here
    // while costing a lot of annotation noise. We can tighten this later.
    swiftLanguageModes: [.v5]
)
