#!/usr/bin/env bash
# gate-deploy.sh — Build statis + push tgcloud + pastikan link nota & aset hidup.
# Pakai setelah ada perubahan di assets/js/mascim*.js / style.css / index.html / build.sh.
# Syarat: `tgcloud login` dan `gh auth login` sudah lakukan sekali.
#
#   1/3 build dist/  (build.sh otomatis sertakan nota.html — cegah 404 link nota)
#   2/3 tgcloud push (unggah dist/ ke Mini App Telegram)
#   3/3 verify live  (HTTP 200 untuk nota.html + aset; sha256 src==live)
set -euo pipefail
cd "$(dirname "$0")"

APP="https://app8842237612.tgcloud.ai"

echo "1/3 build dist ..."
bash build.sh

echo "2/3 tgcloud push ..."
tgcloud push

echo "3/3 verify live:"
for p in nota.html index.html riasan.html assets/js/mascim-local.js assets/js/mascim.js assets/js/ronce.js assets/css/style.css; do
  c=$(curl -sL -o /dev/null -w "%{http_code}" "$APP/$p")
  if [ "$c" = "200" ]; then echo "   OK   $p  -> 200"; else echo "   FAIL $p -> $c"; exit 1; fi
done
for f in assets/js/mascim-local.js assets/js/mascim.js assets/js/ronce.js assets/css/style.css riasan.html; do
  s=$(sha256sum "$f" | awk '{print $1}')
  l=$(curl -sL "$APP/$f" | sha256sum | awk '{print $1}')
  if [ "$s" = "$l" ]; then echo "   OK   $f sha256 match"; else echo "   FAIL $f src=$s live=$l"; exit 1; fi
done
# smoke link nota: nota.html harus 200 (nota self-contained, baca ?s=)
n=$(curl -sL -o /dev/null -w "%{http_code}" "$APP/nota.html?s=smoke")
if [ "$n" = "200" ]; then echo "   OK   nota link target -> 200"; else echo "   FAIL nota link -> $n"; exit 1; fi

echo "=== DEPLOY GATE PASSED ✅ ==="
