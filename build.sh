#!/bin/bash
# 打包 Zotero 10 插件（XPI 就是 zip，manifest.json 必须在根目录）
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
OUT="dist/page-organizer-${VERSION}.xpi"
mkdir -p dist
rm -f "$OUT"

zip -X -q -r "$OUT" \
    manifest.json bootstrap.js content locale \
    -x '*.DS_Store' '*/.*'

echo "生成: $OUT"
python3 - "$OUT" <<'PY'
import json, sys, zipfile
p = sys.argv[1]
with zipfile.ZipFile(p) as z:
    names = z.namelist()
    m = json.loads(z.read("manifest.json"))
    assert "manifest.json" in names and "bootstrap.js" in names
    assert "content/pdf-lib.bundle.js" in names
    assert any(n.startswith("locale/") for n in names)
    a = m["applications"]["zotero"]
    # Zotero 10 的 ExtensionData.parseManifest() 强制要求这三字段，缺失会导致安装被拒
    for key in ("id", "update_url", "strict_max_version"):
        assert isinstance(a.get(key), str) and a[key], \
            "applications.zotero.%s 缺失（Zotero 10 安装会被拒绝）" % key
    print("  插件 ID:", a["id"])
    print("  版本:", m["version"], " 兼容:", a["strict_min_version"], "~", a["strict_max_version"])
    print("  文件数:", len(names))
PY
