import { Schema, model, Types } from 'mongoose';

/**
 * Generic key/value store for admin-tunable business-rule defaults (spec
 * Part C). Every write should go through settingsService.set() so it is
 * captured in audit_logs (per B13, item 20).
 */
export interface ISetting {
  _id: Types.ObjectId;
  key: string;
  value: unknown;
  description?: string;
  updatedBy?: Types.ObjectId;
  updatedAt: Date;
  createdAt: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Setting = model<ISetting>('Setting', settingSchema);

export const SETTING_KEYS = {
  refundPolicy: 'refund_policy',
  stockChannelDefaultMode: 'stock_channel_default_mode',
  lowStockDefaultThreshold: 'low_stock_default_threshold',
  expiryWarningDays: 'expiry_warning_days',
  deadStockDays: 'dead_stock_days',
  transferOverdueDays: 'transfer_overdue_days',
  skuGenerationCap: 'sku_generation_cap',
  skuCodeFormat: 'sku_code_format',
  promotionStackingMode: 'promotion_stacking_mode',
  purchaseAllocationMethod: 'purchase_allocation_method',
  openingFloatStandardByBranch: 'opening_float_standard_by_branch',
  permissionOverridesByRole: 'permission_overrides_by_role',
} as const;

export const SETTING_DEFAULTS: Record<string, unknown> = {
  [SETTING_KEYS.refundPolicy]: {
    returnWindowDays: 7,
    allowOpenedReturn: false,
  },
  [SETTING_KEYS.stockChannelDefaultMode]: 'shared',
  [SETTING_KEYS.lowStockDefaultThreshold]: 5,
  [SETTING_KEYS.expiryWarningDays]: 90,
  [SETTING_KEYS.deadStockDays]: 90,
  [SETTING_KEYS.transferOverdueDays]: 3,
  [SETTING_KEYS.skuGenerationCap]: 500,
  [SETTING_KEYS.skuCodeFormat]: '{modelCode}-{power}',
  [SETTING_KEYS.promotionStackingMode]: 'lowest_price_no_stack',
  [SETTING_KEYS.purchaseAllocationMethod]: 'proportional_value',
  [SETTING_KEYS.openingFloatStandardByBranch]: {},
  [SETTING_KEYS.permissionOverridesByRole]: {},
};
