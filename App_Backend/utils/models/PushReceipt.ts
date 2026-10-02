import mongoose from "mongoose";

interface PushReceiptProps {
  ticketId: string;
  pushToken: string;
  lastCheckedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pushReceiptSchema = new mongoose.Schema<PushReceiptProps>(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
    },
    pushToken: {
      type: String,
      required: true,
    },
    lastCheckedAt: Date,
  },
  { timestamps: true }
);

pushReceiptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 172800 });

const PushReceipt =
  (mongoose.models.PushReceipt as mongoose.Model<PushReceiptProps> | undefined) ??
  mongoose.model<PushReceiptProps>("PushReceipt", pushReceiptSchema);

export default PushReceipt;