import { Types } from 'mongoose';
import { Promotion, IPromotion } from '../models/Promotion';
import { Coupon } from '../models/Coupon';
import { ProductSku, IProductSku } from '../models/ProductSku';
import { Customer } from '../models/Customer';
import { SaleChannel } from '../config/constants';
import { ApiError } from '../utils/ApiError';

export interface CartLineInput {
  sku: IProductSku;
  qty: number;
}

export interface ResolvedLine {
  skuId: string;
  qty: number;
  unitPriceTiered: number; // regular/member/special, before promotions
  unitPriceFinal: number; // after best per-line promotion
  promotionId?: string;
  lineTotal: number;
}

export interface CartPromotionResult {
  lines: ResolvedLine[];
  cartPromotionId?: string;
  cartDiscount: number;
  couponId?: string;
  couponDiscount: number;
  subtotal: number; // sum of unitPriceTiered * qty, before any discount
  discountTotal: number; // cartDiscount + couponDiscount + sum(per-line promo discounts)
  netTotal: number;
}

/**
 * Promotions the cashier can pick for this branch/channel right now. Nothing
 * applies on its own: a promotion only counts when it is selected on the bill
 * (or, for one that backs a coupon, when that coupon code is entered).
 */
async function getSelectablePromotions(branchId: string, channel: SaleChannel, at: Date): Promise<IPromotion[]> {
  const couponPromotionIds = await Coupon.distinct('promotionId');
  return Promotion.find({
    _id: { $nin: couponPromotionIds },
    active: true,
    startAt: { $lte: at },
    endAt: { $gte: at },
    $and: [
      { $or: [{ scopeBranchIds: { $size: 0 } }, { scopeBranchIds: new Types.ObjectId(branchId) }] },
      { $or: [{ scopeChannels: { $size: 0 } }, { scopeChannels: channel }] },
    ],
  }).sort({ endAt: 1, name: 1 });
}

/**
 * Tiered static price (spec item 11): the lowest of regular / member (if
 * the customer has a member level) / special. This is independent of the
 * promotion-stacking rule, which only governs promotions proper.
 */
export function tieredUnitPrice(sku: IProductSku, isMember: boolean): number {
  const candidates = [sku.priceRegular];
  if (isMember && sku.priceMember !== undefined) candidates.push(sku.priceMember);
  if (sku.priceSpecial !== undefined) candidates.push(sku.priceSpecial);
  return Math.min(...candidates);
}

type CustomerLike = { memberLevelId?: Types.ObjectId } | null;

/**
 * Prices the cart with the given promotions. Promotions do not stack with
 * each other (spec Part C): per line the lowest resulting price wins, and at
 * most one cart-wide promotion (the biggest discount) applies on top.
 */
