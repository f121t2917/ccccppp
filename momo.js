(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * MOMO / MO+ 優惠擷取助手  v1.2.0
   * 規則來源：《MOMO&MO+ 執行步驟》簡報（22 頁）
   * 只做「讀取 + 分類 + 判斷可否採用」，不做任何金額計算。
   *
   * v1.1.0 修正
   *   1. 價格：支援「下單再折」展開，取得折扣後價格
   *   2. 折扣活動：不再強制要求日期區間，改用折扣語句比對
   *   3. 回饋：逐標籤隔離取列，「登記送」與實體贈品確實濾除
   * v1.2.0 修正
   *   4. 「下單再折」實際由最優惠折價券計算 → 讀出券內容，並依折價券排除規則判斷
   *   5. 區分「頁面明示無可用券」與「折價券 API 讀取失敗」，後者強制人工確認
   *   6. 每次點開對話框後確實關閉，避免殘留視窗污染後續步驟
   * v1.3.0 修正
   *   7. 標籤與金額分屬不同節點時也讀得到（往祖先／兄弟節點找），修正下單再折漏抓
   *   8. 價格改為「先直接讀，讀不到才點開」，避免無謂觸發會失敗的折價券 API
   * ------------------------------------------------------------------ */

  const APP_ID = 'momo-judgement-helper';
  const VERSION = '1.3.0';

  if (window.MomoJudgementHelper?.destroy) window.MomoJudgementHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  /* ========================= 基礎工具 ========================= */

  const normalize = (value) => String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);

  const unique = (items) => [...new Set(items.map(normalize).filter(Boolean))];
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  async function waitFor(check, timeout = 3000, interval = 80) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  const textIn = (element) => normalize(element?.innerText || element?.textContent);
  const rawTextIn = (element) => normalize(element?.textContent);

  const DIALOG_SELECTOR = '[role="dialog"], .dialog, .popup, .layer, [class*="modal" i]';
  const openDialogs = () => [...document.querySelectorAll(DIALOG_SELECTOR)].filter(isVisible);

  /** 關閉所有開著的對話框；殘留視窗會擋住後續的「說明」點擊與折價券入口 */
  async function closeAnyDialog(rounds = 3) {
    for (let round = 0; round < rounds; round += 1) {
      const dialogs = openDialogs();
      if (!dialogs.length) return true;
      for (const dialog of dialogs) {
        const close = [...dialog.querySelectorAll('button, a, [role="button"], span, i, svg')]
          .filter(isVisible)
          .find((element) => /^(關閉|close|×|✕|✖|X|x)$/i.test(textIn(element))
            || /close/i.test(element.className || '')
            || /close/i.test(normalize(element.getAttribute?.('aria-label'))));
        close?.click();
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(260);
    }
    return openDialogs().length === 0;
  }

  /**
   * momo 折價券 API 失敗時（getCouponDetailData 執行失敗 / 取得折價券資料失敗），
   * 畫面同樣呈現空狀態。若不攔截，「讀取失敗」會被誤判成「無可用券」而漏券。
   */
  function installErrorWatch() {
    const hits = [];
    const original = console.error;
    const record = (args) => {
      const text = args.map((item) => {
        if (typeof item === 'string') return item;
        return normalize(item?.message || item?.toString?.());
      }).join(' ');
      if (/(getCouponDetailData|取得折價券資料失敗|fetchCouponDetailData|CouponDetail)/i.test(text)) {
        hits.push(normalize(text).slice(0, 200));
      }
    };
    console.error = function patched(...args) {
      try { record(args); } catch (_) { /* 監看失敗不影響主流程 */ }
      return original.apply(console, args);
    };
    return {
      hits,
      stop() { console.error = original; return unique(hits); },
    };
  }

  function numberText(value) {
    const match = normalize(value).match(/[\d,]+/);
    return match ? match[0].replace(/,/g, '') : '';
  }

  /** 可見、且自身不含相同文字子節點的葉區塊，避免同一段文字重複計列 */
  function leafBlocks(root = document.body, selector = 'li, dd, dt, p, div, span, a, section, tr, td') {
    const all = [...root.querySelectorAll(selector)].filter(isVisible);
    return all.filter((element) => {
      const text = textIn(element);
      if (!text || text.length < 2 || text.length > 800) return false;
      const sameChild = [...element.querySelectorAll(selector)]
        .filter((child) => child !== element && isVisible(child))
        .some((child) => textIn(child) === text);
      return !sameChild;
    });
  }

  /**
   * 取「含關鍵字的最小區塊」——同一關鍵字只保留最內層那一個，
   * 避免大容器把多個標籤列合成一段，造成判斷互相污染。
   */
  function smallestBlocksContaining(keyword, maxLength = 300,
    selector = 'li, div, p, tr, dd, td, span') {
    const candidates = [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .filter((element) => {
        const text = textIn(element);
        return text.includes(keyword) && text.length <= maxLength;
      });
    return candidates.filter((element) => !candidates
      .some((other) => other !== element && element.contains(other) && textIn(other).includes(keyword)));
  }

  /* ========================= 賣場類型 ========================= */

  function detectShopType() {
    const bodyText = textIn(document.body);
    const evidence = [];

    const plusBadge = [...document.querySelectorAll('img, span, i, em, div')]
      .filter(isVisible)
      .some((element) => /^店\+$/.test(textIn(element))
        || /^店\+$/.test(normalize(element.getAttribute?.('alt'))));
    if (plusBadge) evidence.push('頁面有「店+」標記');

    const codeMatch = bodyText.match(/品號\s*[:：]?\s*([A-Za-z0-9]+)/);
    const goodsCode = codeMatch ? codeMatch[1] : '';
    if (/^TP\d+/i.test(goodsCode)) evidence.push(`品號 ${goodsCode} 為 TP 開頭`);

    const shopCoupon = /領取商店優惠券/.test(bodyText);
    if (shopCoupon) evidence.push('頁面有「領取商店優惠券」區塊');

    const crossStore = /跨店/.test(bodyText);
    if (crossStore) evidence.push('頁面出現「跨店」字樣');

    const flagship = /官方直營|旗艦店/.test(bodyText);
    if (flagship) evidence.push('頁面有「官方直營／旗艦店」標記');

    let type = '未確定';
    if (plusBadge || /^TP\d+/i.test(goodsCode) || shopCoupon) type = 'MO+';
    else if (flagship) type = '旗艦店';
    else if (goodsCode && /^\d+$/.test(goodsCode)) type = '一般MOMO';

    return { type, goodsCode, evidence };
  }

  function getTitle() {
    const heading = [...document.querySelectorAll('h1, h2')]
      .filter(isVisible)
      .map(textIn)
      .find((text) => text.length >= 4 && text.length <= 200);
    return heading || normalize(document.title);
  }

  /* ========================= 價格（步驟 2） ========================= */

  const PRICE_LABELS = ['折扣後價格', '限時折後價', '下單再折', '促銷價', 'momo價', '市售價'];

  function priceLines() {
    const blocks = leafBlocks(document.body, 'li, p, div, span, td, dd, b, strong');
    const seen = new Set();
    const out = [];
    for (const element of blocks) {
      const text = textIn(element);
      if (!text || text.length > 80) continue;
      const label = PRICE_LABELS.find((item) => text.includes(item));
      if (!label) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ label, text, element });
    }
    return out;
  }

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 讀「標籤 → 金額」。momo 常把標籤與數字拆成不同節點，例如
   *   <div>下單再折▼</div><div>5,258</div>
   * 所以除了看節點自身，還要往祖先（合併後的文字）與後續兄弟節點找。
   * 只取 3 位數以上，且數字後面不可接 % / 折 / 件，避免誤抓折數與件數。
   */
  function readLabelledPrice(label, root = document) {
    const pattern = new RegExp(`${escapeRegExp(label)}[^\\d]{0,14}\\$?\\s*([\\d,]{3,})\\s*(.?)`);
    const accept = (match) => match && !/[%折件]/.test(match[2] || '');

    const candidates = [...root.querySelectorAll('*')]
      .filter(isVisible)
      .filter((element) => {
        const text = textIn(element);
        return text.includes(label) && text.length <= 60;
      });
    if (!candidates.length) return null;

    const innermost = candidates
      .filter((element) => !candidates.some((other) => other !== element && element.contains(other)));

    for (const element of innermost) {
      let node = element;
      for (let level = 0; level <= 4 && node && node !== document.body; level += 1) {
        // a) 本層文字裡就有「標籤…金額」
        const text = textIn(node);
        if (text.length <= 200) {
          const match = text.match(pattern);
          if (accept(match)) {
            return {
              label,
              text: normalize(text).slice(0, 80),
              value: match[1].replace(/,/g, ''),
              via: level === 0 ? '同節點' : `祖先第${level}層`,
            };
          }
        }

        // b) 同層往後最多 4 個兄弟，取第一個純金額（momo 常把金額放在下一個節點）
        let sibling = node.nextElementSibling;
        for (let step = 0; step < 4 && sibling; step += 1) {
          const siblingText = textIn(sibling);
          if (siblingText && siblingText.length <= 40) {
            const numberMatch = siblingText.match(/^\D{0,4}\$?\s*([\d,]{3,})\s*(.?)/);
            if (numberMatch && !/[%折件]/.test(numberMatch[2] || '')) {
              return {
                label,
                text: `${label} ${siblingText}`,
                value: numberMatch[1].replace(/,/g, ''),
                via: level === 0 ? '兄弟節點' : `第${level}層兄弟節點`,
              };
            }
          }
          sibling = sibling.nextElementSibling;
        }

        node = node.parentElement;
      }
    }
    return null;
  }

  const hasLabelOnPage = (label) => [...document.querySelectorAll('*')]
    .filter(isVisible)
    .some((element) => {
      const text = textIn(element);
      return text.includes(label) && text.length <= 60;
    });

  /** 頁面明示「本帳號無可用折價券」的空狀態 */
  const NO_COUPON_PATTERN = /(無本商品可使用之折價券|無可使用的折價券|沒有可使用的折價券|查無.{0,6}折價券)/;

  /**
   * 「下單再折」在 momo 是由「最優惠折價券」算出來的：點它會觸發折價券 API，
   * 開出「最優惠折價券」視窗。所以這裡要
   *   a. 讀出視窗內容（券的原文，或「無可用券」空狀態）
   *   b. 一併比對頁面新增的價格文字
   *   c. 收尾一定要把視窗關掉，否則污染後續步驟
   */
  async function expandOrderDiscount() {
    const triggers = [...document.querySelectorAll('a, button, span, div, i, em, [role="button"]')]
      .filter(isVisible)
      .filter((element) => {
        const text = textIn(element);
        return /下單再折/.test(text) && text.length <= 40;
      })
      .sort((left, right) => textIn(left).length - textIn(right).length);

    if (!triggers.length) {
      return {
        found: false, revealed: [], hidden: [], triggerText: '',
        dialogText: '', explicitNoCoupon: false, fromCoupon: false,
      };
    }

    const trigger = triggers[0];
    const scope = trigger.closest('li, div, section, dl') || document.body;
    const priceLike = (text) => /[\d,]{3,}/.test(text) && text.length <= 60;
    const before = unique([...document.body.querySelectorAll('*')]
      .filter(isVisible).map(textIn).filter(priceLike));
    const dialogsBefore = openDialogs().length;

    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    trigger.click();
    await sleep(600);

    const dialogs = openDialogs();
    const dialog = dialogs.length > dialogsBefore ? dialogs[dialogs.length - 1] : null;
    const dialogText = dialog ? textIn(dialog) : '';
    const fromCoupon = /折價券/.test(dialogText);
    const explicitNoCoupon = NO_COUPON_PATTERN.test(dialogText);

    const after = unique([...document.body.querySelectorAll('*')]
      .filter(isVisible).map(textIn).filter(priceLike));
    const revealed = after.filter((text) => !before.includes(text) && /(折|價|\$)/.test(text));

    const hidden = unique([...scope.querySelectorAll('*')]
      .filter((element) => !isVisible(element))
      .map(rawTextIn)
      .filter((text) => text && priceLike(text)));

    await closeAnyDialog();

    return {
      found: true,
      triggerText: textIn(trigger),
      revealed: revealed.slice(0, 12),
      hidden: hidden.slice(0, 12),
      dialogText: dialogText.slice(0, 600),
      fromCoupon,
      explicitNoCoupon,
    };
  }

  async function capturePrice() {
    const readAll = () => {
      const map = {};
      for (const label of PRICE_LABELS) {
        const reading = readLabelledPrice(label);
        if (reading) map[label] = reading;
      }
      return map;
    };

    // 先直接讀，不點擊：避免無謂觸發會失敗的折價券 API
    let readings = readAll();
    const hasOrderDiscountLabel = hasLabelOnPage('下單再折');
    let orderDiscount = {
      found: false, clicked: false, revealed: [], hidden: [], triggerText: '',
      dialogText: '', explicitNoCoupon: false, fromCoupon: false,
    };

    // 讀不到才展開
    if (hasOrderDiscountLabel && !readings['下單再折']) {
      orderDiscount = await expandOrderDiscount();
      orderDiscount.clicked = true;
      readings = { ...readAll(), ...readings };
      if (!readings['下單再折']) {
        const fromDialog = readLabelledPrice('下單再折', document);
        if (fromDialog) readings['下單再折'] = fromDialog;
      }
    }

    const lines = priceLines();
    const merged = [];
    const seen = new Set();
    for (const item of lines) {
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      merged.push(item);
    }
    // 拆節點讀到的，補進原文列表
    for (const [label, reading] of Object.entries(readings)) {
      if (merged.some((item) => item.label === label && /[\d,]{3,}/.test(item.text))) continue;
      const text = `${reading.text}`;
      if (seen.has(text)) continue;
      seen.add(text);
      merged.push({ label, text });
    }

    const finalReading = readings['折扣後價格'] || readings['限時折後價'];
    const orderReading = readings['下單再折'];
    const revealedPrice = (orderDiscount.revealed || [])
      .find((text) => /(折扣後|再折|折後)/.test(text) && /[\d,]{3,}/.test(text))
      || (orderDiscount.revealed || []).find((text) => /[\d,]{3,}/.test(text));

    let chosenLabel = '';
    let chosenText = '';
    let chosenValue = '';
    if (finalReading) {
      ({ label: chosenLabel, text: chosenText, value: chosenValue } = finalReading);
    } else if (orderReading) {
      chosenLabel = '下單再折';
      chosenText = orderReading.text;
      chosenValue = orderReading.value;
    } else if (revealedPrice) {
      chosenLabel = '下單再折（展開後）';
      chosenText = revealedPrice;
      chosenValue = numberText(revealedPrice);
    } else if (readings['促銷價']) {
      ({ label: chosenLabel, text: chosenText, value: chosenValue } = readings['促銷價']);
    } else if (readings['momo價']) {
      ({ label: chosenLabel, text: chosenText, value: chosenValue } = readings['momo價']);
    }

    const rangeMatch = normalize(chosenText).match(/([\d,]+)\s*[~～]\s*([\d,]+)/);

    // 頁面明示無可用券 → 沒有下單再折價，取促銷價不算漏抓
    const resolvedByPage = orderDiscount.explicitNoCoupon && !orderReading;
    const orderDiscountUnresolved = hasOrderDiscountLabel
      && !finalReading && !orderReading && !revealedPrice && !resolvedByPage;

    // 下單再折價來自折價券 → 必須先套折價券排除規則才能採用
    const needCouponRuleCheck = Boolean(orderReading || revealedPrice)
      && Boolean(chosenLabel && /下單再折/.test(chosenLabel));

    return {
      lines: merged.map((item) => ({ label: item.label, text: item.text })),
      readings,
      orderDiscount,
      chosenLabel,
      chosenText,
      chosenValue: rangeMatch ? '' : (chosenValue || numberText(chosenText)),
      isRange: Boolean(rangeMatch),
      rangeText: rangeMatch ? rangeMatch[0] : '',
      hasOrderDiscountLabel,
      orderDiscountUnresolved,
      resolvedByPage,
      needCouponRuleCheck,
    };
  }

  /* ========================= 賣場層級檢查 ========================= */

  function getPageExclusions() {
    const interactives = unique(
      [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
        .filter(isVisible)
        .map((element) => element.value || element.innerText || element.textContent)
        .filter((text) => normalize(text).length <= 80),
    );
    const reasons = [];
    if (interactives.some((text) => /^(售完|已售完|補貨中)$/.test(text))) reasons.push('頁面顯示售完');
    if (interactives.some((text) => text.includes('有貨通知'))) reasons.push('頁面顯示有貨通知');
    if (interactives.some((text) => text.includes('前往活動賣場'))) reasons.push('頁面只能前往活動賣場');
    if (interactives.some((text) => text === '選購')) reasons.push('購買按鈕為選購');
    return { reasons: unique(reasons), interactives };
  }

  function getPurchaseLimit() {
    const text = textIn(document.body);
    const match = text.match(/每人限購\s*\d+\s*[組件個]?[^。\n]{0,20}/);
    return match ? normalize(match[0]) : '';
  }

  function getProductSections() {
    const text = textIn(document.body);
    return {
      hasFeature: /商品特色|商品描述|商品介紹/.test(text),
      hasSpec: /商品規格|規格說明|商品資訊/.test(text),
    };
  }

  /* ========================= 原文事實解析（不計算） ========================= */

  function parseFacts(text) {
    const value = normalize(text).replace(/，/g, ',').replace(/％/g, '%');
    const threshold = value.match(/(?:單品|訂單|單筆|跨店|每)?\s*滿\s*\$?\s*([\d,]+)\s*(?:元)?/);
    const pieceThreshold = value.match(/滿\s*([\d,]+)\s*件/);
    const fixedDiscount = value.match(/(?:再折|現折|折抵|折)\s*\$?\s*([\d,]+)\s*元/);
    const rateDiscount = value.match(/([\d.]+)\s*折(?:\D|$)/);
    const coinFixed = value.match(/送\s*(?:momo幣|mo幣)\s*([\d,]+)\s*元?/i)
      || value.match(/送\s*([\d,]+)\s*(?:momo幣|mo幣)/i);
    const coinRate = value.match(/(?:momo幣|mo幣)[^。\n]{0,8}?([\d.]+)\s*%/i)
      || value.match(/([\d.]+)\s*%[^。\n]{0,8}?(?:momo幣|mo幣)/i)
      || value.match(/刷\s*(?:momo|mo)卡[^。\n]{0,20}?([\d.]+)\s*%/i);
    const pointRate = value.match(/mo點[^。\n]{0,8}?([\d.]+)\s*%/i)
      || value.match(/([\d.]+)\s*%[^。\n]{0,8}?mo點/i);
    const pointFixed = value.match(/送\s*mo點\s*([\d,]+)/i)
      || value.match(/送\s*([\d,]+)\s*mo點/i);
    const cap = value.match(/(?:上限|最高折|累加上限|回饋上限)[^。\n]{0,8}?([\d,]+\s*[千萬]?)/);
    const freeShipThreshold = value.match(/(?:訂單滿|滿)\s*\$?\s*([\d,]+)\s*元?\s*免運/);

    let benefit = '';
    let unit = '';
    if (coinFixed) [benefit, unit] = [coinFixed[1].replace(/,/g, ''), 'mo幣'];
    else if (coinRate) [benefit, unit] = [coinRate[1], '% mo幣'];
    else if (pointFixed) [benefit, unit] = [pointFixed[1].replace(/,/g, ''), 'mo點'];
    else if (pointRate) [benefit, unit] = [pointRate[1], '% mo點'];
    else if (fixedDiscount) [benefit, unit] = [fixedDiscount[1].replace(/,/g, ''), '元'];
    else if (rateDiscount) [benefit, unit] = [rateDiscount[1], '折'];

    return {
      threshold: threshold ? threshold[1].replace(/,/g, '') : '',
      pieceThreshold: pieceThreshold ? pieceThreshold[1].replace(/,/g, '') : '',
      benefit,
      unit,
      cap: cap ? normalize(cap[1]).replace(/,/g, '') : '',
      freeShipThreshold: freeShipThreshold ? freeShipThreshold[1].replace(/,/g, '') : '',
    };
  }

  function quotaFrom(text) {
    const match = normalize(text).match(/(?:限量|限前|名額)\s*[^\d]{0,4}([\d,]+)\s*(人|名|份|筆|組)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  /* ========================= 判斷規則（完全依簡報） ========================= */

  function classifyOffer(offer, shopType) {
    const own = normalize(`${offer.label || ''} ${offer.summary || ''}`);
    const text = normalize(`${own} ${offer.detailText || ''}`);
    const isMoPlus = shopType === 'MO+';

    /* ---- 硬規則 1：登記送一律不採用（只使用免登記的優惠和回饋） ----
       以「該列自己的標籤 / 原文」判定，不看相鄰列，避免同容器的
       「免登記」把「登記送」洗掉。 */
    if (offer.tag === '登記送') {
      return { status: 'reject', reason: '登記送回饋優惠不採用（只使用免登記的優惠和回饋）' };
    }
    const ownNoRegistration = /(免登記|不需登記|無須登記|不用登記)/.test(own);
    if (!ownNoRegistration && /(登記送|須登記|需登記|限登記|登記回饋|登記領|登記抽|登記活動|立即登記)/.test(own)) {
      return { status: 'reject', reason: '登記送回饋優惠不採用（只使用免登記的優惠和回饋）' };
    }

    /* ---- 硬規則 2：非幣、非點數的實體贈品一律忽略 ---- */
    const giftRow = ['贈品', '滿件贈'].includes(offer.tag) || /贈品/.test(own);
    const hasCurrency = /(momo幣|mo幣|mo點|momo點)/i.test(text);
    if (giftRow && !hasCurrency) {
      return { status: 'ignore', reason: '非幣／非點數的實體贈品，無視物品' };
    }

    // 會員專屬類（含 MO+ 不可使用的四種）
    if (/(會員專屬|專屬優惠|指定會員|新客專屬|追蹤商店專屬|回購專屬|限會員)/.test(text)) {
      return { status: 'reject', reason: '會員專屬／新客專屬／追蹤商店專屬／回購專屬不採用' };
    }
    if (offer.couponType === '商店抵用券') {
      return { status: 'reject', reason: 'MO+ 賣場：商店抵用券不可使用' };
    }

    // 限定特別支付方式（頁面預設的「刷mo卡享X%」屬預設回饋，不算限定支付）
    const defaultMoCard = /刷\s*(?:momo|mo)卡[^。\n]{0,24}?[\d.]+\s*%/i.test(own);
    const paymentRestricted = !defaultMoCard
      && (/(限|僅限|指定)[^。\n]{0,20}(支付|Pay|pay|PAY|卡別|信用卡|聯名卡)/.test(text)
        || /刷[^。\n]{0,10}卡(?![^。\n]{0,24}?[\d.]\s*%)/.test(own));
    if (paymentRestricted) return { status: 'reject', reason: '限定特別支付方式不採用' };

    // 一般MOMO 折價券字樣排除
    if (offer.kind === 'coupon' && !isMoPlus
      && /(\d+\s*月|限定|限時|秘密|專屬|獨家|會員)/.test(own)) {
      return { status: 'reject', reason: '一般MOMO折價券含 月份／限定／限時／秘密／專屬／獨家／會員 不採用' };
    }

    // 限量規則（MO+ 三種可用券豁免：無論是否限量）
    const quota = quotaFrom(text);
    const vagueLimited = /(數量有限|送完為止|贈完為止)/.test(text);
    const bareLimited = /限量/.test(text) && !Number.isFinite(quota) && !vagueLimited;
    const underThousand = Number.isFinite(quota) && quota < 1000;
    const moPlusExempt = isMoPlus && offer.kind === 'coupon'
      && ['單品折價券', '單店抵用券', '商店免運券'].includes(offer.couponType);
    if (!moPlusExempt) {
      if (underThousand) return { status: 'reject', reason: `限量名額 ${quota}，少於 1,000 不採用` };
      if (bareLimited) return { status: 'reject', reason: '只寫限量、未標註名額，不採用' };
    }

    // 需人工確認
    if (offer.mixedTags) {
      return { status: 'review', reason: `此區塊同時含多個標籤（${offer.mixedTags}），請人工拆分後判斷` };
    }
    if (offer.detailRequired && !offer.detailLoaded) {
      return { status: 'review', reason: '須點開「說明／查看贈品」查看，本次未讀到明細' };
    }
    if (offer.kind === 'coupon' && offer.couponType === '未分類折價券') {
      return { status: 'review', reason: '頁面未明示券別，不自行分類' };
    }
    if (offer.kind === 'unknown') {
      return { status: 'review', reason: '頁面標籤未列於既有規則，請人工確認' };
    }
    if (offer.kind === 'coupon' && shopType === '未確定') {
      return { status: 'review', reason: '賣場類型未確定，券別規則無法套用' };
    }

    // 可採用
    if (vagueLimited) return { status: 'usable', reason: '限量但標示「數量有限送完為止」，可使用' };
    if (Number.isFinite(quota) && quota >= 1000) {
      return { status: 'usable', reason: `限量名額 ${quota}，不少於 1,000，可使用` };
    }
    if (moPlusExempt) return { status: 'usable', reason: 'MO+ 可使用券，符合門檻均可採用（限量也可以）' };
    return { status: 'usable', reason: '未觸發任何排除條件' };
  }

  function combineRule(offer, shopType) {
    if (shopType !== 'MO+') {
      if (offer.kind === 'discount' || offer.kind === 'coupon') {
        return '擇優：一般MOMO 折扣活動 & 折價券僅擇 1 種最優惠';
      }
    } else {
      if (offer.couponType === '單品折價券') return '擇優：單品折價券 vs 單店折扣活動（不可疊加）；可與跨店活動併用';
      if (offer.couponType === '單店抵用券') return '可併用：單店抵用券可與折扣活動併用';
      if (offer.couponType === '商店免運券') return '可使用：符合條件免運券可用；若無可用則依配送方式最低運費';
      if (offer.kind === 'discount' && offer.scope === '單店') return '擇優：單店折扣活動 vs 單品折價券（不可疊加）';
      if (offer.kind === 'discount' && offer.scope === '跨店') return '可併用：跨店活動可與單品折價券併用';
    }
    if (offer.kind === 'reward') {
      if (offer.tag === '免登記') return '擇優：免登記 mo卡回饋 與 預設 3% 擇優';
      if (offer.tag === '預設') return '基準：可與 滿件贈 / mo幣加碼 疊加；與免登記 mo卡回饋擇優';
      if (/(滿件贈|加碼)/.test(offer.tag || '')) return '可疊加：滿件贈 mo幣 / mo幣加碼 可與預設 3% 疊加';
      return '獨立';
    }
    if (offer.kind === 'mopro') return '獨立：填 discount_mopro 欄位，不須備註折扣';
    return '獨立';
  }

  /* ========================= 擷取：折扣活動 ========================= */

  /** 折扣語句——不要求日期區間（很多頁面沒有日期，例如「滿1件享95折」） */
  const DISCOUNT_PATTERNS = [
    /滿\s*\d+\s*件\s*(?:享|打|再)?\s*[\d.]+\s*折/,
    /滿\s*\$?\s*[\d,]+\s*元?\s*(?:再|現)?折\s*\$?\s*[\d,]+/,
    /每\s*\$?\s*[\d,]+\s*元?\s*折\s*\$?\s*[\d,]+/,
    /(?:單品|單店|跨店|全館|本館)[^。\n]{0,14}[\d.]+\s*折/,
    /(?:跨店|單店)[^。\n]{0,14}折\s*\$?\s*[\d,]+/,
    /(?:直降|下殺|限時)\s*[\d.]+\s*折/,
    /滿\s*\$?\s*[\d,]+\s*元?\s*享\s*[\d.]+\s*折/,
  ];
  const DATE_RANGE = /\d{1,2}\/\d{1,2}\s*[~～-]\s*\d{1,2}\/\d{1,2}/;
  const REWARD_TAGS = ['免登記', '登記送', '滿件贈', '贈品', 'mo幣加碼', 'mo點加碼', 'momo幣加碼'];

  function isDiscountRow(text) {
    if (text.length > 300) return false;
    if (/(折價券|抵用券|免運券|優惠券)/.test(text)) return false;     // 券歸券，另行處理
    if (REWARD_TAGS.some((tag) => text.startsWith(tag))) return false; // 回饋列另行處理
    if (PRICE_LABELS.some((label) => text.startsWith(label))) return false;
    return DISCOUNT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function discountRows() {
    const blocks = leafBlocks(document.body, 'li, p, div, tr, dd, td, a, span');
    const hits = blocks.filter((element) => isDiscountRow(textIn(element)));
    // 同一段文字只留最內層
    const rows = hits.filter((element) => !hits
      .some((other) => other !== element && element.contains(other)
        && isDiscountRow(textIn(other))));
    const seen = new Set();
    return rows.filter((element) => {
      const key = textIn(element);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function discountScope(text) {
    if (/跨店/.test(text)) return '跨店';
    if (/(單店|單品|全館|本館|滿\s*\d+\s*件)/.test(text)) return '單店';
    return '';
  }

  /** 折扣活動的促銷標籤（例如列旁的「95折」小標） */
  function promoLabelNear(element) {
    const container = element.closest('li, div, dd, tr') || element;
    const candidates = [...container.querySelectorAll('a, span, em, b, i')]
      .filter(isVisible)
      .map(textIn)
      .filter((text) => /^[\d.]+\s*折$/.test(text) || /^滿[\d,]+(元|件)?.{0,8}$/.test(text));
    return candidates[0] || '';
  }

  async function openDetail(row) {
    const trigger = [...row.querySelectorAll('a, button, span, [role="button"], img')]
      .filter(isVisible)
      .find((element) => /^[（(]?(說明|活動說明|詳情|查看贈品|查看說明)[）)]?$/.test(textIn(element)));
    if (!trigger) return { loaded: false, detailText: '' };

    await closeAnyDialog();            // 先確保沒有殘留視窗擋住這次點擊
    const before = openDialogs().length;
    trigger.click();
    const dialog = await waitFor(() => {
      const nodes = openDialogs();
      return nodes.length > before ? nodes[nodes.length - 1] : null;
    }, 3000);
    if (!dialog) { await closeAnyDialog(); return { loaded: false, detailText: '' }; }
    await sleep(220);
    const detailText = textIn(dialog);
    await closeAnyDialog();            // 收尾一定要關，否則污染下一列
    return { loaded: true, detailText };
  }

  async function captureDiscounts(shopType, onProgress) {
    const rows = discountRows();
    const offers = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const summary = textIn(row);
      onProgress(`讀取折扣活動 ${index + 1}/${rows.length}`);
      const hasDetailLink = /[（(]?說明[）)]?/.test(summary);
      const detail = hasDetailLink ? await openDetail(row) : { loaded: false, detailText: '' };
      const scope = discountScope(`${summary} ${detail.detailText}`);
      const offer = {
        kind: 'discount',
        tag: '',
        scope,
        category: scope === '跨店' ? '跨店折扣活動' : '單店折扣活動',
        couponType: '',
        label: promoLabelNear(row) || (scope ? `${scope}折扣` : '折扣活動'),
        summary,
        hasDate: DATE_RANGE.test(summary),
        detailRequired: hasDetailLink,
        detailLoaded: detail.loaded,
        detailText: detail.detailText,
        order: index + 1,
        facts: parseFacts(`${summary} ${detail.detailText}`),
      };
      Object.assign(offer, classifyOffer(offer, shopType));
      offer.combine = combineRule(offer, shopType);
      offers.push(offer);
    }
    return offers;
  }

  /* ========================= 擷取：折價券 ========================= */

  function couponType(text) {
    const value = normalize(text);
    if (/單品折價券|單品券/.test(value)) return '單品折價券';
    if (/單店抵用券|單店券/.test(value)) return '單店抵用券';
    if (/(商店免運券|免運券)/.test(value)) return '商店免運券';
    if (/商店抵用券/.test(value)) return '商店抵用券';
    return '未分類折價券';
  }

  function needLogin() {
    return [...document.querySelectorAll('a, button, [role="button"]')]
      .some((element) => isVisible(element) && /^(登入|會員登入)$/.test(textIn(element)));
  }

  async function captureCoupons(shopType, onProgress, errorWatch) {
    const notes = [];
    const loggedOut = needLogin();
    if (loggedOut) notes.push('頁面偵測到「登入」，折價券須登入帳戶才能看到，請先登入再重跑助手');

    await closeAnyDialog();
    const entry = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter(isVisible)
      .find((element) => /查看可使用的折價券|查看折價券|領取商店優惠券/.test(textIn(element)));
    let dialogText = '';
    if (entry) {
      onProgress('開啟折價券清單（不領券）');
      entry.click();
      const dialog = await waitFor(() => openDialogs().pop() || null, 3500);
      await sleep(360);
      dialogText = dialog ? textIn(dialog) : textIn(openDialogs().pop());
    } else {
      notes.push('頁面未找到折價券入口');
    }
    const explicitNoCoupon = NO_COUPON_PATTERN.test(dialogText);

    // MO+ 橫向券列：捲到底才算讀完
    const sliders = [...document.querySelectorAll('div, ul')]
      .filter((element) => isVisible(element) && element.scrollWidth > element.clientWidth + 40);
    for (const slider of sliders) {
      for (let step = 0; step < 12 && slider.scrollLeft + slider.clientWidth < slider.scrollWidth; step += 1) {
        slider.scrollLeft += slider.clientWidth;
        await sleep(120);
      }
    }
    if (sliders.length) notes.push(`已將 ${sliders.length} 個橫向券列捲到底；若畫面仍有未載入的券，請手動滑到底後重跑`);

    const scope = [...document.querySelectorAll('[role="dialog"], .dialog, .popup, [class*="modal" i]')]
      .filter(isVisible).pop() || document.body;

    const rows = leafBlocks(scope, 'li, div, tr')
      .filter((element) => {
        const text = textIn(element);
        return /(折價券|抵用券|免運券)/.test(text) && text.length >= 6 && text.length <= 400
          && !/查看可使用的折價券/.test(text);
      });

    const seen = new Set();
    const offers = [];
    for (const row of rows) {
      const summary = textIn(row);
      if (seen.has(summary)) continue;
      seen.add(summary);
      const type = couponType(summary);
      const offer = {
        kind: 'coupon',
        tag: '',
        scope: '',
        category: type,
        couponType: type,
        label: type,
        summary,
        detailRequired: false,
        detailLoaded: true,
        detailText: '',
        facts: parseFacts(summary),
      };
      Object.assign(offer, classifyOffer(offer, shopType));
      offer.combine = combineRule(offer, shopType);
      offers.push(offer);
    }

    await closeAnyDialog();

    // 空清單有三種成因，必須分開，否則「讀取失敗」會被當成「無券」而漏券
    const apiErrors = unique(errorWatch?.hits || []);
    let couponState = 'ok';
    if (!offers.length) {
      if (explicitNoCoupon) {
        couponState = 'none';
        notes.push('折價券：頁面明示「帳號無本商品可使用之折價券」→ 判定為無可用折價券');
      } else if (apiErrors.length) {
        couponState = 'failed';
        notes.push(`折價券讀取失敗（${apiErrors[0]}），空白不代表無券，必須人工重整頁面確認`);
      } else if (loggedOut) {
        couponState = 'logged-out';
        notes.push('折價券：未登入，無法判定有無可用券，請登入後重跑');
      } else {
        couponState = 'unknown';
        notes.push('未讀到任何折價券項目，且頁面未明示無券，請人工確認');
      }
    } else if (apiErrors.length) {
      notes.push(`折價券 API 曾回報錯誤（${apiErrors[0]}），已讀到的券可能不完整，請人工複查`);
    }

    return { offers, notes, couponState, explicitNoCoupon, apiErrors, dialogText: dialogText.slice(0, 600) };
  }

  /* ========================= 擷取：回饋 ========================= */

  /** 頁面預設 mo 卡回饋，寫法多變：刷momo卡消費回饋最高3% / 刷mo卡享3%，回饋上限翻倍至2千 */
  function defaultMoCardReward() {
    const blocks = leafBlocks(document.body, 'li, div, p, span, td, a');
    const hit = blocks.map(textIn)
      .find((text) => /刷\s*(?:momo|mo)卡[^。\n]{0,30}?[\d.]+\s*%/i.test(text) && text.length <= 120);
    if (!hit) return null;
    const offer = {
      kind: 'reward',
      tag: '預設',
      scope: '',
      category: 'mo幣（預設）',
      couponType: '',
      label: '預設',
      summary: hit,
      detailRequired: false,
      detailLoaded: true,
      detailText: '',
      facts: parseFacts(hit),
      status: 'usable',
      reason: '頁面標示的 momo 卡預設回饋',
    };
    offer.combine = combineRule(offer, '');
    return offer;
  }

  /** 逐標籤取最小區塊，避免多列黏在一起互相污染判斷 */
  function rewardRows() {
    const collected = [];
    const seen = new Set();
    for (const tag of REWARD_TAGS) {
      for (const element of smallestBlocksContaining(tag)) {
        const text = textIn(element);
        if (seen.has(text)) continue;
        seen.add(text);
        const others = REWARD_TAGS.filter((item) => item !== tag && text.includes(item));
        collected.push({ tag, element, text, mixedTags: others.length ? [tag, ...others].join('／') : '' });
      }
    }
    return collected;
  }

  function rewardCategory(text) {
    const value = normalize(text);
    if (/mo點/i.test(value)) return 'mo點';               // mo點加碼不可視為 mo幣
    if (/(momo幣|mo幣)/i.test(value)) return 'mo幣';
    return '其他回饋';
  }

  const isMoProMemberPoint = (text) => /moPro/i.test(text) && /mo點/i.test(text);
  const isSiteWideMemberPoint = (text) => /全站會員/.test(text) && /mo點/i.test(text);

  async function captureRewards(shopType, onProgress) {
    const offers = [];
    const seen = new Set();

    const base = defaultMoCardReward();
    if (base) { offers.push(base); seen.add(base.summary); }

    const rows = rewardRows();
    for (let index = 0; index < rows.length; index += 1) {
      const { tag, element, text, mixedTags } = rows[index];
      if (seen.has(text)) continue;
      seen.add(text);
      onProgress(`讀取回饋 ${index + 1}/${rows.length}`);

      const needDetail = ['滿件贈', '贈品'].includes(tag) || /查看贈品/.test(text);
      const detail = needDetail ? await openDetail(element) : { loaded: false, detailText: '' };
      const full = `${text} ${detail.detailText}`;

      const offer = {
        kind: 'reward',
        tag,
        mixedTags,
        scope: '',
        category: rewardCategory(full),
        couponType: '',
        label: tag,
        summary: text,
        detailRequired: needDetail,
        detailLoaded: needDetail ? detail.loaded : true,
        detailText: detail.detailText,
        facts: parseFacts(full),
      };
      Object.assign(offer, classifyOffer(offer, shopType));
      offer.combine = combineRule(offer, shopType);

      if (offer.status === 'usable' && isMoProMemberPoint(full)) {
        offer.status = 'note-only';
        offer.category = '僅備註';
        offer.reason = 'moPro 會員送 mo點：僅需備註，不計入公式';
      } else if (offer.status === 'usable' && isSiteWideMemberPoint(full)) {
        offer.reason = `${offer.reason}；會員條件為全站會員，可套用並備註`;
      }
      offers.push(offer);
    }
    return offers;
  }

  /* ========================= 擷取：moPro 折扣 ========================= */

  function captureMoPro(shopType) {
    const rows = leafBlocks(document.body, 'li, div, p, tr')
      .filter((element) => {
        const text = textIn(element);
        return /moPro/i.test(text) && /(再省|省\s*[\d,]+\s*元)/.test(text) && text.length <= 200;
      });
    const offers = [];
    const seen = new Set();
    for (const row of rows) {
      const summary = textIn(row);
      if (seen.has(summary) || /mo點/i.test(summary)) continue;
      seen.add(summary);
      const amount = summary.match(/(?:再省|省)\s*([\d,]+)\s*元/);
      const offer = {
        kind: 'mopro',
        tag: '',
        scope: '',
        category: 'moPro折扣',
        couponType: '',
        label: 'moPro',
        summary,
        detailRequired: false,
        detailLoaded: true,
        detailText: '',
        facts: { ...parseFacts(summary), benefit: amount ? amount[1].replace(/,/g, '') : '', unit: '元' },
      };
      Object.assign(offer, classifyOffer(offer, shopType));
      offer.combine = combineRule(offer, shopType);
      offers.push(offer);
    }
    return offers;
  }

  /* ========================= 擷取：運費 ========================= */

  function captureShipping(shopType) {
    const options = unique(leafBlocks(document.body, 'li, div, p, tr, td')
      .map(textIn)
      .filter((text) => /(運費|免運)/.test(text) && text.length <= 200));
    const needCalculate = shopType === 'MO+';
    return {
      shopType,
      needCalculate,
      fieldValue: needCalculate ? '' : '0',
      note: needCalculate
        ? 'MO+ 賣場：未符合免運門檻須計算最低運費；運費門檻判定在折扣計算完畢之後'
        : '一般MOMO／旗艦店：不計運費，shipping_fee_momo 填 0',
      options,
    };
  }

  /* ========================= UI ========================= */

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
      header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
        justify-content: space-between; gap: 8px; padding: 11px 12px; color: #fff; background: #d6006e;
        cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.5); border-radius: 6px; cursor: pointer; }
      main { padding: 12px; }
      section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; margin-bottom: 6px; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 96px 1fr; gap: 4px 8px; }
      .facts b { overflow-wrap: anywhere; }
      label { display: block; margin-top: 8px; color: #334155; font-size: 12px; }
      textarea { width: 100%; min-height: 54px; margin-top: 3px; padding: 7px 8px; resize: vertical;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button.action { padding: 8px 11px; color: #fff; background: #d6006e; border: 0;
        border-radius: 6px; cursor: pointer; font: inherit; font-weight: 700; }
      button.action:disabled { opacity: .55; cursor: wait; }
      button.secondary { color: #334155; background: #f1f5f9; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .usable { color: #166534; } .reject { color: #b42318; } .review { color: #92400e; }
      .ignore { color: #64748b; } .noteonly { color: #6d28d9; }
      .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回到右上角">
        <strong>MOMO / MO+ 優惠擷取助手 v${VERSION}</strong>
        <button id="close" title="關閉">×</button>
      </header>
      <main>
        <section id="pageSection"></section>
        <div id="progress" class="status info">尚未擷取。按下「自動抓取優惠」。</div>
        <div class="actions">
          <button class="action" id="capture">自動抓取優惠</button>
          <button class="action secondary" id="copyUsable" disabled>複製可填資料</button>
          <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
        </div>
        <section id="filledSection" class="hidden">
          <h2>符合規則，可填入表單欄位</h2>
          <label>price_momo（價格）<textarea id="outPrice" readonly></textarea></label>
          <label>discount_momo（折扣：折扣活動／折價券）<textarea id="outDiscount" readonly></textarea></label>
          <label>discount_mopro（moPro 折扣）<textarea id="outMoPro" readonly></textarea></label>
          <label>coinback_momo（mo幣回饋）<textarea id="outCoin" readonly></textarea></label>
          <label>Pointsback_platform_momo（mo點回饋）<textarea id="outPoint" readonly></textarea></label>
          <label>shipping_fee_momo（運費）<textarea id="outShip" readonly></textarea></label>
          <label>note_momo（備註：任何優惠 &amp; 折扣）<textarea id="outNote" readonly></textarea></label>
          <p class="muted">保留網頁原文與門檻／折數，不做任何金額計算、不挑最優惠。已排除的項目不會進入備註。</p>
        </section>
        <section id="decisionSection" class="hidden"></section>
      </main>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;
  let busy = false;

  function setProgress(message, type = 'info') {
    $('#progress').className = `status ${type}`;
    $('#progress').textContent = message;
  }

  function renderPageHeader(base) {
    const { shop, title, price, exclusion, limit, sections } = base;
    const domain = /momoshop\.com\.tw$/i.test(location.hostname)
      ? '' : '<div class="status warn">目前不是 momoshop 網域</div>';
    const pageStatus = exclusion.reasons.length
      ? `<div class="status bad">賣場不採用：${escapeHtml(exclusion.reasons.join('、'))}</div>`
      : '<div class="status ok">未偵測到賣場排除條件（售完／有貨通知／前往活動賣場／選購）</div>';
    const shopStatus = shop.type === '未確定'
      ? '<div class="status warn">賣場類型未確定，運費與券別規則請人工判斷</div>'
      : `<div class="status info">賣場類型：${escapeHtml(shop.type)}</div>`;
    const priceWarn = price?.isRange
      ? `<div class="status warn">價格為區間 ${escapeHtml(price.rangeText)}，須點選品項後重抓</div>` : '';
    const orderWarn = price?.orderDiscountUnresolved
      ? '<div class="status warn">頁面有「下單再折」，但展開後仍讀不到折扣後價格，請人工點開確認</div>' : '';
    const checkStatus = (sections.hasFeature && sections.hasSpec)
      ? '<div class="status info">頁面有商品特色與商品規格區塊，請人工查看</div>'
      : '<div class="status warn">未同時找到商品特色／商品規格區塊，請人工確認</div>';

    $('#pageSection').innerHTML = `<h2>商品頁</h2>${domain}${shopStatus}${pageStatus}${priceWarn}${orderWarn}${checkStatus}
      <div class="facts">
        <span>商品</span><b>${escapeHtml(title)}</b>
        <span>品號</span><b>${escapeHtml(shop.goodsCode) || '未讀到'}</b>
        <span>類型依據</span><b>${escapeHtml(shop.evidence.join('；')) || '無'}</b>
        <span>價格各列</span><b>${escapeHtml((price?.lines || []).map((line) => line.text).join('｜')) || '未讀到'}</b>
        <span>採用價格</span><b>${escapeHtml(price?.chosenLabel ? `${price.chosenLabel}：${price.chosenText}` : '未確定')}</b>
        <span>下單再折</span><b>${(() => {
    if (!price) return '尚未讀取';
    const reading = price.readings?.['下單再折'];
    if (reading) return escapeHtml(`${reading.value}（${reading.text}，來源：${reading.via}）`);
    if (!price.hasOrderDiscountLabel) return '頁面無此標示';
    if (price.resolvedByPage) return '由最優惠折價券計算；頁面明示無可用券 → 無下單再折價';
    const extra = [...(price.orderDiscount?.revealed || []), ...(price.orderDiscount?.hidden || [])].join('｜');
    return escapeHtml(extra || price.orderDiscount?.dialogText || '有標示但讀不到數字，請人工確認');
  })()}</b>
        <span>限購</span><b>${escapeHtml(limit) || '未標示'}</b>
      </div>`;
  }

  function outputLine(offer) {
    const facts = offer.facts || {};
    const extras = [
      facts.threshold ? `門檻=${facts.threshold}` : '',
      facts.pieceThreshold ? `件數門檻=${facts.pieceThreshold}` : '',
      facts.benefit ? `優惠=${facts.benefit}${facts.unit}` : '',
      facts.cap ? `上限=${facts.cap}` : '',
      facts.freeShipThreshold ? `免運門檻=${facts.freeShipThreshold}` : '',
      offer.scope ? `範圍=${offer.scope}` : '',
      offer.order ? `頁面順序=${offer.order}` : '',
      offer.combine ? `關係=${offer.combine}` : '',
    ].filter(Boolean);
    return `${offer.label ? `[${offer.label}] ` : ''}${offer.summary}${extras.length ? `｜${extras.join('｜')}` : ''}`;
  }

  function renderOfferList(items, cssClass) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((offer) => `<li class="${cssClass}">
      <b>${escapeHtml(offer.category)}｜${escapeHtml(offer.reason)}</b><br>
      ${escapeHtml(offer.label ? `[${offer.label}] ${offer.summary}` : offer.summary)}
      ${offer.combine ? `<div class="evidence">關係：${escapeHtml(offer.combine)}</div>` : ''}
      ${offer.detailText ? `<div class="evidence">明細：${escapeHtml(offer.detailText.slice(0, 220))}</div>` : ''}
    </li>`).join('')}</ul>`;
  }

  function renderResults(result) {
    const { offers } = result;
    const usable = offers.filter((offer) => offer.status === 'usable');
    const review = offers.filter((offer) => offer.status === 'review');
    const rejected = offers.filter((offer) => offer.status === 'reject');
    const ignored = offers.filter((offer) => offer.status === 'ignore');
    const noteOnly = offers.filter((offer) => offer.status === 'note-only');
    const byKind = (predicate) => usable.filter(predicate).map(outputLine).join('\n');

    $('#outPrice').value = [
      result.price.chosenLabel ? `${result.price.chosenLabel}：${result.price.chosenText}` : '',
      result.price.chosenValue ? `數值：${result.price.chosenValue}` : '',
      ...result.price.lines.filter((line) => line.text !== result.price.chosenText)
        .map((line) => `（參考）${line.text}`),
      result.limit ? `限購：${result.limit}` : '',
    ].filter(Boolean).join('\n');

    $('#outDiscount').value = byKind((offer) => offer.kind === 'discount'
      || (offer.kind === 'coupon' && offer.couponType !== '商店免運券'));
    $('#outMoPro').value = byKind((offer) => offer.kind === 'mopro');
    $('#outCoin').value = byKind((offer) => offer.kind === 'reward' && /mo幣/.test(offer.category));
    $('#outPoint').value = byKind((offer) => offer.kind === 'reward' && /mo點/.test(offer.category));
    $('#outShip').value = [
      result.shipping.needCalculate ? '需計算最低運費' : `填 ${result.shipping.fieldValue}`,
      result.shipping.note,
      ...usable.filter((offer) => offer.couponType === '商店免運券').map(outputLine),
      ...result.shipping.options.map((text) => `配送方式原文：${text}`),
    ].filter(Boolean).join('\n');

    // 備註只收「可填入」與「僅備註」；不採用／忽略一律不進備註
    $('#outNote').value = [...usable, ...noteOnly]
      .filter((offer) => offer.kind !== 'reward' || offer.tag !== '預設' || true)
      .map((offer) => `${offer.label ? `[${offer.label}] ` : ''}${offer.summary}`)
      .concat(result.limit ? [`限購：${result.limit}`] : [])
      .join('\n');

    $('#filledSection').classList.remove('hidden');
    const couponBanner = {
      failed: '<div class="status bad">折價券讀取失敗：清單空白不代表無券，請重整頁面後重跑，或人工開啟折價券確認</div>',
      none: '<div class="status ok">折價券：頁面明示帳號無本商品可使用之折價券 → 判定為無可用折價券</div>',
      'logged-out': '<div class="status warn">折價券：尚未登入，無法判定有無可用券</div>',
      unknown: '<div class="status warn">折價券：未讀到項目且頁面未明示無券，請人工確認</div>',
    }[result.couponState] || '';

    $('#decisionSection').innerHTML = `<h2>逐項判斷</h2>
      ${couponBanner}
      ${result.notes.map((note) => `<div class="status warn">${escapeHtml(note)}</div>`).join('')}
      <details open><summary class="usable">可填入（${usable.length}）</summary>${renderOfferList(usable, 'usable')}</details>
      <details open><summary class="noteonly">僅備註不計入（${noteOnly.length}）</summary>${renderOfferList(noteOnly, 'noteonly')}</details>
      <details open><summary class="review">需人工確認（${review.length}）</summary>${renderOfferList(review, 'review')}</details>
      <details><summary class="reject">不採用（${rejected.length}）</summary>${renderOfferList(rejected, 'reject')}</details>
      <details><summary class="ignore">忽略（${ignored.length}）</summary>${renderOfferList(ignored, 'ignore')}</details>`;
    $('#decisionSection').classList.remove('hidden');
    $('#copyUsable').disabled = usable.length === 0;
    $('#copyAll').disabled = offers.length === 0;
  }

  function toTsv(result, onlyUsable) {
    const rows = onlyUsable
      ? result.offers.filter((offer) => ['usable', 'note-only'].includes(offer.status))
      : result.offers;
    const header = ['網址', '商品', '品號', '賣場類型', '採用價格', '價格各列', '限購', '判定', '類別',
      '標籤', '範圍', '券別', '原文', '門檻', '件數門檻', '優惠值', '單位', '上限', '免運門檻',
      '疊加關係', '頁面順序', '明細', '理由'];
    const clean = (value) => normalize(value).replace(/[\t\r\n]+/g, ' ');
    const data = rows.map((offer) => [
      location.href, result.title, result.shop.goodsCode, result.shop.type,
      `${result.price.chosenLabel}:${result.price.chosenText}`,
      result.price.lines.map((line) => line.text).join(' / '), result.limit,
      offer.status, offer.category, offer.tag, offer.scope, offer.couponType, offer.summary,
      offer.facts?.threshold, offer.facts?.pieceThreshold, offer.facts?.benefit, offer.facts?.unit,
      offer.facts?.cap, offer.facts?.freeShipThreshold, offer.combine, offer.order,
      (offer.detailText || '').slice(0, 300), offer.reason,
    ].map(clean).join('\t'));
    return [header.join('\t'), ...data].join('\n');
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
      console.error('[MOMO 助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally { setTimeout(() => { button.textContent = original; }, 1200); }
  }

  async function capture() {
    if (busy) return latest;
    busy = true;
    $('#capture').disabled = true; $('#copyUsable').disabled = true; $('#copyAll').disabled = true;
    const errorWatch = installErrorWatch();
    try {
      const shop = detectShopType();
      const title = getTitle();
      const exclusion = getPageExclusions();
      const limit = getPurchaseLimit();
      const sections = getProductSections();
      renderPageHeader({ shop, title, price: null, exclusion, limit, sections });

      setProgress('讀取價格（含展開「下單再折」）…');
      const price = await capturePrice();
      renderPageHeader({ shop, title, price, exclusion, limit, sections });

      const shopType = shop.type;
      const discounts = await captureDiscounts(shopType, setProgress);
      const rewards = await captureRewards(shopType, setProgress);
      const mopro = captureMoPro(shopType);
      const couponResult = await captureCoupons(shopType, setProgress, errorWatch);
      const shipping = captureShipping(shopType);

      const notes = [...couponResult.notes];
      if (price.isRange) notes.push('價格為區間，須點選品項後重新擷取');
      if (price.resolvedByPage) {
        notes.push('「下單再折」由最優惠折價券計算；頁面明示無可用券 → 無下單再折價，price_momo 取促銷價');
      }
      if (price.needCouponRuleCheck) {
        notes.push('「下單再折」價格來自折價券，採用前請先依折價券規則檢查該券（含 月份／限定／限時／秘密／專屬／獨家／會員 者不採用）');
      }
      if (price.orderDiscountUnresolved) notes.push('「下單再折」展開後仍讀不到折扣後價格，請人工確認後手動填 price_momo');
      if (shopType === '未確定') notes.push('賣場類型未確定：券別規則與運費規則請人工判斷');
      if (discounts.length > 1) notes.push('複數折扣活動：Excel 請先算上方第一個，再算下方第二個');
      notes.push(shopType === 'MO+'
        ? 'MO+ 計算順序：(單品券／單店折扣) → 單店券 → 跨店活動 → 再判定免運門檻'
        : '一般MOMO：折扣活動 & 折價券僅擇 1 種最優惠，且折價券無法與上方折扣活動疊加');

      latest = {
        title, shop, price, limit, pageExclusions: exclusion.reasons, shipping, notes,
        couponState: couponResult.couponState,
        apiErrors: couponResult.apiErrors || [],
        offers: [...discounts, ...couponResult.offers, ...rewards, ...mopro],
      };
      renderResults(latest);
      const usableCount = latest.offers.filter((offer) => offer.status === 'usable').length;
      const reviewCount = latest.offers.filter((offer) => offer.status === 'review').length;
      const failed = latest.couponState === 'failed';
      setProgress(failed
        ? `擷取完成但折價券讀取失敗：可填入 ${usableCount} 項；人工確認 ${reviewCount} 項。折價券必須人工複查。`
        : `擷取完成：可填入 ${usableCount} 項；人工確認 ${reviewCount} 項。未做任何金額計算。`,
      failed ? 'bad' : (usableCount ? 'ok' : 'warn'));
      return latest;
    } catch (error) {
      console.error('[MOMO 助手] 擷取失敗', error);
      setProgress(`擷取失敗：${normalize(error?.message || error)}`, 'bad');
      return null;
    } finally {
      errorWatch.stop();
      await closeAnyDialog();
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
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));
      panel.style.left = `${Math.min(maxLeft, Math.max(0, event.clientX - drag.offsetX))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(0, event.clientY - drag.offsetY))}px`;
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

  function destroy() {
    host.remove();
    if (window.MomoJudgementHelper?.version === VERSION) delete window.MomoJudgementHelper;
  }

  $('#close').addEventListener('click', destroy);
  $('#capture').addEventListener('click', capture);
  $('#copyUsable').addEventListener('click', () => latest && copyText(toTsv(latest, true), $('#copyUsable')));
  $('#copyAll').addEventListener('click', () => latest && copyText(toTsv(latest, false), $('#copyAll')));
  enableDragging();
  renderPageHeader({
    shop: detectShopType(), title: getTitle(), price: null,
    exclusion: getPageExclusions(), limit: getPurchaseLimit(), sections: getProductSections(),
  });
  window.MomoJudgementHelper = { version: VERSION, capture, result: () => latest, destroy };
  console.info(`[MOMO / MO+ 優惠擷取助手 v${VERSION}] 已啟動。不計算、不領券；只讀取、分類並判斷可否採用。`);
})();
