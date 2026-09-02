# ConnectionApp

ConnectionApp is a two-device Expo app for private session-based chat, voice
messages, calls, and file sharing.

## V2 features

- Six-character create/join session codes.
- Stable participant IDs and reconnect tokens with automatic recovery.
- A disconnected participant has a 20-second reconnection grace period.
- Peer lifecycle states: reconnecting, connected, offline, and expired.
- Chunked file transfers with metadata-first negotiation, receiver
  acknowledgements, ordered chunks, progress, pause/resume, and cancellation.
- Metadata-only file history with local categories, search, direction/status
  filters, newest-first sorting, persistence, and safe clearing.
- Existing V1 chat, voice-message, calling, navigation, and dashboard behavior.

## Setup and run

Install the root and server dependencies:

```bash
npm install
npm install --prefix server
```

Start the relay server in one terminal:

```bash
node server/index.js
```

Start Expo in another terminal:

```bash
npx expo start
```

Use `npx expo start --web`, `--android`, or `--ios` for a specific target.
Devices must be able to reach the server address configured in
`constants/socket.ts`.

## Session recovery

Creating or joining a channel assigns a stable participant ID and a
cryptographically random reconnect token. The client stores the active session
credentials locally and attempts to rejoin after a short network or app
interruption. The server keeps the participant slot for 20 seconds, rejects
expired or mismatched credentials, prevents duplicate active slots, and
notifies the peer when a participant goes offline, reconnects, or permanently
leaves.

## Reliable transfer flow

1. The sender sends validated metadata: transfer ID, filename, MIME type, byte
   size, and total chunk count.
2. The server authorizes both participants and relays bounded chunks in order.
3. The receiver acknowledges each accepted chunk; duplicate chunks are safe and
   out-of-order chunks are rejected.
4. The sender reports completion only after all receiver acknowledgements.
5. Disconnects pause active transfers; reconnection resumes from the last
   acknowledged chunk when possible. Either participant can cancel.

The documented maximum file size is **25 MB**. File contents are not stored in
history or logged by the server.

## File history

Completed, failed, and cancelled transfers store only transfer metadata locally:
transfer ID, sanitized filename, MIME type, size, direction, status, category,
and timestamp. Categories are derived locally from MIME type and extension:
Images, Videos, Audio, Documents, Archives, and Other. Filename search is
case-insensitive and can be combined with category, direction, and status
filters. Clearing history removes metadata only and never deletes saved files.

## Security limits

- Session authorization is based on the live socket participant slot.
- Reconnect credentials are validated with a timing-safe comparison and are not
  included in application logs or file history.
- Transfer metadata and chunk sizes are bounded and validated server-side.
- Filenames are sanitized before display and storage.
- Malformed payloads are rejected without forwarding.
- The development server currently uses the configured plain HTTP endpoint.
  Production deployment must place Socket.IO behind HTTPS/WSS and use a secure
  platform credential store instead of browser `localStorage`.
- This relay does not provide end-to-end encryption; do not use it for
  sensitive production data until TLS and application-level encryption are
  deployed.

## Manual two-device checklist

1. Start the server and Expo app; open the app on a laptop and phone.
2. Create a channel on one device and join with the six-character code.
3. Send a small image and document in both directions; verify metadata and
   acknowledged progress reach completion.
4. Cancel an outgoing transfer and cancel an incoming transfer; verify both
   peers show cancelled.
5. Disable network briefly, restore it within 20 seconds, and verify the
   channel and an active transfer recover without duplicate messages.
6. Keep a peer offline longer than 20 seconds and verify the session expires.
7. Restart the app and confirm file history persists without file contents.
8. Search history, combine filters, clear filters, then clear history and
   confirm saved files remain.

## Checks

```bash
npm test --prefix server
npx tsc --noEmit
npm run lint
node --check server/index.js
node --check server/session-manager.js
node --check server/transfer-manager.js
git diff --check
```
