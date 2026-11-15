#!/usr/bin/env bash
# 发布新版本：改版本号 -> 更新 update.json -> 提交 -> 打 tag -> 推送。
# GitHub Actions 会自动构建 XPI、发 Release、刷新固定更新通道，Zotero 随后自动升级。
# 用法： ./scripts/release.sh [新版本号，如 2.0.5]（省略则补丁 +1）
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
    if command -v node >/dev/null 2>&1; then
        NODE_BIN=$(command -v node)
    else
        for cand in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
                    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
            if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
        done
    fi
fi
if [ -z "$NODE_BIN" ]; then
    echo "找不到 node：请安装 Node.js，或用 NODE_BIN=/path/to/node 指定路径。" >&2
    exit 1
fi

REPO=$(python3 - <<'PY'
import re, json, subprocess
repo = ""
try:
    u = subprocess.check_output(["git", "remote", "get-url", "origin"], text=True).strip()
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", u)
    if m:
        repo = m.group(1)
except Exception:
    pass
if not repo:
    try:
        doc = json.load(open("update.json", encoding="utf-8"))
        link = next(iter(doc["addons"].values()))["updates"][0]["update_link"]
        m = re.search(r"github\.com/([^/]+/[^/]+)/", link)
        if m:
            repo = m.group(1)
    except Exception:
        pass
print(repo)
PY
)
if [ -z "$REPO" ]; then
    echo "无法从 origin 解析 GitHub 仓库；请先运行 ./scripts/setup-github.sh" >&2
    exit 1
fi

if [ -n "${1:-}" ]; then
    NEW="$1"
else
    NEW=$(python3 -c 'import json; p=json.load(open("manifest.json"))["version"].split("."); p[-1]=str(int(p[-1])+1); print(".".join(p))')
fi

python3 - "$NEW" <<'PY'
import json, re, sys
v = sys.argv[1]
assert re.fullmatch(r"\d+\.\d+\.\d+", v), "版本号须为 x.y.z"
p = "manifest.json"
m = json.load(open(p, encoding="utf-8"))
m["version"] = v
with open(p, "w", encoding="utf-8") as f:
    json.dump(m, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("版本 ->", v)
PY

TAG="v$NEW"
"$NODE_BIN" scripts/make-update-json.mjs --tag "$TAG" --repo "$REPO"
./build.sh

# 必须提交全部改动：Actions 是从仓库源码重新打包 XPI 的，只提交 manifest 会丢掉功能修改
git add -A
if git config user.name >/dev/null 2>&1 && git config user.email >/dev/null 2>&1; then
    git commit -m "release: $TAG"
else
    git -c user.name="${GIT_AUTHOR_NAME:-page-organizer-bot}" \
        -c user.email="${GIT_AUTHOR_EMAIL:-bot@users.noreply.github.com}" \
        commit -m "release: $TAG"
fi
git tag -f "$TAG" >/dev/null
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "HEAD:$BRANCH"
git push -f origin "refs/tags/$TAG"

echo
echo "已推送 ${TAG}。GitHub Actions 发布完成后，Zotero 会在下次检查更新时自动升级。"
echo "查看进度： https://github.com/$REPO/actions"
