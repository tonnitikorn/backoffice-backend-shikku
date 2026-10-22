import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { StockPhotoScan, IStockPhotoScanRow, IStockPhotoScanSample } from '../models/StockPhotoScan';
import { Product } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { ApiError } from '../utils/ApiError';

const SYSTEM_PROMPT = `You read contact-lens stock from photos of vial trays in a Thai contact-lens shop.
Each vial holds one lens. Its cap label shows the model name, the color, and the power (e.g. "Nene / BROWN / -1.00"). Many caps are rotated or upside down; read them anyway.

Count every vial you can see, cap by cap, and group identical model + color + power into one row with the count of vials.
- Use the exact model and color names from the shop catalog in the request when a cap matches one; if a cap shows a model or color not in the catalog, write it as printed.
- Power is a negative number for myopia (e.g. -1.25). A cap with no power, "0.00" or "plano" is power 0.
- Mark a row "low" confidence if any cap in it was partly hidden, blurry, or you had to guess the model, color or power, and say what was uncertain in "note" (in Thai).
- Count caps you cannot read at all in "unreadable" instead of guessing.
- For each model + color, also give one "sample": the bounding box of the clearest, most legible cap of that model + color, as fractions of the image width and height (x, y = top-left corner).

Accuracy matters more than speed: these counts pre-fill a stock top-up form that a staff member checks before saving.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'samples', 'unreadable'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'color', 'power', 'vials', 'confidence', 'note'],
        properties: {
          model: { type: 'string' },
          color: { type: 'string' },
          power: { type: 'number' },
          vials: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'low'] },
          note: { type: 'string' },
        },
      },
    },
    samples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'color', 'x', 'y', 'w', 'h'],
        properties: {
          model: { type: 'string' },
          color: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
      },
    },
    unreadable: { type: 'integer' },
  },
} as const;

interface ScanOutput {
  rows: { model: string; color: string; power: number; vials: number; confidence: 'high' | 'low'; note: string }[];
  samples: { model: string; color: string; x: number; y: number; w: number; h: number }[];
  unreadable: number;
}

const MEDIA_TYPE: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function isScanConfigured() {
  return Boolean(env.anthropicApiKey);
}

/**
 * Creates the scan record. With an API key the photo is read in the background and the client polls until it is ready;
 * without one the scan waits ('awaiting') for the user to read it in the Claude app and paste the result back.
 */
export async function startScan(input: { branchId: string; imageUrl: string; userId: string }) {
  const status = isScanConfigured() ? 'processing' : 'awaiting';
  const scan = await StockPhotoScan.create({ branchId: input.branchId, imageUrl: input.imageUrl, status, createdBy: input.userId });
  if (status === 'processing') void runScan(scan._id).catch((err) => logger.error({ err, scanId: scan._id.toString() }, 'Stock photo scan crashed'));
  return scan;
}

/** Everything the Claude app needs besides the photo: the same instructions and catalog the API call uses, plus the reply format. */
export async function manualPrompt() {
  return `${SYSTEM_PROMPT}

Shop catalog (model: colors):
${await catalogText()}

Read every vial cap in the attached tray photo.
Reply with only one JSON object (no other text) matching this JSON schema:
${JSON.stringify(OUTPUT_SCHEMA)}`;
}

const pastedSchema = z.object({
  rows: z.array(
    z.object({
      model: z.string(),
      color: z.string(),
      power: z.number().nullable().default(0),
      vials: z.number().int().min(0),
      confidence: z.enum(['high', 'low']).default('high'),
      note: z.string().default(''),
    }),
  ),
  samples: z.array(z.object({ model: z.string(), color: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })).default([]),
  unreadable: z.number().int().min(0).default(0),
});

/** Parses the reply copied from the Claude app; tolerates a ```json fence or text around the object. */
export function parsePastedResult(text: string): ScanOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw ApiError.badRequest('ข้อความที่วางไม่ใช่ JSON — คัดลอกคำตอบจาก Claude มาทั้งก้อน');
  }
  const parsed = pastedSchema.safeParse(json);
  if (!parsed.success) throw ApiError.badRequest('รูปแบบ JSON ไม่ตรงกับที่ระบบต้องการ — ลองให้ Claude ตอบใหม่ตามคำสั่ง');
  return { ...parsed.data, rows: parsed.data.rows.map((r) => ({ ...r, power: r.power ?? 0 })) };
}

/** Completes an 'awaiting' scan with the result pasted back from the Claude app. */
export async function applyPastedResult(scanId: string, text: string) {
  const scan = await StockPhotoScan.findById(scanId);
  if (!scan) throw ApiError.notFound('Scan not found');
  if (scan.status !== 'awaiting' && scan.status !== 'failed') throw ApiError.badRequest('รูปนี้อ่านผลไปแล้ว');
  const output = parsePastedResult(text);
  const { rows, samples } = await matchToCatalog(output);
  scan.rows = rows;
  scan.samples = samples;
  scan.unreadable = output.unreadable;
  scan.modelUsed = 'manual';
  scan.error = undefined;
  scan.status = 'ready';
  await scan.save();
  return scan;
}

