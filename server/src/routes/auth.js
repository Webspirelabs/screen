import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import Admin from '../models/Admin.js';
import AuditLog from '../models/AuditLog.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'strict',
  path: '/',
  maxAge: 8 * 60 * 60 * 1000
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 100 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter a valid username and password.' });
    }

    const admin = await Admin.findOne({ username });
    const valid = admin ? await bcrypt.compare(password, admin.passwordHash) : false;
    if (!valid) {
      await AuditLog.create({ event: 'admin.login_failed', username, ip: req.ip });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = jwt.sign(
      { role: 'admin', username: admin.username },
      process.env.JWT_SECRET,
      { subject: admin.id, expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.cookie('admin_token', token, cookieOptions());
    await AuditLog.create({ event: 'admin.login', username: admin.username, ip: req.ip });
    return res.json({ user: { username: admin.username } });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.admin_token;
    let username = null;
    if (token) {
      try {
        username = jwt.verify(token, process.env.JWT_SECRET).username;
      } catch {
        username = null;
      }
    }
    res.clearCookie('admin_token', { ...cookieOptions(), maxAge: undefined });
    if (username) await AuditLog.create({ event: 'admin.logout', username, ip: req.ip });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ user: { username: req.admin.username } });
});

export default router;
