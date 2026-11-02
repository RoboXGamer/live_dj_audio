# Roomtone Karaoke

A local karaoke microphone receiver. A laptop hosts a room, approves phones, mixes their WebRTC audio, and can open a separate lyrics window. The server handles signaling only; audio goes directly from each phone to the laptop. No STUN server, cloud account, or internet connection is used at runtime.

## Requirements

- Node.js and pnpm; a laptop with speakers and current WebRTC-capable browsers on phones.
- All devices on the same LAN, with client-to-client traffic allowed. Guest networks and firewalls may block connections. Allow the server port (default 3000) through the laptop firewall.
- Phones require **trusted HTTPS** for microphone access. A plain LAN HTTP address is not a secure context. A browser exception for a self-signed certificate is not a reliable substitute for trusting the issuing CA, especially on mobile. This is a browser/platform requirement: a truly installation-free first-time setup cannot be guaranteed on every phone.

## Install and build

```powershell
pnpm --dir ui install
pnpm --dir server install
pnpm --dir ui build
```

## Quick local HTTPS with Vite

After installing the dependencies above, start both the HTTPS Vite server and the local Hono signaling server with:

```powershell
pnpm --dir ui dev:lan
```

The first run downloads mkcert (internet required) and prompts Windows to trust a new local root CA. Confirm the Windows security prompt if you want to trust this CA. Later runs can work offline. Open the network HTTPS URL printed by Vite on the laptop; use port 5173 in the QR code. Vite proxies `/api` and WebSocket signaling to Hono on localhost port 3000. Keep both ports free and allow access to 5173 through the firewall.

Each phone must also trust the plugin's **public** CA certificate at `C:\Users\<your-user>\.vite-plugin-mkcert\rootCA.pem`. Transfer that file securely and install it as a CA certificate in the phone's settings. On iPhone, also enable full trust under Settings > General > About > Certificate Trust Settings. Steps vary by Android version. Never share `rootCA-key.pem` or other private keys: anyone holding that key can issue certificates trusted by your devices. Remove the CA from devices when you no longer need it.

Vite's plugin generates a certificate for local IP addresses at startup. Restart it after changing networks; if the address is missing from the certificate, regenerate the plugin certificate. An HTTPS warning or an untrusted certificate can prevent phone microphone access. This development server is intended for a trusted LAN and must stay running during the session.

## HTTPS on a local network

Obtain a certificate trusted by every device, with the laptop's LAN IP in its subject alternative names. One option is [mkcert](https://github.com/FiloSottile/mkcert): install it on the laptop, run `mkcert -install`, and create a certificate for the LAN IP, e.g. `mkcert 192.168.1.20 localhost 127.0.0.1`. Install and trust mkcert's local root CA on each phone following its device-specific instructions. Protect the CA private key and never copy it to phones. The certificate must match the IP selected in the app; regenerate it if the IP changes. Phone OS/browser trust policies differ.

From the project root, set the paths to your certificate and private key (use absolute paths):

```powershell
$env:TLS_CERT = 'C:\path\to\192.168.1.20+2.pem'
$env:TLS_KEY = 'C:\path\to\192.168.1.20+2-key.pem'
pnpm --dir server start
```

Open `https://192.168.1.20:3000` on the laptop. Start a session, choose the corresponding network address, and scan the QR code on each phone. Approve each singer in the mixer. Use the sliders and mute buttons to control the speaker mix. Paste lyrics and open the projector view, then move that window to the projector. Browsers may require permission for pop-ups.

For laptop-only development, omit both TLS variables and open `http://localhost:3000`; phones will not normally be able to use microphones over LAN HTTP. `PORT` changes the listening port. Restart the server to change configuration.

## Operation and limits

Keep the host page and each phone page open. Room membership is in memory; a server restart or host disconnect ends the session. Reload to reconnect. Phones ask for microphone permission before host approval and stop capture when disconnected. Up to 12 phones can join one room. This is intended for a trusted local network: room links are bearer invitations, and there is no account system, encryption beyond HTTPS/WebRTC, or protection against a hostile device occupying resources. WebRTC encrypts media in transit. Avoid acoustic feedback by keeping phones away from speakers; latency and audio quality depend on the devices, browser, Wi-Fi and speaker connection. Bluetooth speakers can add substantial delay. No backing-track player is included; use an external player and follow its audio routing.

## Checks

```powershell
pnpm --dir ui build
pnpm --dir server test
```

