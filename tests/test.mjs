/* 离线验证：用 Node vm 模拟 Zotero bootstrap 的独立 realm，
   验证页码解析、命名、pdf-lib 提取结果，并用 pdftk 独立复核输出 PDF。
   运行：node tests/test.mjs
*/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const plain = (x) => JSON.parse(JSON.stringify(x));

let passed = 0;
function ok(name, fn) {
    fn();
    console.log("  ✓ " + name);
    passed++;
}

/* ---- 构造一个与宿主不同的 realm，加载插件脚本 ---- */
const scope = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    crypto: globalThis.crypto
};
scope.__PO_SCOPE__ = scope;
const context = vm.createContext(scope);
for (const f of [
    "content/pdf-lib.bundle.js",
    "content/strings.js",
    "content/extractor.js",
    "content/dialog.js",
    "content/pyscript.js"
]) {
    vm.runInContext(read(f), context, { filename: f });
}

ok("四个脚本在独立 realm 中加载并导出到 scope", () => {
    assert.ok(scope.POPDFLib && scope.POPDFLib.PDFDocument, "POPDFLib");
    assert.equal(typeof scope.POPDFLib_fromBinaryString, "function");
    assert.equal(typeof scope.POPDFLib_toBinaryString, "function");
    assert.equal(typeof scope.makePageOrganizerStrings, "function");
    assert.ok(scope.PageExtractor, "PageExtractor");
    assert.ok(scope.PageOrganizerDialog, "PageOrganizerDialog");
    assert.ok(scope.PageOrganizerPyScript, "PageOrganizerPyScript");
});

const EX = scope.PageExtractor;
EX.PDFLib = scope.POPDFLib;
EX.fromBinaryString = scope.POPDFLib_fromBinaryString;
EX.toBinaryString = scope.POPDFLib_toBinaryString;

/* ---- 生成一份 12 页的测试 PDF，每页宽度不同，便于核对抽页顺序 ---- */
const generate = vm.runInContext(`(async () => {
    const doc = await POPDFLib.PDFDocument.create();
    for (let i = 1; i <= 12; i++) {
        const page = doc.addPage([300 + i * 10, 400]);
        page.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    }
    return POPDFLib_toBinaryString(await doc.save());
})()`, context);
const bin = await generate;
console.log("  测试 PDF 大小:", bin.length, "bytes");

ok("二进制字符串与 Uint8Array 可跨 realm 往返", () => {
    const nodeBytes = new Uint8Array(Buffer.from(bin, "latin1"));
    const again = EX.bytesToBinaryString(nodeBytes);   // 模拟 IOUtils.read 的跨 realm 结果
    assert.equal(again.length, bin.length);
    assert.equal(again.slice(0, 64), bin.slice(0, 64));
    const vmBytes = EX.binaryStringToBytes(bin);       // 写文件兜底路径
    assert.equal(vmBytes.length, bin.length);
    assert.equal(EX.bytesToBinaryString(vmBytes).slice(0, 64), bin.slice(0, 64));
});

const pageCount = await EX.getPageCount(bin);
ok("getPageCount = 12", () => assert.equal(pageCount, 12));

