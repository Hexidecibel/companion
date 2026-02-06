# Install Linux .deb Package

Download the latest Companion .deb from GitHub Releases and install it locally.

## Steps

1. Find the latest release with a .deb asset:
```bash
gh release list --limit 5
```

2. Download the .deb asset to /tmp:
```bash
gh release download <tag> --pattern '*.deb' --dir /tmp --clobber
```

3. Install the .deb:
```bash
sudo dpkg -i /tmp/Companion_*.deb
```

4. Report what was installed and the version:
```bash
dpkg -s companion-desktop 2>/dev/null | grep -E 'Version|Status'
```

## Notes

- This installs the **desktop app** (Tauri), not the daemon. The daemon runs from source via systemd.
- If dependencies are missing after dpkg, run `sudo apt-get install -f`.
- The installed app binary is typically at `/usr/bin/companion-desktop` or similar — check with `which companion-desktop` or `dpkg -L companion-desktop`.