async function catalogText() {
  const products = await Product.find({ active: true, type: 'contact_lens' }, { name: 1 }).sort({ name: 1 });
  const variants = await ProductVariant.find({ productId: { $in: products.map((p) => p._id) } }, { productId: 1, colorName: 1 });
  const colors = new Map<string, string[]>();
  for (const v of variants) {
    if (!v.colorName) continue;
    const key = v.productId.toString();
    colors.set(key, [...(colors.get(key) ?? []), v.colorName]);
  }
  return products.map((p) => `- ${p.name}: ${(colors.get(p._id.toString()) ?? []).join(', ') || '(no colors)'}`).join('\n');
}

async function runScan(scanId: Types.ObjectId) {
  const scan = await StockPhotoScan.findById(scanId);
  if (!scan) return;
  try {
    const file = path.resolve(process.cwd(), scan.imageUrl.replace(/^\//, ''));
    const mediaType = MEDIA_TYPE[path.extname(file).toLowerCase()];
    if (!mediaType) throw new Error('Unsupported image type');
    const data = (await fs.readFile(file)).toString('base64');

    const client = new Anthropic({ apiKey: env.anthropicApiKey });
    const response = await client.beta.messages
      .stream({
        model: env.stockScanModel,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
              { type: 'text', text: `Shop catalog (model: colors):\n${await catalogText()}\n\nRead every vial cap in this tray photo.` },
            ],
          },
        ],
      })
      .finalMessage();

    if (response.stop_reason === 'refusal') throw new Error('The model declined to read this photo');
    if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens');
    const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
    if (!text) throw new Error('The model returned no result');
    const output = JSON.parse(text) as ScanOutput;

    const { rows, samples } = await matchToCatalog(output);
    scan.rows = rows;
    scan.samples = samples;
    scan.unreadable = output.unreadable;
    scan.modelUsed = response.model;
    scan.status = 'ready';
    await scan.save();
  } catch (err) {
    logger.error({ err, scanId: scanId.toString() }, 'Stock photo scan failed');
    scan.status = 'failed';
    scan.error =
      err instanceof Anthropic.AuthenticationError
        ? 'ANTHROPIC_API_KEY ไม่ถูกต้อง'
        : err instanceof Anthropic.RateLimitError
          ? 'ระบบ AI ถูกใช้งานเยอะ ลองใหม่อีกครั้ง'
          : err instanceof Anthropic.APIError
            ? `AI error ${err.status}: ${err.message}`
            : (err as Error).message;
    await scan.save();
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');

/** Resolves AI-read names to products/colors/SKUs; anything that doesn't match is kept with a reason for the reviewer. */
export async function matchToCatalog(output: Pick<ScanOutput, 'rows' | 'samples'>) {
  const products = await Product.find({ active: true }, { name: 1, shortCode: 1 });
  const byName = new Map(products.map((p) => [norm(p.name), p]));
  const variants = await ProductVariant.find({ productId: { $in: products.map((p) => p._id) } }, { productId: 1, colorName: 1 });

  const findProduct = (name: string) => byName.get(norm(name));
  const findVariant = (productId: Types.ObjectId, color: string) =>
    variants.find((v) => v.productId.equals(productId) && norm(v.colorName ?? '') === norm(color));

  const rows: IStockPhotoScanRow[] = [];
  for (const r of output.rows) {
    const row: IStockPhotoScanRow = { model: r.model, color: r.color, power: r.power ?? null, vials: r.vials, confidence: r.confidence, note: r.note || undefined };
    const product = findProduct(r.model);
    if (!product) row.matchError = 'ไม่พบรุ่นนี้ในระบบ';
    else {
      row.productId = product._id;
      const variant = findVariant(product._id, r.color);
      if (!variant) row.matchError = 'ไม่พบสีนี้ในรุ่นนี้';
      else {
        row.variantId = variant._id;
        const powerFilter = !r.power ? { $in: [0, null] } : r.power;
        const sku = await ProductSku.findOne({ productId: product._id, variantId: variant._id, power: powerFilter, active: true }, { _id: 1 });
        if (!sku) row.matchError = 'ไม่พบค่าสายตานี้ (ยังไม่มี SKU)';
        else row.skuId = sku._id;
      }
    }
    rows.push(row);
  }

  const samples: IStockPhotoScanSample[] = [];
  for (const s of output.samples) {
    const product = findProduct(s.model);
    const variant = product ? findVariant(product._id, s.color) : undefined;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    samples.push({ model: s.model, color: s.color, box: { x: clamp(s.x), y: clamp(s.y), w: clamp(s.w), h: clamp(s.h) }, productId: product?._id, variantId: variant?._id });
  }
  return { rows, samples };
}
