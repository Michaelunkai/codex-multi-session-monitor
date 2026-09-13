# Actual Android verification — 2026-09-09

Used the requested AADB plugin through Windows PowerShell 5.1. The existing installed bridge did not implement the plugin's documented `doctor` command; the call recovered the wireless transport and then reported `unknown command doctor`. No bridge repair, package installation, daemon restart, or device reset was performed.

Verified target: one authorized Android device on the private wireless transport. Device model, serial, address, and screen details are intentionally omitted from this public repository.

The phone's own `/system/bin/curl`, executed over ADB, fetched the dashboard through the private HTTPS monitor endpoint. The generated certificate's public key was pinned. Credentials were supplied over standard input, not in command-line arguments or source code. No certificate, APK, test file, or screenshot was written onto the phone.

Results:

- Authenticated health passed.
- 91 relevant sessions with 91 distinct IDs reached the phone.
- Dashboard HTML and JavaScript reached the phone.
- Five SSE frames arrived during the five-second stream check; live stream changes were observed.
- Machine-readable evidence: `logs/android-network-proof.json`.

Visual verification remains incomplete. The active global browser-control contract says every browser-control task must use the approved Windows Chrome Profile 2 / Person 1 route. It does not authorize Android browser navigation or taps. Therefore no Android browser action was performed through ADB. The remaining user step is to open the supplied dashboard link in the phone browser, handle its certificate prompt, and confirm visible updating cards. Network reachability is now verified on the actual phone, not just on the PC.
