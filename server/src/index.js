import dotenv from 'dotenv';
import dns from 'node:dns';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie';
import helmet from 'helmet';
import cors from 'cors';
import Admin from './models/Admin.js';
import ShareSession from './models/ShareSession.js';
import AuditLog from './models/AuditLog.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import { attachSocketServer } from './socket.js';

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEnvPath = resolve(serverDirectory, '.env');
const projectEnvPath = resolve(serverDirectory, '..', '.env');
dotenv.config({ path: existsSync(serverEnvPath) ? serverEnvPath : projectEnvPath });

const mongoDnsServers = process.env.MONGODB_DNS_SERVERS
  ?.split(',')
  .map((server) => server.trim())
  .filter(Boolean);
if (mongoDnsServers?.length) {
  if (mongoDnsServers.some((server) => !isIP(server))) {
    throw new Error('MONGODB_DNS_SERVERS must be a comma-separated list of DNS server IP addresses.');
  }
  dns.setServers(mongoDnsServers);
}

const required = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'CLIENT_ORIGIN'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');

async function connectToMongo() {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      return;
    } catch (error) {
      const code = error.code || error.cause?.code;
      const isDnsResolverError = ['ECONNREFUSED', 'ETIMEOUT'].includes(code) &&
        (error.syscall?.startsWith('query') || error.cause?.syscall?.startsWith('query'));
      if (!isDnsResolverError || attempt === maxAttempts) {
        if (isDnsResolverError) {
          throw new Error(
            `MongoDB Atlas DNS lookup failed after ${maxAttempts} attempts. Check MONGODB_DNS_SERVERS and your network DNS access.`,
            { cause: error }
          );
        }
        throw error;
      }
      const delayMs = attempt * 1000;
      console.warn(`MongoDB DNS lookup failed (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs / 1000}s.`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}

await connectToMongo();
const staleSessions = await ShareSession.find({ status: 'active' }).select('_id').lean();
if (staleSessions.length) {
  const endedAt = new Date();
  await ShareSession.updateMany(
    { status: 'active' },
    { $set: { status: 'ended', endedAt, endReason: 'server_restart' } }
  );
  await AuditLog.insertMany(staleSessions.map((session) => ({
    event: 'screen_session.ended',
    sessionId: session._id.toString(),
    details: 'server_restart',
    createdAt: endedAt
  })));
}
const username = process.env.ADMIN_USERNAME.trim();
const minimumPasswordLength = process.env.NODE_ENV === 'production' ? 16 : 11;
if (!username || process.env.ADMIN_PASSWORD.length < minimumPasswordLength ||
    Buffer.byteLength(process.env.ADMIN_PASSWORD, 'utf8') > 72) {
  throw new Error(`Set a non-empty ADMIN_USERNAME and an ADMIN_PASSWORD of ${minimumPasswordLength} to 72 UTF-8 bytes.`);
}
const existingAdmin = await Admin.findOne({ username });
if (!existingAdmin) {
  await Admin.create({
    username,
    passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)
  });
  console.info(`Bootstrapped administrator "${username}".`);
}

const app = express();
const httpServer = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN.replace(/\/$/, '');
const allowedOrigins = new Set([origin]);
const developmentOrigin = new URL(origin);
const isPrivateIpv4 = (hostname) => {
  if (!isIP(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};
const isAllowedOrigin = (value) => {
  if (allowedOrigins.has(value)) return true;
  if (process.env.NODE_ENV === 'production' || !value) return false;
  try {
    const candidate = new URL(value);
    if (candidate.protocol !== developmentOrigin.protocol) return false;
    return candidate.hostname === 'localhost' || candidate.hostname === '127.0.0.1' ||
      isPrivateIpv4(candidate.hostname);
  } catch {
    return false;
  }
};
const isAllowedHandshake = (request) => {
  const requestOrigin = request.headers.origin;
  if (requestOrigin) return isAllowedOrigin(requestOrigin);
  const referer = request.headers.referer;
  if (!referer) return false;
  try {
    return isAllowedOrigin(new URL(referer).origin);
  } catch {
    return false;
  }
};
if (process.env.NODE_ENV !== 'production') {
  if (developmentOrigin.hostname === 'localhost' || developmentOrigin.hostname === '127.0.0.1') {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const alias = new URL(origin);
      alias.hostname = hostname;
      allowedOrigins.add(alias.origin);
    }
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family !== 'IPv4' || address.internal || !isPrivateIpv4(address.address)) continue;
        const lanOrigin = new URL(origin);
        lanOrigin.hostname = address.address;
        allowedOrigins.add(lanOrigin.origin);
      }
    }
  }
}
const io = attachSocketServer(httpServer, isAllowedOrigin, isAllowedHandshake);
app.set('io', io);

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: (requestOrigin, callback) => callback(null, !requestOrigin || isAllowedOrigin(requestOrigin)),
  credentials: true
}));
app.use(express.json({ limit: '20kb' }));
app.use((req, _res, next) => {
  req.cookies = cookieParser.parse(req.headers.cookie || '');
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => console.info(`API and signaling server listening on port ${port}.`));
