/* 页面组织器 — 加密 PDF 的解密提取引擎（PyMuPDF）
 *
 * pdf-lib 明确不支持解密：PDFDocument.load(..., {ignoreEncryption:true}) 只是
 * 跳过「加密文档」报错，复制页面时拿到的仍然是密文内容流，写出的新 PDF
 * 又不带 /Encrypt 字典，阅读器按明文解码就会得到满页空白（并报 zlib
 * incorrect header check）。30 份本机真实 PDF 的抽检里，只有带 /Encrypt
 * 的两份出现这个问题。
 *
 * 因此加密 PDF 交给 PyMuPDF：它能用空用户密码自动解密，insert_pdf 后以
 * PDF_ENCRYPT_NONE 写出，内容完整且不带加密。脚本以字符串形式随插件打包，
 * 运行时写到临时文件再调用，避免 chrome URL -> 本地路径转换的差异。
 *
 * 用法: python extract_pages.py <config.json> <result.json>
 */
var PageOrganizerPyScript = [
    'import json, os, sys',
    '',
    'def run(cfg_path, res_path):',
    '    result = {"ok": False, "files": []}',
    '    try:',
    '        with open(cfg_path, "r", encoding="utf-8") as f:',
    '            cfg = json.load(f)',
    '        try:',
    '            import pymupdf as pdf',
    '        except ImportError:',
    '            import fitz as pdf',
    '        doc = pdf.open(cfg["source"])',
    '        try:',
    '            if doc.needs_pass and not doc.authenticate(""):',
    '                raise RuntimeError("PDF requires a password; cannot decrypt")',
    '            total = len(doc)',
    '            for spec in cfg["outputs"]:',
    '                start, end = int(spec["start"]), int(spec["end"])',
    '                if start < 1 or end > total or start > end:',
    '                    raise RuntimeError("page range out of bounds: %d-%d of %d" % (start, end, total))',
    '                out = pdf.open()',
    '                out.insert_pdf(doc, from_page=start - 1, to_page=end - 1)',
    '                out.save(spec["path"], garbage=4, deflate=True, encryption=pdf.PDF_ENCRYPT_NONE)',
    '                out.close()',
    '                result["files"].append({',
    '                    "path": spec["path"],',
    '                    "bytes": os.path.getsize(spec["path"]),',
    '                    "pages": end - start + 1',
    '                })',
    '            result["ok"] = True',
    '        finally:',
    '            doc.close()',
    '    except Exception as e:',
    '        result["error"] = "%s: %s" % (type(e).__name__, e)',
    '    with open(res_path, "w", encoding="utf-8") as f:',
    '        json.dump(result, f, ensure_ascii=False)',
    '',
    'if __name__ == "__main__":',
    '    run(sys.argv[1], sys.argv[2])',
    ''
].join("\n");

if (typeof __PO_SCOPE__ !== "undefined" && __PO_SCOPE__) {
    __PO_SCOPE__.PageOrganizerPyScript = PageOrganizerPyScript;
}
