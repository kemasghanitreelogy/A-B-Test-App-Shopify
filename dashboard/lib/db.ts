import { PrismaClient } from "@prisma/client";

/**
 * Database yang sama dengan yang dipakai app Shopify.
 *
 * Dashboard tidak pernah menjalankan migrate — skema dimiliki oleh repo root dan
 * migrasi hanya dijalankan dari sana saat deploy app. Kalau keduanya boleh
 * migrate, dua deploy yang berjalan bersamaan bisa saling menimpa.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
