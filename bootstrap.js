/* 页面组织器 (Page Organizer) — Zotero 10.x bootstrap 插件
 *
 * 适配依据（本机 /Applications/Zotero.app 10.0.9，Firefox ESR 140 内核）：
 *   - manifest.json: strict_min_version 10.0 / strict_max_version 10.999
 *   - Zotero.Plugins 在 startup 前已 await registerLocales(addon)，
 *     因此 locale/*.ftl 会被自动登记到 L10nRegistry；
 *   - 菜单用 Zotero.MenuManager.registerMenu（target "main/library/item"、
 *     "main/menubar/tools"），context.items 是 Zotero.Item 数组；
 *   - 对话框用 about:blank + DOM 构建，不需要 chrome.manifest/
 *     registerChrome/XUL 包；
 *   - 链接入库用 Zotero.Attachments.linkFromFile（linked file，文件留在原目录）；
 *   - 文件读写用 IOUtils.read + nsIBinaryOutputStream（二进制字符串为桥梁），
 *     不把跨 realm 的 Uint8Array 交给 pdf-lib；
 *   - 双引擎：普通 PDF 用内置 pdf-lib；带 /Encrypt 的 PDF 交给本机 PyMuPDF
 *     解密提取（pdf-lib 的 ignoreEncryption 只跳过报错、不解密内容流，
 *     直接复制会生成空白页）；
 *   - 通过 Attanger 的 filenameSkip*Rules 阻止其它插件把「页xx-xx.pdf」改名。
 */

var PageOrganizer = {
    id: null,
    version: null,
    rootURI: null,
    S: null,
    scope: null,
    pyScript: null,
    _menuIDs: [],
    _windows: [],
    _protectApplied: [],
    _session: null
};

function poLog(msg) {
    try { Zotero.debug("[页面组织器] " + msg); } catch (e) {}
}
function poLogError(e) {
    try { Zotero.logError(e); } catch (e2) {}
}

function install(data, reason) {}
function uninstall(data, reason) {}

async function startup(params, reason) {
    var id = params.id;
    var version = params.version;
    var root = params.rootURI || (params.resourceURI && params.resourceURI.spec);
    if (root && typeof root === "object" && root.spec) root = root.spec;

    // MenuManager / Intl 等由 Zotero 初始化后才可用
    try { await Zotero.initializationPromise; } catch (e) {}

    PageOrganizer.id = id;
    PageOrganizer.version = version;
    if (!root.endsWith("/")) root += "/";
    PageOrganizer.rootURI = root;

    // 所有脚本加载到同一个 scope，跨文件通过 scope 上的属性互相访问，
    // 不依赖 loadSubScript 各版本对顶层 var 的处理差异。
    var scope = { __PO_SCOPE__: null };
    scope.__PO_SCOPE__ = scope;
    Services.scriptloader.loadSubScript(root + "content/pdf-lib.bundle.js", scope);
    Services.scriptloader.loadSubScript(root + "content/strings.js", scope);
    Services.scriptloader.loadSubScript(root + "content/extractor.js", scope);
    Services.scriptloader.loadSubScript(root + "content/dialog.js", scope);
    Services.scriptloader.loadSubScript(root + "content/pyscript.js", scope);
    PageOrganizer.scope = scope;

    var EX = scope.PageExtractor || (typeof PageExtractor !== "undefined" ? PageExtractor : null);
    var PDFLib = scope.POPDFLib || (typeof POPDFLib !== "undefined" ? POPDFLib : null);
    var fromBin = scope.POPDFLib_fromBinaryString ||
        (typeof POPDFLib_fromBinaryString !== "undefined" ? POPDFLib_fromBinaryString : null);
    var toBin = scope.POPDFLib_toBinaryString ||
        (typeof POPDFLib_toBinaryString !== "undefined" ? POPDFLib_toBinaryString : null);
    var makeStrings = scope.makePageOrganizerStrings ||
        (typeof makePageOrganizerStrings !== "undefined" ? makePageOrganizerStrings : null);
    var dialog = scope.PageOrganizerDialog ||
        (typeof PageOrganizerDialog !== "undefined" ? PageOrganizerDialog : null);
    var pyScript = scope.PageOrganizerPyScript ||
        (typeof PageOrganizerPyScript !== "undefined" ? PageOrganizerPyScript : null);
    if (!EX || !PDFLib || !PDFLib.PDFDocument || !fromBin || !toBin || !makeStrings || !dialog || !pyScript) {
        throw new Error("页面组织器: 脚本加载失败 (EX=" + !!EX + ", PDFLib=" + !!PDFLib +
            ", dialog=" + !!dialog + ")");
    }
    EX.PDFLib = PDFLib;
    EX.fromBinaryString = fromBin;
    EX.toBinaryString = toBin;
    PageOrganizer.EX = EX;
    PageOrganizer.dialog = dialog;
    PageOrganizer.pyScript = pyScript;

    var locale = "";
    try { locale = Zotero.locale || Services.locale.requestedLocale || ""; } catch (e) {}
    PageOrganizer.S = makeStrings(locale);

    // 保留插件 FTL 登记；菜单文字不依赖 FTL，由 onShowing 直接写入 label，
    // 避免本地化资源未登记时出现空白菜单项。
    try { Zotero.ftl.addResourceIds(["pageOrganizer.ftl"]); } catch (e) { poLog(e); }
    try {
        var enumerator = Services.wm.getEnumerator(null);
        while (enumerator.hasMoreElements()) {
            poInjectFTL(enumerator.getNext());
        }
    }
    catch (e) { poLog(e); }

    poRegisterMenus(id);
    PageOrganizer._protectApplied = PageOrganizer._protectFromAutoRename();
    Zotero.PageOrganizer = PageOrganizer;
    poLog("启动 v" + version + "，Zotero " + (Zotero.version || "10.x") + "，语言 " + locale);
}