/* ---- 页码范围解析 ---- */
ok("单段 / 单页 / 多段解析", () => {
    assert.deepEqual(plain(EX.parseRanges("3-7", 12).ranges), [{ start: 3, end: 7 }]);
    assert.deepEqual(plain(EX.parseRanges("10", 12).ranges), [{ start: 10, end: 10 }]);
    assert.deepEqual(plain(EX.parseRanges("3-7,10,15-18", 20).ranges),
        [{ start: 3, end: 7 }, { start: 10, end: 10 }, { start: 15, end: 18 }]);
});
ok("全角标点 / 波浪号 / .. / 空格 / 逆序自动纠正", () => {
    assert.equal(EX.parseRanges("3－7，10；15~18", 20).ranges.length, 3);
    assert.deepEqual(plain(EX.parseRanges("3 .. 7", 12).ranges), [{ start: 3, end: 7 }]);
    assert.deepEqual(plain(EX.parseRanges("3 - 7", 12).ranges), [{ start: 3, end: 7 }]);
    assert.deepEqual(plain(EX.parseRanges("7-3", 12).ranges), [{ start: 3, end: 7 }]);
});
ok("非法输入返回显式错误码", () => {
    assert.equal(EX.parseRanges("", 12).error, "EMPTY");
    assert.equal(EX.parseRanges("  ", 12).error, "EMPTY");
    assert.equal(EX.parseRanges("abc", 12).error, "FORMAT");
    assert.equal(EX.parseRanges("3-7x", 12).error, "FORMAT");
    assert.equal(EX.parseRanges("0", 12).error, "OUT_OF_RANGE");
    assert.equal(EX.parseRanges("13", 12).error, "OUT_OF_RANGE");
    assert.equal(EX.parseRanges("3-13", 12).error, "OUT_OF_RANGE");
    assert.equal(EX.parseRanges("3-7,", 12).error, null);
});
ok("文件名生成符合「页xx-xx.pdf」", () => {
    assert.equal(EX.buildName({ start: 3, end: 7 }), "页3-7");
    assert.equal(EX.buildName({ start: 10, end: 10 }), "页10");
    assert.deepEqual(plain(EX.previewNames([{ start: 3, end: 7 }, { start: 10, end: 10 }])),
        ["页3-7.pdf", "页10.pdf"]);
});
ok("同名文件自动追加 (1)/(2)", () => {
    assert.equal(EX.nextAvailableName([], "页3-7.pdf"), "页3-7.pdf");
    assert.equal(EX.nextAvailableName(["页3-7.pdf"], "页3-7.pdf"), "页3-7 (1).pdf");
    assert.equal(EX.nextAvailableName(["页3-7.pdf", "页3-7 (1).pdf"], "页3-7.pdf"), "页3-7 (2).pdf");
});
ok("中英文文案按 locale 切换", () => {
    const zh = scope.makePageOrganizerStrings("zh-CN");
    const en = scope.makePageOrganizerStrings("en-US");
    assert.equal(zh.get("totalPages", { count: 12 }), "共 12 页");
    assert.equal(zh.get("preview", { names: "页3-7.pdf" }), "将生成：页3-7.pdf");
    assert.equal(en.get("menu"), "Page Organizer: Extract Pages…");
    assert.equal(zh.get("nonexistent"), "nonexistent");
});

/* ---- 实际提取并写盘 ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-organizer-test-"));
const parsed = EX.parseRanges("3-7,10", 12);
const results = await EX.extract(bin, parsed.ranges);

ok("提取结果数量与命名", () => {
    assert.equal(results.length, 2);
    assert.equal(results[0].name, "页3-7.pdf");
    assert.equal(results[0].pageCount, 5);
    assert.equal(results[1].name, "页10.pdf");
    assert.equal(results[1].pageCount, 1);
});

const written = [];
for (const r of results) {
    const p = path.join(tmp, r.name);
    fs.writeFileSync(p, Buffer.from(r.binary, "latin1"));
    written.push(p);
}

const inspect = vm.runInContext(`(async (b) => {
    const doc = await POPDFLib.PDFDocument.load(POPDFLib_fromBinaryString(b));
    return { count: doc.getPageCount(), widths: doc.getPages().map(p => p.getWidth()) };
})`, context);

const first = await inspect(results[0].binary);
const second = await inspect(results[1].binary);
ok("输出 PDF 页数与页面顺序正确（页宽校验）", () => {
    assert.equal(first.count, 5);
    assert.deepEqual(plain(first.widths), [330, 340, 350, 360, 370]);
    assert.equal(second.count, 1);
    assert.deepEqual(plain(second.widths), [400]);
});

/* pdftk 独立复核（本机 /opt/homebrew/bin/pdftk） */
const pdftk = "/opt/homebrew/bin/pdftk";
if (fs.existsSync(pdftk)) {
    const countOf = (p) => {
        const out = execFileSync(pdftk, [p, "dump_data"], { encoding: "utf8" });
        const m = out.match(/NumberOfPages:\s*(\d+)/);
        return m ? Number(m[1]) : -1;
    };
    ok("pdftk 独立校验输出 PDF 页数", () => {
        assert.equal(countOf(written[0]), 5);
        assert.equal(countOf(written[1]), 1);
    });
}
else {
    console.log("  · 跳过 pdftk 校验（未安装）");
}

