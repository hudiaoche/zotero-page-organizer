/* 真实 PDF 端到端验证（本机专用，需要 Python + PyMuPDF）
 *
 * 运行：node tests/verify-encrypted.mjs
 *
 * 目的：防止 2.0.2 的「加密 PDF 提取出空白页」回归。pdf-lib 的
 * ignoreEncryption 只跳过报错、不解密内容流，因此这里分别验证：
 *   1) 加密 PDF 走 content/pyscript.js 的 PyMuPDF 通道后内容完整；
 *   2) 未加密 PDF 继续走内置 pdf-lib 通道后内容完整。
 * 判定标准用 PyMuPDF 实际渲染的非白像素数，而不是页数/页宽。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PY = "/Users/husay/.workbuddy/binaries/python/envs/default/bin/python";
const USER_ENC = "/Users/husay/Desktop/坚果云/zotero自动检索同步/3无主题阅读/论文/01诗经/李华 - 2011 - 孟子与汉代《诗经》学研究 ——以四家诗为主要对象.pdf";

if (!fs.existsSync(PY)) throw new Error("未找到本机 Python: " + PY);

/* 干净 realm 加载插件脚本（与 tests/test.mjs 一致） */
const scope = {
    console, setTimeout, clearTimeout, queueMicrotask,
    TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto
};
scope.__PO_SCOPE__ = scope;
const context = vm.createContext(scope);
for (const f of ["content/pdf-lib.bundle.js", "content/extractor.js", "content/pyscript.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), context, { filename: f });
}
const EX = scope.PageExtractor;
EX.PDFLib = scope.POPDFLib;
EX.fromBinaryString = scope.POPDFLib_fromBinaryString;
EX.toBinaryString = scope.POPDFLib_toBinaryString;

/* 用 PyMuPDF 渲染第一页，返回非白像素数等客观指标 */
const CHECK = `
import sys, json, os, pymupdf
out = []
for p in sys.argv[1:]:
    try:
        d = pymupdf.open(p)
        pg = d[0]
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(0.3, 0.3), colorspace=pymupdf.csGRAY)
        nw = sum(1 for b in pix.samples if b < 200)
        out.append({"pages": len(d), "encrypted": d.is_encrypted,
                    "text": len(pg.get_text()), "nonwhite": nw,
                    "size": os.path.getsize(p), "ok": True})
    except Exception as e:
        out.append({"ok": False, "error": str(e)})
print(json.dumps(out))
`;
const render = (files) => JSON.parse(execFileSync(PY, ["-c", CHECK, ...files], { encoding: "utf8" }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-organizer-verify-"));
let failures = 0;
const report = (label, ok, detail) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
};

try {
    const all = [];
    const storage = path.join(os.homedir(), "Zotero", "storage");
    if (fs.existsSync(storage)) {
        for (const d of fs.readdirSync(storage)) {
            const dir = path.join(storage, d);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const f of fs.readdirSync(dir)) {
                if (f.toLowerCase().endsWith(".pdf")) all.push(path.join(dir, f));
            }
        }
    }
    const encrypted = [];
    const plain = [];
    for (const p of all) {
        try {
            const fd = fs.openSync(p, "r");
            const buf = Buffer.alloc(4096);
            fs.readSync(fd, buf, 0, 4096, 0);
            const tailBuf = Buffer.alloc(8192);
            const size = fs.statSync(p).size;
            fs.readSync(fd, tailBuf, 0, 8192, Math.max(0, size - 8192));
            fs.closeSync(fd);
            (buf.includes(Buffer.from("/Encrypt")) || tailBuf.includes(Buffer.from("/Encrypt"))
                ? encrypted : plain).push(p);
        }
        catch (e) { /* 跳过不可读文件 */ }
    }
    const encSrc = fs.existsSync(USER_ENC) ? USER_ENC : encrypted[0];
    if (!encSrc) throw new Error("资料库里找不到加密 PDF 样本");

    console.log("=== 1) 加密 PDF → PyMuPDF 解密通道 ===");
    const scriptPath = path.join(tmp, "extract_pages.py");
    const cfgPath = path.join(tmp, "cfg.json");
    const resPath = path.join(tmp, "result.json");
    const outPdf = path.join(tmp, "页5-9.pdf");
    fs.writeFileSync(scriptPath, scope.PageOrganizerPyScript);
    fs.writeFileSync(cfgPath, JSON.stringify({
        source: encSrc,
        outputs: [{ path: outPdf, start: 5, end: 9 }]
    }));
    execFileSync(PY, [scriptPath, cfgPath, resPath], { encoding: "utf8" });
    const res = JSON.parse(fs.readFileSync(resPath, "utf8"));
    report("PyMuPDF 脚本返回 ok", res.ok === true, res.error || "");
    const [srcInfo, outInfo] = render([encSrc, outPdf]);
    report("输出为 5 页且不带加密", outInfo.pages === 5 && outInfo.encrypted === false,
        `pages=${outInfo.pages} encrypted=${outInfo.encrypted}`);
    report("输出第一页有可见内容（非白像素 > 0）", outInfo.nonwhite > 0,
        `源=${srcInfo.nonwhite} 输出=${outInfo.nonwhite} 文字=${outInfo.text}`);
    report("输出体积合理（> 10 KB）", outInfo.size > 10240, `${Math.round(outInfo.size / 1024)} KB`);
    const raw = fs.readFileSync(outPdf);
    report("输出不含 /Encrypt 字典", !raw.includes(Buffer.from("/Encrypt")));

    console.log("=== 2) 未加密 PDF → 内置 pdf-lib 通道 ===");
    const sample = plain.filter(p => fs.statSync(p).size < 40 * 1024 * 1024).slice(0, 8);
    let checked = 0;
    for (const p of sample) {
        const bin = EX.bytesToBinaryString(new Uint8Array(fs.readFileSync(p)));
        const r = JSON.parse(JSON.stringify((await EX.extract(bin, [{ start: 1, end: 1 }]))[0]));
        const dst = path.join(tmp, `plain-${checked}.pdf`);
        fs.writeFileSync(dst, Buffer.from(r.binary, "latin1"));
        const [a, b] = render([p, dst]);
        if (!b.ok || !a.ok) continue;
        checked++;
        const ok = b.nonwhite > 0 && Math.abs(a.nonwhite - b.nonwhite) / Math.max(a.nonwhite, 1) < 0.35;
        report(`pdf-lib 抽取内容完整: ${path.basename(p).slice(0, 40)}`, ok,
            `源=${a.nonwhite} 输出=${b.nonwhite}`);
    }
    report("至少抽检了 5 份未加密 PDF", checked >= 5, `实际 ${checked} 份`);
}
finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n端到端验证全部通过" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