function onMainWindowLoad(params, reason) {
    poInjectFTL(params.window);
}

function onMainWindowUnload(params, reason) {
    poRemoveFTL(params.window);
    var idx = PageOrganizer._windows.indexOf(params.window);
    if (idx >= 0) PageOrganizer._windows.splice(idx, 1);
}

function shutdown(params, reason) {
    if (typeof Zotero === "undefined") return;
    for (var i = 0; i < PageOrganizer._menuIDs.length; i++) {
        try { Zotero.MenuManager.unregisterMenu(PageOrganizer._menuIDs[i]); } catch (e) { poLogError(e); }
    }
    PageOrganizer._menuIDs = [];
    for (var j = 0; j < PageOrganizer._windows.length; j++) {
        poRemoveFTL(PageOrganizer._windows[j]);
    }
    PageOrganizer._windows = [];
    try { Zotero.ftl.removeResourceIds(["pageOrganizer.ftl"]); } catch (e) {}
    PageOrganizer._session = null;
    PageOrganizer.scope = null;
    try { delete Zotero.PageOrganizer; } catch (e) {}
    poLog("已关闭");
}

function poInjectFTL(win) {
    try {
        if (!win || !win.document || !win.MozXULElement) return;
        win.MozXULElement.insertFTLIfNeeded("pageOrganizer.ftl");
        if (PageOrganizer._windows.indexOf(win) < 0) PageOrganizer._windows.push(win);
    }
    catch (e) { poLog(e); }
}

function poRemoveFTL(win) {
    try {
        if (!win || !win.document) return;
        var link = win.document.querySelector('link[href="pageOrganizer.ftl"]');
        if (link) link.remove();
    }
    catch (e) {}
}

