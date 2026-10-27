import { Server } from 'socket.io';
import ShareSession from './models/ShareSession.js';
import AuditLog from './models/AuditLog.js';
import { getTokenFromCookieHeader, verifyAdminToken } from './middleware/requireAdmin.js';
import { publicSession } from './routes/sessions.js';

export function attachSocketServer(httpServer, isAllowedOrigin, isAllowedHandshake) {
  const io = new Server(httpServer, {
    cors: {
      origin: (requestOrigin, callback) => callback(null, isAllowedOrigin(requestOrigin)),
      credentials: true
    },
    allowRequest: (request, callback) => callback(null, isAllowedHandshake(request)),
    maxHttpBufferSize: 1e6
  });

  io.use((socket, next) => {
    const requestedRole = socket.handshake.auth?.role;
    if (requestedRole === 'sharer') {
      socket.data.role = 'sharer';
      return next();
    }
    if (requestedRole !== 'admin') {
      return next(new Error('Socket role is required.'));
    }
    const payload = verifyAdminToken(getTokenFromCookieHeader(socket.handshake.headers.cookie));
    if (payload?.role === 'admin') {
      socket.data.role = 'admin';
      socket.data.username = payload.username;
      return next();
    }
    return next(new Error('Administrator authentication required.'));
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'admin') socket.join('admins');

    socket.on('share:start', async (ack = () => {}) => {
      if (socket.data.role !== 'sharer') return ack({ error: 'Only a sharing browser can start a session.' });
      if (socket.data.sessionId) return ack({ error: 'This browser already has an active sharing session.' });
      try {
        const session = await ShareSession.create({ ownerSocketId: socket.id });
        socket.data.sessionId = session.id;
        await AuditLog.create({ event: 'screen_session.started', sessionId: session.id });
        io.to('admins').emit('session:updated', publicSession(session));
        ack({ sessionId: session.id });
      } catch (error) {
        ack({ error: 'Unable to create the sharing session.' });
      }
    });

    socket.on('viewer:join', async ({ sessionId } = {}, ack = () => {}) => {
      if (socket.data.role !== 'admin') return ack({ error: 'Administrator authentication required.' });
      if (typeof sessionId !== 'string' || !/^[a-f\d]{24}$/i.test(sessionId)) {
        return ack({ error: 'Invalid session ID.' });
      }
      try {
        const session = await ShareSession.findById(sessionId).select('+ownerSocketId +viewerSocketId');
        if (!session || session.status !== 'active') return ack({ error: 'This sharing session is no longer active.' });
        const currentViewer = session.viewerSocketId && io.sockets.sockets.get(session.viewerSocketId);
        if (currentViewer?.connected && session.viewerSocketId !== socket.id) {
          return ack({ error: 'This session is already being viewed by an administrator.' });
        }
        const ownerSocket = io.sockets.sockets.get(session.ownerSocketId);
        if (!ownerSocket?.connected) return ack({ error: 'The sharing browser has disconnected.' });
        session.viewerSocketId = socket.id;
        await session.save();
        socket.data.viewingSessionId = sessionId;
        ownerSocket.emit('viewer:ready', { sessionId });
        ack({ ok: true });
      } catch {
        ack({ error: 'Unable to connect to this sharing session.' });
      }
    });

    socket.on('rtc:signal', async ({ sessionId, description, candidate } = {}) => {
      if (typeof sessionId !== 'string') return;
      try {
        const session = await ShareSession.findById(sessionId).select('+ownerSocketId +viewerSocketId');
        if (!session || session.status !== 'active') return;
        const isOwner = socket.id === session.ownerSocketId;
        const isViewer = socket.data.role === 'admin' && socket.id === session.viewerSocketId;
        if (!isOwner && !isViewer) return;
        const destination = isOwner ? session.viewerSocketId : session.ownerSocketId;
        if (!destination) return;
        if (description && typeof description.type === 'string' &&
            ['offer', 'answer'].includes(description.type) &&
            typeof description.sdp === 'string' && description.sdp.length <= 100000) {
          io.to(destination).emit('rtc:signal', { sessionId, description });
        } else if (candidate && typeof candidate.candidate === 'string' &&
            candidate.candidate.length <= 4096) {
          io.to(destination).emit('rtc:signal', { sessionId, candidate });
        }
      } catch {
        socket.emit('rtc:error', { message: 'A signaling error occurred.' });
      }
    });

    socket.on('share:stop', async ({ sessionId, reason = 'user' } = {}) => {
      if (socket.data.role !== 'sharer' || socket.data.sessionId !== sessionId) return;
      await finishSession(io, sessionId, reason === 'permission_revoked' ? reason : 'user');
    });

    socket.on('viewer:leave', async ({ sessionId } = {}) => {
      if (socket.data.role !== 'admin' || socket.data.viewingSessionId !== sessionId) return;
      await ShareSession.updateOne({ _id: sessionId, viewerSocketId: socket.id }, { $set: { viewerSocketId: null } });
      socket.data.viewingSessionId = null;
    });

    socket.on('disconnect', async () => {
      if (socket.data.role === 'sharer' && socket.data.sessionId) {
        await finishSession(io, socket.data.sessionId, 'disconnected');
      }
      if (socket.data.viewingSessionId) {
        await ShareSession.updateOne(
          { _id: socket.data.viewingSessionId, viewerSocketId: socket.id },
          { $set: { viewerSocketId: null } }
        );
      }
    });
  });

  return io;
}

async function finishSession(io, sessionId, reason) {
  const session = await ShareSession.findById(sessionId).select('+ownerSocketId +viewerSocketId');
  if (!session || session.status !== 'active') return;
  session.status = 'ended';
  session.endedAt = new Date();
  session.endReason = reason;
  await session.save();
  io.to(session.ownerSocketId).emit('session:ended', { sessionId, reason });
  if (session.viewerSocketId) io.to(session.viewerSocketId).emit('session:ended', { sessionId, reason });
  io.to('admins').emit('session:updated', publicSession(session));
  await AuditLog.create({ event: 'screen_session.ended', sessionId, details: reason });
}
