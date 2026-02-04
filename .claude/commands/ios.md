# Build iOS via EAS

Build the Companion iOS app using EAS Build.

## Usage
```
/ios [profile]
```

Profile is optional. Defaults to `production`. Options: `development`, `preview`, `production`.

## Steps

1. Determine the build profile from `$ARGUMENTS`. If empty or not provided, default to `production`.

2. Run the EAS build:
```bash
cd app && eas build --platform ios --profile <profile> --non-interactive
```

3. Monitor the build output. EAS will print a URL to track the build.

4. Report the build URL and status when the command completes or when the build is submitted to EAS servers.

If the build fails, show the full error output. Common issues:
- **Pod install failures**: Check `app.config.js` `expo-build-properties` iOS settings (`useFrameworks`, `useModularHeaders`)
- **Signing issues**: May need to run `eas credentials` to configure certificates
- **Missing GoogleService-Info.plist**: Ensure the file exists in the `app/` directory