/* ---- 用最小 DOM 桩跑一遍对话框构建与交互 ---- */
function fakeWindow() {
    const makeEl = (tag) => ({
        tagName: tag,
        children: [],
        listeners: {},
        className: "", textContent: "", id: "", hidden: false,
        disabled: false, checked: false, value: "",
        appendChild(c) { this.children.push(c); return c; },
        setAttribute(k, v) { this[k] = v; },
        addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
        focus() {},
        click() { return (this.listeners.click || []).map((fn) => fn({})); }
    });
    const doc = {
        title: "", readyState: "complete",
        head: makeEl("head"), body: makeEl("body"),
        createElement: makeEl
    };
    const win = {
        document: doc, closed: false,
        addEventListener() {}, sizeToContent() {},
        close() { this.closed = true; }
    };
    const find = (node, id) => {
        if (node.id === id) return node;
        for (const c of node.children || []) {
            const hit = find(c, id);
            if (hit) return hit;
        }
        return null;
    };
    return { win, doc, find };
}

const { win: fakeWin, doc: fakeDoc, find } = fakeWindow();
let captured = null;
let doneResult = null;
const zh = scope.makePageOrganizerStrings("zh-CN");
const dialogIO = {
    S: zh,
    parentWindow: { openDialog: () => fakeWin },
    sourceTitle: "测试文献.pdf",
    pdfPath: "/tmp/测试文献.pdf",
    pageCount: 12,
    linkDefault: true,
    preview: (input) => {
        const p = EX.parseRanges(input, 12);
        if (p.error) {
            return { names: [], errorKey: { EMPTY: "errorEmpty", FORMAT: "errorFormat", OUT_OF_RANGE: "errorOutOfRange" }[p.error] };
        }
        return { names: EX.previewNames(p.ranges), errorKey: null };
    },
    onExtract: async (input, link) => {
        captured = { input, link };
        return { files: ["/tmp/页3-7.pdf"], linked: [1], linkErrors: [] };
    },
    onDone: (result) => { doneResult = result; }
};
scope.PageOrganizerDialog.open(dialogIO);

ok("对话框 DOM 构建完成，关键控件齐全", () => {
    assert.equal(fakeDoc.title, "页面组织器");
    for (const id of ["po-range", "po-preview", "po-link", "po-error", "po-status", "po-accept", "po-cancel"]) {
        assert.ok(find(fakeDoc.body, id), "缺少 " + id);
    }
    assert.equal(find(fakeDoc.body, "po-link").checked, true);
    assert.equal(find(fakeDoc.body, "po-accept").disabled, true);
});

const range = find(fakeDoc.body, "po-range");
const preview = find(fakeDoc.body, "po-preview");
const accept = find(fakeDoc.body, "po-accept");
const error = find(fakeDoc.body, "po-error");
const fire = (node, type) => (node.listeners[type] || []).forEach((fn) => fn({ key: "" }));

ok("实时预览：合法范围显示文件名、非法范围显示错误", () => {
    range.value = "3-7,10";
    fire(range, "input");
    assert.ok(preview.textContent.includes("页3-7.pdf"));
    assert.ok(preview.textContent.includes("页10.pdf"));
    assert.equal(accept.disabled, false);
    assert.equal(error.hidden, true);

    range.value = "99";
    fire(range, "input");
    assert.equal(accept.disabled, true);
    assert.equal(error.hidden, false);
    assert.ok(error.textContent.includes("12"));
});

