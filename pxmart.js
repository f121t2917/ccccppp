/*
 * PXMart 全電商 優惠擷取助手 v1.0.0
 * 平台：https://pxbox.es.pxmart.com.tw/product/xxxx（全聯全電商）
 * 用法：在商品頁或購物車頁開 DevTools Console 貼上執行（或存成 Sources > Snippets，Ctrl+Enter 執行）
 * 原則：只讀取、分類網頁資訊；不計算折扣金額、不領券、不加入購物車、不點「前往活動賣場」。
 * 會自動點擊的只有：現折列的「說明」、「查看可用折價券」、以及彈窗的關閉鈕。
 */
(() => {
  'use strict';

  const APP_ID = 'pxmart-judgement-helper';
  const VERSION = '1.0.0';
  const PLATFORM_HOST = /(^|\.)pxbox\.es\.pxmart\.com\.tw$/i;

  const CN_DIGITS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  // 數字：1萬5（後接折抵等）＝15000、1,999、一
  const NUM = '(?:\\d+(?:\\.\\d+)?萬(?:\\d(?=\\s*(?:折抵|抵|元|享|打|現折|送|[,，]|\\s|$)))?|\\d[\\d,]*(?:\\.\\d+)?|[一二兩三四五六七八九十])';

  // ───────────── 純文字工具（不碰 DOM） ─────────────
  function normalize(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function oneLine(value) {
    return normalize(value).replace(/\n+/g, ' ').trim();
  }

  function unique(items) {
    return [...new Set((items || []).map(oneLine).filter(Boolean))];
  }

  function toHalfWidth(value) {
    return String(value ?? '')
      .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/＄/g, '$').replace(/％/g, '%').replace(/，/g, ',').replace(/．/g, '.');
  }

  function numberFromToken(token) {
    const text = String(token || '').replace(/[,，\s]/g, '');
    if (CN_DIGITS[text] != null) return String(CN_DIGITS[text]);
    const wan = text.match(/^(\d+(?:\.\d+)?)萬(\d)?$/);
    if (wan) return String(Math.round(Number(wan[1]) * 10000 + (wan[2] ? Number(wan[2]) * 1000 : 0)));
    return text;
  }

  // 只「拆出」網頁文字中的門檻／優惠值／上限，不做任何折扣計算
  function parseFacts(text) {
    let value = toHalfWidth(oneLine(text));
    const facts = { threshold: '', thresholdUnit: '', benefit: '', benefitUnit: '', cap: '' };

    const cap = value.match(new RegExp(`(?:累折上限|最高可折|最高折抵|最高折|最高|上限)\\s*\\$?\\s*(${NUM})\\s*元?`));
    if (cap) { facts.cap = numberFromToken(cap[1]); value = value.replace(cap[0], ' '); }

    const threshold = value.match(new RegExp(`(?:滿|任)\\s*\\$?\\s*(${NUM})\\s*(件|組|入|個|元)?`));
    if (threshold) {
      facts.threshold = numberFromToken(threshold[1]);
      facts.thresholdUnit = threshold[2] || '元';
      value = value.replace(threshold[0], ' ');
    }

    const rate = value.match(/(?:打|享)?\s*(\d{1,2}(?:\.\d+)?)\s*折(?!\s*(?:抵|價|\$|\d))/);
    const percent = value.match(/(\d{1,2}(?:\.\d+)?)\s*%/);
    const amount = value.match(new RegExp(`(?:現折|現抵|折抵|折|抵|減)\\s*\\$?\\s*(${NUM})\\s*元?`));
    const points = value.match(new RegExp(`送\\s*(${NUM})\\s*(點|P幣|福利點)`));

    if (rate) [facts.benefit, facts.benefitUnit] = [rate[1], '折'];
    else if (percent) [facts.benefit, facts.benefitUnit] = [percent[1], '%'];
    else if (amount) [facts.benefit, facts.benefitUnit] = [numberFromToken(amount[1]), '元'];
    else if (points) [facts.benefit, facts.benefitUnit] = [numberFromToken(points[1]), '點'];
    return facts;
  }

  function hasRegistration(text) {
    const value = oneLine(text);
    return !/(免登記|不需登記|無須登記|無需登記)/.test(value) && /登記/.test(value);
  }

  // 規則：首購不採用；只使用免登記的優惠；其餘可採用
  function classifyDiscount(text) {
    const value = oneLine(text);
    if (/首購/.test(value)) return { status: 'reject', reason: '首購限定，不採用', flags: ['首購'] };
    if (hasRegistration(value)) return { status: 'reject', reason: '需登記；只使用免登記的優惠', flags: ['登記'] };
    const flags = ['限量', '會員專屬'].filter((word) => value.includes(word));
    if (flags.length) {
      return { status: 'review', reason: `標示「${flags.join('、')}」：規則只對折價券明訂不採用，現折活動未明訂，需人工確認`, flags };
    }
    return { status: 'usable', reason: '已點說明查看；非首購、免登記，可採用（依頁面順序累計）', flags: [] };
  }

  // 規則：折價券顯示限量、首購、會員專屬等不採用，其餘要採用；只使用免登記的優惠
  function classifyCoupon(text) {
    const value = oneLine(text);
    const hits = [];
    if (/限量/.test(value)) hits.push('限量');
    if (/首購/.test(value)) hits.push('首購');
    if (/會員專屬/.test(value)) hits.push('會員專屬');
    if (hasRegistration(value)) hits.push('需登記');
    if (hits.length) return { status: 'reject', reason: `折價券顯示「${hits.join('、')}」，不採用`, flags: hits };
    const other = value.match(/(專屬|新客|新戶|限新|指定會員)/);
    if (other) {
      return { status: 'review', reason: `含「${other[1]}」字樣，是否屬「限量、首購、會員專屬等」需人工確認`, flags: [other[1]] };
    }
    return { status: 'usable', reason: '未顯示限量／首購／會員專屬，依規則採用', flags: [] };
  }

  // 規則：特價→直接填；首購價不採用→填售價；賣場顯示折扣價→填價格欄並備註折扣
  function analyzePrices(entries) {
    const list = (entries || []).filter((entry) => entry && entry.amount);
    const KNOWN = /^(首購價|特價|售價|折後價|折扣價|原價)$/;
    const result = {
      price: '', source: '', original: '', firstBuyPrice: '', noteHint: '',
      status: 'review', reason: '', entries: list,
    };
    const setPrice = (entry, source, status, reason) => Object.assign(result, { price: entry.amount, source, status, reason });

    const firstBuy = list.find((entry) => entry.label === '首購價');
    if (firstBuy) result.firstBuyPrice = firstBuy.amount;
    const special = list.find((entry) => entry.label === '特價' && !entry.strike);
    const sale = list.find((entry) => entry.label === '售價');
    const discounted = list.find((entry) => /^(折後價|折扣價)$/.test(entry.label) && !entry.strike);
    const unknown = list.filter((entry) => entry.label && !KNOWN.test(entry.label) && !entry.strike);
    const liveUnlabeled = list.filter((entry) => !entry.label && !entry.strike);

    if (unknown.length) {
      result.reason = `價格標示「${unique(unknown.map((entry) => entry.label)).join('、')}」不在規則內，需人工確認`;
    } else if (special) {
      setPrice(special, '特價', 'usable', `頁面顯示特價，依規則直接填特價${firstBuy ? '（首購價不採用）' : ''}`);
    } else if (firstBuy) {
      if (sale) setPrice(sale, '售價', 'usable', '首購價為首購限定不採用，改填售價');
      else result.reason = '顯示首購價，但未讀到售價，需人工確認';
    } else if (discounted) {
      setPrice(discounted, discounted.label, 'review',
        `依規則填價格欄並備註折扣、該折扣不再重算；「${discounted.label}」是否即規則所稱折扣價、已含哪一項折扣，需人工確認`);
      result.noteHint = `賣場顯示${discounted.label}（請備註已含的折扣）`;
    } else if (sale && sale.strike && liveUnlabeled.length) {
      result.reason = '售價有刪除線，另有未標示的價格（可能是首購價等），需人工確認';
    } else if (sale && !sale.strike) {
      setPrice(sale, '售價', 'usable', '頁面售價');
    } else {
      const amounts = unique(liveUnlabeled.map((entry) => entry.amount));
      if (amounts.length === 1) setPrice(liveUnlabeled[0], '頁面價格（未標示）', 'usable', '頁面唯一未刪除線價格');
      else if (amounts.length > 1) result.reason = `讀到多個未標示價格（${amounts.join('、')}），需人工確認`;
      else result.reason = list.length ? '只讀到刪除線價格，需人工確認' : '未讀到價格，需人工確認';
    }
    const struck = list.find((entry) => entry.strike && entry.amount !== result.price && entry.label !== '首購價');
    if (struck) result.original = struck.amount;
    return result;
  }

  function parseShipping(text) {
    const value = toHalfWidth(oneLine(text));
    const threshold = value.match(/滿\s*\$?\s*(\d[\d,]*)/);
    const fee = value.match(/未滿\s*運費\s*\$?\s*(\d[\d,]*)/) || value.match(/運費\s*\$?\s*(\d[\d,]*)/);
    const freeAll = /免運/.test(value) && !threshold && !fee;
    return {
      threshold: threshold ? threshold[1].replace(/,/g, '') : (freeAll ? '0' : ''),
      fee: fee ? fee[1].replace(/,/g, '') : '',
      freeAll,
      text: value,
    };
  }

  // Node 測試用：非瀏覽器環境只匯出純函式
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { parseFacts, classifyDiscount, classifyCoupon, analyzePrices, parseShipping, numberFromToken };
    }
    return;
  }

  // ───────────── DOM 工具 ─────────────
  if (window.PXMartHelper?.destroy) window.PXMartHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classText = (node) => (typeof node?.className === 'string' ? node.className : (node?.className?.baseVal || ''));
  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  }

  async function waitFor(check, timeout = 4000, interval = 100) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  async function waitStable(el, timeout = 2500) {
    let last = -1;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const length = (el?.innerText || '').length;
      if (length > 0 && length === last) return;
      last = length;
      await sleep(250);
    }
  }

  function textOf(el) {
    return normalize(el?.innerText || el?.textContent || '');
  }

  function visibleElements(root) {
    return [...(root || document.body).querySelectorAll('*')]
      .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName) && isVisible(el));
  }

  // 找「最小的」含指定文字的可見元素
  function leafMatches(regex, root, maxLength = 120) {
    const matched = visibleElements(root).filter((el) => {
      if ((el.textContent || '').length > maxLength * 4) return false;
      const text = oneLine(textOf(el));
      return text && text.length <= maxLength && regex.test(text);
    });
    return matched.filter((el) => !matched.some((other) => other !== el && el.contains(other)));
  }

  function hasFixedAncestorOrSelf(node) {
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      if (getComputedStyle(current).position === 'fixed') return true;
    }
    return false;
  }

  function isModalNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches('[role="dialog"], [aria-modal="true"]')) return true;
    return /(^|[\s_-])(dialog|modal|popup|drawer|lightbox)([\s_-]|$)/i.test(classText(node)) && hasFixedAncestorOrSelf(node);
  }

  function insideModal(el) {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (isModalNode(node)) return true;
    }
    return false;
  }

  function outermost(list) {
    return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
  }

  function openModals() {
    const selector = '[role="dialog"], [aria-modal="true"], [class*="dialog" i], [class*="modal" i], [class*="popup" i], [class*="drawer" i], [class*="lightbox" i]';
    return outermost([...document.querySelectorAll(selector)].filter((el) => {
      if (!isVisible(el) || !isModalNode(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 160 && rect.height > 100;
    }));
  }

  function clickableFor(el) {
    return el.closest('button, a, [role="button"]') || el;
  }

  function isNavigatingLink(el) {
    if (el.tagName !== 'A') return false;
    const href = (el.getAttribute('href') || '').trim();
    return Boolean(href) && !/^(#|javascript:)/i.test(href);
  }

  function isDisabled(el) {
    const node = clickableFor(el);
    return Boolean(node.disabled)
      || node.getAttribute('aria-disabled') === 'true'
      || /(^|[\s_-])(is-?)?disabled?([\s_-]|$)/i.test(classText(node))
      || getComputedStyle(node).pointerEvents === 'none';
  }

  function fire(el) {
    el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const options = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, options));
    });
    el.click();
  }

  async function closeModal(modal) {
    const isOpen = () => modal && modal.isConnected && isVisible(modal);
    if (!isOpen()) return true;
    const closers = [...modal.querySelectorAll('*')].filter(isVisible).filter((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
      const text = oneLine(textOf(el));
      return /close|關閉/i.test(label) || /(^|[\s_-])close/i.test(classText(el)) || /^(×|✕|✖|X|關閉)$/.test(text);
    });
    const closer = closers.find((el) => !closers.some((other) => other !== el && el.contains(other)));
    if (closer) {
      fire(clickableFor(closer));
      if (!(await waitFor(() => !isOpen(), 1500))) {
        // 繼續嘗試 Esc
      } else return true;
    }
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    modal.dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    return Boolean(await waitFor(() => !isOpen(), 1500));
  }

  async function closeAllModals() {
    for (const modal of openModals()) await closeModal(modal);
  }

  async function clickAndWaitModal(target, contentRe, titleLeafRe) {
    await closeAllModals();
    const before = new Set(openModals());
    fire(target);
    const modal = await waitFor(() => {
      const fresh = openModals().filter((el) => !before.has(el));
      const matched = fresh.filter((el) => contentRe.test(textOf(el)));
      if (matched.length) return matched[0];
      const leaf = leafMatches(titleLeafRe, document.body, 30)[0];
      if (!leaf) return null;
      for (let node = leaf; node && node !== document.body; node = node.parentElement) {
        if (isModalNode(node) || getComputedStyle(node).position === 'fixed') return node;
      }
      return null;
    }, 4000);
    if (modal) await waitStable(modal);
    return modal;
  }

  function contextText(el, maxLength) {
    let context = el;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if ((node.textContent || '').length > maxLength) break;
      context = node;
    }
    return oneLine(textOf(context));
  }

  // ───────────── 商品頁 ─────────────
  function findTitle() {
    const candidates = [
      ...[...document.querySelectorAll('h1, h2')].filter(isVisible),
      ...leafMatches(/【.+】/, document.body, 160),
    ].filter((el) => {
      const text = oneLine(textOf(el));
      return text.length >= 6 && !/^全聯/.test(text) && !insideModal(el);
    });
    return candidates.sort((a, b) => {
      const bracket = Number(/【/.test(textOf(b))) - Number(/【/.test(textOf(a)));
      return bracket || parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize);
    })[0] || null;
  }

  function findProductRoot(titleEl) {
    if (!titleEl) return document.body;
    let best = null;
    for (let node = titleEl.parentElement; node && node !== document.body; node = node.parentElement) {
      const text = node.textContent || '';
      if ((text.match(/【/g) || []).length > 3 || text.length > 12000) break;
      best = node;
    }
    return best || document.body;
  }

  function makeScope(root, titleEl) {
    if (root !== document.body || !titleEl) return () => true;
    const top = docTop(titleEl);
    return (el) => {
      const current = docTop(el);
      return current > top - 900 && current < top + 1500;
    };
  }

  function readPageStatus(root, scope) {
    const blockerRe = /^(售完|已售完|有貨通知我?|尚未開賣|前往活動賣場)$/;
    const blockers = leafMatches(blockerRe, root, 12)
      .filter(scope).filter((el) => !insideModal(el))
      .filter((el) => !/活動期間/.test(contextText(el, 300)));
    const buys = [...new Set(leafMatches(/^(加入購物車|立即購買|直接購買|立即結帳|馬上購買|購買)$/, root, 12)
      .filter(scope).filter((el) => !insideModal(el)).map(clickableFor))];
    const enabled = buys.filter((el) => !isDisabled(el));
    if (blockers.length) {
      return { status: 'reject', reason: `賣場顯示「${unique(blockers.map(textOf)).join('、')}」，不採用` };
    }
    if (enabled.length) return { status: 'usable', reason: '可直接按購買；未顯示售完／有貨通知／尚未開賣／前往活動賣場' };
    if (buys.length) return { status: 'reject', reason: '購買按鈕不可按（不能直接按購買），不採用' };
    return { status: 'review', reason: '未偵測到購買按鈕，請人工確認是否能直接購買' };
  }

  function readPriceEntries(root, scope, offerRows) {
    const exclude = /(現折|最高折|折\s*\$|折\s*\d|折抵|券|送|滿\s*\$?\s*\d|運費|免運|點)/;
    const leaves = leafMatches(/(?:NT)?\$\s*\d[\d,]*/, root, 40)
      .filter(scope).filter((el) => !insideModal(el))
      .filter((el) => !offerRows.some((row) => row.element.contains(el)))
      .filter((el) => !exclude.test(oneLine(textOf(el))));

    const groups = new Map();
    leaves.forEach((leaf) => {
      let context = leaf;
      for (let node = leaf.parentElement; node && node !== root.parentElement; node = node.parentElement) {
        if (oneLine(textOf(node)).length > 60) break;
        context = node;
      }
      if (!groups.has(context)) groups.set(context, []);
      groups.get(context).push(leaf);
    });

    const LABEL = /(首購價|特價|售價|折後價|折扣價|原價|會員價|限時價|活動價|優惠價)/g;
    const entries = [];
    for (const [context, members] of groups) {
      const text = toHalfWidth(oneLine(textOf(context)));
      const matches = [...text.matchAll(/(?:NT)?\$\s*(\d[\d,]*)/g)];
      members.forEach((leaf, index) => {
        const leafDigits = (toHalfWidth(textOf(leaf)).match(/\d[\d,]*/) || [''])[0].replace(/,/g, '');
        let matchIndex = matches.findIndex((match) => match[1].replace(/,/g, '') === leafDigits);
        if (matches.length === members.length) matchIndex = index;
        if (matchIndex < 0) return;
        const match = matches[matchIndex];
        const previousEnd = matchIndex > 0 ? matches[matchIndex - 1].index + matches[matchIndex - 1][0].length : 0;
        const nextStart = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index : text.length;
        const before = [...text.slice(previousEnd, match.index).matchAll(LABEL)].pop();
        const after = text.slice(match.index + match[0].length, nextStart).match(new RegExp(LABEL.source));
        let strike = false;
        for (let node = leaf; node; node = node.parentElement) {
          if (['DEL', 'S', 'STRIKE'].includes(node.tagName) || /line-through/.test(getComputedStyle(node).textDecorationLine)) {
            strike = true;
            break;
          }
          if (node === context) break;
        }
        entries.push({
          label: before ? before[1] : (after ? after[1] : ''),
          amount: match[1].replace(/,/g, ''),
          strike,
          raw: text,
        });
      });
    }
    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry.label}|${entry.amount}|${entry.strike}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findOfferRows(root, scope) {
    const buttons = [...new Set(leafMatches(/^說明$/, root, 4)
      .filter(scope).filter((el) => !insideModal(el)).map(clickableFor))];
    return buttons.map((button) => {
      let element = button;
      for (let node = button.parentElement; node && node !== document.body; node = node.parentElement) {
        const others = buttons.some((other) => other !== button && node.contains(other));
        if (others || node.getBoundingClientRect().height > 140 || (node.textContent || '').length > 400) break;
        element = node;
      }
      const lines = normalize(textOf(element)).split(/\n|\t/).map(oneLine).filter((line) => line && line !== '說明');
      const label = lines[0] || '';
      let kind = null;
      if (/^現折/.test(label)) kind = 'discount';
      else if (/^(贈點|回饋|點數|加碼贈點|送點)/.test(label)) kind = 'points';
      else if (/(折|券|送|贈|回饋|點)/.test(lines.join(' '))) kind = 'other';
      const chips = /^現折$/.test(label) ? lines.slice(1) : lines;
      return { button, element, label, lines, chips, kind };
    }).filter((row) => row.kind);
  }

  function readShipping(root, scope, offerRows) {
    const texts = unique(leafMatches(/(免運|運費)/, root, 80)
      .filter(scope).filter((el) => !insideModal(el))
      .filter((el) => !offerRows.some((row) => row.element.contains(el)))
      .map(textOf)).filter((text) => !/再湊/.test(text));
    const chosen = texts.find((text) => /滿/.test(text) && /運費/.test(text))
      || texts.find((text) => /免運費/.test(text)) || '';
    return { ...parseShipping(chosen), allTexts: texts };
  }

  async function readDiscountRow(row) {
    const modal = await clickAndWaitModal(row.button, /現折活動|活動期間/, /^現折活動$/);
    if (!modal) {
      return [{
        source: 'discount', category: '折扣活動', summary: row.chips.join(' ｜ '), period: '',
        facts: parseFacts(row.chips.join(' ')), status: 'review', flags: [],
        reason: '未能開啟「說明」，無法查看折扣內容（規則要求點說明查看）',
      }];
    }
    const periodLeaves = leafMatches(/活動期間/, modal, 60);
    const offers = [];
    periodLeaves.forEach((leaf) => {
      let container = leaf;
      for (let node = leaf.parentElement; node && node !== modal; node = node.parentElement) {
        if (periodLeaves.some((other) => other !== leaf && node.contains(other))) break;
        container = node;
      }
      let raw = normalize(textOf(container)).split(/\n|\t/).map(oneLine).filter(Boolean);
      if (raw.every((line) => /活動期間|^\d{4}\//.test(line))) {
        const siblings = [];
        for (let sibling = container.previousElementSibling; sibling && siblings.length < 2; sibling = sibling.previousElementSibling) {
          if (/活動期間/.test(textOf(sibling))) break;
          siblings.unshift(...normalize(textOf(sibling)).split('\n'));
        }
        raw = [...siblings.map(oneLine).filter(Boolean), ...raw];
      }
      const periodIndex = raw.findIndex((line) => /活動期間/.test(line));
      let period = periodIndex >= 0 ? raw[periodIndex].replace(/^活動期間\s*[:：]?\s*/, '') : '';
      const drop = new Set([periodIndex]);
      if (!period && /^\d{4}\//.test(raw[periodIndex + 1] || '')) {
        period = raw[periodIndex + 1];
        drop.add(periodIndex + 1);
      }
      const body = raw.filter((line, index) => !drop.has(index) && !/^(前往活動賣場|查看活動|現折活動|×|✕)$/.test(line));
      const text = body.join(' ｜ ');
      offers.push({
        source: 'discount', category: '折扣活動', summary: text, period,
        facts: parseFacts(body.join(' ')), ...classifyDiscount(text),
      });
    });
    if (!offers.length) {
      offers.push({
        source: 'discount', category: '折扣活動', summary: oneLine(textOf(modal)).slice(0, 300), period: '',
        facts: {}, status: 'review', flags: [], reason: '已開啟說明，但無法切分出各活動明細，需人工確認',
      });
    }
    const closed = await closeModal(modal);
    if (!closed) offers.push({ source: 'note', note: '「說明」視窗無法自動關閉，請手動關閉後再執行' });
    return offers;
  }

  async function readCoupons(root, scope) {
    const entry = [...new Set(leafMatches(/^(查看可用折價券|查看折價券|可用折價券|查看全部折價券)$/, root, 12)
      .filter(scope).filter((el) => !insideModal(el)).map(clickableFor))][0];
    if (!entry) return { offers: [], notes: ['頁面未顯示折價券入口'] };
    if (isNavigatingLink(entry)) return { offers: [], notes: ['折價券入口為跳頁連結，助手不自動開啟，請人工確認'] };

    const modal = await clickAndWaitModal(entry, /折價券/, /^(可使用的折價券|可用折價券|折價券)$/);
    if (!modal) {
      const needLogin = leafMatches(/^(登入|會員登入|請先登入|登入\/註冊)$/, document.body, 10).length > 0;
      return { offers: [], notes: [needLogin ? '未能開啟折價券清單，可能需先登入，再重新執行' : '未能開啟折價券清單，請人工確認'] };
    }
    const modalLines = normalize(textOf(modal)).split('\n').map(oneLine).filter(Boolean);
    const notes = modalLines.filter((line) => /^\d+\s*[.、．]\s*\S/.test(line)).map((line) => `折價券頁註：${line}`);
    if (/不可使用|已失效|不適用/.test(modalLines.join(' '))) notes.push('折價券清單有其他分頁（如不可使用），只讀取目前顯示的內容');

    const DESC = /((滿|任).{0,24}(折|抵|享|打)|折抵|現折|\d+(?:\.\d+)?\s*折|\d+(?:\.\d+)?\s*%)/;
    const NOT_DESC = /^(\d+\s*[.、．]|折扣優惠$|適用)|折價券須|每筆訂單|保有所有|使用期限|取消訂單|退換貨|可使用的折價券/;
    const descs = leafMatches(DESC, modal, 80).filter((el) => !NOT_DESC.test(oneLine(textOf(el))));
    const rows = new Map();
    descs.forEach((desc) => {
      let row = desc;
      for (let node = desc.parentElement; node && node !== modal; node = node.parentElement) {
        if (descs.some((other) => other !== desc && node.contains(other))) break;
        row = node;
      }
      if (!rows.has(row)) rows.set(row, desc);
    });

    const offers = [];
    for (const [row, desc] of rows) {
      const summary = oneLine(textOf(desc));
      const lines = normalize(textOf(row)).split(/\n|\t/).map(oneLine)
        .filter((line) => line && line !== summary && !/^(領取|已領取|立即領取|使用|去使用)$/.test(line));
      const warnings = lines.filter((line) => /(限量|用完為止|首購|會員|登記|專屬|新客|新戶)/.test(line));
      const scopeLines = lines.filter((line) => !warnings.includes(line));
      const fullText = [summary, ...lines].join(' ');
      offers.push({
        source: 'coupon', category: '折價券', summary, period: '',
        scopeText: scopeLines.join(' '), flagsText: warnings.join(' '),
        facts: parseFacts(summary), ...classifyCoupon(fullText),
      });
    }
    if (!offers.length) notes.push('已開啟折價券清單，但無法切分出各券內容，需人工確認');
    const closed = await closeModal(modal);
    if (!closed) notes.push('折價券視窗無法自動關閉，請手動關閉');
    return { offers, notes };
  }

  function readPageFacts(titleEl, root) {
    const urlId = (location.pathname.match(/\/product\/([^/?#]+)/) || [])[1] || '';
    const pageNo = (oneLine(textOf(root)).match(/商品編號\s*[:：]?\s*([A-Za-z0-9-]+)/) || [])[1] || '';
    return {
      url: location.href,
      urlId,
      pageNo,
      title: titleEl ? oneLine(textOf(titleEl)) : oneLine(document.title),
      isPlatform: PLATFORM_HOST.test(location.hostname),
      rootIsBody: root === document.body,
    };
  }

  // ───────────── 購物車頁（只讀取，不計算） ─────────────
  function isCartPage() {
    return /cart/i.test(location.pathname)
      || (leafMatches(/^金額小計$/, document.body, 8).length > 0 && leafMatches(/^商品總金額$/, document.body, 8).length > 0);
  }

  function readCart() {
    const labelRe = /^(商品總金額|商品金額|活動現折|折價券折抵|折價券|優惠券|運費|金額小計|點數折抵|福利點數折抵|結帳金額|應付金額)$/;
    const amountRe = /-?\s*(?:NT)?\$\s*\d[\d,]*/g;
    const summary = [];
    const seen = new Set();
    leafMatches(labelRe, document.body, 12).filter((el) => !insideModal(el)).forEach((leaf) => {
      let row = null;
      let node = leaf;
      for (let depth = 0; node && node !== document.body && depth < 6; depth += 1, node = node.parentElement) {
        const text = oneLine(textOf(node));
        if (text.length > 220) break;
        if (/(?:NT)?\$\s*\d/.test(text)) { row = node; break; }
      }
      if (!row) return;
      const text = oneLine(textOf(row));
      const amounts = text.match(amountRe) || [];
      const amountText = amounts[amounts.length - 1] || '';
      const label = oneLine(textOf(leaf));
      const note = oneLine(text.replace(label, '').replace(amountText, ''));
      const amount = amountText.replace(/\s|NT|\$|,/g, '');
      const key = `${label}|${amount}|${note}`;
      if (seen.has(key)) return;
      seen.add(key);
      summary.push({ label, amount, note });
    });

    const rules = unique(leafMatches(/(滿.{0,12}免運|未滿運費|免運門檻)/, document.body, 80)
      .filter((el) => !insideModal(el)).map(textOf));

    const items = [];
    leafMatches(/^【.+/, document.body, 150).filter((el) => !insideModal(el)).forEach((leaf) => {
      let row = null;
      for (let node = leaf.parentElement; node && node !== document.body; node = node.parentElement) {
        const text = oneLine(textOf(node));
        if (text.length > 400) break;
        if (/\$\s*\d/.test(text) && node.querySelector('input')) { row = node; break; }
      }
      if (!row) return;
      const input = [...row.querySelectorAll('input')].find((el) => /^\d+$/.test(el.value || ''));
      const price = (oneLine(textOf(row)).match(/(?:NT)?\$\s*(\d[\d,]*)/) || [])[1] || '';
      items.push({ name: oneLine(textOf(leaf)), price: price.replace(/,/g, ''), qty: input ? input.value : '' });
    });
    return { url: location.href, summary, rules, items };
  }

  // ───────────── 診斷（抓不到時複製給開發者調整） ─────────────
  function diagnostics() {
    const keys = ['現折', '說明', '查看可用折價券', '首購價', '特價', '售價', '折後價', '加入購物車', '立即購買',
      '售完', '有貨通知', '贈點', '運費', '免運', '商品編號', '活動期間', '限量', '金額小計', '商品總金額'];
    const describe = (el) => {
      const path = [];
      for (let node = el, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        path.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classText(node) ? `.${classText(node).trim().split(/\s+/).join('.')}` : ''}`);
      }
      const attributes = {};
      [...el.attributes].forEach((attribute) => {
        if (/^(data-|role|aria-|href|type|disabled)/.test(attribute.name)) attributes[attribute.name] = attribute.value.slice(0, 80);
      });
      return { text: oneLine(textOf(el)).slice(0, 80), path: path.join(' < '), attributes, inModal: insideModal(el) };
    };
    const report = {
      helper: VERSION, url: location.href, when: new Date().toISOString(),
      viewport: `${innerWidth}x${innerHeight}`,
      keys: {},
      modals: openModals().map(describe),
    };
    keys.forEach((key) => {
      report.keys[key] = leafMatches(new RegExp(escapeRegExp(key)), document.body, 80).slice(0, 6).map(describe);
    });
    return JSON.stringify(report, null, 2);
  }

  // ───────────── UI ─────────────
  const host = document.createElement('div');
  host.id = APP_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; } * { box-sizing: border-box; }
      .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 520px;
        max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto;
        color: #17202a; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px;
        box-shadow: 0 18px 50px rgba(15,23,42,.28); font: 13px/1.45 system-ui, sans-serif; }
      header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 11px 12px; color: #fff; background: #0b5cad; cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.5); border-radius: 6px; cursor: pointer; }
      main { padding: 12px; } section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; margin: 4px 0; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 104px 1fr; gap: 4px 8px; } .facts b { overflow-wrap: anywhere; }
      label { display: block; margin-top: 8px; color: #334155; font-size: 12px; }
      textarea { width: 100%; min-height: 58px; margin-top: 3px; padding: 7px 8px; resize: vertical;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button.action { padding: 8px 11px; color: #fff; background: #0b5cad; border: 0; border-radius: 6px;
        cursor: pointer; font: inherit; font-weight: 700; }
      button.action:disabled { opacity: .55; cursor: wait; } button.secondary { color: #334155; background: #f1f5f9; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .usable { color: #166534; } .reject { color: #b42318; } .review { color: #92400e; } .ignore { color: #64748b; }
      .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回右上角"><strong>PXMart 優惠擷取助手 v${VERSION}</strong><button id="close" title="關閉">×</button></header>
      <main>
        <div id="progress" class="status info">尚未擷取。商品頁或購物車頁按「自動抓取」。</div>
        <div class="actions">
          <button class="action" id="capture">自動抓取</button>
          <button class="action secondary" id="copyUsable" disabled>複製可填資料</button>
          <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
          <button class="action secondary" id="copyDiag">複製診斷資料</button>
        </div>
        <div id="output"></div>
      </main>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;
  let busy = false;

  const STATUS_LABEL = { usable: '可填入', review: '需人工確認', reject: '不採用', ignore: '忽略' };
  const STATUS_CLASS = { usable: 'ok', review: 'warn', reject: 'bad', ignore: 'info' };

  function setProgress(message, type = 'info') {
    $('#progress').className = `status ${type}`;
    $('#progress').textContent = message;
  }

  function factsText(offer) {
    const facts = offer.facts || {};
    return [
      facts.threshold ? `門檻=${facts.threshold}${facts.thresholdUnit}` : '',
      facts.benefit ? `優惠=${facts.benefit}${facts.benefitUnit}` : '',
      facts.cap ? `上限=${facts.cap}` : '',
      offer.scopeText ? `適用=${offer.scopeText}` : '',
      offer.period ? `期間=${offer.period}` : '',
    ].filter(Boolean).join('｜');
  }

  function outputLine(offer) {
    const extra = factsText(offer);
    return `${offer.order ? `#${offer.order} ` : ''}${offer.summary}${extra ? `｜${extra}` : ''}`;
  }

  function renderOfferList(items, css) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((offer) => `<li class="${css}"><b>${escapeHtml(offer.category)}${offer.order ? ` #${offer.order}` : ''}｜${escapeHtml(offer.reason)}</b><br>
      ${escapeHtml(offer.summary)}
      ${factsText(offer) || offer.flagsText ? `<div class="evidence">${escapeHtml([factsText(offer), offer.flagsText ? `標示：${offer.flagsText}` : ''].filter(Boolean).join('｜'))}</div>` : ''}</li>`).join('')}</ul>`;
  }

  function renderProduct(result) {
    const { page, offers, notes } = result;
    const price = page.prices;
    const usable = offers.filter((offer) => offer.status === 'usable');
    const byStatus = (status) => offers.filter((offer) => offer.status === status);
    const ship = page.shipping;
    $('#output').innerHTML = `
      <section>
        <h2>① 賣場判定</h2>
        ${page.isPlatform ? '' : '<div class="status warn">目前網域不是 pxbox.es.pxmart.com.tw（全電商），請確認平台</div>'}
        ${page.rootIsBody ? '<div class="status warn">未能鎖定商品資訊區，改用標題附近範圍判讀，請多留意</div>' : ''}
        <div class="status ${STATUS_CLASS[page.status.status]}">${STATUS_LABEL[page.status.status]}：${escapeHtml(page.status.reason)}</div>
        <div class="facts">
          <span>商品</span><b>${escapeHtml(page.title)}</b>
          <span>網址商品ID</span><b>${escapeHtml(page.urlId || '未讀到')}</b>
          <span>頁面商品編號</span><b>${escapeHtml(page.pageNo || '未讀到')}</b>
        </div>
      </section>
      <section>
        <h2>② 價格</h2>
        <div class="status ${STATUS_CLASS[price.status]}">${STATUS_LABEL[price.status]}：${escapeHtml(price.reason)}</div>
        <div class="facts">
          <span>價格候選</span><b>${price.price ? `$${escapeHtml(price.price)}（${escapeHtml(price.source)}）` : '—'}</b>
          <span>原價(刪除線)</span><b>${price.original ? `$${escapeHtml(price.original)}` : '—'}</b>
          <span>首購價</span><b>${price.firstBuyPrice ? `$${escapeHtml(price.firstBuyPrice)}（不採用）` : '—'}</b>
          <span>備註建議</span><b>${escapeHtml(price.noteHint || '—')}</b>
          <span>讀到的價格</span><b>${escapeHtml(price.entries.map((entry) => `${entry.label || '未標示'} $${entry.amount}${entry.strike ? '(刪除線)' : ''}`).join('、') || '—')}</b>
        </div>
      </section>
      <section>
        <h2>③④ 可填入（依頁面順序，不計算）</h2>
        <label>折扣活動（先算 #1 再算 #2）<textarea readonly>${escapeHtml(usable.filter((offer) => offer.source === 'discount').map(outputLine).join('\n'))}</textarea></label>
        <label>折價券<textarea readonly>${escapeHtml(usable.filter((offer) => offer.source === 'coupon').map(outputLine).join('\n'))}</textarea></label>
        <p class="muted">⑤ 贈點／回饋不採用：賣場可採用時回饋欄填 0；DB～DD 不需填。</p>
      </section>
      <section>
        <h2>⑥ 運費（仍須加入購物車確認）</h2>
        <div class="facts">
          <span>運費原文</span><b>${escapeHtml(ship.text || '未讀到')}</b>
          <span>免運門檻</span><b>${escapeHtml(ship.threshold || '—')}</b>
          <span>未滿運費</span><b>${escapeHtml(ship.fee || '—')}</b>
        </div>
        <p class="muted">CP 組數／是否有其他組數需人工判斷；加入購物車後在購物車頁再執行一次助手核對。</p>
      </section>
      <section>
        <h2>逐項判斷</h2>
        ${notes.length ? notes.map((note) => `<div class="status warn">${escapeHtml(note)}</div>`).join('') : ''}
        <details open><summary class="usable">可填入（${byStatus('usable').length}）</summary>${renderOfferList(byStatus('usable'), 'usable')}</details>
        <details open><summary class="review">需人工確認（${byStatus('review').length}）</summary>${renderOfferList(byStatus('review'), 'review')}</details>
        <details><summary class="reject">不採用（${byStatus('reject').length}）</summary>${renderOfferList(byStatus('reject'), 'reject')}</details>
        <details><summary class="ignore">忽略（${byStatus('ignore').length}）</summary>${renderOfferList(byStatus('ignore'), 'ignore')}</details>
      </section>`;
  }

  function renderCart(result) {
    $('#output').innerHTML = `
      <section>
        <h2>購物車摘要（只讀取）</h2>
        ${result.summary.length ? `<div class="facts">${result.summary.map((row) => `<span>${escapeHtml(row.label)}</span><b>${escapeHtml(row.amount)}${row.note ? `｜${escapeHtml(row.note)}` : ''}</b>`).join('')}</div>` : '<p class="muted">未讀到金額摘要</p>'}
      </section>
      <section>
        <h2>商品列</h2>
        ${result.items.length ? `<ul>${result.items.map((item) => `<li>${escapeHtml(item.name)}<div class="evidence">單價 ${escapeHtml(item.price || '?')}｜數量 ${escapeHtml(item.qty || '?')}</div></li>`).join('')}</ul>` : '<p class="muted">未讀到商品列</p>'}
      </section>
      <section>
        <h2>運費規則原文</h2>
        ${result.rules.length ? `<ul>${result.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>` : '<p class="muted">未讀到</p>'}
        <p class="muted">判斷依「特殊運費上乘規則」：CP 有其他組數→依實際總金額；CP 無其他組數且 PX 數量=1→假設上乘 2 看是否達門檻；PX 數量&gt;1→依實際金額。達門檻運費 0，未達填最低運費。</p>
      </section>`;
  }

  function productTsv(result, onlyUsable) {
    const { page } = result;
    const price = page.prices;
    const header = ['網址', '網址商品ID', '頁面商品編號', '商品', '賣場判定', '賣場理由', '價格候選', '價格來源', '原價(刪除線)',
      '首購價(不採用)', '價格判定', '價格理由', '贈點回饋', '免運門檻', '未滿運費', '運費原文',
      '判定', '類型', '順序', '優惠原文', '門檻', '門檻單位', '優惠值', '優惠單位', '上限', '適用範圍', '活動期間', '限制字樣', '理由'];
    const clean = (value) => oneLine(value).replace(/\t+/g, ' ');
    const base = [page.url, page.urlId, page.pageNo, page.title, STATUS_LABEL[page.status.status], page.status.reason,
      price.price, price.source, price.original, price.firstBuyPrice, STATUS_LABEL[price.status], price.reason,
      page.status.status === 'usable' ? '0' : '', page.shipping.threshold, page.shipping.fee, page.shipping.text];
    const list = onlyUsable ? result.offers.filter((offer) => offer.status === 'usable') : result.offers;
    const rows = list.map((offer) => {
      const facts = offer.facts || {};
      return [...base, STATUS_LABEL[offer.status], offer.category, offer.order || '', offer.summary,
        facts.threshold, facts.thresholdUnit, facts.benefit, facts.benefitUnit, facts.cap,
        offer.scopeText || '', offer.period || '', offer.flagsText || (offer.flags || []).join(' '), offer.reason];
    });
    if (!rows.length) rows.push([...base, ...Array(13).fill('')]);
    return [header.join('\t'), ...rows.map((row) => row.map(clean).join('\t'))].join('\n');
  }

  function cartTsv(result) {
    const lines = [['網址', '區塊', '項目', '金額／數量', '備註'].join('\t')];
    result.summary.forEach((row) => lines.push([result.url, '摘要', row.label, row.amount, row.note].map(oneLine).join('\t')));
    result.items.forEach((item) => lines.push([result.url, '商品', item.name, `${item.price} x ${item.qty}`, ''].map(oneLine).join('\t')));
    result.rules.forEach((rule) => lines.push([result.url, '運費規則', '', '', rule].map(oneLine).join('\t')));
    return lines.join('\n');
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
      }
      button.textContent = '已複製';
    } catch (error) {
      console.error('[PXMart 助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally {
      setTimeout(() => { button.textContent = original; }, 1200);
    }
  }

  async function capture(options = {}) {
    if (busy) return latest;
    busy = true;
    ['#capture', '#copyUsable', '#copyAll'].forEach((id) => { $(id).disabled = true; });
    try {
      await closeAllModals();
      if (isCartPage()) {
        setProgress('讀取購物車…');
        latest = { mode: 'cart', ...readCart() };
        renderCart(latest);
        setProgress('購物車讀取完成（未做任何計算）。', latest.summary.length ? 'ok' : 'warn');
        $('#copyAll').disabled = false;
        $('#copyUsable').disabled = false;
        return latest;
      }

      setProgress('① 確認賣場…');
      const titleEl = findTitle();
      const root = findProductRoot(titleEl);
      const scope = makeScope(root, titleEl);
      const page = readPageFacts(titleEl, root);
      const rowDefs = findOfferRows(root, scope);
      page.status = readPageStatus(root, scope);
      page.prices = analyzePrices(readPriceEntries(root, scope, rowDefs));
      page.shipping = readShipping(root, scope, rowDefs);

      const offers = [];
      const notes = [];
      if (page.status.status === 'reject' && !options.force) {
        notes.push('賣場不採用，依流程停止，未讀取優惠（如仍要讀取：Console 執行 PXMartHelper.capture({ force: true })）');
      } else {
        for (let index = 0; index < rowDefs.length; index += 1) {
          let row = rowDefs[index];
          if (!row.button.isConnected) row = findOfferRows(findProductRoot(findTitle()), scope)[index] || row;
          if (row.kind === 'discount') {
            setProgress(`③ 讀取現折「說明」（${index + 1}/${rowDefs.length}）…`);
            const items = await readDiscountRow(row);
            items.filter((item) => item.source === 'note').forEach((item) => notes.push(item.note));
            offers.push(...items.filter((item) => item.source !== 'note'));
          } else if (row.kind === 'points') {
            offers.push({
              source: 'points', category: '贈點回饋', summary: row.lines.join(' '), facts: parseFacts(row.lines.join(' ')),
              status: 'ignore', reason: 'PX 贈點、回饋皆不採用（賣場可採用時回饋欄填 0）', flags: [],
            });
          } else {
            offers.push({
              source: 'other', category: '其他區塊', summary: row.lines.join(' '), facts: {},
              status: 'review', reason: '不屬於現折／折價券／贈點，規則未涵蓋，未自動開啟', flags: [],
            });
          }
        }
        setProgress('④ 讀取折價券清單（不領券）…');
        const coupons = await readCoupons(root, scope);
        offers.push(...coupons.offers);
        notes.push(...coupons.notes);
        let order = 0;
        offers.forEach((offer) => {
          if (offer.source === 'discount' && offer.status === 'usable') { order += 1; offer.order = order; }
        });
      }

      latest = { mode: 'product', page, offers, notes };
      renderProduct(latest);
      const usableCount = offers.filter((offer) => offer.status === 'usable').length;
      const reviewCount = offers.filter((offer) => offer.status === 'review').length
        + (page.prices.status === 'review' ? 1 : 0) + (page.status.status === 'review' ? 1 : 0);
      setProgress(`擷取完成：可填入 ${usableCount} 項、需人工確認 ${reviewCount} 項。未做任何金額計算。`,
        page.status.status === 'reject' ? 'bad' : (reviewCount ? 'warn' : 'ok'));
      $('#copyUsable').disabled = false;
      $('#copyAll').disabled = false;
      return latest;
    } catch (error) {
      console.error('[PXMart 助手] 擷取失敗', error);
      setProgress(`擷取失敗：${oneLine(error?.message || error)}（可按「複製診斷資料」回報）`, 'bad');
      return null;
    } finally {
      busy = false;
      $('#capture').disabled = false;
    }
  }

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
      panel.style.left = `${Math.min(Math.max(0, innerWidth - rect.width), Math.max(0, event.clientX - drag.offsetX))}px`;
      panel.style.top = `${Math.min(Math.max(0, innerHeight - Math.min(rect.height, innerHeight)), Math.max(0, event.clientY - drag.offsetY))}px`;
    });
    const stop = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId); drag = null;
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', () => { panel.style.left = 'auto'; panel.style.right = '12px'; panel.style.top = '12px'; });
  }

  function destroy() {
    host.remove();
    if (window.PXMartHelper?.version === VERSION) delete window.PXMartHelper;
  }

  $('#close').addEventListener('click', destroy);
  $('#capture').addEventListener('click', () => capture());
  $('#copyUsable').addEventListener('click', () => latest && copyText(latest.mode === 'cart' ? cartTsv(latest) : productTsv(latest, true), $('#copyUsable')));
  $('#copyAll').addEventListener('click', () => latest && copyText(latest.mode === 'cart' ? cartTsv(latest) : productTsv(latest, false), $('#copyAll')));
  $('#copyDiag').addEventListener('click', () => copyText(diagnostics(), $('#copyDiag')));
  enableDragging();
  window.PXMartHelper = { version: VERSION, capture, result: () => latest, diagnostics, destroy };
  console.info(`[PXMart 優惠擷取助手 v${VERSION}] 已啟動。只讀取並分類，不計算、不領券、不加購物車。`);
})();
