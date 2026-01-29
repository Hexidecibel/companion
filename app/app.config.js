import 'dotenv/config';

export default {
  expo: {
    name: "Claude Companion",
    slug: "claude-companion",
    version: "1.0.0",
    sdkVersion: "54.0.0",
    platforms: ["ios", "android", "web"],
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/icon.png",
    splash: {
      backgroundColor: "#111827",
      resizeMode: "contain"
    },
    ios: {
      bundleIdentifier: "com.claudecompanion.app",
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
          NSAllowsLocalNetworking: true
        },
        NSLocalNetworkUsageDescription: "Connect to Claude Companion daemon on your local network"
      }
    },
    android: {
      package: "com.claudecompanion.app",
      softwareKeyboardLayoutMode: "pan",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#111827"
      },
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || "./google-services.json"
    },
    plugins: [
      [
        "expo-build-properties",
        {
          android: {
            usesCleartextTraffic: true
          }
        }
      ],
      "@react-native-firebase/app",
      "@react-native-firebase/messaging",
      [
        "@sentry/react-native",
        {
          organization: "hexi-ts",
          project: "react-native"
        }
      ]
    ],
    web: {
      bundler: "metro"
    },
    extra: {
      eas: {
        projectId: "a2c8ed18-6605-4dfc-a5c3-cec39533f8c2"
      },
      // Secrets passed via environment variables
      sentryDsn: process.env.SENTRY_DSN,
      buildDate: new Date().toISOString(),
    },
    owner: "xludax"
  }
};
