export const ROLES = ['admin', 'branch_manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const SALE_CHANNELS = ['store', 'grab', 'line', 'facebook', 'ig', 'other'] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];

/** How shift summaries split the money: walk-in, Grab, and everything sold over chat (LINE/FB/IG/other). */
export type SalesBucket = 'store' | 'grab' | 'online';
export const salesBucket = (channel: string | undefined): SalesBucket => (!channel || channel === 'store' ? 'store' : channel === 'grab' ? 'grab' : 'online');

// 'platform' = collected by a delivery/marketplace platform (e.g. Grab); never lands in the drawer or shop account.
export const PAYMENT_METHODS = ['cash', 'transfer', 'qr', 'platform'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVENTORY_TXN_TYPES = [
  'purchase_in',
  'sale_out',
  'return_in',
  'write_off',
  'adjustment_increase',
  'adjustment_decrease',
  'damage_out',
  'internal_use_out',
  'transfer_out',
  'transfer_in',
  'reversal',
] as const;
export type InventoryTxnType = (typeof INVENTORY_TXN_TYPES)[number];

export const PRODUCT_TYPES = ['contact_lens', 'other'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const UNIT_OF_MEASURE = ['piece', 'box', 'bottle', 'pair', 'set'] as const;
export type UnitOfMeasure = (typeof UNIT_OF_MEASURE)[number];

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded', 'partially_refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_TYPES = ['refund', 'exchange'] as const;
export type RefundType = (typeof REFUND_TYPES)[number];

export const ITEM_CONDITIONS = ['sealed', 'opened', 'defective', 'wrong_item'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const STOCK_DESTINATIONS = ['return_stock', 'write_off'] as const;
export type StockDestination = (typeof STOCK_DESTINATIONS)[number];

export const REFUND_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const TRANSFER_STATUSES = ['sent', 'in_transit', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const SHIFT_SESSION_STATUSES = ['open', 'pending_review', 'approved', 'reopened'] as const;
export type ShiftSessionStatus = (typeof SHIFT_SESSION_STATUSES)[number];

export const CASH_MOVEMENT_TYPES = ['cash_in', 'cash_out', 'deposit'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const PROMOTION_TYPES = ['percent', 'amount', 'buy_x_get_y', 'spend_x_get_y', 'coupon'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const STOCK_CHANNEL_MODES = ['shared', 'split'] as const;
export type StockChannelMode = (typeof STOCK_CHANNEL_MODES)[number];

export const EXPENSE_CATEGORIES = [
  'rent',
  'electricity',
  'water',
  'shipping',
  'packaging',
  'advertising',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const NOTIFICATION_TYPES = [
  'stock_out',
  'low_stock',
  'stock_adjustment',
  'daily_sale_closed',
  'sale_completed',
  'refund_requested',
  'refund_decided',
  'transfer_incoming',
  'transfer_overdue',
  'shift_pending_review',
  'shift_cash_variance',
  'shift_schedule_published',
  'shift_schedule_changed',
  'shift_conflict',
  'branch_understaffed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Default permission matrix (spec section 21 + B2). Admin can override via
 * the `settings` collection (key: permission_overrides) without a code
 * change; services must consult resolvePermission(), never this constant
 * directly, so overrides always take effect.
 */
export const DEFAULT_PERMISSIONS = {
  admin: {
    manageUsers: true,
    manageBranches: true,
    manageSystemSettings: true,
    sellInStore: true,
    sellOnline: true,
    viewCost: true,
    editCost: true,
    editMainPrice: true,
    deleteStock: true,
    editPastSales: true,
    reportsHistoryDays: null, // null = unlimited
    receivePurchase: true,
    adjustStock: true,
    deleteStockTransfer: true,
    createStockTransfer: true,
    receiveStockTransfer: true,
    approveRefund: true,
    createRefundRequest: true,
    approveShiftClose: true,
    editPastShiftClose: true,
    manageShiftSchedule: true,
    viewShiftScheduleAll: true,
    viewOwnReportsOnly: false,
  },
  branch_manager: {
    manageUsers: false,
    manageBranches: false,
    manageSystemSettings: false,
    sellInStore: true,
    sellOnline: false,
    viewCost: false,
    editCost: false,
    editMainPrice: false,
    deleteStock: false,
    editPastSales: false,
    reportsHistoryDays: null,
    receivePurchase: true,
    adjustStock: true,
    deleteStockTransfer: false,
    createStockTransfer: true,
    receiveStockTransfer: true,
    approveRefund: true,
    createRefundRequest: true,
    approveShiftClose: true,
    editPastShiftClose: false,
    manageShiftSchedule: false,
    viewShiftScheduleAll: false,
    viewOwnReportsOnly: false,
  },
  staff: {
    manageUsers: false,
    manageBranches: false,
    manageSystemSettings: false,
    sellInStore: true,
    sellOnline: false,
    viewCost: false,
    editCost: false,
    editMainPrice: false,
    deleteStock: false,
    editPastSales: false,
    reportsHistoryDays: 1,
    receivePurchase: false,
    adjustStock: false,
    deleteStockTransfer: false,
    createStockTransfer: false,
    receiveStockTransfer: false,
    approveRefund: false,
    createRefundRequest: true,
    approveShiftClose: false,
    editPastShiftClose: false,
    manageShiftSchedule: false,
    viewShiftScheduleAll: false,
    viewOwnReportsOnly: true,
  },
} as const satisfies Record<Role, Record<string, boolean | number | null>>;

export type PermissionKey = keyof typeof DEFAULT_PERMISSIONS.admin;
