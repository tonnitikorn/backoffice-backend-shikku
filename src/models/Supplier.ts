import { Schema, model, Types } from 'mongoose';

export interface ISupplier {
  _id: Types.ObjectId;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  taxId?: string;
  notes?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const supplierSchema = new Schema<ISupplier>(
  {
    name: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },
    taxId: { type: String, trim: true },
    notes: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Supplier = model<ISupplier>('Supplier', supplierSchema);
