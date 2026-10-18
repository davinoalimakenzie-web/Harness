/* ===================================================================
   endpoints/loadPrices.js — Ambil daftar harga tersimpan dari server.

   Dipanggil Mini App:
     Telegram.WebApp.Serverless.call('loadPrices')

   Mengembalikan { rev, templates }. Kalau database masih kosong
   (pertama kali / setelah pindah server), rev = '' dan templates = [].
   =================================================================== */
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { priceLists } from '../schema.js';

export default async function (input, ctx) {
  const id = (input && input.id) || 'calc_templates';

  const row = await db.select()
    .from(priceLists)
    .where(eq(priceLists.id, id))
    .get();

  if (!row) return { rev: '', templates: [] };

  let templates = [];
  try {
    const parsed = JSON.parse(row.data);
    if (Array.isArray(parsed)) templates = parsed;
  } catch (e) { /* data rusang -> anggap kosong */ }

  return { rev: row.rev || '', templates };
}
