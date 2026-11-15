/* 页面组织器 — 文案
 * 由 bootstrap.js 通过 loadSubScript 加载。不依赖任何 Zotero 全局，
 * 因此可以在 Node 里单独测试。
 */
function makePageOrganizerStrings(locale) {
    var zh = {
        title: "页面组织器",
        menu: "页面组织器：提取页面…",
        tools: "页面组织器…",
        source: "源文件",
        pagesLabel: "总页数",
        totalPages: "共 {count} 页",
        rangeLabel: "页码范围（例：3-7,10,15-18）",
        rangeHint: "支持多段，用逗号分隔；每段单独生成一个 PDF",
        preview: "将生成：{names}",
        linkCheckbox: "同时在 Zotero 库中创建链接附件",
        extract: "提取",
        cancel: "取消",
        working: "正在提取，请稍候…",
        errorEmpty: "请输入页码范围。",
        errorFormat: "格式不正确，请使用如 3-7,10,15-18 的写法。",
        errorOutOfRange: "页码超出范围，本文档共 {count} 页。",
        errorNoPDF: "请先选中一个 PDF 附件，或选中一个带有 PDF 附件的条目。",
        errorNoFile: "该附件没有可用的本地 PDF 文件。",
        errorRead: "无法读取该 PDF：{detail}",
        errorExtract: "提取失败：{detail}",
        encryptedNote: "这份 PDF 带加密，将改用本机 PyMuPDF 解密后提取，内容不会丢失。",
        engineNote: "加密 PDF 已通过 PyMuPDF 解密提取。",
        protectNote: "已阻止 Attanger 等插件自动重命名「页xx-xx.pdf」。",
        errorEngine: "这份 PDF 带加密，pdf-lib 无法解密；本机未找到可用的 PyMuPDF，已取消提取以免生成空白页。请在 about:config 里把 extensions.zotero.pageorganizer.pythonPath 指向装有 pymupdf 的 Python。",
        linkFailed: "以下文件入库失败（文件本身已保存）：",
        success: "已生成 {count} 个 PDF。\n\n保存目录（与源 PDF 相同）：\n{dir}\n\n文件：\n{files}\n\n{linkSummary}",
        linkedToParent: "已在 Zotero 中新建 {count} 个链接附件，挂在条目「{parent}」下；展开该条目即可看到。",
        linkedStandalone: "已在 Zotero 库中新建 {count} 个独立链接附件（源 PDF 没有上级条目）。",
        linkSkipped: "未在 Zotero 库中创建链接附件（未勾选）。",
        linkNone: "未能创建 Zotero 链接附件，详见下方错误。",
        importedNote: "其中 {count} 个位于群组库，已自动复制进 Zotero 存储（导入附件）。",
        unknownParent: "（未命名条目）",
        promptText: "文档：{name}\n共 {count} 页。\n输入页码范围，例如 3-7,10,15-18："
    };
    var en = {
        title: "Page Organizer",
        menu: "Page Organizer: Extract Pages…",
        tools: "Page Organizer…",
        source: "Source",
        pagesLabel: "Total pages",
        totalPages: "{count} pages",
        rangeLabel: "Page ranges (e.g. 3-7,10,15-18)",
        rangeHint: "Separate multiple ranges with commas; each range becomes one PDF",
        preview: "Will create: {names}",
        linkCheckbox: "Also create linked attachments in Zotero",
        extract: "Extract",
        cancel: "Cancel",
        working: "Extracting, please wait…",
        errorEmpty: "Please enter a page range.",
        errorFormat: "Invalid format. Use something like 3-7,10,15-18.",
        errorOutOfRange: "Page out of range. The document has {count} pages.",
        errorNoPDF: "Select one PDF attachment, or an item with a PDF attachment.",
        errorNoFile: "This attachment has no local PDF file.",
        errorRead: "Could not read the PDF: {detail}",
        errorExtract: "Extraction failed: {detail}",
        encryptedNote: "This PDF is encrypted. Extraction will use the local PyMuPDF engine so no content is lost.",
        engineNote: "The encrypted PDF was decrypted and extracted with PyMuPDF.",
        protectNote: "Other plugins (e.g. Attanger) were prevented from renaming the 页xx-xx.pdf files.",
        errorEngine: "This PDF is encrypted and pdf-lib cannot decrypt it. No usable PyMuPDF was found, so extraction was cancelled to avoid blank pages. Set extensions.zotero.pageorganizer.pythonPath in about:config to a Python with pymupdf installed.",
        linkFailed: "These files were saved but could not be linked:",
        success: "Created {count} PDF(s).\n\nSaved in (same folder as source PDF):\n{dir}\n\nFiles:\n{files}\n\n{linkSummary}",
        linkedToParent: "Created {count} linked attachment(s) in Zotero under “{parent}”. Expand that item to see them.",
        linkedStandalone: "Created {count} standalone linked attachment(s) in Zotero (source PDF has no parent item).",
        linkSkipped: "No Zotero linked attachments were created (option unchecked).",
        linkNone: "No Zotero linked attachments could be created; see the errors below.",
        importedNote: "{count} of them were in a group library, so they were copied into Zotero storage instead.",
        unknownParent: "(untitled item)",
        promptText: "Document: {name}\n{count} pages.\nEnter page ranges, e.g. 3-7,10,15-18:"
    };
    var table = /^zh/i.test(String(locale || "")) ? zh : en;
    return {
        locale: locale,
        isZH: table === zh,
        get: function (key, vars) {
            var text = table[key];
            if (text === undefined) return String(key);
            if (!vars) return text;
            return text.replace(/\{(\w+)\}/g, function (m, k) {
                return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
            });
        }
    };
}

if (typeof __PO_SCOPE__ !== "undefined" && __PO_SCOPE__) {
    __PO_SCOPE__.makePageOrganizerStrings = makePageOrganizerStrings;
}
