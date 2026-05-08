// ==UserScript==
// @name         Yamato 外部連携エラー自動修正
// @namespace    https://newb2web.kuronekoyamato.co.jp/
// @version      1.0.0
// @description  外部システムとの連携画面で町・番地が長すぎるエラーを自動修正する
// @author       Jeven
// @match        https://newb2web.kuronekoyamato.co.jp/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ── 各フィールドの全角文字数上限 ──
    const LIMIT = {
        machi:   16,   // 町・番地
        mansion: 16,   // マンション・ビル名
        kaisha1: 25,   // 会社・部門１
        kaisha2: 25,   // 会社・部門２
    };

    // =====================================================================
    // 文字幅ユーティリティ（全角=1、半角=0.5）
    // =====================================================================
    function charWidth(ch) {
        const c = ch.codePointAt(0);
        return (
            (c >= 0x1100 && c <= 0x115F) ||
            (c >= 0x2E80 && c <= 0x303E) ||
            (c >= 0x3040 && c <= 0x33FF) ||
            (c >= 0x3400 && c <= 0x4DBF) ||
            (c >= 0x4E00 && c <= 0x9FFF) ||
            (c >= 0xAC00 && c <= 0xD7AF) ||
            (c >= 0xF900 && c <= 0xFAFF) ||
            (c >= 0xFE30 && c <= 0xFE4F) ||
            (c >= 0xFF00 && c <= 0xFF60) ||
            (c >= 0xFFE0 && c <= 0xFFE6)
        ) ? 1 : 0.5;
    }

    function fwLen(str) {
        let n = 0;
        for (const ch of str) n += charWidth(ch);
        return n;
    }

    // strを全角max文字で切り出し [前半, 後半] を返す
    function fwSplit(str, max) {
        let n = 0, i = 0;
        for (const ch of str) {
            const w = charWidth(ch);
            if (n + w > max) break;
            n += w;
            i += ch.length;
        }
        return [str.slice(0, i), str.slice(i)];
    }

    // =====================================================================
    // 住所分割：番地部分 vs マンション名部分
    // 例: 下依知2丁目22-26サンライズ片倉A-201
    //   → ['下依知2丁目22-26', 'サンライズ片倉A-201']
    // =====================================================================
    function splitAtBuilding(addr) {
        let i = 0;
        while (i < addr.length) {
            const c = addr[i];
            if (/[0-9０-９]/.test(c)) {
                // 数字・ハイフン部分を全部読む
                let j = i;
                while (j < addr.length && /[0-9０-９\-－]/.test(addr[j])) j++;
                // 番・号・地・丁・目 を読み飛ばす
                while (j < addr.length && /[番号地丁目]/.test(addr[j])) j++;

                if (j < addr.length) {
                    const next = addr[j];
                    // カタカナ・英字・括弧 → マンション名の始まりと判断
                    const isBuildingStart =
                        /[゠-ヿ･-ﾟ]/.test(next) ||   // カタカナ
                        /[a-zA-ZＡ-Ｚａ-ｚ]/.test(next) ||             // 英字
                        /[（(【「『]/.test(next);                        // 括弧

                    if (isBuildingStart) {
                        return [addr.slice(0, j), addr.slice(j)];
                    }
                }
                i = j;
            } else {
                i++;
            }
        }

        // 分割点が見つからない場合は全角16文字で強制分割
        return fwSplit(addr, LIMIT.machi);
    }

    // =====================================================================
    // DOM ユーティリティ
    // =====================================================================
    function setVal(input, val) {
        if (!input) return;
        const proto = input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, val);
        ['input', 'change', 'blur'].forEach(t =>
            input.dispatchEvent(new Event(t, { bubbles: true }))
        );
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ── ラベルテキストで input を探す ──
    function findInputByLabel(labelText) {
        const normalized = labelText.replace(/\s/g, '');
        const cells = document.querySelectorAll(
            'th, td, label, dt, .form-label, .label, [class*="label"]'
        );
        for (const cell of cells) {
            const text = (cell.innerText || cell.textContent || '').replace(/\s/g, '');
            if (!text.includes(normalized)) continue;

            // 同じ tr 内の input
            const tr = cell.closest('tr');
            if (tr) {
                const inp = tr.querySelector(
                    'input[type="text"], ' +
                    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
                    ':not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"])'
                );
                if (inp) return inp;
            }

            // 次の兄弟要素内の input
            let sib = cell.nextElementSibling;
            while (sib) {
                const inp = sib.querySelector?.('input[type="text"], input:not([type="hidden"]), textarea') ||
                            (sib.matches?.('input, textarea') ? sib : null);
                if (inp) return inp;
                sib = sib.nextElementSibling;
            }
        }
        return null;
    }

    // ── テキストでボタンを探す（モーダル内を優先）──
    function findBtn(text) {
        const all = [...document.querySelectorAll(
            'button, input[type="button"], input[type="submit"], a.btn, a[class*="btn"]'
        )];
        const matched = all.filter(el =>
            (el.textContent || el.value || '').trim().includes(text) &&
            el.offsetParent !== null   // visible check
        );
        // モーダル内のボタンを優先
        for (const el of matched) {
            if (el.closest(
                '.modal, .modal-content, .overlay, .dialog, [role="dialog"], ' +
                '[class*="modal"], [class*="overlay"], [class*="popup"]'
            )) return el;
        }
        return matched[matched.length - 1] || null;
    }

    // =====================================================================
    // エラー行（赤背景）の検出
    // =====================================================================
    function isRed(colorStr) {
        const m = (colorStr || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        return r > 150 && g < 120 && b < 120 && (r - g) > 50 && (r - b) > 50;
    }

    function findErrorEditButtons() {
        const result = [];
        for (const tr of document.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('td')];
            if (!cells.length) continue;

            const rowRed   = isRed(getComputedStyle(tr).backgroundColor);
            const cellRed  = cells.some(td =>
                isRed(getComputedStyle(td).backgroundColor) ||
                isRed(td.style.backgroundColor)
            );
            const classRed = /error|danger|red|invalid/i.test(tr.className + ' ' + tr.id);

            if (!(rowRed || cellRed || classRed)) continue;

            const btn = [...tr.querySelectorAll('button, a, input[type="button"]')]
                .find(b => (b.textContent || b.value || '').includes('編集'));
            if (btn) result.push(btn);
        }
        return result;
    }

    // =====================================================================
    // テーブルのスクロールコンテナを探す
    // =====================================================================
    function findTableScrollContainer() {
        // テーブル要素を起点に、overflow: scroll/auto の祖先を探す
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            let el = table.parentElement;
            while (el && el !== document.body && el !== document.documentElement) {
                const st = getComputedStyle(el);
                if (st.overflowY === 'scroll' || st.overflowY === 'auto') {
                    // スクロール可能な高さがあるか確認
                    if (el.scrollHeight > el.clientHeight + 10) return el;
                }
                el = el.parentElement;
            }
        }
        // フォールバック: ページ自体をスクロール
        return document.documentElement.scrollHeight > document.documentElement.clientHeight + 10
            ? document.documentElement
            : null;
    }

    // =====================================================================
    // スクロールしながら最初の赤行の編集ボタンを探す
    // =====================================================================
    async function findFirstErrorWithScroll() {
        const container = findTableScrollContainer();

        // コンテナが見つからない or スクロール不要 → DOM全体を直接検索
        if (!container) {
            const btns = findErrorEditButtons();
            return btns[0] || null;
        }

        // 先頭に戻ってからスキャン開始
        container.scrollTop = 0;
        await sleep(400);

        while (true) {
            const btns = findErrorEditButtons();
            if (btns.length > 0) {
                // 見つかったボタンをビューに収める
                btns[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
                await sleep(400);
                return btns[0];
            }

            // 1画面分スクロールダウン
            const prev = container.scrollTop;
            container.scrollTop += Math.max(container.clientHeight * 0.8, 200);
            await sleep(400);

            // これ以上スクロールできなければ終了
            if (container.scrollTop <= prev) break;
        }

        return null;
    }

    // =====================================================================
    // native alert / confirm のインターセプト
    // =====================================================================
    let autoOK = false;
    const _confirm = window.confirm.bind(window);
    const _alert   = window.alert.bind(window);
    window.confirm = (...a) => {
        if (autoOK) { console.log('[YamatoFix] confirm → OK:', ...a); return true; }
        return _confirm(...a);
    };
    window.alert = (...a) => {
        if (autoOK) { console.log('[YamatoFix] alert → OK:', ...a); return; }
        return _alert(...a);
    };

    // =====================================================================
    // 1行分の修正処理
    // =====================================================================
    async function processRow(editBtn) {
        editBtn.click();
        await sleep(1800);

        const machiInput = findInputByLabel('町・番地');
        if (!machiInput) throw new Error('町・番地フィールドが見つかりません');

        const addr = machiInput.value;
        if (fwLen(addr) <= LIMIT.machi) {
            throw new Error(`町・番地は制限内（別のエラー？）: "${addr}"`);
        }

        // 番地部分とマンション名部分に分割
        const [street, building] = splitAtBuilding(addr);
        console.log('[YamatoFix] 分割結果:', { street, building });

        if (fwLen(street) > LIMIT.machi) {
            throw new Error(`番地部分だけで16文字超（自動修正不可）: "${street}"`);
        }

        // 町・番地 をセット
        setVal(machiInput, street);

        let rem = building;

        // マンション・ビル名（最大16文字）
        if (rem) {
            const inp = findInputByLabel('マンション・ビル名') ||
                        findInputByLabel('マンション') ||
                        findInputByLabel('ビル名');
            if (!inp) throw new Error('マンション・ビル名フィールドが見つかりません');
            const [val, rest] = fwSplit(rem, LIMIT.mansion);
            setVal(inp, val);
            rem = rest;
        }

        // 会社・部門１（最大25文字）
        if (rem) {
            const inp = findInputByLabel('会社・部門１') ||
                        findInputByLabel('会社・部門1');
            if (!inp) throw new Error('会社・部門１フィールドが見つかりません');
            const [val, rest] = fwSplit(rem, LIMIT.kaisha1);
            setVal(inp, val);
            rem = rest;
        }

        // 会社・部門２（最大25文字）
        if (rem) {
            const inp = findInputByLabel('会社・部門２') ||
                        findInputByLabel('会社・部門2');
            if (!inp) throw new Error('会社・部門２フィールドが見つかりません');
            const [val, rest] = fwSplit(rem, LIMIT.kaisha2);
            setVal(inp, val);
            rem = rest;
        }

        if (rem) {
            throw new Error(`全フィールドに収まりません（残り: "${rem}"）`);
        }

        await sleep(600);

        // 更新ボタンをクリック
        const updateBtn = findBtn('更新');
        if (!updateBtn) throw new Error('更新ボタンが見つかりません');

        autoOK = true;
        updateBtn.click();
        // confirm（よろしいですか？）と alert（更新しました）を自動OK
        await sleep(3500);
        autoOK = false;
    }

    // =====================================================================
    // エラー時：閉じるボタンでスキップ
    // =====================================================================
    async function tryClose() {
        autoOK = true;
        const btn = findBtn('閉じる');
        if (btn) {
            btn.click();
            await sleep(1500);
        }
        autoOK = false;
        await sleep(600);
    }

    // =====================================================================
    // ステータス表示
    // =====================================================================
    function showStatus(html, bg = '#2c3e50') {
        let el = document.getElementById('yf-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'yf-status';
            Object.assign(el.style, {
                position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
                padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
                color: '#fff', lineHeight: '1.7', maxWidth: '300px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontFamily: 'sans-serif',
                whiteSpace: 'pre-line',
            });
            document.body.appendChild(el);
        }
        el.style.background = bg;
        el.innerHTML = html;
    }

    // =====================================================================
    // メインループ
    // =====================================================================
    async function run() {
        let fixed = 0, skipped = 0;

        while (true) {
            showStatus(
                `🔍 エラー行を探しています...<br>` +
                `修正済: <b>${fixed}</b> 件 ／ スキップ: <b>${skipped}</b> 件`
            );

            // スクロールしながら最初のエラー行を探す
            const editBtn = await findFirstErrorWithScroll();
            if (!editBtn) break;

            showStatus(
                `🔄 処理中...<br>` +
                `修正済: <b>${fixed}</b> 件 ／ スキップ: <b>${skipped}</b> 件`
            );

            try {
                await processRow(editBtn);
                fixed++;
                console.log(`[YamatoFix] 修正完了 (合計 ${fixed} 件)`);
            } catch (err) {
                console.warn('[YamatoFix] スキップ:', err.message);
                skipped++;
                await tryClose();
            }

            await sleep(1500);
        }

        const allDone = skipped === 0;
        showStatus(
            `✅ 処理完了！<br>` +
            `修正: <b>${fixed}</b> 件 ／ スキップ: <b>${skipped}</b> 件` +
            (skipped > 0 ? '<br><small>スキップされた行は手動で確認してください。</small>' : ''),
            allDone ? '#27ae60' : '#c0392b'
        );
    }

    // =====================================================================
    // 起動ボタンを追加（対象ページのみ）
    // =====================================================================
    function isTargetPage() {
        const body = document.body?.textContent || '';
        return body.includes('修正必要件数') || body.includes('取込み結果');
    }

    function addStartButton() {
        if (!isTargetPage()) return;

        const btn = document.createElement('button');
        btn.id = 'yf-start';
        btn.textContent = '🚀 エラー自動修正';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '60px', right: '10px', zIndex: '2147483647',
            background: '#27ae60', color: '#fff', border: 'none',
            padding: '10px 18px', borderRadius: '8px', cursor: 'pointer',
            fontSize: '14px', fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
        });

        btn.onclick = () => {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '処理中...';
            run().finally(() => {
                btn.disabled = false;
                btn.textContent = '🚀 エラー自動修正';
            });
        };

        document.body.appendChild(btn);
    }

    // DOM 準備完了後に実行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addStartButton);
    } else {
        // ページ遷移後に再チェックするための MutationObserver
        addStartButton();
        new MutationObserver(() => {
            if (!document.getElementById('yf-start') && isTargetPage()) {
                addStartButton();
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

})();
