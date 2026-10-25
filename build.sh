#!/bin/bash
# build.sh — Siapkan output statis untuk Telegram Serverless.
# Folder dist/ adalah "build output" yang di-host tgcloud.ai sebagai Mini App.
set -e
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist

cp index.html service.html ronce.html nota.html sync.json dist/
cp -r assets dist/
if [ -d data ]; then
  cp -r data dist/
fi

echo "dist/ siap: $(find dist -type f | wc -l) file"
echo "Jalankan: tgcloud push   (setelah tgcloud login)"
