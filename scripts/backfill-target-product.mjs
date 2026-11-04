/**
 * Terapkan saringan "order harus memuat produk yang dites" ke konversi yang
 * sudah tercatat sebelum saringan itu ada (lihat app/lib/target-products.server.ts).
 *
 * Default-nya hanya membaca dan melaporkan. Dengan --apply, baris Conversion
 * yang ordernya tidak memuat produk target dihapus dan OrderIntake-nya diberi
 * status no_target_product. Semua baris yang dihapus disalin dulu ke berkas
 * JSON cadangan, jadi bisa dikembalikan.
 *
 *   node --env-file=/etc/treelogy-ab/env scripts/backfill-target-product.mjs <experimentId> [--apply]
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const [experimentId, flag] = process.argv.slice(2);
const apply = flag === "--apply";
if (!experimentId) {
  console.error("pakai: backfill-target-product.mjs <experimentId> [--apply]");
  process.exit(1);
}

const API_VERSION = "2026-07";
const db = new PrismaClient();

try {
  const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId } });
  if (experiment.kind !== "template" || experiment.targetType === "all_products" || experiment.targetHandles.length === 0) {
    console.log("eksperimen ini tidak dibatasi produk — tidak ada yang perlu disaring");
    process.exit(0);
  }

  const session = await db.session.findFirst({ where: { shop: experiment.shop, isOnline: false } });
  if (!session) throw new Error(`tidak ada sesi offline untuk ${experiment.shop}`);

  const gql = async (query, variables) => {
    const res = await fetch(`https://${experiment.shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
    return json.data;
  };

  const q = experiment.targetHandles.map((h) => `handle:'${h.replace(/'/g, "")}'`).join(" OR ");
  const products = await gql(`query($q: String!) { products(first: 250, query: $q) { nodes { id handle } } }`, { q });
  const targetIds = new Set(products.products.nodes.filter((n) => experiment.targetHandles.includes(n.handle)).map((n) => n.id));
  if (targetIds.size === 0) throw new Error("produk target tidak ditemukan");
  console.log(`produk target: ${[...targetIds].join(", ")}`);

  const conversions = await db.conversion.findMany({ where: { experimentId } });
  console.log(`${conversions.length} konversi tercatat`);

  const drop = [];
  for (const c of conversions) {
    const orderGid = c.orderId.split("#")[0];
    const data = await gql(
      `query($id: ID!) { order(id: $id) { name lineItems(first: 100) { nodes { product { id } customAttributes { key } } } } }`,
      { id: orderGid },
    );
    const lines = data.order?.lineItems?.nodes ?? [];
    const hasTarget = lines.some(
      (li) => li.product && targetIds.has(li.product.id) && !li.customAttributes.some((a) => a.key === "_Gifted"),
    );
    console.log(`  ${hasTarget ? "tetap " : "BUANG "} ${data.order?.name ?? orderGid}  ${c.variant}  Rp ${Number(c.totalPrice).toLocaleString("id-ID")}`);
    if (!hasTarget) drop.push({ ...c, orderName: data.order?.name ?? null });
  }

  console.log(`\n${drop.length} dari ${conversions.length} konversi tidak memuat produk target`);
  if (!apply) {
    console.log("mode baca saja — jalankan lagi dengan --apply untuk menerapkan");
    process.exit(0);
  }
  if (drop.length === 0) process.exit(0);

  const backup = `/tmp/backfill-target-product-${experimentId}-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(drop, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`cadangan: ${backup}`);

  await db.$transaction([
    db.conversion.deleteMany({ where: { orderId: { in: drop.map((d) => d.orderId) } } }),
    db.orderIntake.updateMany({
      where: { orderId: { in: drop.map((d) => d.orderId.split("#")[0]) }, status: "attributed" },
      data: { status: "no_target_product", attributionKind: null },
    }),
  ]);
  console.log("diterapkan");
} finally {
  await db.$disconnect();
}
