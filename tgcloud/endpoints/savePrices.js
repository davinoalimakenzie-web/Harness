/* ===================================================================
   endpoints/savePrices.js — Simpan daftar harga tersimpan ke server.

   Dipanggil Mini App:
     Telegram.WebApp.Serverless.call('savePrices', { rev, templates })

   Server selalu menerima tulisan terbaru (last write wins) lalu
   mengembalikan { rev, templates } sebagai kebenaran terbaru.
   Penggabungan/perbedaan dilakukan di sisi aplikasi (calc-sync.js).
   =================================================================== */
import { db } from 'sdk';
import { priceLists } from '../schema.js';

export default async function (input, ctx) {
  const body = input || {};
  const id = body.id || 'calc_templates';
  const templates = Array.isArray(body.templates) ? body.templates : [];
  const rev = new Date().toISOString();

  await db.insert(priceLists)
    .values({ id, rev, data: JSON.stringify(templates), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: priceLists.id,
      set: { rev, data: JSON.stringify(templates), updatedAt: Date.now() },
    })
    .run();

  return { rev, templates };
}