function poRegisterMenus(id) {
    if (!Zotero.MenuManager || !Zotero.MenuManager.registerMenu) {
        poLogError(new Error("Zotero.MenuManager 不可用"));
        return;
    }
    // Zotero 10 的 MenuManager 只提供 l10nID，没有 label 字段。插件 FTL 未
    // 成功登记时，data-l10n-id 会让 Fluent 把标签清空并覆盖代码写入的文字，
    // 结果就是一条「空白但可点击」的菜单项。这里改为完全用代码设置 label，
    // 并主动移除可能残留的 l10n 属性。
    var onShowing = function (event, context, label, alwaysEnabled) {
        try {
            var elem = context && context.menuElem;
            if (elem) {
                try { elem.removeAttribute("data-l10n-id"); } catch (e) {}
                try { if (elem.dataset) delete elem.dataset.l10nId; } catch (e) {}
                try { elem.setAttribute("label", label); } catch (e) {}
                try { elem.label = label; } catch (e) {}
            }
            if (context && context.setVisible) context.setVisible(true);
            if (context && context.setEnabled) {
                context.setEnabled(alwaysEnabled || PageOrganizer.hasPDF((context && context.items) || null));
            }
        }
        catch (e) { poLogError(e); }
    };
    var onCommand = function (event, context) {
        PageOrganizer.openDialog((context && context.items) || null);
    };

    var specs = [
        {
            menuID: "page-organizer-item-menu",
            target: "main/library/item",
            labelKey: "menu"
        },
        {
            menuID: "page-organizer-tools-menu",
            target: "main/menubar/tools",
            labelKey: "tools",
            alwaysEnabled: true
        }
    ];
    for (var i = 0; i < specs.length; i++) {
        (function (spec) {
            var result = Zotero.MenuManager.registerMenu({
                menuID: spec.menuID,
                pluginID: id,
                target: spec.target,
                menus: [{
                    menuType: "menuitem",
                    onShowing: function (event, context) {
                        onShowing(event, context, PageOrganizer.S.get(spec.labelKey), spec.alwaysEnabled);
                    },
                    onCommand: onCommand
                }]
            });
            if (result) PageOrganizer._menuIDs.push(result);
            else poLogError(new Error("菜单注册失败: " + spec.menuID));
        })(specs[i]);
    }
}

/* ---------- 防止其它插件自动改名 ---------- */

/* Zotero Attanger 监听新增附件并按条目标题自动改名/移动，会把
   「页5-9.pdf」改成「李华 - 2011 - …… 2.pdf」。它提供两个逗号分隔的
   正则跳过规则（zoteroattanger.js::isFilenameMatched），这里追加 ^页，
   保留用户已有规则、重复调用不会重复添加。
   可用 about:config 的 extensions.zotero.pageorganizer.protectFilename=false 关闭。 */
PageOrganizer._skipRule = "^页";

PageOrganizer._protectFromAutoRename = function () {
    var applied = [];
    try {
        var enabled = true;
        try {
            enabled = Services.prefs.getBoolPref("extensions.zotero.pageorganizer.protectFilename");
        }
        catch (e) {}
        if (!enabled || !this.EX || !this.EX.appendSkipRule) return applied;
        var keys = [
            "extensions.zotero.zoteroattanger.filenameSkipAutoMoveRenameRules",
            "extensions.zotero.zoteroattanger.filenameSkipRenameRules"
        ];
        for (var i = 0; i < keys.length; i++) {
            var cur;
            try { cur = Services.prefs.getStringPref(keys[i]); }
            catch (e) { continue; }   // 该插件未安装 / 偏好未初始化
            var r = this.EX.appendSkipRule(cur, this._skipRule);
            if (r.changed) {
                try {
                    Services.prefs.setStringPref(keys[i], r.value);
                    applied.push(keys[i]);
                }
                catch (e2) { poLogError(e2); }
            }
        }
    }
    catch (e) { poLogError(e); }
    if (applied.length) poLog("已添加 Attanger 文件名跳过规则: " + applied.join(", "));
    return applied;
};

/* ---------- 加密 PDF：本机 PyMuPDF 解密引擎 ---------- */

PageOrganizer._pythonCandidates = function () {
    var list = [];
    try {
        var custom = Services.prefs.getStringPref("extensions.zotero.pageorganizer.pythonPath");
        if (custom) list.push(custom);
    }
    catch (e) {}
    return list.concat([
        "/Users/husay/.workbuddy/binaries/python/envs/default/bin/python",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3"
    ]);
};

