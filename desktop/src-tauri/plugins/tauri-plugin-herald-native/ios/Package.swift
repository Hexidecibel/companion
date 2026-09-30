// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-herald-native",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-herald-native",
      type: .static,
      targets: ["tauri-plugin-herald-native"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-herald-native",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
