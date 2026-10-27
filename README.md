# Clearview — consent-first screen sharing

Clearview is a MERN application for real-time, browser-based support sessions. Screen capture is initiated by the sharing user, requires the browser's native `getDisplayMedia` permission prompt, and has an always-visible in-page stop control. The application does not record screen content or capture input.

## Requirements

- Node.js 20 or newer and npm
- MongoDB 6 or newer (local or hosted)
- A current browser supporting `getDisplayMedia` (secure context required outside localhost)

## Local development

1. Copy `.env.example` to `server/.env` (recommended). The server also loads a project-root `.env` as a fallback, so `D:\screen\.env` works when starting from `D:\screen\server`. If both files exist, `server/.env` takes precedence.
2. Set `MONGODB_URI` to your MongoDB connection string.
3. Replace `JWT_SECRET` with a random value of at least 32 characters. Change the sample administrator password before use outside a private development machine; production administrator passwords must be at least 16 characters (up to 72 UTF-8 bytes).
4. Install and launch:

   ```sh
   npm install
   npm run dev
   ```

5. Open `http://localhost:5173`. Administrator sign-in is at `http://localhost:5173/admin/login`.

The configured administrator is created with a bcrypt password hash the first time the server starts if the username is not already in MongoDB. The password is not returned by any API. Changing `ADMIN_PASSWORD` does not overwrite an existing account's password. The supplied 11-character sample credential works only in development; use a unique 16+ character password in production.

If MongoDB Atlas startup fails with `querySrv ECONNREFUSED`, check that your network's DNS resolver permits SRV queries. If it does not, either configure a permitted DNS resolver in Windows network settings or set `MONGODB_DNS_SERVERS` in `.env` to resolver IPs reachable on your network (for example `1.1.1.1,8.8.8.8`). This override affects DNS lookups made by the server process only; follow your network administrator's DNS policy.

## Production build

```sh
npm ci
npm run build
```

The Vite production bundle is generated in `client/dist`. Run the API/signaling service with `npm start` from the project root (or `npm run start -w server`). Put a reverse proxy in front of it and serve the frontend and API on the same HTTPS origin. A sample Nginx configuration is in `deploy/nginx.conf.example`.

### VPS deployment checklist

1. Provision a VPS, MongoDB, and a DNS name. Restrict MongoDB network access to the application host and use a database account with access only to this database.
2. Install Node.js 20+, check out the project, copy the environment file to `server/.env`, and set production values. Use a unique random `JWT_SECRET`, strong administrator credentials, `NODE_ENV=production`, `COOKIE_SECURE=true`, and `CLIENT_ORIGIN=https://your-domain.example`. Set `TRUST_PROXY=true` only when the service is behind the configured trusted reverse proxy.
3. Install dependencies, run `npm run build`, and start the backend with a process manager such as systemd or PM2. Keep `server/.env` readable only by the service account; never commit it.
4. Configure HTTPS at Nginx (for example with Let's Encrypt). Serve `client/dist` and proxy `/api/` and `/socket.io/` to the Node process. Preserve the `/admin` locations and internal `auth_request` check from `deploy/nginx.conf.example`; this protects the dashboard document at the reverse proxy as well as its server-guarded APIs. Socket.IO needs WebSocket upgrade support and a suitably long proxy read timeout.
5. For connections across restrictive NAT/firewalls, deploy a TURN service and configure its ICE servers in both `RTCPeerConnection` constructors in `client/src/App.jsx`. Use short-lived TURN credentials; browser ICE credentials are necessarily visible to the authorized browser. The default STUN setting is suitable for development, not a guarantee of connectivity in every network.
6. Back up MongoDB securely, monitor the service, and rotate secrets and bootstrap credentials according to your operations policy.

## Security and consent behavior

- Admin routes and session APIs verify a signed JWT in an HTTP-only, SameSite=Strict cookie. The cookie is Secure in production when `COOKIE_SECURE=true`.
- Administrator tokens expire after `JWT_EXPIRES_IN` (8 hours by default); logout clears the cookie. On server restart, any session left active by an unexpected shutdown is marked ended and audit logged.
- Login attempts are rate limited. Passwords are stored as bcrypt hashes. Administrator sign-in, failed sign-in, logout, and session start/end events are recorded in MongoDB.
- Session creation in the sharing UI happens only after the user has accepted the browser's screen-share prompt and a video track is available. The browser's own indicator remains authoritative; stopping that track immediately ends the session.
- The admin dashboard and APIs are protected on the server. Socket signaling checks the administrator token and binds messages to the active session owner and its authorized viewer.
- Audio capture is disabled. No screen data is recorded or persisted. An administrator may end an active session; this tells the sharing browser to stop its capture tracks.
- Use HTTPS in production; browsers restrict screen capture to secure contexts. Set an exact `CLIENT_ORIGIN`, not a wildcard.
- To test from a phone, use an HTTPS development/preview URL and a mobile browser that implements `getDisplayMedia`. A plain `http://192.168.x.x:5173` LAN address is not a secure context, and many mobile browsers do not support screen capture; the UI reports this instead of silently failing. In development, the signaling server permits the machine's private LAN IPv4 origins on the configured Vite port. Production remains restricted to the exact `CLIENT_ORIGIN`.

## Scripts

- `npm run dev` — start Vite and Express/Socket.IO for local development
- `npm run build` — create the production client bundle
- `npm start` — start the Express/Socket.IO server
