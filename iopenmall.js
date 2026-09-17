// ==UserScript==
// @name         iOPEN MALL 優惠擷取助手
// @namespace    iopen-judgement-helper
// @version      1.0.0
// @description  商品頁：每張「點我領取」自動領取並記錄結果；結帳頁：讀取系統自動套用的折價／免運券、逐項讀取運送方式運費。不計算。
// @match        *://*.iopenmall.tw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// 用法：可直接貼到 DevTools Console 執行；或存成 DevTools Snippet；或裝進 Tampermonkey（會自動在商品頁／結帳頁啟動）。
(() => {
  'use strict';

  const APP_ID = 'iopen-judgement-helper';
  const VERSION = '1.0.0';
  const STORE_KEY = 'iopenJudgementHelper.v1';
  const SETTINGS_KEY = 'iopenJudgementHelper.settings.v1';
  const FRESH_MS = 10 * 60 * 1000;
  const IS_USERSCRIPT = typeof GM_info !== 'undefined';

  if (window.IOpenJudgementHelper?.destroy) window.IOpenJudgementHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  // ───────────── 規則用文字（全部取自 SOP 投影片） ─────────────
  const CLAIM_RE = /^點我領取\s*[>＞›〉»]?$/;
  const LOGIN_CLAIM_RE = /^登入領取\s*[>＞›〉»]?$/;
  const COUPON_TAG_RE = /^(折價券|免運券|優惠券)$/;
  const MORE_RE = /^(?:more|更多|查看更多|看更多|顯示更多|展開|展開更多)\s*[>＞›〉»+▼▾]?$/i;
  const DISMISS_RE = /^(確認|確定|OK|好|關閉|我知道了)$/i;
  const CLAIM_SUCCESS_RE = /領取成功/;
  const CLAIM_SOLD_OUT_RE = /已發送完畢/;
  const QTY_LIMIT_RE = /最多可購買\s*([\d,]+)\s*件/;
  const AMOUNT_LIMIT_RE = /超過金額上限/;
  const RESTRICT_RE = /超過.{0,20}(?:限制|尺寸|重量)|重量限制|無法使用.{0,12}運送服務/;
  const FOREIGN_CURRENCY_RE = /[¥￥€£₩]|(?:US|HK|S|A|C)\$|\b(?:JPY|USD|CNY|RMB|HKD|KRW|EUR)\b|人民幣|日圓|日幣|韓元|美金|美元|港幣|歐元/;
  const WEIGHT_NOTE = '商品超過便利商店運送方限制尺寸及重量，且無宅配選項';

  // ───────────── 通用工具 ─────────────
  const normalize = (value) => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const flat = (value) => normalize(value).replace(/\s*\n\s*/g, ' ');
  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unique = (items) => [...new Set(items.map(normalize).filter(Boolean))];
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  // innerText（瀏覽器）優先；沒有時以不含 script/style 的遞迴取字備援
  const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  function fallbackText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || NON_TEXT_TAGS.has(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    const view = node.ownerDocument?.defaultView;
    const display = view ? view.getComputedStyle(node).display : 'block';
    if (display === 'none') return '';
    let out = '';
    for (const child of node.childNodes) out += fallbackText(child);
    return /^(inline|inline-block|inline-flex|contents)$/.test(display) ? out : `\n${out}\n`;
  }
  const rawText = (element) => (typeof element?.innerText === 'string'
    ? element.innerText
    : (element?.nodeType === 1 ? fallbackText(element) : (element?.textContent ?? '')));
  const textOf = (element) => normalize(rawText(element));
  const money = (value) => { const match = normalize(value).match(/[\d,]+/); return match ? match[0].replace(/,/g, '') : ''; };

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  async function waitFor(check, timeout = 3500, interval = 100) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function snippet(text, re, radius = 18) {
    const value = flat(text);
    const match = value.match(re);
    if (!match) return '';
    const start = Math.max(0, match.index - radius);
    const end = Math.min(value.length, match.index + match[0].length + radius);
    return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
  }

  // 找「完整文字」符合 fullRe 的元素（例如整顆按鈕文字就是「點我領取 >」）
  function findTextElements(root, keywordRe, fullRe, climb = true) {
    if (!root) return [];
    const found = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!keywordRe.test(node.nodeValue)) continue;
      let element = node.parentElement;
      if (!element || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName)) continue;
      if (!fullRe.test(textOf(element))) continue;
      if (climb) {
        while (element.parentElement && element.parentElement !== root
          && fullRe.test(textOf(element.parentElement))) element = element.parentElement;
      }
      if (isVisible(element)) found.add(element);
    }
    root.querySelectorAll?.('input[type="button"], input[type="submit"]').forEach((input) => {
      if (isVisible(input) && fullRe.test(normalize(input.value))) found.add(input);
    });
    return [...found];
  }

  const clickable = (element) => element.closest('a, button, [role="button"], input, label') || element;

  function rowFor(element, boundary, count, maxLength = 400) {
    let row = element;
    while (row.parentElement && row.parentElement !== boundary && boundary.contains(row.parentElement)) {
      const parent = row.parentElement;
      if (count(parent) > 1) break;
      if (normalize(parent.textContent).length > maxLength) break;
      row = parent;
    }
    return row;
  }

  function commonAncestor(first, second) {
    for (let element = first; element; element = element.parentElement) {
      if (element.contains(second)) return element;
    }
    return null;
  }

  // ───────────── 暫存（商品頁 → 結帳頁） ─────────────
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function saveStore(patch) {
    const next = { ...loadStore(), ...patch };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* 無法寫入時僅本頁有效 */ }
    return next;
  }
  function loadSettings() {
    try { return { autoClaim: true, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch { return { autoClaim: true }; }
  }
  function saveSettings(patch) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch { /* ignore */ }
  }

  // ───────────── 攔截彈窗文字（數量上限／金額上限） ─────────────
  const hookState = { suppress: false, captured: [] };
  const originalDialogs = window.__iopenHelperOriginalDialogs || { alert: window.alert, confirm: window.confirm };
  window.__iopenHelperOriginalDialogs = originalDialogs;

  function inspectMessage(text) {
    const value = flat(text);
    if (!value) return;
    const qty = value.match(QTY_LIMIT_RE);
    const amount = AMOUNT_LIMIT_RE.test(value);
    if (!qty && !amount) return;
    const events = { ...(loadStore().events || {}) };
    if (qty) {
      Object.assign(events, {
        qtyLimit: qty[1].replace(/,/g, ''), qtyLimitText: snippet(value, QTY_LIMIT_RE, 12),
        qtyLimitUrl: location.href, qtyLimitAt: Date.now(),
      });
    }
    if (amount) {
      Object.assign(events, { amountLimitText: snippet(value, AMOUNT_LIMIT_RE, 30), amountLimitUrl: location.href, amountLimitAt: Date.now() });
    }
    saveStore({ events });
    renderEvents?.();
  }

  window.alert = function helperAlert(message) {
    inspectMessage(message);
    hookState.captured.push(flat(message));
    if (hookState.suppress) return undefined;
    return originalDialogs.alert.call(window, message);
  };
  window.confirm = function helperConfirm(message) {
    inspectMessage(message);
    hookState.captured.push(flat(message));
    if (hookState.suppress) return true;
    return originalDialogs.confirm.call(window, message);
  };

  // ───────────── 商品頁：步驟 1 賣場判斷 ─────────────
  function productFacts() {
    const heading = [...document.querySelectorAll('h1')]
      .find((element) => isVisible(element) && textOf(element).length > 4 && !/^iOPEN\s*Mall$/i.test(textOf(element)));
    const buy = findTextElements(document.body, /加入購物車|立即結帳/, /^(加入購物車|立即結帳)$/)[0];
    let block = heading && buy ? commonAncestor(heading, buy) : null;
    if (block && (block === document.body || normalize(block.textContent).length > 3000)) block = null;
    const title = heading ? flat(textOf(heading)) : flat(document.title.replace(/\s*[-|｜]\s*iOPEN\s*Mall.*$/i, ''));
    const blockText = block ? textOf(block) : '';
    const productNo = (blockText || textOf(document.body)).match(/商品編號\s*[:：]\s*([A-Za-z0-9_-]+)/);
    return { title, url: location.href, block, blockText, productNo: productNo ? productNo[1] : '', ...priceFacts(block) };
  }

  function isStruck(element, boundary) {
    for (let current = element; current && current !== boundary; current = current.parentElement) {
      if (['DEL', 'S', 'STRIKE'].includes(current.tagName)) return true;
      if (/line-through/.test(getComputedStyle(current).textDecorationLine || getComputedStyle(current).textDecoration || '')) return true;
    }
    return false;
  }

  function priceFacts(block) {
    if (!block) return { currentPrice: '', originalPrice: '' };
    const PRICE_ONLY = /^(?:NT)?[$＄]?\s*[\d,]+$/;
    const seen = new Set();
    const candidates = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/\d/.test(node.nodeValue)) continue;
      let element = node.parentElement;
      if (!element || !PRICE_ONLY.test(textOf(element))) continue;
      while (element.parentElement && element.parentElement !== block
        && PRICE_ONLY.test(textOf(element.parentElement))) element = element.parentElement;
      if (seen.has(element) || !/[$＄]/.test(textOf(element)) || !isVisible(element)) continue;
      seen.add(element);
      const size = Math.max(...[element, ...element.querySelectorAll('*')]
        .map((item) => parseFloat(getComputedStyle(item).fontSize) || 0));
      candidates.push({ value: money(textOf(element)), struck: isStruck(element, block), size });
    }
    const current = candidates.filter((item) => !item.struck).sort((left, right) => right.size - left.size)[0];
    const original = candidates.find((item) => item.struck);
    return { currentPrice: current?.value || '', originalPrice: original?.value || '' };
  }

  function productExclusions(facts) {
    const reasons = [];
    const reviews = [];
    const scanText = facts.block ? facts.blockText : facts.title;
    if (!facts.block) reviews.push('未定位到商品資訊區，只掃描標題；跨境／預購請人工確認');
    if (/預購/.test(scanText)) reasons.push(`提及「預購」：${snippet(scanText, /預購/)}`);
    const imageAlt = facts.block ? [...facts.block.querySelectorAll('img')]
      .map((image) => `${image.alt || ''} ${image.title || ''}`).join(' ') : '';
    if (!/預購/.test(scanText) && /預購/.test(imageAlt)) reasons.push('商品資訊區圖片標示「預購」');
    if (/跨境/.test(scanText)) reasons.push(`提及「跨境」：${snippet(scanText, /跨境/)}`);
    if (FOREIGN_CURRENCY_RE.test(scanText)) reasons.push(`出現不同貨幣：${snippet(scanText, FOREIGN_CURRENCY_RE)}`);
    return { reasons, reviews };
  }

  // ───────────── 商品頁：步驟 2 領取所有折價券 ─────────────
  function activitySection() {
    const heads = findTextElements(document.body, /本商品適用活動/, /^本商品適用活動$/, false);
    for (const head of heads) {
      let element = head;
      for (let level = 0; level < 8 && element.parentElement && element.parentElement !== document.body; level += 1) {
        element = element.parentElement;
        if (/點我領取|登入領取|折價券|免運券/.test(element.textContent)) return element;
      }
    }
    return null;
  }

  function claimButtons(root) {
    return [
      ...findTextElements(root, /點我領取/, CLAIM_RE).map((element) => ({ el: element, kind: 'claim' })),
      ...findTextElements(root, /登入領取/, LOGIN_CLAIM_RE).map((element) => ({ el: element, kind: 'login' })),
    ];
  }
  const couponTags = (root) => findTextElements(root, /券/, COUPON_TAG_RE);
  const couponUnits = (element) => Math.max(claimButtons(element).length, couponTags(element).length);

  function describeRow(row) {
    const tag = couponTags(row)[0];
    const label = tag ? textOf(tag) : '';
    let summary = flat(textOf(row))
      .replace(/本商品適用活動/g, ' ')
      .replace(/(?:點我領取|登入領取)\s*[>＞›〉»]?/g, ' ');
    if (label) summary = summary.replace(label, ' ');
    return { label, summary: flat(summary) };
  }

  function readProductCouponRows(root) {
    const entries = claimButtons(root).map((button) => ({ row: rowFor(button.el, root, couponUnits), button }));
    for (const tag of couponTags(root)) {
      if (entries.some((entry) => entry.row.contains(tag))) continue;
      const tagRow = rowFor(tag, root, couponUnits);
      const inside = entries.filter((entry) => entry.button && tagRow.contains(entry.button.el));
      if (inside.length === 1) inside[0].row = tagRow;
      else if (inside.length === 0) entries.push({ row: tagRow, button: null });
    }
    return entries.map((entry) => ({ ...entry, ...describeRow(entry.row) }));
  }

  const sameCoupon = (left, right) => Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));

  async function expandMore(root) {
    const reviews = [];
    const clicked = new Set();
    for (let round = 0; round < 5; round += 1) {
      const targets = findTextElements(root, /more|更多|展開/i, MORE_RE)
        .map(clickable).filter((element) => !clicked.has(element));
      if (!targets.length) break;
      for (const target of targets) {
        clicked.add(target);
        const href = target.tagName === 'A' ? (target.getAttribute('href') || '').trim() : '';
        if (href && href !== '#' && !/^javascript:/i.test(href)) {
          reviews.push(`「${textOf(target)}」是另開頁面的連結，未自動點開；請人工點開確認是否有更多折價券`);
          continue;
        }
        target.click();
        await sleep(450);
      }
    }
    return reviews;
  }

  function dismissButtons(root = document.body) {
    return findTextElements(root, /確認|確定|OK|好|關閉|我知道了/i, DISMISS_RE);
  }

  function dialogText(button) {
    const own = textOf(button);
    let element = button;
    for (let level = 0; level < 10 && element.parentElement && element.parentElement !== document.body; level += 1) {
      element = element.parentElement;
      const text = flat(textOf(element));
      if (text.length > 500) break;
      const rest = flat(text.replace(own, ' ').replace(/確認|確定|取消|關閉|OK|我知道了/gi, ' '));
      if (rest.length >= 4) return rest;
    }
    return '';
  }

  const countMatches = (re) => (flat(textOf(document.body)).match(new RegExp(re.source, 'g')) || []).length;

  async function clickAndRead(target) {
    const before = new Set(dismissButtons());
    const successBefore = countMatches(CLAIM_SUCCESS_RE);
    const soldOutBefore = countMatches(CLAIM_SOLD_OUT_RE);
    hookState.captured = [];
    hookState.suppress = true;
    let changedAt = 0;
    let changedText = '';
    try {
      clickable(target).click();
      const started = Date.now();
      let tick = 0;
      while (Date.now() - started < 6000) {
        await sleep(120);
        tick += 1;
        if (hookState.captured.length) return { text: hookState.captured.join(' / '), via: 'alert' };
        const fresh = dismissButtons().find((button) => !before.has(button));
        if (fresh) {
          const text = dialogText(fresh);
          clickable(fresh).click();
          await waitFor(() => !fresh.isConnected || !isVisible(fresh), 2500);
          return { text, via: 'dialog' };
        }
        if (tick % 3 === 0) {
          if (countMatches(CLAIM_SUCCESS_RE) > successBefore) return { text: '折價券領取成功（頁面提示）', via: 'toast' };
          if (countMatches(CLAIM_SOLD_OUT_RE) > soldOutBefore) return { text: '折價券已發送完畢（頁面提示）', via: 'toast' };
        }
        const stillClaim = target.isConnected && CLAIM_RE.test(textOf(target));
        if (!stillClaim && !changedAt) {
          changedAt = Date.now();
          changedText = target.isConnected ? textOf(target) : '';
        }
        if (changedAt && Date.now() - changedAt > 1500) {
          return { text: changedText ? `按鈕變為「${changedText}」` : '按鈕消失', via: 'button' };
        }
      }
      return { text: '', via: 'timeout' };
    } finally {
      hookState.suppress = false;
    }
  }

  function claimStatus(text) {
    if (CLAIM_SUCCESS_RE.test(text)) return { status: 'claimed', reason: '領取成功' };
    if (CLAIM_SOLD_OUT_RE.test(text)) return { status: 'failed', reason: '折價券已發送完畢（領取失敗）' };
    return {
      status: 'review',
      reason: text ? `回應不是 SOP 列出的兩種狀態：${text}` : '點擊後沒有讀到回應訊息，請到會員中心【我的優惠券】確認',
    };
  }

  async function runProduct({ force = false } = {}, onProgress) {
    let store = loadStore();
    if (store.product?.url !== location.href) {
      const events = store.events?.qtyLimitUrl === location.href ? store.events : {};
      store = saveStore({ product: null, checkout: null, events });
    }
    const facts = productFacts();
    const exclusion = productExclusions(facts);
    const product = {
      url: facts.url, title: facts.title, productNo: facts.productNo,
      currentPrice: facts.currentPrice, originalPrice: facts.originalPrice,
      exclusions: exclusion.reasons, reviews: [...exclusion.reviews],
      claimLog: store.product?.url === location.href ? (store.product.claimLog || []) : [],
      savedAt: Date.now(),
    };
    const persist = () => saveStore({ product: { ...product, claimLog: product.claimLog } });

    if (exclusion.reasons.length && !force) {
      product.reviews.push('賣場判定不採用，未執行領券（若判斷有誤，可按「略過賣場排除並領券」）');
      persist();
      return product;
    }

    const section = activitySection();
    const root = section || document.body;
    if (!section) product.reviews.push('找不到「本商品適用活動」區塊，改掃描整頁的「點我領取」；請人工確認');
    else product.reviews.push(...await expandMore(section));

    // 重新整理後遺留的「已點擊但未讀到結果」
    product.claimLog.forEach((entry) => {
      if (entry.status === 'pending') Object.assign(entry, { status: 'review', reason: '點擊後頁面重新載入，未讀到結果；請到會員中心【我的優惠券】確認' });
    });

    const triedElements = new Set();
    for (let guard = 0; guard < 60; guard += 1) {
      const rows = readProductCouponRows(root);
      if (rows.some((row) => row.button?.kind === 'login') && !product.reviews.some((text) => text.includes('未登入'))) {
        product.reviews.push('未登入：頁面顯示「登入領取」，須先登入（可用 LINE 綁定登入）後再執行');
      }
      const next = rows.find((row) => row.button?.kind === 'claim'
        && !triedElements.has(row.button.el)
        && !product.claimLog.some((entry) => sameCoupon(entry.summary, row.summary)));
      if (!next) break;
      triedElements.add(next.button.el);
      const entry = { label: next.label, summary: next.summary, status: 'pending', reason: '', at: Date.now() };
      product.claimLog.push(entry);
      persist();
      onProgress(`領取第 ${product.claimLog.length} 張：${next.summary || next.label}`);
      const response = await clickAndRead(next.button.el);
      Object.assign(entry, { response: response.text }, claimStatus(response.text));
      persist();
      await sleep(500);
    }

    const leftovers = [];
    for (const row of readProductCouponRows(root)) {
      if (product.claimLog.some((entry) => sameCoupon(entry.summary, row.summary))) continue;
      if (row.button?.kind === 'login') leftovers.push({ ...row, status: 'review', reason: '頁面顯示「登入領取」，須登入後領取' });
      else if (row.button?.kind === 'claim') leftovers.push({ ...row, status: 'review', reason: '仍顯示「點我領取」，未完成領取' });
      else leftovers.push({ ...row, status: 'review', reason: '頁面沒有「點我領取」按鈕，無法領取' });
    }
    product.leftovers = leftovers.map(({ label, summary, status, reason }) => ({ label, summary, status, reason }));
    product.reviews = unique(product.reviews);
    persist();
    return product;
  }

  // ───────────── 結帳頁：步驟 5 折價／免運券 ─────────────
  const isCheckoutPage = () => /選擇優惠折抵|選擇運送方式|新增或選擇折價券/.test(textOf(document.body));
  const isProductPage = () => /本商品適用活動/.test(textOf(document.body))
    || findTextElements(document.body, /加入購物車|立即結帳/, /^(加入購物車|立即結帳)$/).length > 0;

  const checkboxCount = (element) => element.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
  const couponDialogTitles = () => findTextElements(document.body, /選擇/, /^選擇.{0,10}折價券$/, false);

  function dialogContainer(title) {
    let element = title;
    while (element.parentElement && element.parentElement !== document.body && element.parentElement !== document.documentElement) {
      const parent = element.parentElement;
      if (/選擇運送方式|選擇優惠折抵|運費小計|總金額/.test(parent.textContent)) break;
      const rect = parent.getBoundingClientRect();
      if (rect.width >= window.innerWidth * 0.98 && rect.height >= window.innerHeight * 0.98) break;
      element = parent;
    }
    return element;
  }

  function isCheckedControl(control) {
    if (control.matches('input')) return control.checked;
    if (control.getAttribute('aria-checked') === 'true') return true;
    return /(^|[\s_-])(checked|is-checked|active|selected)([\s_-]|$)/i.test(String(control.className || ''));
  }

  function sectionLabelFor(row, container) {
    for (let element = row; element && element !== container; element = element.parentElement) {
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        const text = flat(textOf(sibling));
        const match = text.match(/^(免運券|[^\s新增]{0,6}折價券)/);
        if (match && text.length < 40) return match[1];
      }
    }
    return '';
  }

  function couponTitle(row) {
    const lines = rawText(row).split(/\n+/).map(flat).filter(Boolean);
    return lines.find((line) => /[$＄]/.test(line) && !/^(使用方式|有效日期)/.test(line))
      || lines.find((line) => !COUPON_TAG_RE.test(line) && !/^(使用方式|有效日期)/.test(line))
      || flat(textOf(row));
  }

  async function readCheckoutCoupons(onProgress) {
    const OPEN_RE = /^新增或選擇折價券\s*[>＞›〉»]?$/;
    const openerCount = findTextElements(document.body, /新增或選擇折價券/, OPEN_RE).length;
    const result = { items: [], reviews: [] };
    if (!openerCount) {
      result.reviews.push('找不到「新增或選擇折價券」按鈕，折價／免運券請人工確認');
      return result;
    }
    for (let index = 0; index < openerCount; index += 1) {
      const opener = findTextElements(document.body, /新增或選擇折價券/, OPEN_RE)[index];
      if (!opener) break;
      onProgress(`開啟「新增或選擇折價券」${openerCount > 1 ? ` ${index + 1}/${openerCount}` : ''}`);
      const titlesBefore = new Set(couponDialogTitles());
      clickable(opener).click();
      const title = await waitFor(() => couponDialogTitles().find((element) => !titlesBefore.has(element)), 4000);
      if (!title) { result.reviews.push('未能開啟折價券視窗，請人工確認'); continue; }
      await sleep(400);
      const dialog = dialogContainer(title);
      const dialogName = textOf(title);
      const controls = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')];
      if (!controls.length) {
        const leftover = flat(textOf(dialog).replace(dialogName, ' ').replace(/新增折價券|確認|取消|×/g, ' '));
        if (leftover.length > 2) result.reviews.push(`${dialogName}：視窗內有內容但讀不到勾選框，請人工確認（${leftover.slice(0, 80)}）`);
      }
      for (const control of controls) {
        const row = rowFor(control, dialog, checkboxCount, 600);
        const checked = isCheckedControl(control);
        const section = sectionLabelFor(row, dialog);
        result.items.push({
          dialog: dialogName, section, title: couponTitle(row), text: flat(textOf(row)), checked,
          status: checked ? 'usable' : 'review',
          reason: checked ? '結帳頁系統已自動套用（已勾選）' : '結帳頁列出但未勾選，需人工確認是否可選用',
        });
      }
      const anyChecked = controls.some(isCheckedControl);
      const cancel = findTextElements(dialog, /取消/, /^取消$/)[0];
      const confirms = findTextElements(dialog, /確認|確定/, /^(確認|確定)$/);
      let closer = null;
      if (anyChecked && cancel && confirms.length) {
        const cancelTop = cancel.getBoundingClientRect().top;
        closer = confirms.sort((left, right) => Math.abs(left.getBoundingClientRect().top - cancelTop)
          - Math.abs(right.getBoundingClientRect().top - cancelTop))[0];
      } else {
        closer = cancel
          || dialog.querySelector('[aria-label*="close" i], [aria-label*="關閉"], [class*="close" i]')
          || findTextElements(dialog, /[×✕╳]/, /^[×✕╳]$/)[0];
      }
      if (closer) {
        clickable(closer).click();
        await waitFor(() => !title.isConnected || !isVisible(title), 3000);
      } else {
        result.reviews.push(`${dialogName}：找不到關閉按鈕，請手動關閉視窗後再讀運費`);
      }
      await sleep(400);
    }
    return result;
  }

  function checkoutSummary() {
    const text = flat(textOf(document.body));
    const all = (re) => [...text.matchAll(re)].map((match) => match[1].replace(/,/g, ''));
    return {
      itemCount: all(/小計\s*([\d,]+)\s*項/g),
      discount: all(/優惠共折抵\s*-?\s*[$＄]\s*-?\s*([\d,]+)/g),
      openpoint: all(/OPENPOINT\s*共折抵\s*-?\s*[$＄]\s*-?\s*([\d,]+)/gi),
      shipping: all(/運費小計\s*[$＄]\s*([\d,]+)/g),
      total: all(/總金額\s*[$＄]\s*([\d,]+)/g),
    };
  }

  // ───────────── 結帳頁：步驟 6 運費 ─────────────
  function shippingSection() {
    const heads = findTextElements(document.body, /選擇運送方式/, /^選擇運送方式$/, false);
    for (const head of heads) {
      let element = head;
      for (let level = 0; level < 8 && element.parentElement; level += 1) {
        element = element.parentElement;
        if (element.querySelector('input[type="radio"], [role="radio"]')) return element;
      }
    }
    return null;
  }
  const radioCount = (element) => element.querySelectorAll('input[type="radio"], [role="radio"]').length;
  const radiosIn = (root) => [...root.querySelectorAll('input[type="radio"], [role="radio"]')]
    .filter((radio) => isVisible(radio) || [...(radio.labels || [])].some(isVisible) || isVisible(radio.parentElement));
  const isRadioChecked = (radio) => radio.checked === true || radio.getAttribute('aria-checked') === 'true';

  function radioInfo(radio, section, index) {
    const row = rowFor(radio, section, radioCount, 400);
    const lines = rawText(row).split(/\n+/).map(flat).filter(Boolean);
    return {
      name: lines.find((line) => !RESTRICT_RE.test(line)) || `運送方式 ${index + 1}`,
      restriction: lines.filter((line) => RESTRICT_RE.test(line)).join(' '),
    };
  }

  function clickRadio(radio) {
    const label = [...(radio.labels || [])].find(isVisible);
    if (isVisible(radio)) radio.click();
    else if (label) label.click();
    else radio.parentElement?.click();
  }

  function shippingRecords() {
    const checkout = loadStore().checkout || {};
    if (checkout.shippingPath !== location.pathname) return {};
    return Object.fromEntries(Object.entries(checkout.shipping || {}).filter(([, record]) => Date.now() - record.at < FRESH_MS));
  }
  function saveShippingRecord(record) {
    const checkout = loadStore().checkout || {};
    const shipping = checkout.shippingPath === location.pathname ? { ...(checkout.shipping || {}) } : {};
    shipping[record.name] = record;
    saveStore({ checkout: { ...checkout, shippingPath: location.pathname, shipping, pending: null } });
  }

  function readCurrentMethod(section, index, extraMessages = []) {
    const radio = radiosIn(section)[index];
    const info = radioInfo(radio, section, index);
    const fees = checkoutSummary().shipping;
    const alertRestriction = extraMessages.find((text) => RESTRICT_RE.test(text)) || '';
    return {
      name: info.name,
      fee: fees.length === 1 ? fees[0] : '',
      feeRaw: fees.map((fee) => `$${fee}`).join('、'),
      restriction: info.restriction || alertRestriction,
      selected: isRadioChecked(radio),
      at: Date.now(),
    };
  }

  async function scanShipping(onProgress) {
    const section = shippingSection();
    if (!section) return { methods: [], reviews: ['找不到「選擇運送方式」區塊，運費請人工確認'] };
    const reviews = [];
    const count = radiosIn(section).length;
    const checkout = loadStore().checkout || {};
    if (checkout.pending && Date.now() - checkout.pending.at < 120000) {
      const index = radiosIn(section).findIndex(isRadioChecked);
      if (index >= 0) {
        const record = readCurrentMethod(section, index);
        if (record.name === checkout.pending.name) saveShippingRecord(record);
      }
    }
    for (let index = 0; index < count; index += 1) {
      let currentSection = shippingSection();
      const radio = radiosIn(currentSection)[index];
      if (!radio) break;
      const info = radioInfo(radio, currentSection, index);
      if (shippingRecords()[info.name]) continue;
      onProgress(`讀取運費 ${index + 1}/${count}：${info.name}`);
      hookState.captured = [];
      if (!isRadioChecked(radio)) {
        const beforeFees = checkoutSummary().shipping.join('|');
        saveStore({ checkout: { ...(loadStore().checkout || {}), pending: { name: info.name, at: Date.now() } } });
        clickRadio(radio);
        await waitFor(() => checkoutSummary().shipping.join('|') !== beforeFees, 2500);
        await sleep(500);
      }
      currentSection = shippingSection();
      saveShippingRecord(readCurrentMethod(currentSection, index, hookState.captured));
    }
    const methods = Object.values(shippingRecords());
    if (methods.some((method) => method.fee === '' && method.feeRaw.includes('、'))) {
      reviews.push('頁面有多個「運費小計」（購物車可能有多個賣場），請確認後人工填寫運費');
    }
    return { methods, reviews };
  }

  function decideShipping(methods) {
    if (!methods.length) return { value: '', review: true, reason: '未讀到任何運送方式' };
    const missing = methods.filter((method) => !method.restriction && method.fee === '');
    if (missing.length) return { value: '', review: true, reason: `未讀到運費：${missing.map((method) => method.name).join('、')}` };
    const usable = methods.filter((method) => !method.restriction);
    if (usable.length) {
      const lowest = usable.reduce((best, method) => (Number(method.fee) < Number(best.fee) ? method : best));
      const hasRestricted = methods.length > usable.length;
      return {
        value: lowest.fee, method: lowest.name, review: false,
        reason: `${hasRestricted ? '部分運送方式有尺寸／重量限制，採用可直接購買的方式；' : ''}逐項確認後取最低運費：${lowest.name}`,
      };
    }
    return {
      value: '', review: true, note: WEIGHT_NOTE,
      reason: '所有運送方式都出現尺寸／重量限制：依 SOP 以 CP 組數確認該配送方式可下單的最大組數，並備註',
    };
  }

  async function selectMethod(name) {
    const section = shippingSection();
    if (!section) return;
    const radios = radiosIn(section);
    const index = radios.findIndex((radio, position) => radioInfo(radio, section, position).name === name);
    if (index >= 0 && !isRadioChecked(radios[index])) { clickRadio(radios[index]); await sleep(800); }
  }

  function checkoutItem(title) {
    if (!title) return { note: '沒有商品頁暫存（或結帳頁網域不同），商品列價格／數量請人工填寫' };
    const key = flat(title).slice(0, 8);
    const nodes = findTextElements(document.body, new RegExp(escapeRegExp(key.slice(0, 3))), new RegExp(escapeRegExp(key)), false);
    for (const node of nodes) {
      let row = node;
      for (let level = 0; level < 8 && row.parentElement; level += 1) {
        row = row.parentElement;
        const text = flat(textOf(row));
        if (text.length > 1500) break;
        const qtyInput = [...row.querySelectorAll('input')]
          .find((input) => isVisible(input) && !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(input.type) && /^\d+$/.test(input.value));
        const qtyText = text.match(/數量\s*[:：]?\s*(\d+)/) || text.match(/[x×]\s*(\d+)(?!\d)/);
        if (/[$＄]\s*[\d,]+/.test(text) && (qtyInput || qtyText)) {
          return {
            qty: qtyInput ? qtyInput.value : qtyText[1],
            amounts: unique([...text.matchAll(/[$＄]\s*([\d,]+)/g)].map((match) => `$${match[1]}`)),
          };
        }
      }
    }
    return { note: '結帳頁沒有比對到商品列，價格／數量請人工填寫' };
  }

  async function runCheckout({ resume = false } = {}, onProgress) {
    const store = loadStore();
    const flags = [];
    const bodyText = flat(textOf(document.body));
    if (/休假/.test(bodyText)) flags.push({ status: 'review', reason: `頁面出現「休假」字樣，SOP 要求確認賣場是否休假中：${snippet(bodyText, /休假/)}` });
    if (AMOUNT_LIMIT_RE.test(bodyText) || store.events?.amountLimitText) {
      flags.push({ status: 'review', reason: `出現金額上限訊息（SOP：若無法跳轉至「結帳畫面」則不採用該賣場）：${store.events?.amountLimitText || snippet(bodyText, AMOUNT_LIMIT_RE, 30)}` });
    }
    if (!store.product) flags.push({ status: 'review', reason: '沒有商品頁暫存資料（未在商品頁執行助手，或結帳頁網域不同），網址與數量上限需人工補' });

    let coupons = store.checkout?.coupons;
    if (!(resume && coupons && Date.now() - coupons.at < FRESH_MS)) {
      coupons = { ...(await readCheckoutCoupons(onProgress)), at: Date.now() };
      saveStore({ checkout: { ...(loadStore().checkout || {}), coupons } });
    }
    const usedCoupons = coupons.items.filter((item) => item.checked);
    const freeShippingApplied = usedCoupons.some((item) => /免運/.test(`${item.section} ${item.title} ${item.text}`));

    let shipping;
    const summaryBefore = checkoutSummary();
    if (freeShippingApplied) {
      shipping = {
        methods: [], reviews: [],
        decision: {
          value: summaryBefore.shipping.length === 1 ? summaryBefore.shipping[0] : '',
          review: summaryBefore.shipping.length !== 1,
          reason: '已套用免運券：運費以目前「運費小計」為準（SOP：無可套用免運券時才需逐項確認運送方式）',
        },
      };
    } else {
      const scanned = await scanShipping(onProgress);
      const decision = decideShipping(scanned.methods);
      if (decision.method) await selectMethod(decision.method);
      shipping = { ...scanned, decision };
    }

    const summary = checkoutSummary();
    if (summary.itemCount.some((count) => Number(count) > 1) || summary.itemCount.length > 1) {
      flags.push({ status: 'review', reason: `購物車顯示「小計 ${summary.itemCount.join('、')} 項」，優惠與運費可能混入其他商品，請確認` });
    }
    const item = checkoutItem(store.product?.title);
    const events = loadStore().events || {};
    const notes = unique([
      ...usedCoupons.map((coupon) => coupon.title),
      events.qtyLimit ? `商品購買上限${events.qtyLimit}件` : '',
      shipping.decision.note || '',
    ]);

    const result = {
      page: 'checkout', url: location.href, savedAt: Date.now(), product: store.product || null, flags,
      coupons, shipping, summary, item, events, notes,
      fields: {
        url_i_open_mall: store.product?.url || '',
        price_i_open_mall: item.amounts ? item.amounts.join(' / ') : '',
        qty_i_open_mall: item.qty || '',
        discount_i_open_mall: summary.discount.join(' / '),
        coinback_i_open_mall: '0',
        shipping_fee_i_open_mall: shipping.decision.value || '',
        note_i_open_mall: notes.join('；'),
      },
    };
    saveStore({ checkout: { ...(loadStore().checkout || {}), result, pending: null } });
    return result;
  }

  // ───────────── 面板 ─────────────
  const host = document.createElement('div');
  host.id = APP_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; } * { box-sizing: border-box; }
      .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 520px;
        max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto;
        color: #17202a; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px;
        box-shadow: 0 18px 50px rgba(15,23,42,.28); font: 13px/1.45 system-ui, sans-serif; }
      header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 11px 12px; color: #fff; background: #d9480f; cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.5); border-radius: 6px; cursor: pointer; }
      main { padding: 12px; } section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { margin: 4px 0; padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 96px 1fr; gap: 4px 8px; } .facts b { overflow-wrap: anywhere; }
      .field { margin-top: 8px; } .field-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      .field-head span { color: #334155; font-size: 12px; font-weight: 700; }
      textarea { width: 100%; min-height: 36px; margin-top: 3px; padding: 6px 8px; resize: vertical;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button.action { padding: 8px 11px; color: #fff; background: #d9480f; border: 0; border-radius: 6px;
        cursor: pointer; font: inherit; font-weight: 700; }
      button.action:disabled { opacity: .55; cursor: wait; } button.secondary { color: #334155; background: #f1f5f9; }
      button.mini { padding: 2px 8px; color: #334155; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 5px; cursor: pointer; font: 12px system-ui; }
      .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 9px 0 12px; }
      .toggle { display: flex; align-items: center; gap: 4px; color: #334155; font-size: 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .claimed, .usable { color: #166534; } .reject, .failed { color: #b42318; } .review { color: #92400e; }
      .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回到右上角"><strong>iOPEN MALL 優惠擷取助手 v${VERSION}</strong><button id="close" title="關閉">×</button></header>
      <main>
        <section id="pageSection"></section>
        <div id="progress" class="status info">待命</div>
        <div class="actions" id="actions"></div>
        <section id="eventSection" class="hidden"></section>
        <section id="fieldSection" class="hidden"></section>
        <section id="decisionSection" class="hidden"></section>
        <p class="muted">只讀取與分類頁面資訊，不計算。商品頁會自動按「點我領取」；結帳頁會開關折價券視窗、切換運送方式以讀取運費，最後停在最低運費的方式。</p>
      </main>
    </div>`;
  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;
  let busy = false;
  let pageType = 'unknown';

  function setProgress(message, type = 'info') {
    $('#progress').className = `status ${type}`;
    $('#progress').textContent = message;
  }

  const STATUS_TEXT = { reject: '不採用', review: '需人工確認', claimed: '領取成功', failed: '領取失敗', usable: '可用' };

  function listHtml(items) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((item) => `<li class="${item.status}"><b>${escapeHtml(STATUS_TEXT[item.status] || item.status)}｜${escapeHtml(item.reason)}</b>
      ${item.text ? `<br>${escapeHtml(item.text)}` : ''}${item.evidence ? `<div class="evidence">${escapeHtml(item.evidence)}</div>` : ''}</li>`).join('')}</ul>`;
  }

  function group(title, items, open = true) {
    return `<details ${open ? 'open' : ''}><summary>${escapeHtml(title)}（${items.length}）</summary>${listHtml(items)}</details>`;
  }

  function fieldHtml(key, label, value, hint = '') {
    return `<div class="field"><div class="field-head"><span>${escapeHtml(label)}</span><button class="mini" data-copy="${key}">複製</button></div>
      <textarea data-field="${key}" readonly>${escapeHtml(value)}</textarea>${hint ? `<div class="muted">${escapeHtml(hint)}</div>` : ''}</div>`;
  }

  function renderPage() {
    const store = loadStore();
    if (pageType === 'product') {
      const facts = productFacts();
      $('#pageSection').innerHTML = `<h2>商品頁</h2><div class="facts">
        <span>商品</span><b>${escapeHtml(facts.title)}</b>
        <span>商品編號</span><b>${escapeHtml(facts.productNo || '未讀到')}</b>
        <span>頁面售價</span><b>${facts.currentPrice ? `$${escapeHtml(facts.currentPrice)}` : '未讀到'}</b>
        <span>原價</span><b>${facts.originalPrice ? `$${escapeHtml(facts.originalPrice)}` : '未讀到'}</b></div>
        <p class="muted">價格／數量僅供參考；SOP：表單資訊以購物車結帳畫面顯示為準。出貨天數不列入判斷。</p>`;
      $('#actions').innerHTML = `<button class="action" id="runProduct">領取折價券並擷取</button>
        <button class="action secondary hidden" id="forceProduct">略過賣場排除並領券</button>
        <label class="toggle"><input type="checkbox" id="autoClaim" ${loadSettings().autoClaim ? 'checked' : ''}>開頁自動領取</label>
        <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
        <button class="action secondary" id="clearStore">清除暫存</button>`;
    } else if (pageType === 'checkout') {
      $('#pageSection').innerHTML = `<h2>結帳頁</h2><div class="facts">
        <span>商品頁暫存</span><b>${escapeHtml(store.product ? store.product.title : '無')}</b>
        <span>數量上限</span><b>${escapeHtml(store.events?.qtyLimit ? `${store.events.qtyLimit} 件` : '未偵測到')}</b></div>`;
      $('#actions').innerHTML = `<button class="action" id="runCheckout">讀取結帳頁（券＋運費）</button>
        <button class="action secondary" id="rescanShipping">清除運費紀錄重讀</button>
        <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
        <button class="action secondary" id="clearStore">清除暫存</button>`;
    } else {
      $('#pageSection').innerHTML = '<h2>未偵測到商品頁或結帳頁</h2><p class="muted">商品頁需有「本商品適用活動」或購買按鈕；結帳頁需有「選擇優惠折抵」或「選擇運送方式」。</p>';
      $('#actions').innerHTML = '<button class="action secondary" id="redetect">重新偵測</button><button class="action secondary" id="clearStore">清除暫存</button>';
    }
    renderEvents();
  }

  function renderEvents() {
    const section = $('#eventSection');
    if (!section) return;
    const events = loadStore().events || {};
    const lines = [];
    if (events.qtyLimit) lines.push(`<div class="status warn">數量上限：${escapeHtml(events.qtyLimitText)} → 以最高數量上限下單，NOTE 備註「商品購買上限${escapeHtml(events.qtyLimit)}件」</div>`);
    if (events.amountLimitText) lines.push(`<div class="status bad">金額上限：${escapeHtml(events.amountLimitText)} → 若無法跳轉至結帳畫面則不採用該賣場</div>`);
    section.innerHTML = lines.length ? `<h2>系統上限偵測</h2>${lines.join('')}` : '';
    section.classList.toggle('hidden', !lines.length);
  }

  function renderProduct(product) {
    const claims = [...product.claimLog.map((entry) => ({ status: entry.status, reason: entry.reason, text: entry.summary, evidence: entry.response ? `頁面回應：${entry.response}` : '' })),
      ...(product.leftovers || []).map((entry) => ({ status: entry.status, reason: entry.reason, text: entry.summary }))];
    const pageItems = [
      ...product.exclusions.map((reason) => ({ status: 'reject', reason })),
      ...product.reviews.map((reason) => ({ status: 'review', reason })),
    ];
    $('#fieldSection').innerHTML = `<h2>欄位</h2>${fieldHtml('url_i_open_mall', 'url_i_open_mall', product.url)}
      <p class="muted">下一步：依 CP 組數加入購物車或按立即結帳，到結帳頁再執行助手。</p>`;
    $('#fieldSection').classList.remove('hidden');
    $('#decisionSection').innerHTML = `<h2>判斷明細</h2>
      ${product.exclusions.length ? `<div class="status bad">賣場不採用：${escapeHtml(product.exclusions.join('；'))}</div>` : '<div class="status ok">未偵測到跨境／預購／不同貨幣</div>'}
      ${group('賣場與作業提示', pageItems)}
      ${group('領取成功', claims.filter((item) => item.status === 'claimed'))}
      ${group('領取失敗（已發送完畢）', claims.filter((item) => item.status === 'failed'))}
      ${group('需人工確認', claims.filter((item) => item.status === 'review'))}`;
    $('#decisionSection').classList.remove('hidden');
    $('#forceProduct')?.classList.toggle('hidden', !product.exclusions.length);
  }

  function renderCheckout(result) {
    const decision = result.shipping.decision;
    $('#fieldSection').innerHTML = `<h2>欄位（頁面原文，不計算）</h2>
      ${fieldHtml('url_i_open_mall', 'url_i_open_mall', result.fields.url_i_open_mall, result.product ? '' : '無商品頁暫存，請手動貼上')}
      ${fieldHtml('price_i_open_mall', 'price_i_open_mall（結帳頁商品列金額原文）', result.fields.price_i_open_mall, result.item.note || '若有多個金額，請依表單定義擇一')}
      ${fieldHtml('qty_i_open_mall', 'qty_i_open_mall（結帳頁數量）', result.fields.qty_i_open_mall, result.item.note || '')}
      ${fieldHtml('discount_i_open_mall', 'discount_i_open_mall（結帳頁「優惠共折抵」原文）', result.fields.discount_i_open_mall)}
      ${fieldHtml('coinback_i_open_mall', 'coinback_i_open_mall', result.fields.coinback_i_open_mall, 'SOP：iOPEN MALL 回饋不採用，有商品仍須填 0')}
      ${fieldHtml('shipping_fee_i_open_mall', 'shipping_fee_i_open_mall', result.fields.shipping_fee_i_open_mall, decision.reason)}
      ${fieldHtml('note_i_open_mall', 'note_i_open_mall', result.fields.note_i_open_mall, '若有採用「免運活動」（非券），助手無法辨識，請自行補進 NOTE')}`;
    $('#fieldSection').classList.remove('hidden');
    const couponItems = result.coupons.items.map((item) => ({ status: item.status, reason: `${item.dialog}${item.section ? `／${item.section}` : ''}｜${item.reason}`, text: item.text }));
    const methodItems = result.shipping.methods.map((method) => ({
      status: method.restriction ? 'reject' : (method.name === decision.method ? 'usable' : 'review'),
      reason: method.restriction ? `有限制：${method.restriction}` : (method.name === decision.method ? '最低運費（採用）' : '非最低'),
      text: `${method.name}｜運費小計 ${method.feeRaw || '未讀到'}`,
    }));
    const otherReviews = [
      ...result.flags,
      ...result.coupons.reviews.map((reason) => ({ status: 'review', reason })),
      ...result.shipping.reviews.map((reason) => ({ status: 'review', reason })),
      ...(decision.review ? [{ status: 'review', reason: decision.reason }] : []),
    ];
    $('#decisionSection').innerHTML = `<h2>判斷明細</h2>
      ${group('需人工確認', otherReviews)}
      ${group('折價／免運券（結帳頁）', couponItems)}
      ${group('運送方式', methodItems)}
      <p class="muted">頁面合計原文：小計 ${escapeHtml(result.summary.itemCount.join('、') || '-')} 項｜優惠共折抵 ${escapeHtml(result.summary.discount.map((v) => `$${v}`).join('、') || '-')}｜OPENPOINT共折抵 ${escapeHtml(result.summary.openpoint.map((v) => `$${v}`).join('、') || '-')}｜總金額 ${escapeHtml(result.summary.total.map((v) => `$${v}`).join('、') || '-')}</p>`;
    $('#decisionSection').classList.remove('hidden');
  }

  function toTsv(result) {
    const clean = (value) => flat(value).replace(/\t/g, ' ');
    const rows = [['頁面', '網址', '項目', '判定', '內容', '理由']];
    if (result.page === 'product') {
      result.exclusions.forEach((reason) => rows.push(['商品頁', result.url, '賣場', '不採用', '', reason]));
      result.reviews.forEach((reason) => rows.push(['商品頁', result.url, '提示', '需人工確認', '', reason]));
      [...result.claimLog, ...(result.leftovers || [])].forEach((entry) => rows.push(['商品頁', result.url, entry.label || '折價券', STATUS_TEXT[entry.status] || entry.status, entry.summary, entry.reason]));
    } else {
      Object.entries(result.fields).forEach(([key, value]) => rows.push(['結帳頁', result.url, key, '欄位', value, '']));
      result.coupons.items.forEach((item) => rows.push(['結帳頁', result.url, item.section || item.dialog, STATUS_TEXT[item.status], item.text, item.reason]));
      result.shipping.methods.forEach((method) => rows.push(['結帳頁', result.url, '運送方式', method.restriction ? '有限制' : '', `${method.name} ${method.feeRaw}`, method.restriction]));
      result.flags.forEach((flag) => rows.push(['結帳頁', result.url, '提示', STATUS_TEXT[flag.status], '', flag.reason]));
    }
    return rows.map((row) => row.map(clean).join('\t')).join('\n');
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = text; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
      }
      button.textContent = '已複製';
    } catch (error) {
      console.error('[iOPEN 優惠擷取助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally { setTimeout(() => { button.textContent = original; }, 1200); }
  }

  async function guarded(task) {
    if (busy) return latest;
    busy = true;
    shadow.querySelectorAll('button.action').forEach((button) => { button.disabled = true; });
    try {
      return await task();
    } catch (error) {
      console.error('[iOPEN 優惠擷取助手] 執行失敗', error);
      setProgress(`執行失敗：${flat(error?.message || error)}`, 'bad');
      return null;
    } finally {
      busy = false;
      shadow.querySelectorAll('button.action').forEach((button) => { button.disabled = false; });
      const copy = $('#copyAll');
      if (copy) copy.disabled = !latest;
    }
  }

  const captureProduct = (options = {}) => guarded(async () => {
    setProgress(options.force ? '略過賣場排除，開始領券…' : '判斷賣場並領取折價券…');
    latest = { page: 'product', ...(await runProduct(options, (message) => setProgress(message))) };
    renderProduct(latest);
    const count = (status) => [...latest.claimLog, ...(latest.leftovers || [])].filter((entry) => entry.status === status).length;
    if (latest.exclusions.length && !options.force) setProgress('賣場判定不採用，未領券。', 'bad');
    else setProgress(`領券完成：成功 ${count('claimed')}、失敗 ${count('failed')}、需人工確認 ${count('review')}。`, count('review') ? 'warn' : 'ok');
    return latest;
  });

  const captureCheckout = (options = {}) => guarded(async () => {
    setProgress('讀取結帳頁…');
    const result = await runCheckout(options, (message) => setProgress(message));
    latest = result;
    renderPage();
    renderCheckout(result);
    const reviews = result.flags.length + result.coupons.reviews.length + result.shipping.reviews.length + (result.shipping.decision.review ? 1 : 0);
    setProgress(`結帳頁讀取完成：套用券 ${result.coupons.items.filter((item) => item.checked).length} 張；需人工確認 ${reviews} 項。未做任何金額計算。`, reviews ? 'warn' : 'ok');
    return result;
  });

  shadow.addEventListener('click', (event) => {
    const target = event.target.closest('button, input');
    if (!target) return;
    if (target.id === 'close') destroy();
    else if (target.id === 'runProduct') captureProduct();
    else if (target.id === 'forceProduct') captureProduct({ force: true });
    else if (target.id === 'runCheckout') captureCheckout();
    else if (target.id === 'rescanShipping') {
      const checkout = loadStore().checkout || {};
      saveStore({ checkout: { ...checkout, shipping: {}, pending: null } });
      captureCheckout({ resume: true });
    } else if (target.id === 'autoClaim') saveSettings({ autoClaim: target.checked });
    else if (target.id === 'clearStore') {
      try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
      latest = null;
      renderPage();
      setProgress('已清除暫存。');
    } else if (target.id === 'redetect') init();
    else if (target.id === 'copyAll' && latest) copyText(toTsv(latest), target);
    else if (target.dataset.copy) copyText($(`textarea[data-field="${target.dataset.copy}"]`)?.value || '', target);
  });

  function enableDragging() {
    const panel = $('.panel');
    const handle = $('header');
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      panel.style.left = `${rect.left}px`; panel.style.top = `${rect.top}px`; panel.style.right = 'auto';
      handle.setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.min(Math.max(0, window.innerWidth - rect.width), Math.max(0, event.clientX - drag.offsetX))}px`;
      panel.style.top = `${Math.min(Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight)), Math.max(0, event.clientY - drag.offsetY))}px`;
      event.preventDefault();
    });
    const stop = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId); drag = null;
    };
    handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      panel.style.left = 'auto'; panel.style.right = '12px'; panel.style.top = '12px';
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const nodes = mutation.type === 'childList' ? [...mutation.addedNodes] : [mutation.target];
      for (const node of nodes) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element || element === host) continue;
        const text = element.textContent || '';
        if (text.length > 600) continue;
        if ((QTY_LIMIT_RE.test(text) || AMOUNT_LIMIT_RE.test(text)) && (mutation.type !== 'attributes' || isVisible(element))) inspectMessage(text);
      }
    }
  });

  function destroy() {
    observer.disconnect();
    window.alert = originalDialogs.alert;
    window.confirm = originalDialogs.confirm;
    host.remove();
    if (window.IOpenJudgementHelper?.version === VERSION) delete window.IOpenJudgementHelper;
  }

  async function init() {
    await waitFor(() => isCheckoutPage() || isProductPage(), IS_USERSCRIPT ? 6000 : 1500, 250);
    pageType = isCheckoutPage() ? 'checkout' : (isProductPage() ? 'product' : 'unknown');
    if (IS_USERSCRIPT && pageType === 'unknown') { destroy(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    renderPage();
    const store = loadStore();
    if (pageType === 'product') {
      if (store.product?.url === location.href) renderProduct({ page: 'product', leftovers: [], ...store.product });
      if (loadSettings().autoClaim) captureProduct();
      else setProgress('按「領取折價券並擷取」開始。');
    } else if (pageType === 'checkout') {
      const pending = store.checkout?.pending;
      if (pending && Date.now() - pending.at < 120000) captureCheckout({ resume: true });
      else if (store.checkout?.result && Date.now() - (store.checkout.result.savedAt || 0) < FRESH_MS
        && store.checkout.result.url === location.href) {
        latest = store.checkout.result;
        renderCheckout(latest);
        setProgress('已載入先前讀取結果；如有變動請重新讀取。');
      } else setProgress('按「讀取結帳頁（券＋運費）」開始。');
    }
  }

  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
  enableDragging();
  window.IOpenJudgementHelper = {
    version: VERSION, destroy, result: () => latest, store: loadStore,
    captureProduct, captureCheckout,
  };
  init();
  console.info(`[iOPEN MALL 優惠擷取助手 v${VERSION}] 已啟動。不計算；商品頁自動領券，結帳頁讀取券與運費。`);
})();
