import type { Config } from "@react-router/dev/config";

export default {
  /* nginx memutus HTTPS lalu meneruskan ke Node lewat HTTP, sehingga
     request.url terbaca http:// sementara header Origin browser https://.
     Tanpa daftar ini React Router 7.12+ menganggapnya CSRF dan menolak
     semua aksi form admin (Save, Start, Pause, Kill switch) dengan 400. */
  allowedActionOrigins: ["ab.treelogy-services.my.id"],
} satisfies Config;
