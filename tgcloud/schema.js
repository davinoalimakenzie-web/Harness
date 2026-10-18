/* ===================================================================
   tgcloud/schema.js — Skema database Telegram Serverless (SQLite)

   Tabel daftar harga tersimpan kalkulator. Satu baris per "kunci" data
   (mis. 'calc_templates'), berisi seluruh daftar harga sebagai JSON.
   Revisi (rev) dipakai sinkronisasi: yang lebih baru menang.
   =================================================================== */
import { table, text, integer } from 'sdk/db';

export const priceLists = table('price_lists', {
  id:        text('id').primaryKey(),   // mis. 'calc_templates'
  rev:       text('rev').notNull(),     // versi terakhir (ISO 8601)
  data:      text('data').notNull(),    // JSON: array entri harga
  updatedAt: integer('updated_at').notNull(),
});
