/**
 * Expo config plugin to fix non-modular header errors in React Native Firebase.
 *
 * With useFrameworks: "static", Xcode treats RNFBApp/RNFBMessaging as framework
 * targets. These targets import React headers (e.g. <React/RCTBridgeModule.h>)
 * which are non-modular, causing -Wnon-modular-include-in-framework-module errors.
 *
 * This plugin adds a post_install hook to the Podfile that sets
 * CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES = YES for RNFB targets.
 *
 * Tracking: https://github.com/expo/expo/issues/39607
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

function withFirebaseModularHeaders(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        "Podfile"
      );
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      const snippet = `
    # [withFirebaseModularHeaders] Allow non-modular includes in RNFB targets
    installer.pods_project.targets.each do |target|
      if target.name.start_with?('RNFB')
        target.build_configurations.each do |config|
          config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
        end
      end
    end`;

      // Append inside the existing post_install block if present
      if (podfile.includes("post_install do |installer|")) {
        // Insert our snippet just after the post_install opening line
        podfile = podfile.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|${snippet}`
        );
      } else {
        // Add a new post_install block at the end
        podfile += `\npost_install do |installer|${snippet}\nend\n`;
      }

      fs.writeFileSync(podfilePath, podfile, "utf-8");
      return config;
    },
  ]);
}

module.exports = withFirebaseModularHeaders;
