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

    // ── タイミング設定（ms）──
    const TIMING = {
        waitForTimeout:   2500,  // waitFor の最大待機時間
        waitForPoll:       300,  // waitFor のポーリング間隔
        beforeUpdate:      600,  // 更新ボタンクリック前の待機
        afterUpdate:      1500,  // 更新ボタンクリック後の待機（confirm + alert を自動OK する余裕）
        afterClose:       1500,  // 閉じるボタンクリック後の待機
        afterCloseExtra:   600,  // tryClose 完了後の追加待機
        scrollReset:       400,  // スクロールリセット後の待機
        scrollStep:        350,  // スクロール1ステップ後の待機
        afterRow:          800,  // 1行処理完了後の待機
    };

    // ── スクロール設定 ──
    const SCROLL = {
        stepRatio:  0.6,   // 1回のスクロール量（ビューポート高さに対する割合）
        stepMinPx:   80,   // 1回のスクロール最小量（px）
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

    // iframe 内の要素にも対応：ownerDocument の window プロトタイプを使う
    function setVal(input, val) {
        if (!input) return;
        const win = input.ownerDocument.defaultView || window;
        const proto = input.tagName === 'TEXTAREA'
            ? win.HTMLTextAreaElement.prototype
            : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, val);
        ['input', 'change', 'blur'].forEach(t =>
            input.dispatchEvent(new Event(t, { bubbles: true }))
        );
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function sleepLog(label, ms) {
        console.log(`[YamatoFix] ⏱ 待機: ${label} ${ms}ms`);
        return sleep(ms);
    }

    // ── セレクタが現れるまで最大 timeoutMs 待機（main + 全 iframe を監視）──
    async function waitFor(selector, timeoutMs = TIMING.waitForTimeout) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            // メイン document を確認
            const inMain = document.querySelector(selector);
            if (inMain) return inMain;

            // 全 iframe を確認（readyState チェックなし：loading 中でも要素があれば取得）
            for (const iframe of document.querySelectorAll('iframe')) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (!doc) continue;
                    const el = doc.querySelector(selector);
                    if (el) {
                        console.log('[YamatoFix] iframe 内で要素を検出:', selector);
                        return el;
                    }
                } catch (e) {
                    if (!iframe.__yfErrLogged) {
                        iframe.__yfErrLogged = true;
                        console.warn('[YamatoFix] iframe アクセスエラー:', e.message);
                    }
                }
            }

            await sleepLog('waitForPoll', TIMING.waitForPoll);
        }
        console.warn('[YamatoFix] waitFor タイムアウト:', selector);
        return null;
    }

    // =====================================================================
    // エラー行の編集ボタンを収集
    // hasError クラスを持つ slick-cell を含む slick-row を対象とする
    // =====================================================================
    function findErrorEditButtons(skippedRowTops = new Set()) {
        const result = [];
        const seenRows = new Set();

        for (const cell of document.querySelectorAll('.slick-cell.hasError')) {
            const row = cell.closest('.slick-row');
            if (!row || seenRows.has(row)) continue;
            seenRows.add(row);

            const rowTop = row.style.top;
            if (skippedRowTops.has(rowTop)) continue;

            const btn = row.querySelector('#editSaveIssue');
            if (btn) result.push({ btn, rowTop });
        }
        return result;
    }

    // =====================================================================
    // alert / confirm のインターセプト
    // メインページ＋動的に追加される iframe の両方をパッチ
    // =====================================================================
    let autoOK = false;

    function patchDialogs(win) {
        if (!win || win.__yfPatched) return;
        try {
            win.__yfPatched = true;
            const oc = win.confirm.bind(win);
            const oa = win.alert.bind(win);
            win.confirm = (...a) => {
                if (autoOK) { console.log('[YamatoFix] confirm → OK:', ...a); return true; }
                return oc(...a);
            };
            win.alert = (...a) => {
                if (autoOK) { console.log('[YamatoFix] alert → OK:', ...a); return; }
                return oa(...a);
            };
        } catch (e) { /* cross-origin は無視 */ }
    }

    // メインウィンドウをパッチ
    patchDialogs(window);

    // iframe が追加されたら即パッチ（FancyBox が動的に生成する iframe に対応）
    new MutationObserver(() => {
        document.querySelectorAll('iframe').forEach(iframe => {
            if (iframe.__yfIframePatchStarted) return;
            iframe.__yfIframePatchStarted = true;
            // すでに読み込まれている場合
            try { patchDialogs(iframe.contentWindow); } catch (e) {}
            // load イベントでも再パッチ（読み込み完了後に window が確定するため）
            iframe.addEventListener('load', () => {
                try { patchDialogs(iframe.contentWindow); } catch (e) {}
            });
        });
    }).observe(document.body, { childList: true, subtree: true });

    // =====================================================================
    // 1行分の修正処理
    // =====================================================================
    async function processRow(editBtn) {
        editBtn.click();

        const machiInput = await waitFor('#consignee_address03');
        if (!machiInput) throw new Error('フォームが見つかりません（タイムアウト）');

        const mDoc = machiInput.ownerDocument;
        let anyFixed = false;

        // ── お届け先 町・番地（#consignee_address03）──
        if (machiInput.classList.contains('is_error')) {
            const addr = machiInput.value;
            if (fwLen(addr) <= LIMIT.machi) {
                throw new Error(`お届け先 町・番地は制限内（別のエラー？）: "${addr}"`);
            }

            const [street, building] = splitAtBuilding(addr);
            console.log('[YamatoFix] お届け先 分割結果:', { street, building });

            if (fwLen(street) > LIMIT.machi) {
                throw new Error(`お届け先 番地部分だけで16文字超（自動修正不可）: "${street}"`);
            }

            setVal(machiInput, street);
            let rem = building;

            if (rem) {
                const inp = mDoc.getElementById('consignee_address04');
                if (!inp) throw new Error('お届け先 マンション・ビル名フィールドが見つかりません');
                const [val, rest] = fwSplit(rem, LIMIT.mansion);
                setVal(inp, val);
                rem = rest;
            }
            if (rem) {
                const inp = mDoc.querySelector('[name="consignee_department1"]');
                if (!inp) throw new Error('お届け先 会社・部門１フィールドが見つかりません');
                const [val, rest] = fwSplit(rem, LIMIT.kaisha1);
                setVal(inp, val);
                rem = rest;
            }
            if (rem) {
                const inp = mDoc.querySelector('[name="consignee_department2"]');
                if (!inp) throw new Error('お届け先 会社・部門２フィールドが見つかりません');
                const [val, rest] = fwSplit(rem, LIMIT.kaisha2);
                setVal(inp, val);
                rem = rest;
            }
            if (rem) throw new Error(`お届け先 全フィールドに収まりません（残り: "${rem}"）`);

            anyFixed = true;
        }

        // ── ご依頼主 町・番地（#shipper_address3）──
        const shipperMachi = mDoc.getElementById('shipper_address3');
        if (shipperMachi && shipperMachi.classList.contains('is_error')) {
            const addr = shipperMachi.value;
            if (fwLen(addr) <= LIMIT.machi) {
                throw new Error(`ご依頼主 町・番地は制限内（別のエラー？）: "${addr}"`);
            }

            const [street, building] = splitAtBuilding(addr);
            console.log('[YamatoFix] ご依頼主 分割結果:', { street, building });

            if (fwLen(street) > LIMIT.machi) {
                throw new Error(`ご依頼主 番地部分だけで16文字超（自動修正不可）: "${street}"`);
            }

            setVal(shipperMachi, street);

            if (building) {
                const inp = mDoc.querySelector('[name="shipper_address4"]');
                if (!inp) throw new Error('ご依頼主 マンション・ビル名フィールドが見つかりません');
                const [val, rest] = fwSplit(building, LIMIT.mansion);
                setVal(inp, val);
                if (rest) throw new Error(`ご依頼主 全フィールドに収まりません（残り: "${rest}"）`);
            }

            anyFixed = true;
        }

        if (!anyFixed) throw new Error('自動修正可能なエラーがありません（is_error なし）');

        await sleepLog('beforeUpdate', TIMING.beforeUpdate);

        // 更新ボタン（id="Edit"）をクリック
        const updateBtn = mDoc.getElementById('Edit');
        if (!updateBtn) throw new Error('更新ボタンが見つかりません（id="Edit"）');

        autoOK = true;
        updateBtn.click();
        // confirm（よろしいですか？）と alert（更新しました）を自動OK
        await sleepLog('afterUpdate', TIMING.afterUpdate);
        autoOK = false;

        // 更新後もモーダルが残っていれば更新失敗と判断 → throw してスキップ処理へ
        if (mDoc.getElementById('Edit')) {
            throw new Error('更新後もモーダルが閉じませんでした（サーバーエラーまたは入力不備）');
        }
    }

    // =====================================================================
    // エラー時：閉じるボタンでスキップ
    // =====================================================================
    async function tryClose() {
        autoOK = true;
        // 閉じるボタン（id="closeWindow1"）を iframe 内から探す
        let closeBtn = null;
        for (const iframe of document.querySelectorAll('iframe')) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) continue;
                closeBtn = doc.getElementById('closeWindow1');
                if (closeBtn) break;
            } catch (e) { /* ignore */ }
        }
        // iframe になければ main document を確認
        if (!closeBtn) closeBtn = document.getElementById('closeWindow1');

        if (closeBtn) {
            closeBtn.click();
            await sleepLog('afterClose', TIMING.afterClose);
        }
        autoOK = false;
        await sleepLog('afterCloseExtra', TIMING.afterCloseExtra);
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
    // SlickGrid スクロール対応：トップから末尾まで走査して赤行を探す
    // =====================================================================

    // SlickGrid のスクロール可能なビューポートを取得
    function getViewport() {
        return (
            document.querySelector('.slick-viewport-top.slick-viewport-right') ||
            document.querySelector('.slick-viewport-top') ||
            document.querySelector('.slick-viewport')
        );
    }

    // ビューポートをトップにリセット
    async function resetScroll() {
        const vp = getViewport();
        if (vp && vp.scrollTop !== 0) {
            vp.scrollTop = 0;
            await sleepLog('scrollReset', TIMING.scrollReset);
        }
    }

    // トップ→末尾へスクロールしながら赤行の編集ボタンを1件返す
    // 見つからなければ null を返す（全件スキャン済み = エラーなし）
    async function scrollAndFindError(skippedRowTops, onScroll) {
        const vp = getViewport();

        // SlickGrid が存在しない場合は現在の DOM だけ検索
        if (!vp) {
            const btns = findErrorEditButtons(skippedRowTops);
            return btns[0] || null;
        }

        // 毎回トップから走査
        vp.scrollTop = 0;
        await sleepLog('scrollReset', TIMING.scrollReset);

        const step = Math.max(SCROLL.stepMinPx, Math.floor(vp.clientHeight * SCROLL.stepRatio));

        while (true) {
            const btns = findErrorEditButtons(skippedRowTops);
            if (btns.length > 0) return btns[0];

            const maxScroll = vp.scrollHeight - vp.clientHeight;
            if (vp.scrollTop >= maxScroll) break;  // 末尾まで到達

            vp.scrollTop = Math.min(vp.scrollTop + step, maxScroll);
            await sleepLog('scrollStep', TIMING.scrollStep);

            if (onScroll) onScroll(vp.scrollTop, maxScroll);
        }

        // 末尾での最終チェック
        const btns = findErrorEditButtons(skippedRowTops);
        return btns[0] || null;
    }

    // =====================================================================
    // メインループ
    // =====================================================================
    async function run() {
        // 修正必要件数を取得してループ上限を決定
        const numEl = document.getElementById('num_of_error');
        const totalCount = numEl ? parseInt(numEl.textContent) : NaN;
        if (isNaN(totalCount)) {
            showStatus('⚠️ 修正必要件数が取得できません', '#e74c3c');
            return;
        }
        if (totalCount === 0) {
            showStatus('✅ 修正が必要な件数は0件です', '#27ae60');
            return;
        }

        let fixed = 0, skipped = 0;
        const skippedRowTops = new Set();  // スキップ済み行の style.top を記録（重複実行防止）

        while (fixed + skipped < totalCount) {
            showStatus(
                `🔍 エラー行を検索中...<br>` +
                `修正済: <b>${fixed}</b> ／ スキップ: <b>${skipped}</b> ／ 合計: <b>${totalCount}</b> 件`
            );

            const found = await scrollAndFindError(skippedRowTops, (pos, max) => {
                const pct = Math.round((pos / max) * 100);
                showStatus(
                    `🔍 スクロール検索中 ${pct}%...<br>` +
                    `修正済: <b>${fixed}</b> ／ スキップ: <b>${skipped}</b> ／ 合計: <b>${totalCount}</b> 件`
                );
            });

            if (!found) break;  // スキップ済み以外のエラー行がなくなった

            const { btn: editBtn, rowTop } = found;

            showStatus(
                `🔄 修正中...<br>` +
                `修正済: <b>${fixed}</b> ／ スキップ: <b>${skipped}</b> ／ 合計: <b>${totalCount}</b> 件`
            );

            try {
                await processRow(editBtn);
                fixed++;
                console.log(`[YamatoFix] 修正完了 (${fixed}/${totalCount})`);
            } catch (err) {
                console.warn('[YamatoFix] スキップ:', err.message);
                skipped++;
                skippedRowTops.add(rowTop);
                await tryClose();
            }

            // 処理後はスクロールをトップに戻してから再スキャン
            await sleepLog('afterRow', TIMING.afterRow);
            await resetScroll();
        }

        const allDone = skipped === 0;
        showStatus(
            `✅ 処理完了！<br>` +
            `修正: <b>${fixed}</b> 件 ／ スキップ: <b>${skipped}</b> 件 ／ 合計: <b>${totalCount}</b> 件` +
            (skipped > 0 ? '<br><small>スキップされた行は手動で確認してください。</small>' : ''),
            allDone ? '#27ae60' : '#c0392b'
        );
    }

    // =====================================================================
    // 起動ボタンを追加（対象ページのみ）
    // =====================================================================
    function isTargetPage() {
        return location.pathname === '/importapi.html';
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
