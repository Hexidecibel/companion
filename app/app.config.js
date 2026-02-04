import 'dotenv/config';

export default {
  expo: {
    name: "Hexi's Companion",
    slug: "companion-app",
    version: "0.0.1",
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
      bundleIdentifier: "com.companion.codeapp",
      googleServicesFile: process.env.GOOGLE_SERVICES_PLIST || "./GoogleService-Info.plist",
      entitlements: {
        "aps-environment": "production"
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        UIBackgroundModes: ["remote-notification"],
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
          NSAllowsLocalNetworking: true
        },
        NSLocalNetworkUsageDescription: "Connect to Companion daemon on your local network"
      }
    },
    android: {
      package: "com.companion.codeapp",
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
          },
          ios: {
            useFrameworks: "static",
            useModularHeaders: true,
            buildReactNativeFromSource: true
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
        projectId: "ab8aeb70-f2ee-4f80-8a52-e6b30b1e883d"
      },
      // Secrets passed via environment variables
      sentryDsn: process.env.SENTRY_DSN,
      buildDate: new Date().toISOString(),
    },
    owner: "xludax"
  }
};
