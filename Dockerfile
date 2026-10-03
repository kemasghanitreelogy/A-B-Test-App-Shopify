# syntax=docker/dockerfile:1

# Multi-stage: build butuh devDependencies (vite hanya peer dependency dari
# @react-router/dev, jadi `npm ci --omit=dev` membuat build kehilangan bundler-nya
# sendiri). Image akhir tetap ramping karena devDependencies dibuang setelah build.

FROM node:22-alpine AS base
# Prisma butuh openssl untuk memilih query engine yang cocok di Alpine.
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# ---- dependencies lengkap ----
FROM base AS deps
COPY package.json package-lock.json* ./
# Manifest workspace harus ikut disalin: lockfile mencatat extensions/* sebagai
# workspace, dan npm menolak bekerja kalau manifest-nya tidak ada di sini.
COPY extensions/tl-ab-pixel/package.json ./extensions/tl-ab-pixel/

# Sengaja `npm install`, bukan `npm ci`.
#
# Lockfile dibuat di macOS, sementara image ini dibangun di Linux. Dependency
# opsional yang khusus Linux (@emnapi/core, @emnapi/runtime) tidak pernah tercatat
# di lockfile macOS, dan `npm ci` menolak lockfile yang tidak lengkap untuk platform
# targetnya. `npm install` tetap memakai lockfile sebagai acuan versi, tapi boleh
# melengkapi dependency opsional milik platform ini.
#
# --include=dev wajib: NODE_ENV=production membuat npm melewati devDependencies,
# padahal vite ada di sana dan build tidak bisa jalan tanpanya.
RUN npm install --include=dev --no-audit --no-fund

# ---- build ----
FROM deps AS build
COPY . .
RUN npm run build
# Dibuang setelah build, lalu Prisma Client dibangkitkan ULANG — npm prune menyentuh
# node_modules dan bisa menghapus client yang sudah digenerate sebelumnya.
RUN npm prune --omit=dev && npx prisma generate

# ---- runtime ----
FROM base AS runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 3000

# Migrasi TIDAK dijalankan di sini. Itu tugas release_command di fly.toml, yang
# berjalan sekali di mesin terpisah dan membatalkan deploy kalau gagal. Menjalankannya
# per container membuat dua mesin bisa bermigrasi bersamaan saat rolling deploy.
CMD ["npm", "run", "start"]