PageOrganizer._runProcess = function (exe, args) {
    return new Promise(function (resolve, reject) {
        var proc;
        try {
            var file = Zotero.File.pathToFile(exe);
            if (!file.exists()) { reject(new Error("Python 不存在: " + exe)); return; }
            proc = Components.classes["@mozilla.org/process/util;1"]
                .createInstance(Components.interfaces.nsIProcess);
            proc.init(file);
            try { proc.startHidden = true; proc.noShell = true; } catch (e) {}
            var settled = false;
            var timer = setTimeout(function () {
                if (!settled) { settled = true; reject(new Error("解密引擎超时（180 秒）")); }
            }, 180000);
            // Zotero 10 (Firefox ESR 140) 内部也用 nsIProcess + observe 对象
            var observer = {
                observe: function (subject, topic) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    var code = -1;
                    try { code = proc.exitValue; } catch (e) {}
                    if (topic === "process-finished" && code === 0) resolve();
                    else reject(new Error("进程 " + topic + "，exit=" + code));
                }
            };
            try {
                proc.runAsync(args, args.length, observer);
            }
            catch (e) {
                // 少数平台构建只暴露 runwAsync，降级再试一次
                proc.runwAsync(args, args.length, observer);
            }
        }
        catch (e) { reject(e); }
    });
};

PageOrganizer._writeText = async function (path, text) {
    try { await IOUtils.writeUTF8(path, text); }
    catch (e) { await Zotero.File.putContentsAsync(path, text); }
};

PageOrganizer._readText = async function (path) {
    try { return await IOUtils.readUTF8(path); }
    catch (e) { return await Zotero.File.getContentsAsync(path); }
};

PageOrganizer._removeQuietly = async function (path) {
    try { await IOUtils.remove(path); } catch (e) {}
};

/* 加密 PDF 绝不能交给 pdf-lib：ignoreEncryption 只跳过报错、不解密内容流，
   复制出来的页面必然是空白。这里让 PyMuPDF 直接写出每一段页码范围的 PDF。 */
PageOrganizer._extractWithPyMuPDF = async function (source, planned, dir) {
    if (!this.pyScript) throw new Error("PyMuPDF 脚本未加载");
    var tag = Date.now() + "-" + Math.floor(Math.random() * 100000);
    var scriptPath = this._joinPath(dir, ".page-organizer-" + tag + ".py");
    var cfgPath = this._joinPath(dir, ".page-organizer-" + tag + ".json");
    var resPath = this._joinPath(dir, ".page-organizer-" + tag + "-result.json");
    var cfg = { source: source, outputs: [] };
    for (var i = 0; i < planned.length; i++) {
        cfg.outputs.push({
            path: planned[i].path,
            start: planned[i].start,
            end: planned[i].end
        });
    }
    var lastError = "";
    try {
        await this._writeText(scriptPath, this.pyScript);
        await this._writeText(cfgPath, JSON.stringify(cfg));
        var candidates = this._pythonCandidates();
        for (var c = 0; c < candidates.length; c++) {
            var exe = candidates[c];
            if (!(await IOUtils.exists(exe))) continue;
            await this._removeQuietly(resPath);
            try {
                await this._runProcess(exe, [scriptPath, cfgPath, resPath]);
            }
            catch (e) {
                lastError = exe + ": " + (e.message || String(e));
                continue;
            }
            var text;
            try { text = await this._readText(resPath); }
            catch (e2) { lastError = exe + ": 未产生结果文件"; continue; }
            var res;
            try { res = JSON.parse(text); }
            catch (e3) { lastError = exe + ": 结果不是合法 JSON"; continue; }
            if (!res.ok) {
                lastError = exe + ": " + (res.error || "未知错误");
                continue;
            }
            var files = [];
            for (var k = 0; k < planned.length; k++) {
                var p = planned[k].path;
                if (!(await IOUtils.exists(p))) throw new Error("解密引擎未生成文件: " + p);
                var st = await IOUtils.stat(p);
                if (!st || st.size < 100) throw new Error("解密引擎生成了空文件: " + p);
                files.push(p);
            }
            poLog("PyMuPDF 解密提取完成: " + exe + "，输出 " + files.length + " 个文件");
            return files;
        }
    }
    finally {
        await this._removeQuietly(scriptPath);
        await this._removeQuietly(cfgPath);
        await this._removeQuietly(resPath);
    }
    var err = new Error(this.S.get("errorEngine") + "\n\n" + lastError);
    err.friendly = err.message;
    throw err;
};

