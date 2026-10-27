import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  event: { type: String, required: true, index: true },
  username: { type: String, default: null },
  sessionId: { type: String, default: null },
  details: { type: String, default: null },
  ip: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});

export default mongoose.model('AuditLog', auditLogSchema);
