import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/session";
import { fetchStorefrontPage, sanitizeForSnapshot } from "@/lib/storefront";
import { getPostHogClient } from "@/lib/posthog-server";

/**
 * Menyajikan snapshot halaman storefront untuk ditampilkan di dalam iframe.
 *
 * Route ini WAJIB dijaga login. Tanpa itu ia menjadi open proxy: siapa pun bisa
 * memakai domain dashboard ini untuk mengambil halaman lain atas nama kita.
 * Karena itu path yang diminta juga dibatasi ke path relatif saja.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const path = request.nextUrl.searchParams.get("path") ?? "/";
  const themeId = request.nextUrl.searchParams.get("theme");

  // Hanya path relatif. Menolak "//evil.com" dan URL absolut mencegah route ini
  // dipakai mengambil host sembarangan.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    return new Response("Path tidak valid", { status: 400 });
  }
  if (themeId && !/^\d+$/.test(themeId)) {
    return new Response("Theme id tidak valid", { status: 400 });
  }

  let page: Awaited<ReturnType<typeof fetchStorefrontPage>>;
  try {
    page = await fetchStorefrontPage(path, themeId);
  } catch (error) {
    const posthog = getPostHogClient();
    if (posthog) {
      posthog.captureException(error, user.id, { route: "storefront_snapshot" });
      posthog.capture({
        distinctId: user.id,
        event: "storefront_snapshot_failed",
        properties: { failure_reason: "upstream_error", has_theme: Boolean(themeId) },
      });
      await posthog.flush();
    }
    return new Response("Gagal mengambil halaman.", { status: 502 });
  }

  if (!page.html) {
    const posthog = getPostHogClient();
    if (posthog) {
      posthog.capture({
        distinctId: user.id,
        event: "storefront_snapshot_failed",
        properties: {
          failure_reason: "empty_response",
          upstream_status: page.status,
          has_theme: Boolean(themeId),
        },
      });
      await posthog.flush();
    }
    return new Response(`Gagal mengambil halaman (HTTP ${page.status}).`, { status: 502 });
  }

  return new Response(sanitizeForSnapshot(page.html), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Hanya boleh dibingkai oleh dashboard ini sendiri.
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "frame-ancestors 'self'",
      "Cache-Control": "private, max-age=60",
      "X-Robots-Tag": "noindex",
    },
  });
}