/* ---------- 条目与文件 ---------- */

PageOrganizer._basename = function (path) {
    var parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path);
};

PageOrganizer._joinPath = function (dir, name) {
    try {
        var f = Zotero.File.pathToFile(dir);
        var out = f.clone();
        out.append(name);
        return out.path;
    }
    catch (e) {
        var sep = String(dir).indexOf("\\") >= 0 && String(dir).indexOf("/") < 0 ? "\\" : "/";
        return String(dir).replace(/[\\/]+$/, "") + sep + name;
    }
};

PageOrganizer.selectedItems = function (items) {
    if (items && items.length) return items;
    var pane = null;
    try { pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane(); } catch (e) {}
    if (!pane) {
        try {
            var mw = Zotero.getMainWindow && Zotero.getMainWindow();
            pane = mw && (mw.ZoteroPane || mw.ZoteroPane_Local);
        }
        catch (e) {}
    }
    try { return (pane && pane.getSelectedItems) ? (pane.getSelectedItems() || []) : []; }
    catch (e) { return []; }
};

/* 选中一个 PDF 附件，或选中一个普通条目时使用它的第一个 PDF 子附件 */
PageOrganizer.findPDF = function (items) {
    if (!items || items.length !== 1) return null;
    var item = items[0];
    if (!item) return null;
    try {
        if (item.isAttachment && item.isAttachment()) {
            return item.attachmentContentType === "application/pdf" ? item : null;
        }
    }
    catch (e) {}
    try {
        if (item.isRegularItem && item.isRegularItem()) {
            var ids = item.getAttachments ? (item.getAttachments() || []) : [];
            for (var i = 0; i < ids.length; i++) {
                var kid = Zotero.Items.get(ids[i]);
                if (kid && kid.isAttachment() && kid.attachmentContentType === "application/pdf") {
                    return kid;
                }
            }
        }
    }
    catch (e) {}
    return null;
};

PageOrganizer.hasPDF = function (items) {
    return !!this.findPDF(this.selectedItems(items));
};

/* Zotero 10 的 Attachments.linkFromFile 忽略 options.libraryID，
 * 只靠 parentItemID 决定条目归属（attachments.js::_addToDB 会据它推断库）。
 * 因此这里必须显式、可靠地解析出父条目 ID，拿不到时才退为独立附件。 */
PageOrganizer._resolveParentID = function (sess) {
    var candidates = [];
    var att = sess.attachment;
    try { candidates.push(att.parentID); } catch (e) {}
    try { candidates.push(att.parentItemID); } catch (e) {}
    try {
        var p = att.getParentItem && att.getParentItem();
        if (p) candidates.push(p.id);
    }
    catch (e) {}
    var src = sess.sourceItem;
    if (src && src !== att) {
        try {
            if (src.isRegularItem && src.isRegularItem()) candidates.push(src.id);
        }
        catch (e) {}
    }
    for (var i = 0; i < candidates.length; i++) {
        var id = candidates[i];
        if (!id) continue;
        try {
            var item = Zotero.Items.get(id);
            if (item && item.isRegularItem && item.isRegularItem()) return id;
        }
        catch (e) {}
    }
    return false;
};

PageOrganizer._itemTitle = function (id) {
    try {
        var item = Zotero.Items.get(id);
        return (item && item.getField("title")) || "";
    }
    catch (e) { return ""; }
};

