import { Schema, model, Types } from 'mongoose';

export interface IAuditLog {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  branchId?: Types.ObjectId;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  refDoc?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    refDoc: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ createdAt: -1 });

// Append-only: block updates/deletes at the driver level.
auditLogSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
  next(new Error('audit_logs is append-only'));
});
auditLogSchema.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function (next) {
  next(new Error('audit_logs is append-only'));
});

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
