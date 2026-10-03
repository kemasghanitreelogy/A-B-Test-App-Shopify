import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/session";
import { drawerSnapshot } from "@/lib/drawer-snapshot";
import { getPostHogClient } from "@/lib/posthog-server";

/**
 * Snapshot of the cart drawer, open, with a sample cart (lib/drawer-snapshot.ts).
 * Login-guarded like /api/snapshot, and every parameter is validated so this
 * can't be used as a proxy: numeric ids only, no paths or hosts.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const p = request.nextUrl.searchParams;
  const theme = p.get("theme");
  const variant = p.get("variant") ?? "";
  const qty = Number(p.get("qty") ?? "1");
  const locale = p.get("locale");
  if (theme && !/^\d+$/.test(theme)) return new Response("Theme id tidak valid", { status: 400 });
  if (!/^\d+$/.test(variant)) return new Response("Varian tidak valid", { status: 400 });
  if (!Number.isInteger(qty) || qty < 1 || qty > 5) return new Response("Jumlah tidak valid", { status: 400 });
  if (locale && !/^[a-z]{2}(-[a-z]{2})?$/i.test(locale)) return new Response("Locale tidak valid", { status: 400 });

  try {
    const html = await drawerSnapshot({ themeId: theme, variantId: Number(variant), quantity: qty, locale });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "frame-ancestors 'self'",
        "Cache-Control": "private, max-age=60",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (error) {
    const posthog = getPostHogClient();
    if (posthog) {
      posthog.captureException(error, user.id, { route: "drawer_snapshot" });
      await posthog.flush();
    }
    const message = error instanceof Error ? error.message : "Gagal mengambil drawer.";
    return new Response(
      `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px;color:#444">${message.replace(/[<>&]/g, "")}</body>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}
