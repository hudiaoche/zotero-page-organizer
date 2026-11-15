#!/usr/bin/env node
/* 跟随 Zotero 主版本：查询最新稳定版，若已超出插件的 strict_max_version，
 * 自动放宽兼容区间并把插件 patch 版本 +1。
 * 由 .github/workflows/follow-zotero.yml 调用；本地测试可用 FORCE_MAJOR=11 node ...
 * 输出写入 $GITHUB_OUTPUT 供 workflow 判断是否发布。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const addon = manifest.applications.zotero;

const emit = (values) => {
    const out = process.env.GITHUB_OUTPUT;
    if (out) {
        fs.appendFileSync(out, Object.entries(values)
            .map(([k, v]) => k + "=" + v).join("\n") + "\n");
    }
    console.log(JSON.stringify(values));
};

const majorOf = (s) => {
    const n = parseInt(String(s).replace(/^v/i, ""), 10);
    return Number.isFinite(n) ? n : null;
};

let latest = process.env.FORCE_MAJOR ? majorOf(process.env.FORCE_MAJOR) : null;
if (latest === null) {
    try {
        const headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "zotero-page-organizer"
        };
        if (process.env.GH_TOKEN) headers.Authorization = "Bearer " + process.env.GH_TOKEN;
        const res = await fetch("https://api.github.com/repos/zotero/zotero/releases/latest", { headers });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const info = await res.json();
        latest = majorOf(info.tag_name || info.name || "");
    }
    catch (e) {
        console.error("无法获取 Zotero 最新版本：" + e.message);
        latest = null;
    }
}

const current = majorOf(addon.strict_max_version);
if (latest === null || current === null) {
    console.error("版本号解析失败", { latest, current, raw: addon.strict_max_version });
    emit({ updated: "false", reason: "version-parse-failed" });
    process.exit(0);
}
if (latest <= current) {
    console.log("Zotero 主版本 " + latest + " 仍在兼容区间 " + addon.strict_max_version + " 内。");
    emit({ updated: "false", major: String(latest) });
    process.exit(0);
}

addon.strict_max_version = latest + ".*";
const parts = manifest.version.split(".").map(Number);
parts[parts.length - 1] = (parts[parts.length - 1] || 0) + 1;
manifest.version = parts.join(".");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("兼容区间放宽到 " + addon.strict_max_version + "，插件版本升至 " + manifest.version);
emit({
    updated: "true",
    major: String(latest),
    version: manifest.version,
    tag: "v" + manifest.version
});
