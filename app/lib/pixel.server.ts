import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Mengaktifkan web pixel extension milik app ini.
 *
 * KENAPA INI PERLU KODE SAMA SEKALI. Men-deploy extension hanya membuat pixel
 * MUNCUL di Settings → Customer events. Ia tidak berjalan sampai app membuat
 * record-nya lewat `webPixelCreate`. Sebelum itu, Shopify menampilkannya dengan
 * titik kosong ("Web" abu-abu) alih-alih titik hijau, dan kodenya tidak pernah
 * dieksekusi pada satu pengunjung pun.
 *
 * Kegagalannya tidak memunculkan error di mana pun: dashboard tetap tampil,
 * eksperimen tetap jalan, dan hanya baris "Mulai checkout" pada funnel yang
 * selamanya nol — persis seperti test yang memang belum ada yang checkout.
 *
 * Settings divalidasi Shopify terhadap skema di shopify.extension.toml; kalau
 * bentuknya tidak cocok, mutasinya ditolak.
 */

const CURRENT_WEB_PIXEL = `#graphql
  query CurrentWebPixel {
    webPixel { id settings }
  }
`;

const WEB_PIXEL_CREATE = `#graphql
  mutation CreateWebPixel($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

const WEB_PIXEL_UPDATE = `#graphql
  mutation UpdateWebPixel($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface WebPixelStatus {
  /** true kalau pixel benar-benar aktif di toko (titik hijau) */
  active: boolean;
  id: string | null;
  /** created | updated | unchanged | failed */
  action: "created" | "updated" | "unchanged" | "failed";
  settings: string | null;
  error: string | null;
}

/**
 * Alamat absolut di domain Fly, BUKAN path App Proxy.
 *
 * Sandbox web pixel menolak request ke origin toko (RestrictedUrlError), jadi
 * `/apps/tl-ab/collect` tidak pernah bisa dipanggil dari pixel. Endpoint pixel
 * punya route sendiri (/pixel/collect) dengan penjagaan tanpa HMAC.
 */
function collectEndpoint(): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  return `${base}/pixel/collect`;
}

/** Settings yang harus dipunyai pixel, sesuai skema di shopify.extension.toml. */
export function desiredSettings(): string {
  return JSON.stringify({ collectEndpoint: collectEndpoint() });
}

function sameSettings(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

/**
 * Baca status pixel tanpa mengubah apa pun.
 *
 * Dipakai halaman eksperimen yang dibuka berkali-kali; membuat atau memperbarui
 * pixel pada tiap pembukaan halaman adalah efek samping yang tidak diminta.
 */
export async function readWebPixel(admin: AdminApiContext): Promise<{ active: boolean; id: string | null; settingsOk: boolean }> {
  try {
    const res = await admin.graphql(CURRENT_WEB_PIXEL);
    const json = await res.json();
    const id = json?.data?.webPixel?.id ?? null;
    return { active: Boolean(id), id, settingsOk: sameSettings(json?.data?.webPixel?.settings, desiredSettings()) };
  } catch {
    return { active: false, id: null, settingsOk: false };
  }
}

/**
 * Pastikan pixel aktif dan settings-nya benar. Idempoten.
 *
 * Tidak pernah melempar: pixel adalah metrik funnel sekunder, dan kegagalannya
 * tidak boleh membatalkan start eksperimen. Alasannya dikembalikan supaya bisa
 * ditampilkan, bukan didiamkan.
 */
export async function ensureWebPixel(admin: AdminApiContext): Promise<WebPixelStatus> {
  const settings = desiredSettings();
  const fail = (error: string): WebPixelStatus => ({ active: false, id: null, action: "failed", settings: null, error });

  let existingId: string | null = null;
  let existingSettings: string | null = null;
  try {
    const res = await admin.graphql(CURRENT_WEB_PIXEL);
    const json = await res.json();
    existingId = json?.data?.webPixel?.id ?? null;
    existingSettings = json?.data?.webPixel?.settings ?? null;
  } catch (error) {
    // Membaca bisa gagal kalau scope read_pixels belum disetujui. Itu bukan
    // alasan untuk berhenti — create di bawah akan memberi tahu keadaan
    // sebenarnya lewat userErrors ("sudah ada" vs "ditolak").
    console.warn(`[pixel] gagal membaca web pixel: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existingId) {
    if (sameSettings(existingSettings, settings)) {
      return { active: true, id: existingId, action: "unchanged", settings: existingSettings, error: null };
    }
    try {
      const res = await admin.graphql(WEB_PIXEL_UPDATE, { variables: { id: existingId, webPixel: { settings } } });
      const json = await res.json();
      const errors: UserError[] = json?.data?.webPixelUpdate?.userErrors ?? [];
      if (errors.length > 0) return fail(`webPixelUpdate: ${errors.map((e) => e.message).join("; ")}`);
      return { active: true, id: json?.data?.webPixelUpdate?.webPixel?.id ?? existingId, action: "updated", settings, error: null };
    } catch (error) {
      return fail(`webPixelUpdate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const res = await admin.graphql(WEB_PIXEL_CREATE, { variables: { webPixel: { settings } } });
    const json = await res.json();
    const errors: UserError[] = json?.data?.webPixelCreate?.userErrors ?? [];
    if (errors.length > 0) {
      /* "Sudah ada" bukan kegagalan. Ini terjadi kalau pembacaan di atas gagal
       * (scope belum disetujui) padahal pixelnya memang sudah aktif. */
      const taken = errors.some((e) => e.code === "TAKEN" || /already|taken|exists/i.test(e.message));
      if (taken) return { active: true, id: null, action: "unchanged", settings: null, error: null };
      return fail(`webPixelCreate: ${errors.map((e) => e.message).join("; ")}`);
    }
    return { active: true, id: json?.data?.webPixelCreate?.webPixel?.id ?? null, action: "created", settings, error: null };
  } catch (error) {
    return fail(`webPixelCreate: ${error instanceof Error ? error.message : String(error)}`);
  }
}