PageOrganizer._alert = function (message) {
    var win = null;
    try { win = Zotero.getMainWindow && Zotero.getMainWindow(); } catch (e) {}
    try { Services.prompt.alert(win, this.S.get("title"), message); }
    catch (e) { poLogError(e); }
};

PageOrganizer._errorKey = function (code) {
    return {
        EMPTY: "errorEmpty",
        FORMAT: "errorFormat",
        OUT_OF_RANGE: "errorOutOfRange"
    }[code] || "errorFormat";
};

/* ---------- 主流程 ---------- */

PageOrganizer.openDialog = async function (items) {
    var selected = this.selectedItems(items);
    var attachment = this.findPDF(selected);
    if (!attachment) {
        this._alert(this.S.get("errorNoPDF"));
        return;
    }

    var pdfPath = null;
    try {
        if (typeof attachment.getFilePathAsync === "function") {
            pdfPath = await attachment.getFilePathAsync();
        }
    }
    catch (e) {}
    if (!pdfPath) {
        try { pdfPath = attachment.getFilePath(); } catch (e) {}
    }
    if (!pdfPath || !(await IOUtils.exists(pdfPath))) {
        try { pdfPath = attachment.getFilePath(); } catch (e) {}
    }
    if (!pdfPath || !(await IOUtils.exists(pdfPath))) {
        this._alert(this.S.get("errorNoFile"));
        return;
    }

    var bin;
    try {
        var raw = await IOUtils.read(pdfPath);
        bin = this.EX.bytesToBinaryString(raw);
    }
    catch (e) {
        this._alert(this.S.get("errorRead", { detail: e.message || String(e) }));
        return;
    }

    var pageCount;
    try { pageCount = await this.EX.getPageCount(bin); }
    catch (e) {
        this._alert(this.S.get("errorRead", { detail: e.message || String(e) }));
        return;
    }

    var sourceTitle = "";
    try { sourceTitle = attachment.getField("title") || ""; } catch (e) {}
    if (!sourceTitle) sourceTitle = this._basename(pdfPath);

    this._session = {
        pdfPath: pdfPath,
        bin: bin,
        pageCount: pageCount,
        attachment: attachment,
        // 带 /Encrypt 的 PDF 必须走 PyMuPDF 解密通道，pdf-lib 会产出空白页
        encrypted: (typeof this.EX.isEncrypted === "function")
            ? this.EX.isEncrypted(bin) : false,
        // 用户实际选中的条目：源附件若没有父条目，用它作为新附件的上级
        sourceItem: selected[0] || null
    };

    var self = this;
    var io = {
        S: this.S,
        parentWindow: (function () {
            try { return Zotero.getMainWindow() || Services.wm.getMostRecentWindow("navigator:browser"); }
            catch (e) { return null; }
        })(),
        sourceTitle: sourceTitle,
        pdfPath: pdfPath,
        pageCount: pageCount,
        encrypted: this._session.encrypted,
        linkDefault: true,
        preview: function (input) { return self.preview(input); },
        onExtract: function (input, linkInLibrary) { return self.doExtract(input, linkInLibrary); },
        onDone: function (result) { self.showResult(result); },
        onUIError: function (e) { poLogError(e); self.promptFallback(io); }
    };

    try {
        this.dialog.open(io);
    }
    catch (e) {
        poLogError(e);
        await this.promptFallback(io);
    }
};

/* 自定义对话框不可用时的降级输入（原生 nsIPromptService） */
PageOrganizer.promptFallback = async function (io) {
    var input = { value: "" };
    var check = { value: true };
    var win = io.parentWindow;
    var ok = Services.prompt.prompt(
        win,
        this.S.get("title"),
        this.S.get("promptText", { name: io.sourceTitle, count: io.pageCount }),
        input,
        this.S.get("linkCheckbox"),
        check
    );
    if (!ok) return;
    try {
        var result = await this.doExtract(input.value, check.value);
        this.showResult(result);
    }
    catch (e) {
        this._alert(e && e.friendly ? e.friendly : (e && e.message ? e.message : String(e)));
    }
};