range.value = "3-7";
fire(range, "input");
fire(accept, "click");
await new Promise((r) => setTimeout(r, 30));
ok("点击提取会把范围与「链接入库」选项交给主逻辑并关闭窗口", () => {
    assert.deepEqual(captured, { input: "3-7", link: true });
    assert.equal(fakeWin.closed, true);
    assert.equal(doneResult.files.length, 1);
});

/* ---- 菜单标签与链接入库归属（Zotero 10 运行时行为） ---- */
const bootScope = {
    console,
    Zotero: {
        debug() {}, logError() {}, locale: "zh-CN",
        MenuManager: {
            registerMenu(opts) { bootScope.__menus.push(opts); return opts.menuID; },
            unregisterMenu() {}
        },
        Items: { get(id) { return bootScope.__items[id] || null; } },
        getActiveZoteroPane() { return null; },
        getMainWindow() { return null; },
        ftl: { addResourceIds() {}, removeResourceIds() {} }
    },
    Services: {
        scriptloader: { loadSubScript() {} },
        wm: { getEnumerator() { return { hasMoreElements: () => false }; } },
        prompt: { alert() {}, prompt() { return false; } },
        locale: { requestedLocale: "zh-CN" },
        prefs: {
            _v: {},
            getBoolPref() { return true; },
            getStringPref(k) { return this._v[k] || ""; },
            setStringPref(k, v) { this._v[k] = v; }
        }
    },
    IOUtils: { exists: async () => false, read: async () => new Uint8Array(), write: async () => {} },
    Components: { classes: {}, interfaces: {} },
    makePageOrganizerStrings: scope.makePageOrganizerStrings,
    __menus: [], __items: {}, __captured: null
};
bootScope.__extractor = scope.PageExtractor;
const bootCtx = vm.createContext(bootScope);
vm.runInContext(read("bootstrap.js"), bootCtx, { filename: "bootstrap.js" });
vm.runInContext("PageOrganizer.S = makePageOrganizerStrings('zh-CN'); poRegisterMenus('page-organizer@workbuddy.local');", bootCtx);

ok("菜单不依赖 FTL，onShowing 直接写入可读标签", () => {
    assert.equal(bootScope.__menus.length, 2);
    const item = bootScope.__menus[0];
    assert.equal(item.target, "main/library/item");
    assert.ok(!item.menus[0].l10nID, "不能依赖 l10nID，否则 FTL 缺失时标签被清空");
    const attrs = {};
    const elem = {
        dataset: {},
        setAttribute(k, v) { attrs[k] = v; },
        removeAttribute(k) { delete attrs[k]; },
        get label() { return attrs.label; },
        set label(v) { attrs.label = v; }
    };
    item.menus[0].onShowing({}, {
        menuElem: elem, items: [], setVisible() {}, setEnabled() {}
    });
    assert.equal(attrs.label, "页面组织器：提取页面…");
    assert.ok(!("data-l10n-id" in attrs), "必须清除残留的 l10n 属性");
});

ok("父条目解析：优先附件 parentID，回退到选中条目", () => {
    const regular = (id) => ({ id, isRegularItem: () => true, getField: () => "父条目" });
    bootScope.__items[5] = regular(5);
    bootScope.__items[7] = regular(7);
    const resolve = (att, src) => {
        bootScope.__testAtt = att;
        bootScope.__testSrc = src;
        return vm.runInContext(
            "PageOrganizer._resolveParentID({ attachment: __testAtt, sourceItem: __testSrc })", bootCtx);
    };
    assert.equal(resolve({ parentID: 5 }, null), 5);
    assert.equal(resolve({ parentID: 0 }, { id: 7, isRegularItem: () => true }), 7);
    assert.equal(resolve({ getParentItem: () => ({ id: 5 }) }, null), 5);
    assert.equal(resolve({}, null), false);
});

