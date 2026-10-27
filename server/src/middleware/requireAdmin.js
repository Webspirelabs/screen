import jwt from 'jsonwebtoken';

export function getTokenFromCookieHeader(header = '') {
  const tokenCookie = header.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('admin_token='));
  return tokenCookie ? decodeURIComponent(tokenCookie.slice('admin_token='.length)) : null;
}

export function verifyAdminToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

export function requireAdmin(req, res, next) {
  const payload = verifyAdminToken(req.cookies?.admin_token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.admin = { id: payload.sub, username: payload.username };
  next();
}
