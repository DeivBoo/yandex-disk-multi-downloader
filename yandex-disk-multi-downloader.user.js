// ==UserScript==
// @name         Yandex Disk Multi-Downloader (Smart Edition)
// @namespace    https://github.com/DeivBoo/yandex-disk-multi-downloader
// @version      1.0.1
// @description  Автоматически скачивает все файлы из открытой папки на Яндекс.Диске (с обходом ленивой загрузки)
// @author       Advenitille, DeivBoo
// @match        https://disk.yandex.ru/d/*
// @match        https://disk.yandex.ru/client/*
// @icon         https://yastatic.net/s3/psf/disk-public/_/9e088280d5e5ab14.png
// @grant        GM_info
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/DeivBoo/yandex-disk-multi-downloader/main/yandex-disk-multi-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/DeivBoo/yandex-disk-multi-downloader/main/yandex-disk-multi-downloader.user.js
// @supportURL   https://github.com/DeivBoo/yandex-disk-multi-downloader/issues
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    console.log('[Yandex Disk Downloader] запущен');

    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    const CONFIG = {
        DELAY_BETWEEN_FILES: 700,    // Пауза между файлами (мс)
        DELAY_AFTER_SCROLL:  1000,   // Пауза после скролла
        DELAY_CLICK_WAIT:    150,    // Пауза после клика по строке
        DELAY_BEFORE_START:  400,    // Пауза перед стартом
        MAX_WAIT_FOR_BUTTON: 2500,   // Макс. ожидание кнопки «Скачать»
        MAX_WAIT_FOR_NAME:   1200,   // Макс. ожидание правильного имени в action bar
        SCROLL_STEP:         700,    // Шаг скролла (px)
        MAX_RETRIES:         3,      // Попытки клика по «Скачать»
        MAX_EMPTY_SCROLLS:   10      // Лимит пустых скроллов подряд
    };

    let isRunning = false;
    let stopRequested = false;
    let abortController = null;

    function sleep(ms) {
        return new Promise((resolve, reject) => {
            if (stopRequested) return reject(new Error('aborted'));
            let timer = null;
            const onAbort = () => {
                if (timer) clearTimeout(timer);
                reject(new Error('aborted'));
            };
            if (abortController) {
                if (abortController.signal.aborted) return onAbort();
                abortController.signal.addEventListener('abort', onAbort, { once: true });
            }
            timer = setTimeout(() => {
                if (abortController) abortController.signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
        });
    }

    function createDownloadButton() {
        if (document.getElementById('tm-download-all-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'tm-download-all-btn';
        btn.innerText = '⚡ Скачать все файлы';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '999999',
            padding: '14px 22px', backgroundColor: '#ffcc00', color: '#000',
            border: '2px solid #000', borderRadius: '8px', fontWeight: 'bold',
            cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
            fontFamily: 'system-ui, sans-serif', fontSize: '14px',
            transition: 'background-color 0.2s, opacity 0.2s'
        });
        btn.addEventListener('click', handleButtonClick);
        document.body.appendChild(btn);
    }

    function updateButtonUI(state, text) {
        const btn = document.getElementById('tm-download-all-btn');
        if (!btn) return;
        if (state === 'running') {
            btn.innerText = text || '🛑 Остановить';
            btn.style.backgroundColor = '#ff5c5c';
            btn.style.color = '#fff';
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
        } else if (state === 'stopping') {
            btn.innerText = text || '⏳ Остановка...';
            btn.style.backgroundColor = '#999999';
            btn.style.color = '#fff';
            btn.disabled = true;
            btn.style.cursor = 'wait';
            btn.style.opacity = '0.85';
        } else {
            btn.innerText = '⚡ Скачать все файлы';
            btn.style.backgroundColor = '#ffcc00';
            btn.style.color = '#000';
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
        }
    }

    function handleButtonClick() {
        if (isRunning) {
            stopRequested = true;
            if (abortController) abortController.abort();
            updateButtonUI('stopping');
        } else {
            if (!confirm('Начать автоматическое скачивание всех файлов в этой папке?\n\nПримечание: Разрешите браузеру скачивание нескольких файлов, если появится запрос.')) return;
            startDownload();
        }
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function simulateFullClick(element) {
        if (!element) return false;
        try {
            const rect = element.getBoundingClientRect();
            const config = {
                bubbles: true, cancelable: true, view: pageWindow,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
                button: 0, buttons: 1
            };
            element.dispatchEvent(new PointerEvent('pointerdown', config));
            element.dispatchEvent(new MouseEvent('mousedown', config));
            element.dispatchEvent(new PointerEvent('pointerup', config));
            element.dispatchEvent(new MouseEvent('mouseup', config));
            element.click();
            return true;
        } catch (e) {
            try { element.click(); return true; } catch (e2) { return false; }
        }
    }

    function normalizeName(name) {
        if (!name) return '';
        return name.replace(/\s+/g, ' ').trim();
    }

    function getFileName(row) {
        const titleEl = row.querySelector('[data-testid="listing-item-title"], [class*="listing-item__title"]');
        if (!titleEl) return null;
        return normalizeName(titleEl.getAttribute('aria-label') || titleEl.textContent);
    }

    function getFileKey(row) {
        const name = getFileName(row);
        if (!name) return null;
        const sizeEl = row.querySelector('[data-testid="listing-item-column-size"], [class*="column-size"]');
        const dateEl = row.querySelector('[data-testid="listing-item-column-date"], [class*="column-date"]');
        const timeEl = row.querySelector('[data-testid="listing-item-column-time"], [class*="column-time"]');
        return `${name}::${sizeEl?.textContent?.trim() || ''}::${dateEl?.textContent?.trim() || ''}::${timeEl?.textContent?.trim() || ''}`;
    }

    function getFileRows() {
        return Array.from(document.querySelectorAll('.listing-item_type_file, [class*="listing-item_type_file"]'));
    }

    function getActionBarFileName() {
        const el = document.querySelector('.resources-info-dropdown__name');
        if (!el) return null;
        const clamped = el.querySelector('.clamped-text');
        if (clamped && clamped.getAttribute('title')) {
            return normalizeName(clamped.getAttribute('title'));
        }
        return normalizeName(el.getAttribute('title') || el.textContent);
    }

    function findDownloadButton() {
        let btn = document.querySelector('button[aria-label="Скачать"]');
        if (isElementVisible(btn)) return btn;

        btn = document.querySelector('.groupable-buttons__visible-button_name_download');
        if (isElementVisible(btn)) return btn;

        btn = document.querySelector('.resources-action-bar .download-button');
        if (isElementVisible(btn)) return btn;

        return null;
    }

    function getScrollContainer() {
        const candidates = [
            document.querySelector('[data-testid="listing-items"]'),
            document.querySelector('.listing__items'),
            document.querySelector('.folder-content'),
            document.querySelector('.public__main'),
            document.querySelector('.content')
        ];
        for (const c of candidates) {
            if (c && c.scrollHeight > c.clientHeight + 20) return c;
        }
        return null;
    }

    function scrollDown() {
        const container = getScrollContainer();
        if (container) container.scrollTop += CONFIG.SCROLL_STEP;
        else window.scrollBy(0, CONFIG.SCROLL_STEP);
    }

    function isAtBottom() {
        const container = getScrollContainer();
        if (container) return container.scrollTop + container.clientHeight >= container.scrollHeight - 30;
        if (document.body.scrollHeight > window.innerHeight) {
            return (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 150);
        }
        return false;
    }

    function isRowSelected(row) {
        return row.getAttribute('aria-selected') === 'true';
    }

    async function startDownload() {
        isRunning = true;
        stopRequested = false;
        abortController = new AbortController();
        updateButtonUI('running');

        const processedKeys = new Set();
        const startUrl = window.location.href;
        let filesCount = 0;
        let skippedCount = 0;
        let emptyScrolls = 0;

        try {
            await sleep(CONFIG.DELAY_BEFORE_START);
            const initialRows = getFileRows();
            console.log(`[Yandex Disk Downloader] Файлов на странице при старте: ${initialRows.length}`);

            if (initialRows.length === 0) {
                alert('Файлы не найдены на странице.\nУбедитесь, что папка загружена и содержит файлы.');
                return;
            }

            while (!stopRequested) {
                if (window.location.href !== startUrl) {
                    console.warn('[Yandex Disk Downloader] Обнаружена смена URL. Останавливаюсь.');
                    break;
                }

                const rows = getFileRows();
                let nextRow = null;
                let nextKey = null;

                for (const row of rows) {
                    const key = getFileKey(row);
                    if (key && !processedKeys.has(key)) {
                        nextRow = row;
                        nextKey = key;
                        break;
                    }
                }

                if (!nextRow) {
                    if (isAtBottom()) {
                        await sleep(800);
                        const lateNew = getFileRows().some(r => {
                            const k = getFileKey(r);
                            return k && !processedKeys.has(k);
                        });
                        if (!lateNew) {
                            console.log('[Yandex Disk Downloader] Достигнут конец списка.');
                            break;
                        }
                        continue;
                    }
                    scrollDown();
                    await sleep(CONFIG.DELAY_AFTER_SCROLL);
                    emptyScrolls++;
                    if (emptyScrolls >= CONFIG.MAX_EMPTY_SCROLLS) {
                        console.warn(`[Yandex Disk Downloader] ${CONFIG.MAX_EMPTY_SCROLLS} пустых скроллов. Останавливаюсь.`);
                        break;
                    }
                    continue;
                }

                emptyScrolls = 0;
                const fileName = getFileName(nextRow) || 'файл';
                processedKeys.add(nextKey);
                filesCount++;

                updateButtonUI('running', `⚡ [${filesCount}] ${fileName.slice(0, 22)}...`);
                nextRow.scrollIntoView({ block: 'center', behavior: 'auto' });
                await sleep(CONFIG.DELAY_CLICK_WAIT);

                if (!isRowSelected(nextRow)) {
                    simulateFullClick(nextRow);
                    for (let i = 0; i < 10; i++) {
                        if (isRowSelected(nextRow)) break;
                        await sleep(100);
                    }
                }

                let downloadBtn = null;
                const btnSteps = Math.ceil(CONFIG.MAX_WAIT_FOR_BUTTON / 100);
                for (let i = 0; i < btnSteps && !stopRequested; i++) {
                    downloadBtn = findDownloadButton();
                    if (downloadBtn) break;
                    await sleep(100);
                }

                let nameConfirmed = false;
                let shownName = '';
                if (downloadBtn) {
                    const nameSteps = Math.ceil(CONFIG.MAX_WAIT_FOR_NAME / 100);
                    for (let i = 0; i < nameSteps && !stopRequested; i++) {
                        shownName = getActionBarFileName();
                        if (shownName === fileName) { nameConfirmed = true; break; }
                        await sleep(100);
                    }
                }

                if (downloadBtn && nameConfirmed) {
                    console.log(`[Yandex Disk Downloader] Клик "Скачать" для: ${fileName}`);
                    let clicked = false;
                    for (let attempt = 0; attempt < CONFIG.MAX_RETRIES && !clicked && !stopRequested; attempt++) {
                        clicked = simulateFullClick(downloadBtn);
                        if (!clicked) {
                            await sleep(200);
                            downloadBtn = findDownloadButton();
                            if (!downloadBtn) break;
                        }
                    }
                    if (!clicked) {
                        console.warn(`[Yandex Disk Downloader] Не удалось кликнуть «Скачать» для "${fileName}"`);
                        skippedCount++;
                    }
                } else if (!downloadBtn) {
                    console.warn(`[Yandex Disk Downloader] Кнопка «Скачать» не появилась для "${fileName}"`);
                    skippedCount++;
                } else {
                    console.warn(`[Yandex Disk Downloader] Имя не подтверждено. В панели: "${shownName}", Ожидалось: "${fileName}". Пропуск.`);
                    skippedCount++;
                }

                await sleep(CONFIG.DELAY_BETWEEN_FILES);
            }

            if (stopRequested) {
                console.log(`[Yandex Disk Downloader] Остановлено. Обработано: ${filesCount}, пропущено: ${skippedCount}`);
            } else {
                let msg = `Готово! Обработано файлов: ${filesCount}.`;
                if (skippedCount > 0) msg += `\nПропущено: ${skippedCount}.`;
                msg += `\n\nВАЖНО: Проверьте папку «Загрузки».`;
                alert(msg);
            }
        } catch (e) {
            if (e.message === 'aborted') {
                console.log('[Yandex Disk Downloader] Прервано пользователем.');
            } else {
                console.error('[Yandex Disk Downloader] Ошибка:', e);
                alert('Произошла ошибка. Откройте консоль (F12) для деталей.');
            }
        } finally {
            isRunning = false;
            abortController = null;
            updateButtonUI('idle');
        }
    }

    function init() {
        createDownloadButton();
        let lastUrl = window.location.href;
        setInterval(() => {
            if (document.body && !document.getElementById('tm-download-all-btn')) createDownloadButton();
            const url = window.location.href;
            if (url !== lastUrl) {
                console.log(`[Yandex Disk Downloader] URL changed: ${lastUrl} -> ${url}`);
                lastUrl = url;
                if (isRunning) {
                    stopRequested = true;
                    if (abortController) abortController.abort();
                    updateButtonUI('stopping');
                }
            }
        }, 1500);
    }

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();