ok("结果提示包含完整保存目录与父条目归属", () => {
    vm.runInContext("PageOrganizer._alert = function (m) { __captured = m; };", bootCtx);
    bootScope.__result = {
        files: ["/Users/husay/Zotero/storage/ABC/页3-7.pdf", "/Users/husay/Zotero/storage/ABC/页10.pdf"],
        dir: "/Users/husay/Zotero/storage/ABC",
        linked: [101, 102], linkErrors: [],
        parentItemID: 5, parentTitle: "测试文献", linkRequested: true, pageCount: 12
    };
    vm.runInContext("PageOrganizer.showResult(__result)", bootCtx);
    const msg = bootScope.__captured;
    assert.match(msg, /\/Users\/husay\/Zotero\/storage\/ABC/, "应给出完整目录");
    assert.match(msg, /页3-7\.pdf/);
    assert.match(msg, /测试文献/, "应说明挂在哪个条目下");
    assert.match(msg, /2 个链接附件/);
});

const fallbackResult = await (async () => {
    bootScope.Zotero.File = {
        pathToFile(p) {
            return {
                path: p, leafName: p.split("/").pop(), parent: { path: "/tmp/po-fallback" },
                clone() { return this; }, append() {}
            };
        }
    };
    bootScope.Zotero.Attachments = {
        linkFromFile: async () => { throw new Error("Cannot save linked file in non-local library"); },
        importFromFile: async () => ({ id: 999, parentID: 5 })
    };
    bootScope.__session = {
        pdfPath: "/tmp/po-fallback/source.pdf", bin: "", pageCount: 12,
        attachment: { parentID: 5, libraryID: 1 }, sourceItem: null
    };
    vm.runInContext(`
        PageOrganizer._session = __session;
        PageOrganizer.EX = {
            parseRanges: __extractor.parseRanges,
            previewNames: function (rs) { return rs.map(r => "页" + (r.start === r.end ? r.start : r.start + "-" + r.end) + ".pdf"); },
            extract: async function () { return [{ name: "页3.pdf", binary: "x" }]; },
            nextAvailableName: function () { return "页3 (1).pdf"; },
            appendSkipRule: __extractor.appendSkipRule,
            isEncrypted: __extractor.isEncrypted
        };
        PageOrganizer._writeBinary = async function () {};
        PageOrganizer._joinPath = function (d, n) { return d + "/" + n; };
    `, bootCtx);
    return await vm.runInContext("PageOrganizer.doExtract('3', true)", bootCtx);
})();

ok("群组库自动改用导入附件兜底，仍挂到父条目", () => {
    assert.deepEqual(plain(fallbackResult.linked), [999]);
    assert.deepEqual(plain(fallbackResult.imported), [999]);
    assert.equal(plain(fallbackResult.linkErrors).length, 0);
    assert.equal(fallbackResult.parentItemID, 5);
    assert.equal(fallbackResult.dir, "/tmp/po-fallback");
});

/* ---- 加密 PDF 解密通道与文件名保护 ---- */
ok("isEncrypted 能识别 /Encrypt，且不误判普通 PDF", () => {
    assert.equal(EX.isEncrypted(bin), false, "pdf-lib 生成的测试 PDF 不应被判为加密");
    assert.equal(EX.isEncrypted("%PDF-1.7\ntrailer\n<< /Encrypt 12 0 R >>\n"), true);
    assert.equal(EX.isEncrypted(""), false);
});

ok("Attanger 跳过规则追加保留原规则且幂等", () => {
    const r1 = EX.appendSkipRule("foo, ^bar", "^页");
    assert.equal(r1.changed, true);
    assert.equal(r1.value, "foo,^bar,^页");
    const r2 = EX.appendSkipRule(r1.value, "^页");
    assert.equal(r2.changed, false);
    assert.equal(r2.value, r1.value);
    assert.equal(EX.appendSkipRule("", "^页").value, "^页");
});

