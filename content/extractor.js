/* 页面组织器 — 纯逻辑层
 *
 * 这里不触碰 Zotero / XPCOM，只用注入进来的 pdf-lib 与「二进制字符串」。
 * 二进制字符串是原始字符串，跨 realm / compartment 传递不会被包装，
 * 因此彻底规避 pdf-lib 对不同 realm 的 Uint8Array 做 instanceof 检查时
 * 抛出的 "must be a Uint8Array" 问题。
 *
 * bootstrap.js 注入：
 *   PDFLib              pdf-lib 的导出对象
 *   fromBinaryString    (bin) -> Uint8Array，定义在 pdf-lib 所在的 realm
 *   toBinaryString      (Uint8Array) -> bin，同样定义在 pdf-lib 所在的 realm
 */
var PageExtractor = {
    PDFLib: null,
    fromBinaryString: null,
    toBinaryString: null,

    /* ---- 任意类数组字节 -> 二进制字符串（在调用方 realm 执行） ---- */
    bytesToBinaryString: function (raw) {
        var CHUNK = 8192;
        var parts = [];
        for (var i = 0; i < raw.length; i += CHUNK) {
            var end = Math.min(i + CHUNK, raw.length);
            var a = new Array(end - i);
            for (var j = i; j < end; j++) {
                a[j - i] = raw[j] & 0xff;
            }
            parts.push(String.fromCharCode.apply(null, a));
        }
        return parts.join("");
    },

    /* ---- 二进制字符串 -> 本 realm 的 Uint8Array（写文件的兜底路径用） ---- */
    binaryStringToBytes: function (bin) {
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i) & 0xff;
        }
        return out;
    },

    /* ---- 页码范围解析 ----
       支持 "3-7"、"3"、"3-7,10,15-18"、全角逗号/分号、
       全角破折号、波浪号、".." 以及 "3 - 7" 这类带空格的写法。
       返回 { ranges:[{start,end}], error:null|"EMPTY"|"FORMAT"|"OUT_OF_RANGE" }
       页码为 1 起始闭区间，保持输入顺序，不合并、不去重。 */
    parseRanges: function (input, totalPages) {
        if (!input || !String(input).trim()) {
            return { ranges: [], error: "EMPTY" };
        }
        var total = Number(totalPages) || 0;
        var parts = String(input).split(/[,，;；]/);
        var ranges = [];
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (!part) continue;
            var m = part.match(/^(\d+)\s*(?:-|－|—|–|~|～|\.\.)\s*(\d+)$/);
            var single = part.match(/^(\d+)$/);
            var start, end;
            if (m) {
                start = parseInt(m[1], 10);
                end = parseInt(m[2], 10);
            }
            else if (single) {
                start = end = parseInt(single[1], 10);
            }
            else {
                return { ranges: [], error: "FORMAT" };
            }
            if (start < 1 || end < 1 || start > total || end > total) {
                return { ranges: [], error: "OUT_OF_RANGE" };
            }
            if (start > end) {
                var t = start;
                start = end;
                end = t;
            }
            ranges.push({ start: start, end: end });
        }
        if (!ranges.length) return { ranges: [], error: "EMPTY" };
        return { ranges: ranges, error: null };
    },

    /* 「页3-7」 / 单页「页10」 */
    buildName: function (range) {
        return "页" + (range.start === range.end
            ? String(range.start)
            : (range.start + "-" + range.end));
    },

    previewNames: function (ranges) {
        var names = [];
        for (var i = 0; i < ranges.length; i++) {
            names.push(this.buildName(ranges[i]) + ".pdf");
        }
        return names;
    },

    /* 重名时生成 "页3-7 (1).pdf"、"页3-7 (2).pdf" … */
    nextAvailableName: function (existingNames, wanted) {
        var existing = existingNames || [];
        if (existing.indexOf(wanted) < 0) return wanted;
        var dot = wanted.lastIndexOf(".");
        var base = dot > 0 ? wanted.slice(0, dot) : wanted;
        var ext = dot > 0 ? wanted.slice(dot) : "";
        for (var i = 1; ; i++) {
            var candidate = base + " (" + i + ")" + ext;
            if (existing.indexOf(candidate) < 0) return candidate;
        }
    },

    /* 带 /Encrypt 字典的 PDF 必须走解密引擎：pdf-lib 的 ignoreEncryption
       只跳过报错、不解密流，直接复制会生成满页空白的 PDF。 */
    isEncrypted: function (bin) {
        return String(bin).indexOf("/Encrypt") >= 0;
    },

    /* Zotero Attanger 用「逗号分隔的正则」匹配不含扩展名的文件名，
       命中 filenameSkipAutoMoveRenameRules / filenameSkipRenameRules 就跳过
       自动改名与自动移动。这里把 ^页 追加进去，且保持幂等、保留用户原规则。 */
    appendSkipRule: function (current, rule) {
        var cur = String(current || "").trim();
        var parts = cur ? cur.split(/,\s*/).filter(function (x) { return x; }) : [];
        if (parts.indexOf(rule) >= 0) return { value: cur, changed: false };
        parts.push(rule);
        return { value: parts.join(","), changed: true };
    },

    _open: async function (bin) {
        var bytes = this.fromBinaryString(bin);
        return await this.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    },

    getPageCount: async function (bin) {
        var doc = await this._open(bin);
        return doc.getPageCount();
    },

    /* 每一段页码范围生成一个独立 PDF；返回 [{ name, pageCount, binary }] */
    extract: async function (bin, ranges) {
        var srcDoc = await this._open(bin);
        var results = [];
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            var indices = [];
            for (var p = r.start; p <= r.end; p++) indices.push(p - 1);
            var outDoc = await this.PDFLib.PDFDocument.create();
            var pages = await outDoc.copyPages(srcDoc, indices);
            for (var j = 0; j < pages.length; j++) outDoc.addPage(pages[j]);
            var saved = await outDoc.save();
            results.push({
                name: this.buildName(r) + ".pdf",
                pageCount: indices.length,
                binary: this.toBinaryString(saved)
            });
        }
        return results;
    }
};

if (typeof __PO_SCOPE__ !== "undefined" && __PO_SCOPE__) {
    __PO_SCOPE__.PageExtractor = PageExtractor;
}
