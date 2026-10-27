import { Router } from 'express';
import ShareSession from '../models/ShareSession.js';
import AuditLog from '../models/AuditLog.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const sessions = await ShareSession.find().sort({ startedAt: -1 }).limit(100).lean();
    return res.json({ sessions: sessions.map((session) => ({
      id: session._id.toString(),
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      endReason: session.endReason
    })) });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/end', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const session = await ShareSession.findById(req.params.id).select('+ownerSocketId +viewerSocketId');
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (session.status === 'active') {
      session.status = 'ended';
      session.endedAt = new Date();
      session.endReason = 'administrator';
      await session.save();
      const io = req.app.get('io');
      const ended = {
        sessionId: session.id,
        reason: 'administrator'
      };
      io.to(session.ownerSocketId).emit('session:ended', ended);
      if (session.viewerSocketId) io.to(session.viewerSocketId).emit('session:ended', ended);
      io.to('admins').emit('session:updated', publicSession(session));
      await AuditLog.create({
        event: 'screen_session.ended_by_admin',
        username: req.admin.username,
        sessionId: session.id,
        ip: req.ip
      });
    }
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export function publicSession(session) {
  return {
    id: session._id.toString(),
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason
  };
}

export default router;
