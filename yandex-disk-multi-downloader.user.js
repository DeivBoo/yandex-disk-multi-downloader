// ==UserScript==
// @name         Yandex Disk Multi-Downloader (Smart Edition)
// @namespace    https://github.com/DeivBoo/yandex-disk-multi-downloader
// @version      1.0.0
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

    console.log('[Yandex Disk Downloader] v1.0.0 запущен');

    // Окно страницы: при наличии sandbox-изоляции (любой @grant) используем unsafeWindow
    // для корректной диспетчеризации событий (свойство view). Иначе — обычный window.
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ==========================================
    // ⚙️ НАСТРОЙКИ
    // ==========================================
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

    // ==========================================
    // 🛠 СОСТОЯНИЕ
    // ==========================================
    let isRunning = false;
    let stopRequested = false;
    let abortController = null;

    // ==========================================
    // 💤 Отменяемый sleep
    // ==========================================
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
                if (abortController) {
                    abortController.signal.removeEventListener('abort', onAbort);
                }
                resolve();
            }, ms);
        });
    }

    // ==========================================
    // 🖱️ UI
    // ==========================================
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

    // ==========================================
    // 🧠 УТИЛИТЫ DOM
    // ==========================================
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
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
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

    function getFileName(row) {
        const titleEl = row.querySelector('[data-testid="listing-item-title"]');
        if (!titleEl) return null;
        return titleEl.getAttribute('aria-label') || titleEl.textContent.trim();
    }

    // Уникальный ключ: имя + размер + дата + длительность (защита от дубликатов)
    function getFileKey(row) {
        const name = getFileName(row);
        if (!name) return null;
        const size = (row.querySelector('[data-testid="listing-item-column-size"]')  || {}).textContent || '';
        const date = (row.querySelector('[data-testid="listing-item-column-date"]')  || {}).textContent || '';
        const time = (row.querySelector('[data-testid="listing-item-column-time"]')  || {}).textContent || '';
        return `${name}::${size.trim()}::${date.trim()}::${time.trim()}`;
    }

    function getFileRows() {
        return Array.from(document.querySelectorAll('.listing-item_type_file'));
    }

    function getActionBarFileName() {
        const el = document.querySelector('.resources-info-dropdown__name');
        return el ? el.textContent.trim() : null;
    }

    // Поиск кнопки «Скачать» (именно в панели действий, не «Скачать всё»)
    function findDownloadButton() {
        // 1. Action bar (наиболее точный селектор)
        let btn = document.querySelector('.resources-action-bar .download-button');
        if (isElementVisible(btn)) return btn;

        // 2. Класс download-button + точный текст «Скачать»
        for (const b of document.querySelectorAll('button.download-button')) {
            if (b.textContent.trim() === 'Скачать' && isElementVisible(b)) return b;
        }

        // 3. Scoped fallback: только внутри action bar (не по всей странице)
        const actionBar = document.querySelector('.resources-action-bar');
        if (actionBar) {
            for (const b of actionBar.querySelectorAll('button, [role="button"]')) {
                if (b.textContent.trim() === 'Скачать' && isElementVisible(b)) return b;
            }
        }
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
            if (!c) continue;
            const style = window.getComputedStyle(c);
            const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll');
            if (scrollable && c.scrollHeight > c.clientHeight + 20) return c;
        }
        return null;
    }

    function scrollDown() {
        const container = getScrollContainer();
        if (container) {
            container.scrollTop += CONFIG.SCROLL_STEP;
        } else {
            window.scrollBy(0, CONFIG.SCROLL_STEP);
        }
    }

    function isAtBottom() {
        const container = getScrollContainer();
        if (container) {
            return container.scrollTop + container.clientHeight >= container.scrollHeight - 30;
        }
        return (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 150);
    }

    function isRowSelected(row) {
        return row.getAttribute('aria-selected') === 'true';
    }

    // ==========================================
    // 🚀 ОСНОВНАЯ ЛОГИКА
    // ==========================================
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
            console.log(`[Yandex Disk Downloader] Файлов на странице: ${initialRows.length}`);

            if (initialRows.length === 0) {
                alert('Файлы не найдены на странице.\nУбедитесь, что папка загружена и содержит файлы.');
                return;
            }

            while (!stopRequested) {
                // Проверка SPA-навигации
                if (window.location.href !== startUrl) {
                    console.warn('[Yandex Disk Downloader] Обнаружена смена URL. Останавливаюсь.');
                    alert('Страница была изменена. Скачивание остановлено.');
                    break;
                }

                // Ищем следующий необработанный файл
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

                // ─── Ветка скролла ───────────────────────────────
                if (!nextRow) {
                    // Проверяем «дно» до скролла
                    if (isAtBottom()) {
                        // Даём шанс ленивой загрузке «догрузить» хвост
                        await sleep(600);
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
                        console.warn(`[Yandex Disk Downloader] ${CONFIG.MAX_EMPTY_SCROLLS} пустых скроллов подряд. Останавливаюсь.`);
                        break;
                    }
                    continue;
                }

                // Нашли файл — сбрасываем счётчик пустых скроллов
                emptyScrolls = 0;

                // ─── Обработка файла ─────────────────────────────
                const fileName = getFileName(nextRow) || 'файл';
                processedKeys.add(nextKey);
                filesCount++;

                updateButtonUI('running', `⚡ [${filesCount}] ${fileName.slice(0, 22)}...`);

                nextRow.scrollIntoView({ block: 'center', behavior: 'auto' });
                await sleep(CONFIG.DELAY_CLICK_WAIT);

                // Выделяем строку только если ещё не выделена
                if (!isRowSelected(nextRow)) {
                    simulateFullClick(nextRow);
                    await sleep(CONFIG.DELAY_CLICK_WAIT);
                }

                // Ждём появления кнопки «Скачать»
                let downloadBtn = null;
                const btnSteps = Math.ceil(CONFIG.MAX_WAIT_FOR_BUTTON / 100);
                for (let i = 0; i < btnSteps && !stopRequested; i++) {
                    downloadBtn = findDownloadButton();
                    if (downloadBtn) break;
                    await sleep(100);
                }

                // ⚠️ КРИТИЧНО: дожидаемся, пока action bar покажет ИМЕННО наш файл
                // Без подтверждения имени кликать нельзя — иначе скачается предыдущий файл.
                let nameConfirmed = false;
                if (downloadBtn) {
                    const nameSteps = Math.ceil(CONFIG.MAX_WAIT_FOR_NAME / 100);
                    for (let i = 0; i < nameSteps && !stopRequested; i++) {
                        const shown = getActionBarFileName();
                        if (shown === fileName) { nameConfirmed = true; break; }
                        await sleep(100);
                    }
                }

                // Клик только при подтверждённом имени
                if (downloadBtn && nameConfirmed) {
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
                    console.warn(`[Yandex Disk Downloader] Файл "${fileName}" не подтверждён в action bar — пропуск (защита от скачивания не того файла)`);
                    skippedCount++;
                }

                await sleep(CONFIG.DELAY_BETWEEN_FILES);
            }

            // Итог
            if (stopRequested) {
                console.log(`[Yandex Disk Downloader] Остановлено. Обработано: ${filesCount}, пропущено: ${skippedCount}`);
            } else {
                let msg = `Готово! Обработано файлов: ${filesCount}.`;
                if (skippedCount > 0) msg += `\nПропущено (кнопка/имя не подтверждены): ${skippedCount}.`;
                msg += `\nПроверьте папку «Загрузки».`;
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

    // ==========================================
    // 🔧 ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    function init() {
        createDownloadButton();

        let lastUrl = window.location.href;
        // Единый интервал: восстановление кнопки + детект SPA-навигации
        setInterval(() => {
            if (document.body && !document.getElementById('tm-download-all-btn')) {
                createDownloadButton();
            }
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

    if (document.body) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();