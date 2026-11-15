/* 页面组织器 — 对话框
 *
 * Zotero 10（Firefox ESR 140）不再需要为插件注册 chrome:// 包：
 * 这里用主窗口的 openDialog("about:blank", …) 打开一个 chrome 窗口，
 * 再在 DOMContentLoaded 之后用 DOM API 构建界面。这是 Zotero 10 插件
 * （如 zotero-plugin-toolkit）验证过的做法，不依赖 chrome.manifest /
 * registerChrome / XUL 文件，也不会因为 FTL 注入失败而白屏。
 */
var PageOrganizerDialog = {
    CSS: [
        ":root { color-scheme: light dark; }",
        "html, body { margin: 0; padding: 0; }",
        "body { background: Canvas; color: CanvasText;",
        "  font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }",
        ".po-root { padding: 18px 20px 16px; min-width: 470px; box-sizing: border-box; }",
        ".po-root [hidden] { display: none !important; }",
        ".po-title { font-size: 16px; font-weight: 600; margin: 0 0 14px; }",
        ".po-row { display: flex; align-items: center; margin-bottom: 7px; gap: 8px; }",
        ".po-key { flex: 0 0 66px; opacity: .72; }",
        ".po-value { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".po-hr { height: 1px; background: GrayText; opacity: .25; margin: 10px 0 13px; }",
        ".po-label { display: block; font-weight: 600; margin-bottom: 5px; }",
        ".po-hint { display: block; opacity: .7; font-size: 12px; margin: 4px 0 10px; }",
        "#po-range { width: 100%; box-sizing: border-box; padding: 7px 9px; font-size: 14px;",
        "  border: 1px solid GrayText; border-radius: 5px; background: Field; color: FieldText; }",
        "#po-range:focus { outline: 2px solid Highlight; outline-offset: -1px; }",
        ".po-preview { display: block; min-height: 20px; margin: 9px 0 4px; font-family: ui-monospace, Menlo, monospace; }",
        ".po-check { display: flex; align-items: center; gap: 7px; margin: 10px 0 4px; }",
        ".po-check input { margin: 0; }",
        ".po-error { display: block; color: #d03030; margin: 6px 0 2px; font-weight: 600; }",
        ".po-status { display: block; margin: 6px 0 2px; opacity: .85; }",
        ".po-buttons { display: flex; justify-content: flex-end; gap: 9px; margin-top: 16px; }",
        ".po-buttons button { min-width: 88px; padding: 7px 15px; font-size: 13px;",
        "  border: 1px solid ButtonBorder; border-radius: 5px;",
        "  background: ButtonFace; color: ButtonText; cursor: pointer; }",
        ".po-buttons button:disabled { opacity: .5; cursor: default; }",
        ".po-buttons .po-primary { font-weight: 600; }"
    ].join("\n"),

    open: function (io) {
        var parent = io.parentWindow;
        if (!parent || !parent.openDialog) throw new Error("no parent window");
        var win = parent.openDialog(
            "about:blank",
            "page-organizer-dialog-" + Date.now(),
            "chrome,centerscreen,resizable=no,dialog=no,width=540,height=350"
        );
        if (!win) throw new Error("openDialog failed");
        var self = this;
        var build = function () {
            try {
                self._build(win, io);
            }
            catch (e) {
                if (io.onUIError) io.onUIError(e);
            }
        };
        var state = win.document && win.document.readyState;
        if (state === "complete" || state === "interactive") {
            build();
        }
        else {
            win.addEventListener("DOMContentLoaded", build, { once: true });
        }
        return win;
    },

    _build: function (win, io) {
        var doc = win.document;
        var S = io.S;
        doc.title = S.get("title");

        var style = doc.createElement("style");
        style.textContent = this.CSS;
        doc.head.appendChild(style);

        var el = function (tag, cls, text) {
            var e = doc.createElement(tag);
            if (cls) e.className = cls;
            if (text !== undefined && text !== null) e.textContent = String(text);
            return e;
        };
        var row = function (key, value, title) {
            var r = el("div", "po-row");
            r.appendChild(el("span", "po-key", key));
            var v = el("span", "po-value", value);
            if (title) v.setAttribute("title", title);
            r.appendChild(v);
            return r;
        };

        var root = el("div", "po-root");
        root.appendChild(el("div", "po-title", S.get("title")));
        root.appendChild(row(S.get("source"), io.sourceTitle, io.pdfPath));
        root.appendChild(row(S.get("pagesLabel"), S.get("totalPages", { count: io.pageCount })));
        root.appendChild(el("div", "po-hr"));

        root.appendChild(el("label", "po-label", S.get("rangeLabel")));
        var range = el("input");
        range.id = "po-range";
        range.type = "text";
        range.placeholder = "3-7,10,15-18";
        range.setAttribute("spellcheck", "false");
        root.appendChild(range);
        root.appendChild(el("span", "po-hint", S.get("rangeHint")));
        if (io.encrypted) {
            root.appendChild(el("span", "po-hint", S.get("encryptedNote")));
        }

        var preview = el("span", "po-preview");
        preview.id = "po-preview";
        root.appendChild(preview);

        var checkRow = el("label", "po-check");
        var check = doc.createElement("input");
        check.type = "checkbox";
        check.id = "po-link";
        check.checked = io.linkDefault !== false;
        checkRow.appendChild(check);
        checkRow.appendChild(el("span", "", S.get("linkCheckbox")));
        root.appendChild(checkRow);

        var error = el("span", "po-error");
        error.id = "po-error";
        error.hidden = true;
        root.appendChild(error);

        var status = el("span", "po-status");
        status.id = "po-status";
        status.hidden = true;
        root.appendChild(status);

        var buttons = el("div", "po-buttons");
        var cancel = el("button", "", S.get("cancel"));
        cancel.type = "button";
        cancel.id = "po-cancel";
        var accept = el("button", "po-primary", S.get("extract"));
        accept.type = "button";
        accept.id = "po-accept";
        accept.disabled = true;
        buttons.appendChild(cancel);
        buttons.appendChild(accept);
        root.appendChild(buttons);
        doc.body.appendChild(root);

        var updatePreview = function () {
            var value = range.value;
            var p = io.preview(value);
            if (p.errorKey) {
                preview.textContent = "";
                error.hidden = false;
                error.textContent = S.get(p.errorKey, { count: io.pageCount });
                accept.disabled = true;
            }
            else if (!p.names || !p.names.length) {
                preview.textContent = "";
                error.hidden = true;
                accept.disabled = true;
            }
            else {
                error.hidden = true;
                preview.textContent = S.get("preview", { names: p.names.join("   ") });
                accept.disabled = false;
            }
        };

        range.addEventListener("input", updatePreview);
        range.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter" && !accept.disabled) accept.click();
        });
        cancel.addEventListener("click", function () { win.close(); });
        win.addEventListener("keydown", function (ev) {
            if (ev.key === "Escape") win.close();
        });

        accept.addEventListener("click", async function () {
            accept.disabled = true;
            cancel.disabled = true;
            range.disabled = true;
            error.hidden = true;
            status.hidden = false;
            status.textContent = S.get("working");
            try {
                var result = await io.onExtract(range.value.trim(), check.checked);
                win.close();
                if (io.onDone) io.onDone(result);
            }
            catch (e) {
                status.hidden = true;
                error.hidden = false;
                error.textContent = e && e.friendly ? e.friendly : (e && e.message ? e.message : String(e));
                accept.disabled = false;
                cancel.disabled = false;
                range.disabled = false;
                range.focus();
            }
        });

        updatePreview();
        range.focus();
        try { win.sizeToContent(); } catch (e) {}
    }
};

if (typeof __PO_SCOPE__ !== "undefined" && __PO_SCOPE__) {
    __PO_SCOPE__.PageOrganizerDialog = PageOrganizerDialog;
}
