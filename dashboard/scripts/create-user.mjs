/**
 * Membuat atau memperbarui akun dashboard.
 *
 *   npm run create-user -- --email nama@treelogy.com --name "Nama" [--role admin|viewer]
 *
 * Password TIDAK boleh lewat argumen baris perintah: argumen terlihat di `ps`
 * milik user lain di mesin yang sama dan tersimpan di riwayat shell. Ada tiga cara
 * memasukkannya, dipilih otomatis sesuai kondisi:
 *
 *   1. Terminal sungguhan  -> prompt tersembunyi (cara yang disarankan)
 *   2. Pipe                -> printf '%s' "$PASS" | npm run create-user -- --email ...
 *   3. Env ADMIN_PASSWORD  -> untuk otomatisasi/CI
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/password.ts";

const KEY_ENTER = ["\r", "\n", "\u0004"]; // Enter, newline, Ctrl-D
const KEY_CTRL_C = "\u0003";
const KEY_BACKSPACE = ["\u007f", "\b"];

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/** Prompt yang tidak menampilkan ketikan. Butuh TTY sungguhan. */
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let value = "";
    const onData = (chunk) => {
      // Raw mode bisa mengirim beberapa karakter sekaligus, misalnya saat di-paste.
      for (const char of chunk) {
        if (KEY_ENTER.includes(char)) {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === KEY_CTRL_C) {
          // Raw mode harus dikembalikan dulu, kalau tidak terminal ditinggalkan
          // dalam keadaan tidak menampilkan ketikan sama sekali.
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (KEY_BACKSPACE.includes(char)) value = value.slice(0, -1);
        else value += char;
      }
    };

    process.stdin.on("data", onData);
  });
}

/** Membaca stdin sampai habis, untuk pemakaian dengan pipe. */
function readPipedStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.split("\n")[0]));
  });
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const email = (arg("email") ?? "").trim().toLowerCase();
const name = arg("name") ?? null;
const role = arg("role") ?? "admin";

if (!email.includes("@")) {
  fail('Butuh --email yang valid.\n  npm run create-user -- --email nama@treelogy.com --name "Nama"');
}
if (!["admin", "viewer"].includes(role)) {
  fail("--role harus 'admin' atau 'viewer'.");
}

let password;
if (process.env.ADMIN_PASSWORD) {
  password = process.env.ADMIN_PASSWORD;
} else if (process.stdin.isTTY) {
  password = await promptHidden(`Password untuk ${email}: `);
  const confirm = await promptHidden("Ulangi password: ");
  if (password !== confirm) fail("Password tidak sama.");
} else {
  password = await readPipedStdin();
  if (!password) {
    fail(
      "Tidak ada terminal interaktif dan tidak ada input dari pipe.\n" +
        "Jalankan di aplikasi terminal kamu sendiri supaya bisa mengetik password tanpa terlihat,\n" +
        "atau salurkan lewat pipe:\n" +
        `  printf '%s' 'password-kamu' | npm run create-user -- --email ${email}`,
    );
  }
}

if (password.length < 12) {
  fail(
    "Password minimal 12 karakter. Akun ini bisa menghentikan test yang sedang berjalan di toko sungguhan.",
  );
}

const db = new PrismaClient();
try {
  const passwordHash = await hashPassword(password);
  const user = await db.adminUser.upsert({
    where: { email },
    create: { email, name, role, passwordHash },
    update: { name, role, passwordHash },
  });
  console.log(`\nOK — ${user.email} (${user.role}) siap dipakai untuk login.`);
} finally {
  await db.$disconnect();
}