PageOrganizer.preview = function (input) {
    var count = this._session ? this._session.pageCount : 0;
    var parsed = this.EX.parseRanges(input, count);
    if (parsed.error) {
        return { names: [], errorKey: this._errorKey(parsed.error), count: count };
    }
    return { names: this.EX.previewNames(parsed.ranges), errorKey: null, count: count };
};

/* 写文件：优先 IOUtils.write（原子写），失败时退回二进制输出流 */
PageOrganizer._writeBinary = async function (path, bin) {
    var u8 = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) {
        u8[k] = bin.charCodeAt(k) & 0xff;
    }
    try {
        await IOUtils.write(path, u8);
    }
    catch (e) {
        poLog("IOUtils.write 失败，改用二进制流: " + e);
        var file = Components.classes["@mozilla.org/file/local;1"]
            .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(path);
        var fos = Components.classes["@mozilla.org/network/file-output-stream;1"]
            .createInstance(Components.interfaces.nsIFileOutputStream);
        // PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE
        fos.init(file, 0x02 | 0x08 | 0x20, 420, 0);
        var bos = Components.classes["@mozilla.org/binaryoutputstream;1"]
            .createInstance(Components.interfaces.nsIBinaryOutputStream);
        bos.setOutputStream(fos);
        bos.writeBytes(bin);
        bos.close();
    }
};

PageOrganizer.doExtract = async function (input, linkInLibrary) {
    var sess = this._session;
    if (!sess) throw new Error("会话已失效，请重新打开对话框");
    if (linkInLibrary === undefined || linkInLibrary === null) linkInLibrary = true;
    var EX = this.EX;
    var protectApplied = this._protectFromAutoRename();

    var parsed = EX.parseRanges(input, sess.pageCount);
    if (parsed.error) {
        var err = new Error("invalid page range");
        err.friendly = this.S.get(this._errorKey(parsed.error), { count: sess.pageCount });
        throw err;
    }

    var dir = Zotero.File.pathToFile(sess.pdfPath).parent.path;
    var names = EX.previewNames(parsed.ranges);
    var planned = [];
    for (var i = 0; i < names.length; i++) {
        var wanted = names[i];
        var taken = [];
        var name = wanted;
        while (await IOUtils.exists(this._joinPath(dir, name))) {
            taken.push(name);
            name = EX.nextAvailableName(taken, wanted);
        }
        planned.push({
            path: this._joinPath(dir, name),
            name: name,
            start: parsed.ranges[i].start,
            end: parsed.ranges[i].end
        });
    }

    var files = [];
    var engine = "pdf-lib";
    if (sess.encrypted) {
        // pdf-lib 不解密内容流，直接复制会写出满页空白的 PDF
        files = await this._extractWithPyMuPDF(sess.pdfPath, planned, dir);
        engine = "pymupdf";
    }
    else {
        var results;
        try {
            results = await EX.extract(sess.bin, parsed.ranges);
        }
        catch (e) {
            var exErr = new Error(e.message || String(e));
            exErr.friendly = this.S.get("errorExtract", { detail: e.message || String(e) });
            throw exErr;
        }
        for (var k = 0; k < results.length; k++) {
            await this._writeBinary(planned[k].path, results[k].binary);
            files.push(planned[k].path);
        }
    }

    var linked = [];
    var imported = [];
    var linkErrors = [];
    var parentItemID = this._resolveParentID(sess);
    var parentTitle = parentItemID ? this._itemTitle(parentItemID) : "";
    var srcLib = "?";
    try { srcLib = sess.attachment.libraryID; } catch (e) {}
    poLog("入库准备: parentItemID=" + parentItemID + ", parentTitle=" + parentTitle +
        ", 源附件库=" + srcLib + ", 文件数=" + files.length + ", 勾选入库=" + !!linkInLibrary);

    if (linkInLibrary) {
        for (var j = 0; j < files.length; j++) {
            try {
                // 注意：options.libraryID 在 Zotero 10 里被忽略，只传 parentItemID
                var options = {
                    file: files[j],
                    parentItemID: parentItemID,
                    title: this._basename(files[j]).replace(/\.pdf$/i, ""),
                    contentType: "application/pdf"
                };
                var linkedItem = await Zotero.Attachments.linkFromFile(options);
                if (linkedItem && linkedItem.id) {
                    if (parentItemID && linkedItem.parentID != parentItemID) {
                        try {
                            linkedItem.parentID = parentItemID;
                            await linkedItem.saveTx();
                        }
                        catch (e2) { poLogError(e2); }
                    }
                    linked.push(linkedItem.id);
                    poLog("已创建链接附件 id=" + linkedItem.id + " parentID=" + linkedItem.parentID);
                }
                else {
                    linkErrors.push(this._basename(files[j]) + " - 未返回附件条目");
                }
            }
            catch (e) {
                poLogError(e);
                var msg = e && e.message ? e.message : String(e);
                // 群组库不允许链接附件（_addToDB 会抛错），改为复制进 Zotero 存储的导入附件
                if (/non-local library|Cannot save linked file/i.test(msg)) {
                    try {
                        var fallbackItem = await Zotero.Attachments.importFromFile({
                            file: files[j],
                            parentItemID: parentItemID,
                            title: this._basename(files[j]).replace(/\.pdf$/i, ""),
                            contentType: "application/pdf"
                        });
                        if (fallbackItem && fallbackItem.id) {
                            linked.push(fallbackItem.id);
                            imported.push(fallbackItem.id);
                            poLog("群组库：改用导入附件 id=" + fallbackItem.id);
                            continue;
                        }
                    }
                    catch (e3) {
                        poLogError(e3);
                        msg += "；导入兜底亦失败：" + (e3.message || String(e3));
                    }
                }
                linkErrors.push(this._basename(files[j]) + " - " + msg);
            }
        }
        // 子附件在折叠状态下无法直接选中，定位到父条目更直观
        if (parentItemID || linked.length) {
            try {
                var pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
                if (pane && pane.selectItem) {
                    await pane.selectItem(parentItemID || linked[linked.length - 1]);
                }
            }
            catch (e) { poLogError(e); }
        }
    }

    this._session = null;
    return {
        files: files,
        dir: dir,
        linked: linked,
        imported: imported,
        linkErrors: linkErrors,
        parentItemID: parentItemID,
        parentTitle: parentTitle,
        linkRequested: !!linkInLibrary,
        engine: engine,
        encrypted: !!sess.encrypted,
        protectApplied: protectApplied,
        pageCount: sess.pageCount
    };
};

