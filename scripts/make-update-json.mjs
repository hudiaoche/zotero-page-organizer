#!/usr/bin/env node
/* 生成 Zotero 插件自动更新清单 update.json。
 * 用法：node scripts/make-update-json.mjs --tag v2.0.4 --repo owner/repo
 *       可选 --xpi 自定义文件名、--out 自定义输出路径。
 * 版本号与兼容区间一律从 manifest.json 读取，避免两处不一致。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const addon = manifest.applications.zotero;

const repo = opt("repo", process.env.GITHUB_REPOSITORY || "OWNER/REPO");
const tag = opt("tag", process.env.GITHUB_REF_NAME || "v" + manifest.version);
const xpi = opt("xpi", "page-organizer-" + manifest.version + ".xpi");
const out = path.resolve(root, opt("out", "update.json"));

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error("仓库必须是 owner/repo 形式，当前：" + repo);
    process.exit(1);
}

const doc = {
    addons: {
        [addon.id]: {
            updates: [{
                version: manifest.version,
                update_link: "https://github.com/" + repo + "/releases/download/" + tag + "/" + xpi,
                applications: {
                    zotero: {
                        strict_min_version: addon.strict_min_version,
                        strict_max_version: addon.strict_max_version
                    }
                }
            }]
        }
    }
};

fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log("update.json -> " + path.relative(root, out)
    + " | " + manifest.version + " | " + repo + " | " + tag);
