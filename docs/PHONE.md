# Phone access with free Tailscale

Verified command against [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve) and [examples](https://tailscale.com/docs/reference/examples/serve), 2026-10-06.

1. Install Tailscale on this computer and phone. Sign both into the same personal tailnet and enable the connection. Use the free personal plan.
2. On the computer run `npm run trade` from the project folder. It binds the dashboard to loopback port 3000.
3. Run `tailscale serve --bg 3000`. If prompted, follow Tailscale's link to enable HTTPS certificates for your tailnet.
4. Run `tailscale serve status`, then open its `https://<computer>.<tailnet>.ts.net` URL on the phone while Tailscale is connected. Enter the same dashboard Basic-auth login. Save it to the home screen if desired.
5. The same HTTPS origin proxies `/ws`, so live updates use WSS without exposing a second port. Auth remains required on static assets, API and WS. No Funnel is needed.

Stop sharing with `tailscale serve reset`. The laptop must remain powered, awake, connected and running the app; keep-awake does not guarantee operation with the lid closed. The launcher requests a Windows system wake lock (the display may still turn off), or runs macOS `caffeinate -dimsu`. Network outages still suppress advice.

Phone notifications and audio depend on browser permission and platform support. Tap Enable browser audio and enable the desired settings while the page is open; iOS background delivery is not promised by a local foreground WebSocket app.
