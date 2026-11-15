#!/usr/bin/env bash
# 一次性初始化：替换仓库占位符、升一个补丁版本、重新打包、建立 Git 仓库并推送。
#
# 用法：
#   ./scripts/setup-github.sh <GitHub用户名> [仓库名]
#   GITHUB_TOKEN=ghp_xxx ./scripts/setup-github.sh <用户名>   # 自动建仓库并推送
#   gh auth login 之后直接运行，也会自动建仓库并推送。
# 两者都没有时，脚本会准备好一切并打印需要手动执行的两条命令。
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${1:-}"
REPO="${2:-zotero-page-organizer}"
if [ -z "$OWNER" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    OWNER=$(gh api user --jq .login 2>/dev/null || true)
fi
if [ -z "$OWNER" ]; then
    echo "用法: $0 <GitHub用户名> [仓库名，默认 zotero-page-organizer]" >&2
    echo "若已安装并登录 gh，可省略用户名，脚本会自动读取。" >&2
    exit 1
fi
FULL="$OWNER/$REPO"

python3 - "$FULL" <<'PY'
import json, sys
full = sys.argv[1]
target = "https://github.com/" + full + "/releases/download/release/update.json"
p = "manifest.json"
m = json.load(open(p, encoding="utf-8"))
z = m["applications"]["zotero"]
if z.get("update_url") != target:
    m["homepage_url"] = "https://github.com/" + full
    z["update_url"] = target
    parts = m["version"].split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    m["version"] = ".".join(parts)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("已写入真实更新地址，版本升至", m["version"])
else:
    print("已是目标仓库，保留版本", m["version"])
print("update_url:", z["update_url"])
PY

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
TAG="v$VERSION"
node scripts/make-update-json.mjs --tag "$TAG" --repo "$FULL"
chmod +x build.sh scripts/release.sh
./build.sh

DESKTOP_DIR="$HOME/Desktop/杂/自制软件/页面组织器"
if [ -d "$DESKTOP_DIR" ]; then
    cp "dist/page-organizer-$VERSION.xpi" "$DESKTOP_DIR/"
    echo "新安装包已放到: $DESKTOP_DIR/page-organizer-$VERSION.xpi"
fi

if [ ! -d .git ]; then
    git init -b main >/dev/null
fi
git add -A
if ! git diff --cached --quiet; then
    if git config user.name >/dev/null 2>&1 && git config user.email >/dev/null 2>&1; then
        git commit -m "Initial import: Zotero 页面组织器 $VERSION"
    else
        git -c user.name="${GIT_AUTHOR_NAME:-$OWNER}" \
            -c user.email="${GIT_AUTHOR_EMAIL:-$OWNER@users.noreply.github.com}" \
            commit -m "Initial import: Zotero 页面组织器 $VERSION"
    fi
fi
if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "https://github.com/$FULL.git"
else
    git remote add origin "https://github.com/$FULL.git"
fi
git config branch.main.remote origin 2>/dev/null || true
git config branch.main.merge refs/heads/main 2>/dev/null || true
git tag -f "$TAG" >/dev/null

PUSHED=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    # 让 git push 走 gh 的凭据助手，以后 ./scripts/release.sh 才能免密推送
    gh auth setup-git >/dev/null 2>&1 || true
    gh repo view "$FULL" >/dev/null 2>&1 || gh repo create "$FULL" --public --description "Zotero page organizer plugin"
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    git push -u origin "HEAD:$BRANCH"
    git push origin "$TAG"
    PUSHED=1
elif [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsS -X POST \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        https://api.github.com/user/repos \
        -d "{\"name\":\"${REPO}\",\"description\":\"Zotero page organizer\",\"private\":false}" \
        >/dev/null 2>&1 || true
    PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${FULL}.git"
    git push "$PUSH_URL" HEAD:refs/heads/main
    git push "$PUSH_URL" "refs/tags/$TAG"
    # origin 里存的是不带 token 的地址，把凭据交给本机助手，否则以后 release.sh 会卡在输密码
    if [ "$(uname)" = "Darwin" ] && [ -z "$(git config --get credential.helper || true)" ]; then
        git config --local credential.helper osxkeychain
    fi
    if [ -n "$(git config --get credential.helper || true)" ]; then
        printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n' "$GITHUB_TOKEN" \
            | git credential approve >/dev/null 2>&1 || true
        echo "已把 GitHub 凭据交给本机 git 凭据助手，之后 git push origin 免密。"
    else
        echo "警告：本机没有 git 凭据助手，以后发版请先安装 gh 并执行 gh auth setup-git。" >&2
    fi
    PUSHED=1
fi

echo
echo "=========================================================="
echo "仓库地址 : https://github.com/$FULL"
echo "更新通道 : https://github.com/$FULL/releases/download/release/update.json"
echo "本次版本 : $VERSION ($TAG)"
echo "----------------------------------------------------------"
if [ "$PUSHED" -eq 1 ]; then
    echo "已推送。GitHub Actions 会自动构建 XPI 并创建 release 更新通道。"
    echo "在仓库 Actions 页确认 Publish plugin update 运行成功。"
else
    echo "尚未推送。请先在 GitHub 网页新建空仓库 ${REPO}（Public，不要勾选 README），然后运行："
    echo "    git push -u origin main && git push origin $TAG"
fi
echo
echo "最后一步：手动安装一次 dist/page-organizer-$VERSION.xpi"
echo "（旧插件里的 update_url 是占位地址，装过这一次后才会自动更新）"
echo "以后发新版只需： ./scripts/release.sh"
echo "=========================================================="
