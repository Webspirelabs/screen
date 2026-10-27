import mongoose from 'mongoose';

const shareSessionSchema = new mongoose.Schema({
  status: { type: String, enum: ['active', 'ended'], default: 'active', index: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  endReason: { type: String, default: null },
  ownerSocketId: { type: String, required: true, select: false },
  viewerSocketId: { type: String, default: null, select: false }
});

export default mongoose.model('ShareSession', shareSessionSchema);
