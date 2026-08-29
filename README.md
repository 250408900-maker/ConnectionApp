# ConnectionApp

Peer-to-peer chat, voice calls, and file transfer between two devices. Expo client plus a Socket.IO relay.

## Run the client

```bash
npm install
npx expo start
```

Optional: point at your server with `EXPO_PUBLIC_SERVER_URL` (see `.env.example`).

## Run the relay

```bash
cd server
npm install
node index.js
```

The server listens on port `3000` by default (`PORT` to override). `GET /health` reports process health.

For production, put HTTPS and WSS behind a reverse proxy (nginx/Caddy) and set:

- Client: `EXPO_PUBLIC_SERVER_URL=https://your-domain`
- Server: `CORS_ORIGIN=https://your-domain`

Do not expose the raw IP over plain HTTP for real users.

## What works in v1

- Shared Socket.IO connection across Dashboard and Connect
- Create / join a 6-character channel
- Chat, typing indicators, images, documents, voice messages
- Voice calls (accept, decline, mute, hang up, reconnect grace period)

Accounts, contacts, E2E encryption, and group calls are later phases.