function priceWithPromotions(lines: CartLineInput[], customer: CustomerLike, promotions: IPromotion[]) {
  const isMember = Boolean(customer?.memberLevelId);
  const perLinePromotions = promotions.filter((p) => p.type === 'percent' || p.type === 'amount');
  const cartWidePromotions = promotions.filter((p) => p.type === 'buy_x_get_y' || p.type === 'spend_x_get_y');

  const resolvedLines: ResolvedLine[] = lines.map(({ sku, qty }) => {
    const unitPriceTiered = tieredUnitPrice(sku, isMember);

    let bestUnitPrice = unitPriceTiered;
    let bestPromotionId: string | undefined;
    for (const promo of perLinePromotions) {
      if (promo.scopeSkuIds.length > 0 && !promo.scopeSkuIds.some((id) => id.equals(sku._id))) continue;
      if (promo.scopeMemberLevelIds.length > 0 && !(customer?.memberLevelId && promo.scopeMemberLevelIds.some((id) => id.equals(customer.memberLevelId!)))) {
        continue;
      }
      const candidate =
        promo.type === 'percent'
          ? unitPriceTiered * (1 - (promo.config.percentOff ?? 0) / 100)
          : unitPriceTiered - (promo.config.amountOff ?? 0);
      const flooredCandidate = Math.max(0, Math.round(candidate));
      if (flooredCandidate < bestUnitPrice) {
        bestUnitPrice = flooredCandidate;
        bestPromotionId = promo._id.toString();
      }
    }

    return {
      skuId: sku._id.toString(),
      qty,
      unitPriceTiered,
      unitPriceFinal: bestUnitPrice,
      promotionId: bestPromotionId,
      lineTotal: bestUnitPrice * qty,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + tieredUnitPrice(l.sku, isMember) * l.qty, 0);
  const afterLinePromotions = resolvedLines.reduce((sum, l) => sum + l.lineTotal, 0);

  let cartDiscount = 0;
  let cartPromotionId: string | undefined;
  for (const promo of cartWidePromotions) {
    let discount = 0;
    if (promo.type === 'spend_x_get_y') {
      if (afterLinePromotions >= (promo.config.spendThreshold ?? Infinity)) {
        discount = promo.config.spendDiscountAmount ?? 0;
      }
    } else if (promo.type === 'buy_x_get_y') {
      const scoped = resolvedLines.filter((l) => promo.scopeSkuIds.length === 0 || promo.scopeSkuIds.some((id) => id.toString() === l.skuId));
      const scopedQty = scoped.reduce((sum, l) => sum + l.qty, 0);
      const buyQty = promo.config.buyQty ?? Infinity;
      const getQty = promo.config.getQty ?? 0;
      if (scopedQty >= buyQty) {
        const cheapestUnit = Math.min(...scoped.map((l) => l.unitPriceFinal));
        discount = cheapestUnit * getQty * Math.floor(scopedQty / buyQty);
      }
    }
    if (discount > cartDiscount) {
      cartDiscount = discount;
      cartPromotionId = promo._id.toString();
    }
  }

  return { resolvedLines, subtotal, afterLinePromotions, cartDiscount, cartPromotionId };
}

/**
 * Resolves final line/cart pricing for a POS or online sale. Static price
 * tiers (regular/member/special) always apply; promotions only when the
 * cashier selected them (`promotionIds`), and a stackable coupon layers on top.
 */
export async function evaluateCart(params: {
  branchId: string;
  channel: SaleChannel;
  customerId?: string;
  lines: CartLineInput[];
  promotionIds?: string[];
  couponCode?: string;
  at?: Date;
}): Promise<CartPromotionResult> {
  const at = params.at ?? new Date();
  const customer = params.customerId ? await Customer.findById(params.customerId) : null;

  const wanted = [...new Set(params.promotionIds ?? [])];
  let selected: IPromotion[] = [];
  if (wanted.length > 0) {
    const selectable = await getSelectablePromotions(params.branchId, params.channel, at);
    selected = selectable.filter((p) => wanted.includes(p._id.toString()));
    if (selected.length !== wanted.length) {
      throw ApiError.badRequest('โปรโมชันที่เลือกใช้กับสาขา/ช่องทางนี้ไม่ได้ หรือหมดเวลาแล้ว');
    }
  }

  const { resolvedLines, subtotal, afterLinePromotions, cartDiscount, cartPromotionId } = priceWithPromotions(params.lines, customer, selected);

  let couponDiscount = 0;
  let couponId: string | undefined;
  if (params.couponCode) {
    const coupon = await Coupon.findOne({ code: params.couponCode.toUpperCase(), active: true }).populate('promotionId');
    if (!coupon) throw ApiError.badRequest('Invalid or inactive coupon code');
    const promo = coupon.promotionId as unknown as IPromotion;
    if (!promo.stackable) {
      throw ApiError.badRequest('This coupon is not marked as stackable and cannot be combined with other pricing');
    }
    if (at < promo.startAt || at > promo.endAt) throw ApiError.badRequest('Coupon promotion is not active');
    if (coupon.usageLimit !== undefined && coupon.usedCount >= coupon.usageLimit) {
      throw ApiError.badRequest('Coupon usage limit reached');
    }
    const base = afterLinePromotions - cartDiscount;
    couponDiscount =
      promo.type === 'percent'
        ? Math.round(base * ((promo.config.percentOff ?? 0) / 100))
        : Math.round(promo.config.amountOff ?? 0);
    couponId = coupon._id.toString();
  }

  const discountTotal = subtotal - afterLinePromotions + cartDiscount + couponDiscount;
  const netTotal = Math.max(0, subtotal - discountTotal);

  return {
    lines: resolvedLines,
    cartPromotionId,
    cartDiscount,
    couponId,
    couponDiscount,
    subtotal,
    discountTotal,
    netTotal,
  };
}

export interface PromotionOption {
  _id: string;
  name: string;
  type: string;
  config: IPromotion['config'];
  endAt: Date;
  /** Discount this promotion alone would give the current cart (0 = doesn't apply to these items yet). */
  saving: number;
}

/** The promotions the cashier can pick for this cart, with what each would save on its own. */
export async function listPromotionOptions(params: {
  branchId: string;
  channel: SaleChannel;
  customerId?: string;
  lines: CartLineInput[];
  at?: Date;
}): Promise<PromotionOption[]> {
  const customer = params.customerId ? await Customer.findById(params.customerId) : null;
  const promotions = await getSelectablePromotions(params.branchId, params.channel, params.at ?? new Date());
  const base = priceWithPromotions(params.lines, customer, []);
  const baseNet = base.afterLinePromotions;
  return promotions
    .map((promo) => {
      const priced = priceWithPromotions(params.lines, customer, [promo]);
      return {
        _id: promo._id.toString(),
        name: promo.name,
        type: promo.type,
        config: promo.config,
        endAt: promo.endAt,
        saving: Math.max(0, baseNet - (priced.afterLinePromotions - priced.cartDiscount)),
      };
    })
    .sort((a, b) => b.saving - a.saving || a.name.localeCompare(b.name));
}

/**
 * Cashier-entered unit prices (a haggled price, or 0 for a giveaway) replace
 * whatever the promotion engine picked for that line. Overrides may only
 * lower the price; the cart-level discounts are kept and totals recomputed.
 */
export function applyPriceOverrides(cart: CartPromotionResult, overrides: Map<string, number>): CartPromotionResult {
  if (overrides.size === 0) return cart;
  const lines = cart.lines.map((line) => {
    const override = overrides.get(line.skuId);
    if (override === undefined) return line;
    if (override < 0 || override > line.unitPriceTiered) throw ApiError.badRequest('Manual price must be between 0 and the regular price');
    return { ...line, unitPriceFinal: override, promotionId: undefined, lineTotal: override * line.qty };
  });
  const afterLines = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const netTotal = Math.max(0, afterLines - cart.cartDiscount - cart.couponDiscount);
  return { ...cart, lines, discountTotal: cart.subtotal - netTotal, netTotal };
}

export async function incrementCouponUsage(couponId: string): Promise<void> {
  await Coupon.findByIdAndUpdate(couponId, { $inc: { usedCount: 1 } });
}