ok("PyMuPDF 脚本具备解密、抽页与无加密写出能力", () => {
    const py = scope.PageOrganizerPyScript;
    assert.match(py, /pymupdf/);
    assert.match(py, /authenticate/);
    assert.match(py, /insert_pdf/);
    assert.match(py, /PDF_ENCRYPT_NONE/);
    assert.match(py, /json\.dump/);
});

const encResult = await (async () => {
    bootScope.__encSession = {
        pdfPath: "/tmp/po-fallback/encrypted.pdf", bin: "dummy", pageCount: 20,
        encrypted: true,
        attachment: { parentID: 5, libraryID: 1 }, sourceItem: null
    };
    vm.runInContext(`
        __extractCalled = false; __writeCalled = false; __planned = null;
        PageOrganizer._session = __encSession;
        PageOrganizer.EX.extract = async function () {
            __extractCalled = true;
            throw new Error("加密 PDF 不应交给 pdf-lib");
        };
        PageOrganizer._extractWithPyMuPDF = async function (src, planned) {
            __planned = planned;
            return planned.map(p => p.path);
        };
        PageOrganizer._writeBinary = async function () { __writeCalled = true; };
    `, bootCtx);
    return await vm.runInContext("PageOrganizer.doExtract('5-9', false)", bootCtx);
})();

ok("加密 PDF 走解密引擎，绝不退回 pdf-lib 生成空白页", () => {
    assert.equal(encResult.engine, "pymupdf");
    assert.equal(plain(encResult.encrypted), true);
    assert.equal(bootScope.__extractCalled, false);
    assert.equal(bootScope.__writeCalled, false);
    assert.equal(plain(encResult.files).length, 1);
    assert.equal(plain(bootScope.__planned)[0].start, 5);
    assert.equal(plain(bootScope.__planned)[0].end, 9);
});

ok("自动为 Attanger 写入 ^页 跳过规则，重复调用不叠加", () => {
    const v = bootScope.Services.prefs._v;
    assert.equal(v["extensions.zotero.zoteroattanger.filenameSkipAutoMoveRenameRules"], "^页");
    assert.equal(v["extensions.zotero.zoteroattanger.filenameSkipRenameRules"], "^页");
    const again = vm.runInContext("PageOrganizer._protectFromAutoRename()", bootCtx);
    assert.equal(plain(again).length, 0, "第二次调用不应再改动偏好");
    assert.equal(v["extensions.zotero.zoteroattanger.filenameSkipRenameRules"], "^页");
});

/* ---- manifest 与本机版本 ---- */
ok("manifest 兼容区间覆盖本机 Zotero 10.0.9", () => {
    const m = JSON.parse(read("manifest.json"));
    const a = m.applications.zotero;
    assert.equal(m.manifest_version, 2);
    assert.equal(a.id, "page-organizer@workbuddy.local");
    assert.equal(a.strict_min_version, "10.0");
    assert.ok(a.strict_max_version.startsWith("10."));
    assert.equal(typeof m.version, "string");
});

// Zotero 10 (Firefox ESR 140) 的 ExtensionData.parseManifest() 对 MV2 插件
// 强制要求这三个字段；缺任意一个都会被判为 "Extension is invalid"，
// 安装时报出笼统的「可能与该版本的 Zotero 不兼容」。
ok("manifest 含 Zotero 10 强制要求的三个 zotero 字段", () => {
    const a = JSON.parse(read("manifest.json")).applications.zotero;
    for (const key of ["id", "update_url", "strict_max_version"]) {
        assert.ok(a[key] && typeof a[key] === "string", `applications.zotero.${key} 缺失`);
    }
    assert.match(a.update_url, /^https?:\/\//);
});

console.log("\n全部通过：" + passed + " 项");
console.log("测试输出目录：" + tmp);
for (const p of written) console.log("  " + p + " (" + fs.statSync(p).size + " bytes)");