PageOrganizer.showResult = function (result) {
    var names = [];
    for (var i = 0; i < result.files.length; i++) {
        names.push("  " + this._basename(result.files[i]));
    }
    var linkSummary;
    if (!result.linkRequested) {
        linkSummary = this.S.get("linkSkipped");
    }
    else if (result.linked.length && result.parentItemID) {
        linkSummary = this.S.get("linkedToParent", {
            count: result.linked.length,
            parent: result.parentTitle || this.S.get("unknownParent")
        });
    }
    else if (result.linked.length) {
        linkSummary = this.S.get("linkedStandalone", { count: result.linked.length });
    }
    else {
        linkSummary = this.S.get("linkNone");
    }
    if (result.imported && result.imported.length) {
        linkSummary += "\n" + this.S.get("importedNote", { count: result.imported.length });
    }
    var message = this.S.get("success", {
        count: result.files.length,
        dir: result.dir,
        files: names.join("\n"),
        linkSummary: linkSummary
    });
    if (result.engine === "pymupdf") message += "\n" + this.S.get("engineNote");
    if (result.protectApplied && result.protectApplied.length) {
        message += "\n" + this.S.get("protectNote");
    }
    if (result.linkErrors && result.linkErrors.length) {
        message += "\n\n" + this.S.get("linkFailed") + "\n" + result.linkErrors.join("\n");
    }
    this._alert(message);
};
