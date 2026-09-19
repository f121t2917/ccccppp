(() => {
  'use strict';

  const APP_ID = 'momo-judgement-helper';
  const VERSION = '1.2.2';

  if (window.MomoJudgementHelper?.destroy) window.MomoJudgementHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  const normalize = (value) => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const unique = (items) => [...new Set(items.map(normalize).filter(Boolean))];
  const toNumber = (value) => {
    const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const roundMoney = (value) => Math.max(0, Math.round(Number(value) || 0));
  const money = (value) => roundMoney(value).toLocaleString('zh-TW');
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  function getTitle() {
    const heading = [...document.querySelectorAll('h1, [class*="productName"], [class*="prdName"]')]
      .find((element) => isVisible(element) && normalize(element.innerText).length > 3);
    return normalize(heading?.innerText || document.title);
  }

  function firstNumber(text) {
    const match = normalize(text).match(/[\d,]+(?:\.\d+)?/);
    return match ? Number(match[0].replace(/,/g, '')) : 0;
  }

  function findPriceCandidates() {
    const found = [];
    const add = (value, source) => {
      const price = firstNumber(value);
      if (price >= 1 && price <= 10000000) found.push({ price, source, raw: normalize(value) });
    };
    document.querySelectorAll('meta[property="product:price:amount"], meta[itemprop="price"]')
      .forEach((element) => add(element.content, '商品價格標籤'));
    document.querySelectorAll('[itemprop="price"], [class*="salePrice"], [class*="productPrice"], [class*="price"]')
      .forEach((element) => {
        if (!isVisible(element)) return;
        const text = normalize(element.innerText || element.textContent || element.getAttribute('content'));
        if (text.length <= 50 && /[$＄NT]?\s*[\d,]+/.test(text)) add(text, '頁面價格區');
      });
    try {
      document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        const data = JSON.parse(script.textContent);
        const visit = (item) => {
          if (!item || typeof item !== 'object') return;
          if (item.price) add(item.price, 'JSON-LD');
          if (item.lowPrice) add(item.lowPrice, 'JSON-LD 最低價');
          Object.values(item).forEach((value) => {
            if (value && typeof value === 'object') visit(value);
          });
        };
        visit(data);
      });
    } catch (_) { /* 頁面結構化資料不是有效 JSON 時忽略 */ }
    return found.filter((item, index, all) => all.findIndex((other) => other.price === item.price) === index);
  }

  function visiblePageText() {
    return normalize(document.body?.innerText || '').slice(0, 80000);
  }


  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isSafeAutoClickTarget(element) {
    if (!(element instanceof Element) || !isVisible(element)) return false;
    const text = normalize(element.innerText || element.textContent || element.getAttribute('aria-label'));
    if (!text) return false;
    if (/(領取|領券|立即領|兌換|加入購物車|直接購買|立即購買|選購|登入|註冊|付款|結帳)/.test(text)) return false;
    return true;
  }

  function clickableFrom(element) {
    if (!(element instanceof Element)) return null;
    const direct = element.closest('button, a, [role="button"], summary, [tabindex]');
    if (direct && isSafeAutoClickTarget(direct)) return direct;
    let node = element;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      if (!isSafeAutoClickTarget(node)) continue;
      const style = getComputedStyle(node);
      if (typeof node.onclick === 'function' || style.cursor === 'pointer') return node;
    }
    return null;
  }

  function findClickableByText(pattern, scope = document) {
    const nodes = [...scope.querySelectorAll('button, a, [role="button"], summary, span, div, p')];
    return nodes
      .filter((element) => isVisible(element))
      .map((element) => ({
        element,
        text: normalize(element.innerText || element.textContent || element.getAttribute('aria-label')),
      }))
      .filter(({ text }) => text && text.length <= 90 && pattern.test(text))
      .sort((a, b) => a.text.length - b.text.length)
      .map(({ element }) => clickableFrom(element))
      .find(Boolean) || null;
  }

  function visibleOverlayRoots() {
    const selectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="modal"]',
      '[class*="dialog"]',
      '[class*="drawer"]',
      '[class*="popup"]',
      '[class*="popper"]',
      '[class*="coupon"]',
    ].join(',');
    return [...document.querySelectorAll(selectors)]
      .filter((element) => isVisible(element))
      .filter((element, index, all) => !all.some((other, otherIndex) => (
        otherIndex !== index && other.contains(element) && normalize(other.innerText).length < 5000
      )));
  }

  async function waitForDomChange(beforeText, timeout = 2600) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      await sleep(120);
      const nowText = visiblePageText();
      if (nowText !== beforeText) return true;
      if (visibleOverlayRoots().length) return true;
    }
    return false;
  }

  const COUPON_TYPE_RE = /(單品折價券|單品券|商品券|品類券|單店抵用券|商店抵用券|店家券|店券|賣場券|商店券)/;
  const DISCOUNT_VALUE_RE = /(?:折\s*\$?\s*[\d,]+|現折\s*\$?\s*[\d,]+|現抵\s*\$?\s*[\d,]+|折抵\s*\$?\s*[\d,]+|[1-9](?:\.\d+)?\s*折)/;

  function couponCardFrom(element, boundary = document.body) {
    if (!(element instanceof Element)) return null;
    let node = element;
    let candidate = null;

    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) break;
      const value = normalize(node.innerText || node.textContent);

      if (
        value.length >= 6
        && value.length <= 520
        && COUPON_TYPE_RE.test(value)
        && DISCOUNT_VALUE_RE.test(value)
      ) {
        candidate = node;
        break;
      }

      if (node === boundary) break;
    }

    if (!candidate) return null;

    // MOMO 的「新客專屬優惠／會員／效期／立即領取」有時是 coupon 內容的兄弟節點，
    // 不在最小的「折$10 + 單店抵用券」節點裡。
    // 因此往上擴 1~3 層，但只在仍像「單一張券」時擴張，避免把相鄰多張券併成一筆。
    let best = candidate;
    let parent = candidate.parentElement;

    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      if (!(parent instanceof Element)) break;
      if (parent === boundary) break;

      const value = normalize(parent.innerText || parent.textContent);
      if (value.length > 700) break;

      const discountMatches = value.match(/(?:折\s*\$?\s*[\d,]+|現折\s*\$?\s*[\d,]+|現抵\s*\$?\s*[\d,]+|折抵\s*\$?\s*[\d,]+|[1-9](?:\.\d+)?\s*折)/g) || [];
      const couponTypeMatches = value.match(/(?:單品折價券|單品券|商品券|品類券|單店抵用券|商店抵用券|店家券|店券|賣場券|商店券)/g) || [];

      // 出現多組折扣值或多張券種類時，代表已進到多卡片共用容器，不再往上。
      if (discountMatches.length > 1 || couponTypeMatches.length > 1) break;

      // 只有父層補上「適用限制/狀態」時才擴張。
      if (/(新客|新戶|首購|首次購買|關注|追蹤|回購|再次購買|會員|專屬|限定|限時|效期|立即領取)/.test(value)) {
        best = parent;
      }
    }

    return best;
  }

  function collectCouponCards(root) {
    if (!(root instanceof Element || root instanceof Document)) return [];

    const scope = root instanceof Document ? root.documentElement : root;
    const candidates = [...scope.querySelectorAll('span, div, li, p, a, button, [role="button"]')]
      .filter((element) => {
        if (!isVisible(element)) return false;
        const value = normalize(element.innerText || element.textContent);
        return value.length > 0 && value.length <= 180 && COUPON_TYPE_RE.test(value);
      });

    const cards = [];
    const seen = new Set();

    candidates.forEach((element) => {
      const card = couponCardFrom(element, scope);
      if (!card || seen.has(card)) return;
      seen.add(card);
      cards.push(card);
    });

    // 如果同時抓到父容器與真正卡片，只保留較內層的卡片。
    return cards.filter((card) => !cards.some((other) => (
      other !== card && card.contains(other)
    )));
  }

  function elementTouchesCouponCard(element, couponCards) {
    if (!(element instanceof Element)) return false;
    return couponCards.some((card) => (
      card === element || card.contains(element) || element.contains(card)
    ));
  }

  function captureOfferTextsFromRoot(root, sourceLabel = '') {
    if (!(root instanceof Element)) return [];

    const rootText = normalize(root.innerText || root.textContent);
    const couponContext = /單品折價券/.test(rootText);
    const keyword = /(折|券|回饋|加碼|MO幣|mo幣|momo幣|MO點|mo點|momo點|免運|運費|moPro|mopro|跨店|跨館|贈品|滿\s*[\d,]+)/i;
    const selectors = [
      'li', 'p', 'button', 'a', 'span', '[role="button"]',
      '[class*="promotion"]', '[class*="discount"]', '[class*="coupon"]',
      '[class*="activity"]', '[class*="benefit"]', '[class*="gift"]', '[class*="shipping"]',
    ].join(',');

    const items = [];
    const couponCards = collectCouponCards(root);

    // 優惠券以「整張卡片」為最小單位，只抓一次。
    couponCards.forEach((card) => {
      let value = normalize(card.innerText || card.textContent);
      if (value.length < 4 || value.length > 520) return;

      // 單品折價券 popup 有時卡片本身只寫滿額/折扣，分類文字在外層分頁。
      // 只有缺乏任何券種類時才補上「單品折價券」。
      if (couponContext && !COUPON_TYPE_RE.test(value)) {
        value = `單品折價券 ${value}`;
      }
      items.push(value);
    });

    root.querySelectorAll(selectors).forEach((element) => {
      if (!isVisible(element)) return;

      // 關鍵修正：
      // 只要元素在 coupon card 裡、或本身是包住 coupon card 的父容器，
      // 就不能再獨立變成另一筆「折$10 / 折$18」優惠。
      if (elementTouchesCouponCard(element, couponCards)) return;

      let value = normalize(element.innerText || element.textContent);
      if (value.length < 4 || value.length > 280 || !keyword.test(value)) return;

      if (couponContext
        && !COUPON_TYPE_RE.test(value)
        && /(?:滿\s*\$?[\d,]+|折\s*\$?\s*[\d,]+|現折|現抵|折抵|[1-9](?:\.\d+)?\s*折)/.test(value)) {
        value = `單品折價券 ${value}`;
      }

      items.push(value);
    });

    // 不把 [來源] 接到優惠文字尾端，避免同一優惠因來源字串不同而無法去重。
    return unique(items);
  }

  function closeVisibleOverlay() {
    const overlays = visibleOverlayRoots();
    for (const overlay of overlays) {
      const close = [...overlay.querySelectorAll('button, a, [role="button"], [aria-label]')]
        .find((element) => {
          if (!isVisible(element)) return false;
          const label = normalize(element.getAttribute('aria-label') || element.innerText || element.textContent);
          return /^(?:關閉|close|×|✕|✖)$/i.test(label);
        });
      if (close) {
        try { close.click(); return true; } catch (_) { /* ignore */ }
      }
    }
    return false;
  }

  async function clickAndCapture(label, pattern, { clickCouponTab = false } = {}) {
    const target = findClickableByText(pattern);
    if (!target) return { label, found: false, clicked: false, changed: false, captured: 0 };

    const before = visiblePageText();
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.click();
    } catch (_) {
      return { label, found: true, clicked: false, changed: false, captured: 0 };
    }

    const changed = await waitForDomChange(before);
    await sleep(180);

    if (clickCouponTab) {
      const roots = visibleOverlayRoots();
      for (const root of roots) {
        const tab = findClickableByText(/單品折價券(?:\s*[（(].*至多\s*5\s*張.*[）)])?/, root);
        if (tab && tab !== target) {
          try {
            const tabBefore = visiblePageText();
            tab.click();
            await waitForDomChange(tabBefore, 1800);
            await sleep(120);
          } catch (_) { /* ignore */ }
          break;
        }
      }
    }

    const roots = visibleOverlayRoots();
    let captured = [];
    roots.forEach((root) => {
      captured.push(...captureOfferTextsFromRoot(root, label));
    });
    captured = unique(captured);
    if (captured.length) {
      state.capturedOfferTexts = unique([...(state.capturedOfferTexts || []), ...captured]);
    }

    // 盡量把 modal 關掉，避免遮住下一個入口；關不掉也不視為失敗。
    if (roots.length) {
      closeVisibleOverlay();
      await sleep(160);
    }

    return { label, found: true, clicked: true, changed, captured: captured.length };
  }

  async function autoExpandOffers() {
    if (state.autoExpanding) return state.autoExpandLog || [];
    state.autoExpanding = true;
    state.autoExpandLog = [];
    state.capturedOfferTexts = [];

    const jobs = [
      ['下單再折', /^下單再折/],
      ['折扣活動／活動說明', /^(?:折扣活動|活動說明|優惠活動|促銷活動)(?:\s|$|[（(])/],
      ['可使用的折價券／抵用券', /查看可使用的折價券(?:\s*\/\s*抵用券)?|可使用的折價券\s*\/\s*抵用券/, { clickCouponTab: true }],
    ];

    for (const [label, pattern, options] of jobs) {
      try {
        const result = await clickAndCapture(label, pattern, options || {});
        state.autoExpandLog.push(result);
      } catch (error) {
        state.autoExpandLog.push({
          label, found: false, clicked: false, changed: false, captured: 0,
          error: normalize(error?.message || String(error)),
        });
      }
    }

    state.autoExpanding = false;
    return state.autoExpandLog;
  }

  function getOrderDiscountInfo() {
    const triggers = [...document.querySelectorAll('span, button, div')]
      .filter((element) => isVisible(element) && /^下單再折/.test(normalize(element.innerText || element.textContent)))
      .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
    const trigger = triggers[0] || null;
    if (!trigger) return { exists: false, expanded: false, price: 0, discount: 0, finalPrice: 0 };

    const priceRoot = trigger.closest('[data-testid="price-main-container"]')
      || trigger.parentElement?.parentElement?.parentElement;
    const discountHeader = [...(priceRoot?.querySelectorAll('*') || [])]
      .find((element) => isVisible(element) && normalize(element.textContent) === '折扣金額');
    if (!discountHeader) {
      return { exists: true, expanded: false, price: 0, discount: 0, finalPrice: 0 };
    }

    const panel = discountHeader.parentElement?.parentElement;
    const rows = panel ? [...panel.children] : [];
    const valueCells = rows[1] ? [...rows[1].children] : [];
    const values = valueCells.map((element) => firstNumber(element.textContent));
    return {
      exists: true,
      expanded: values.length >= 3 && values[1] > 0,
      price: values[0] || 0,
      discount: values[1] || 0,
      finalPrice: values[2] || 0,
    };
  }

  function getPageFacts() {
    const text = visiblePageText();
    const prices = findPriceCandidates();
    const likelyPrice = prices[0]?.price || 0;
    const goodsInfo = document.querySelector('[data-testid="goods-info"]');
    const productText = normalize((goodsInfo?.closest('section.flex') || goodsInfo)?.innerText || '');
    const strongMoPlusSignal = /(?:領取商店優惠券|商店優惠券|問問回應率|商店休假|賣家出貨|店家配送|店家資訊)/i.test(text);
    const mode = strongMoPlusSignal
      || /(?:MO\+|mo\+|店\+商品|店家配送|賣家出貨|店家資訊)/i.test(productText)
      ? 'moplus' : 'momo';
    const priceRange = /(?:售價|價格)?\s*[$＄]?\s*[\d,]+\s*[~-]\s*[$＄]?\s*[\d,]+/.test(text);
    const orderDiscount = getOrderDiscountInfo();
    const priceIncludesPromotion = !orderDiscount.exists
      && /(售價已折|價格已折|已套用(?:活動|折扣)|折扣後售價)/.test(text.slice(0, 20000));
    return {
      title: getTitle(), url: location.href, mode, likelyPrice, prices, priceRange,
      priceIncludesPromotion, orderDiscount,
      isMomo: /momo/i.test(location.hostname) || /momo購物|momo店\+|MO\+/.test(text),
    };
  }

  function quotaFrom(text) {
    const match = normalize(text).match(/(?:限量|限前|前)\s*([\d,]+)\s*(?:人|名|份|筆|組)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function parseFacts(text) {
    const value = normalize(text).replace(/，/g, ',').replace(/％/g, '%');
    const threshold = value.match(/(?:單筆(?:消費)?[^。；，]{0,16}?滿|滿)\s*(?:\$\s*)?([\d,]+)\s*(?:元)?/);
    const minQty = value.match(/(?:滿|任選|任)\s*([\d,]+)\s*(?:件|入|組|包|盒|罐|瓶|個)/);
    const fullDiscount = value.match(/([1-9](?:\d|\.\d)?)\s*折(?:\D|$)/);
    const fixedDiscount = value.match(/(?:現折|現抵|折抵|折|省)\s*(?:\$\s*)?([\d,]+)\s*(?:元)?/);
    const finalPrice = value.match(/(?:折扣後(?:金額|價格)|券後(?:價|金額)|折後價)\s*(?:\$\s*)?([\d,]+)/);
    const rate = value.match(/(?:送|回饋|加碼)?\s*([\d.]+)\s*%\s*(?:MO|mo|momo)?\s*(幣|點)/i);
    const rateAfterUnit = value.match(/(?:送|回饋|加碼)[^。；，]{0,18}?(?:MO|mo|momo)?\s*(幣|點)\s*(?:最高)?\s*([\d.]+)\s*%/i);
    const fixedReward = value.match(/(?:送|回饋)\s*([\d,]+)\s*(?:MO|mo|momo)?\s*(幣|點)/i);
    const fixedRewardAfterUnit = value.match(/(?:送|回饋)[^。；，]{0,18}?(?:MO|mo|momo)?\s*(幣|點)\s*([\d,]+)\s*(?:元)?/i);
    const cap = value.match(/(?:最高|上限)\s*(?:\$\s*)?([\d,]+)\s*(?:元|幣|點)(?!\s*%)/);
    const shipping = value.match(/(?:運費|配送費)\s*(?:\$\s*)?([\d,]+)/);
    const moProSave = value.match(/(?:moPro|mopro)[^\n。；]{0,30}?(?:再省|現折|折抵|省)\s*(?:\$\s*)?([\d,]+)/i);
    return {
      threshold: threshold ? toNumber(threshold[1]) : 0,
      minQty: minQty ? toNumber(minQty[1]) : 0,
      fold: fullDiscount
        ? (Number(fullDiscount[1]) > 10 ? Number(fullDiscount[1]) / 10 : Number(fullDiscount[1]))
        : 0,
      fixed: fixedDiscount ? toNumber(fixedDiscount[1]) : 0,
      finalPrice: finalPrice ? toNumber(finalPrice[1]) : 0,
      rewardRate: rate ? Number(rate[1]) : (rateAfterUnit ? Number(rateAfterUnit[2]) : 0),
      rewardUnit: rate ? rate[2]
        : (rateAfterUnit ? rateAfterUnit[1]
          : (fixedReward ? fixedReward[2] : (fixedRewardAfterUnit ? fixedRewardAfterUnit[1] : ''))),
      rewardFixed: fixedReward ? toNumber(fixedReward[1])
        : (fixedRewardAfterUnit ? toNumber(fixedRewardAfterUnit[2]) : 0),
      cap: cap ? toNumber(cap[1]) : 0,
      shipping: shipping ? toNumber(shipping[1]) : 0,
      moProSave: moProSave ? toNumber(moProSave[1]) : 0,
    };
  }

  function categoryFrom(text) {
    const value = normalize(text);
    if (/moPro|mopro/i.test(value) && /(?:再省|現折|折抵|省)\s*\$?[\d,]+/.test(value)) return 'mopro';
    if (/moPro|mopro/i.test(value) && /(?:MO|mo|momo)?\s*點/i.test(value)) return 'mopro-note';
    if (/(免運券|運費券)/.test(value)) return 'shipping-coupon';
    if (/(?:滿\s*\$?[\d,]+\s*(?:元)?\s*)?免運費|運費\s*\$?\s*0/.test(value)) return 'shipping-rule';
    if (/(?:MO|mo|momo)\s*點/i.test(value)) return 'mopoint';
    if (/(?:MO|mo|momo)\s*幣|momo幣/i.test(value)) return 'mocoin';
    if (/(跨店|跨館)/.test(value) && /(折|抵|券|省)/.test(value)) return 'cross-store';
    if (/(店家券|店券|賣場券|商店券|單店抵用券|商店抵用券)/.test(value)) return 'store-coupon';
    if (/(單品券|商品券|品類券)/.test(value)) return 'item-coupon';
    if (/券/.test(value) && /(?:現折|現抵|折抵|折\s*\$?\s*[\d,]+|\d+(?:\.\d+)?\s*折)/.test(value)) return 'item-coupon';
    if (/(店家活動|店舖活動|商店活動|賣場活動|單店折扣)/.test(value)) return 'store-activity';
    if (/(滿\s*\d+\s*(?:件|組|元).{0,20}(?:折|抵|省)|[1-9](?:\.\d+)?\s*折|現折|折扣)/.test(value)) return 'page-discount';
    return 'other';
  }

  const CATEGORY_LABELS = {
    'mopro': 'moPro 價差', 'mopro-note': 'moPro MO點（只備註）',
    'shipping-coupon': '免運券', 'shipping-rule': '滿額免運', 'mopoint': 'MO點', 'mocoin': 'MO幣',
    'cross-store': '跨店活動', 'store-coupon': '單店券',
    'item-coupon': '單品券', 'store-activity': '單店折扣',
    'page-discount': '頁面折扣活動', 'order-discount': '下單再折',
    other: '其他／待確認',
  };

  function classifyOffer(text, category, mode = 'momo') {
    const value = normalize(text);
    const facts = parseFacts(value);
    const quota = quotaFrom(value);
    const noRegistration = /(免登記|不需登記|無須登記)/.test(value);
    const registration = !noRegistration && /(須登記|需登記|登記送|登記回饋|限登記|登記抽|登記)/.test(value);
    const memberOnly = /(會員專屬|會員限定|限會員|會員限時|每月限定|本月限定|神秘|專屬券)/.test(value);
    const newOrFollow = /(新客|新戶|首購|首次購買|關注|追蹤|回購|再次購買)/.test(value);
    const specialPayment = /(限|僅限|指定).{0,18}(支付|付款|信用卡|卡別|銀行|LINE Pay|街口|悠遊付)/i.test(value);
    const soldOut = /(已領完|已用完|已失效|活動結束|不可使用)/.test(value);
    const underThousand = Number.isFinite(quota) && quota < 1000;
    const vagueLimited = /限量/.test(value) && !Number.isFinite(quota);
    const allowedUntilGone = /(?:數量有限|送完為止)/.test(value) && !/(名額|限前)/.test(value);
    const physicalGift = /(贈品|查看贈品|加贈|送好禮)/.test(value)
      && !/(?:MO|mo|momo)\s*(?:幣|點)/i.test(value);

    const moPlusItemCouponLimitException = mode === 'moplus' && category === 'item-coupon';
    const moCardCoinReward = category === 'mocoin' && /(?:MO|mo)\s*卡/.test(value);
    const momoCobrandPointReward = category === 'mopoint'
      && /(?:momo\s*)?聯名卡/i.test(value)
      && /全站會員/.test(value);
    const regularMomoDiscount = mode === 'momo'
      && ['page-discount', 'order-discount', 'item-coupon', 'store-coupon', 'store-activity'].includes(category);
    const regularMomoExcludedLabel = regularMomoDiscount
      && /(?:\d{1,2}\s*月|限定|限時|秘密|神秘|專屬|獨家|會員)/.test(value);

    if (registration) return { status: 'ignore', reason: '只使用免登記優惠與回饋；登記送不採用' };
    if (/不適用折價券|不可使用折價券/.test(value)) return { status: 'reject', reason: '頁面明示不適用折價券' };
    if (/商店抵用券/.test(value) && !/單店抵用券/.test(value)) return { status: 'reject', reason: '商店抵用券不是單店抵用券，不採用' };
    if (newOrFollow) return { status: 'reject', reason: '新客／新戶／首購／關注／追蹤／回購限定不採用；即使是單店抵用券也排除' };
    if (memberOnly && !momoCobrandPointReward) return { status: 'reject', reason: '會員／每月／神秘專屬不採用' };
    if (regularMomoExcludedLabel) return { status: 'reject', reason: '一般 MOMO 折扣含月份／限定／限時／秘密／專屬／獨家／會員，不採用' };

    if (specialPayment && category !== 'mopro-note') {
      if (moCardCoinReward) {
        if (!noRegistration) return { status: 'review', reason: 'MO卡回饋只有明示免登記才可自動採用' };
      } else if (!momoCobrandPointReward) {
        return { status: 'reject', reason: '一般限定付款方式不採用' };
      }
    }

    if (soldOut) return { status: 'reject', reason: '優惠已無法使用' };
    if (underThousand && !moPlusItemCouponLimitException) {
      return { status: 'reject', reason: `名額 ${quota}，少於 1,000` };
    }
    if (vagueLimited && !allowedUntilGone && !moPlusItemCouponLimitException) {
      return { status: 'reject', reason: '只寫「限量」但未標名額，不採用' };
    }

    if (physicalGift) return { status: 'ignore', reason: '實體贈品不影響本助手 8 個數值欄位' };
    if (category === 'mopro-note') return { status: 'note', reason: 'moPro 會員 MO點只備註，不計入公式' };
    if (['item-coupon', 'store-coupon', 'cross-store'].includes(category)
      && !facts.fixed && !facts.fold && !facts.finalPrice) {
      return { status: 'review', reason: '只看到折價券入口，未讀到實際券額；請展開後重新掃描' };
    }
    if (category === 'other') return { status: 'review', reason: '無法自動判斷優惠類型' };

    if (moPlusItemCouponLimitException && (underThousand || vagueLimited)) {
      return { status: 'usable', reason: 'MO+ 單品折價券符合條件即可使用，無論是否限量' };
    }
    if (momoCobrandPointReward) return { status: 'usable', reason: '教材指定的全站會員 MOMO 聯名卡 MO點回饋可採用' };
    return { status: 'usable', reason: noRegistration ? '免登記，可採用' : '未讀到排除條件' };
  }

  function scanOfferTexts(mode = 'momo') {
    const keyword = /(折|券|回饋|加碼|MO幣|mo幣|momo幣|MO點|mo點|momo點|免運|運費|moPro|mopro|跨店|跨館|贈品|滿\s*[\d,]+)/i;
    const selectors = [
      'li', 'p', 'button', 'a', 'span', '[role="button"]',
      '[class*="promotion"]', '[class*="discount"]', '[class*="coupon"]',
      '[class*="activity"]', '[class*="benefit"]', '[class*="gift"]', '[class*="shipping"]',
    ].join(',');
    const texts = [...(state?.capturedOfferTexts || [])];
    const goodsInfo = document.querySelector('[data-testid="goods-info"]');
    const goodsTitle = document.querySelector('#goods-detail-goods-title');
    const productScope = goodsInfo?.closest('section.flex')
      || goodsInfo?.parentElement
      || goodsTitle?.closest('article.sidebar-main')
      || goodsTitle?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement
      || document;
    const registrationTexts = [];

    // 頁面上可見的商店/單店/單品券，整張卡片只產生一筆 offer。
    const couponCards = collectCouponCards(productScope);
    couponCards.forEach((card) => {
      const cardText = normalize(card.innerText || card.textContent);
      if (cardText) texts.push(cardText);
    });
    [...productScope.querySelectorAll('div')].forEach((row) => {
      const directChildren = [...row.children];
      const registrationLabel = directChildren.find((child) => normalize(child.textContent) === '登記送');
      const list = directChildren.find((child) => child.tagName === 'UL');
      if (!registrationLabel || !list) return;
      list.querySelectorAll('li, a').forEach((element) => {
        const text = normalize(element.innerText || element.textContent);
        if (text) registrationTexts.push(text);
      });
    });
    productScope.querySelectorAll('a[href*="func=18"], a[href*="MemberCenter"]')
      .forEach((element) => {
        const text = normalize(element.innerText || element.textContent);
        if (/(?:送|回饋).*(?:MO|mo|momo)\s*(?:幣|點)/i.test(text)) registrationTexts.push(text);
      });
    productScope.querySelectorAll(selectors).forEach((element) => {
      if (!isVisible(element)) return;

      // coupon card 的子元素（折$10、單店抵用券、新客專屬…）
      // 以及包住多張券的外層容器都不再獨立掃描。
      if (elementTouchesCouponCard(element, couponCards)) return;

      const text = normalize(element.innerText || element.textContent);
      if (text.length < 4 || text.length > 260 || !keyword.test(text)) return;
      texts.push(text);
    });

    const normalizedTexts = unique(texts);

    // 防守性去重：
    // 若還有孤立的「折$10 / 折$18」短字串，而完整優惠券卡片已包含同一字串，
    // 刪除短字串，避免再次被誤分類成 page-discount。
    const cleanedTexts = normalizedTexts.filter((value) => {
      const shortDiscountOnly = value.length <= 28
        && DISCOUNT_VALUE_RE.test(value)
        && !COUPON_TYPE_RE.test(value);

      if (!shortDiscountOnly) return true;

      return !normalizedTexts.some((other) => (
        other !== value
        && COUPON_TYPE_RE.test(other)
        && other.includes(value)
      ));
    });

    const offers = cleanedTexts
      .slice(0, 80)
      .map((text, index) => {
        const category = categoryFrom(text);
        const isRegistrationOffer = registrationTexts.some((registeredText) => (
          registeredText === text
          || (registeredText.length >= 8 && text.includes(registeredText))
          || (text.length >= 8 && registeredText.includes(text))
        ));
        return {
          id: `offer-${index}`, text, category, registration: isRegistrationOffer, facts: parseFacts(text),
          ...(isRegistrationOffer
            ? { status: 'ignore', reason: '位於「登記送」區塊；MOMO／MO+ 都忽略，不計入回饋' }
            : classifyOffer(text, category, mode)),
        };
      });

    const orderDiscount = getOrderDiscountInfo();
    if (orderDiscount.exists && orderDiscount.expanded) {
      offers.unshift({
        id: 'order-discount-detail',
        text: `下單再折：促銷價 ${orderDiscount.price}／折扣金額 ${orderDiscount.discount}／折扣後價格 ${orderDiscount.finalPrice}`,
        category: 'order-discount',
        facts: {
          threshold: 0, minQty: 0, fold: 0, fixed: orderDiscount.discount,
          finalPrice: orderDiscount.finalPrice, rewardRate: 0, rewardUnit: '',
          rewardFixed: 0, cap: 0, shipping: 0, moProSave: 0,
        },
        status: 'usable',
        reason: '已從展開的下單再折表格讀取折扣金額',
      });
    } else if (orderDiscount.exists) {
      offers.unshift({
        id: 'order-discount-collapsed',
        text: '頁面顯示「下單再折」，但折扣明細尚未展開',
        category: 'order-discount',
        facts: parseFacts(''),
        status: 'review',
        reason: '可按助手的「自動展開＋掃描」嘗試展開；若失敗再人工點開後重新掃描',
      });
    }
    return offers;
  }

  function discountAmount(offer, base, qty) {
    const facts = offer.facts || parseFacts(offer.text);
    if (facts.threshold && base < facts.threshold) return 0;
    if (facts.minQty && qty < facts.minQty) return 0;
    let amount = 0;
    if (facts.finalPrice && facts.finalPrice < base) amount = base - facts.finalPrice;
    else if (facts.fixed) amount = facts.fixed;
    else if (facts.fold > 0 && facts.fold < 10) amount = roundMoney(base * (1 - facts.fold / 10));
    if (facts.cap) amount = Math.min(amount, facts.cap);
    return Math.min(base, roundMoney(amount));
  }

  function activityNoteFrom(offer) {
    if (!offer) return '';
    const text = normalize(offer.text).replace(/\s+/g, ' ');
    const condition = text.match(/((?:滿|任選|任)\s*[\d,]+\s*(?:件|入|組|包|盒|罐|瓶|個|元)[^。；，/]{0,28}?(?:[1-9](?:\d|\.\d)?\s*折|折\s*\$?\s*[\d,]+\s*元?|現折\s*\$?\s*[\d,]+\s*元?))/);
    if (condition) return `折扣活動(${normalize(condition[1])})`;
    const shortDiscount = text.match(/([^。；，/\n]{0,28}(?:[1-9](?:\d|\.\d)?\s*折|現折\s*\$?\s*[\d,]+\s*元?))/);
    return shortDiscount ? `折扣活動(${normalize(shortDiscount[1])})` : '';
  }

  const state = {
    facts: getPageFacts(), offers: [], output: null, collapsed: false,
    capturedOfferTexts: [], autoExpandLog: [], autoExpanding: false,
  };
  state.offers = scanOfferTexts(state.facts.mode);

  const host = document.createElement('div');
  host.id = APP_ID;
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;font-family:Arial,"Microsoft JhengHei",sans-serif;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box} .panel{width:430px;max-height:calc(100vh - 32px);background:#fff;color:#252525;border:1px solid #d6d6d6;border-radius:14px;box-shadow:0 14px 42px #0004;overflow:hidden;font-size:13px}
      .head{display:flex;align-items:center;gap:9px;padding:11px 12px;background:linear-gradient(135deg,#8f2168,#d22e7a);color:#fff;cursor:move;user-select:none}.head strong{font-size:15px}.head small{opacity:.85}.spacer{flex:1}.icon{border:0;background:#ffffff26;color:#fff;border-radius:7px;width:29px;height:27px;cursor:pointer;font-weight:700}
      .body{max-height:calc(100vh - 82px);overflow:auto;padding:12px;background:#f8f6f8}.panel.collapsed{width:300px}.panel.collapsed .body{display:none}
      .notice{padding:9px 10px;border-radius:9px;margin-bottom:10px;line-height:1.45}.warn{background:#fff1d9;color:#784600;border:1px solid #f2d19a}.bad{background:#fde6e8;color:#922733;border:1px solid #efb9bf}.good{background:#e8f6ed;color:#17693a;border:1px solid #b9dec7}
      .section{background:#fff;border:1px solid #e3dfe3;border-radius:10px;padding:10px;margin:9px 0}.section h3{font-size:14px;margin:0 0 8px;color:#7d1c59}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field label{display:block;font-size:11px;color:#666;margin:0 0 3px}.field input,.field select,textarea{width:100%;border:1px solid #ccc;border-radius:7px;padding:7px;background:#fff;font:inherit}.check{display:flex;gap:6px;align-items:flex-start;margin-top:8px;line-height:1.35}.check input{margin-top:2px}
      .buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:9px 0}.buttons.three{grid-template-columns:1fr 1fr 1fr}.btn{border:0;border-radius:8px;padding:9px;cursor:pointer;font-weight:700}.primary{background:#a92570;color:#fff}.secondary{background:#ebe3e9;color:#6c1b50}.copy{background:#205c45;color:#fff}
      .offer{border-top:1px solid #eee;padding:8px 0}.offer:first-child{border-top:0}.offer-top{display:flex;align-items:center;gap:6px}.tag{font-size:10px;padding:2px 5px;border-radius:9px;background:#eee;white-space:nowrap}.usable{background:#dff3e7;color:#17643a}.reject{background:#f8dfe2;color:#912532}.review{background:#fff0cd;color:#805000}.note,.ignore{background:#e6ebf5;color:#3c4f75}.offer-text{font-size:12px;line-height:1.4;margin-top:4px;max-height:52px;overflow:auto}.reason{font-size:11px;color:#777;margin-top:3px}.results{width:100%;border-collapse:collapse}.results td{padding:6px;border-bottom:1px solid #eee}.results td:first-child{color:#666}.results td:nth-child(2){font-weight:700;text-align:right}.results td:last-child{width:55px;text-align:right}.mini{font-size:11px;color:#777;line-height:1.45}.hidden{display:none}
    </style>
    <div class="panel">
      <div class="head"><strong>MOMO 對標助手</strong><small>v${VERSION}</small><span class="spacer"></span><button class="icon" id="collapse" title="收合">−</button><button class="icon" id="close" title="關閉">×</button></div>
      <div class="body">
        <div id="siteNotice"></div>
        <div class="section">
          <h3>1. 商品與價格</h3>
          <div class="mini" id="titleText"></div>
          <label class="check"><input id="commonPassed" type="checkbox"><span>已依「商品對標決策圖」通過共同主流程與特殊品類例外</span></label>
          <div class="grid" style="margin-top:8px">
            <div class="field"><label>賣場類型</label><select id="mode"><option value="momo">一般 MOMO</option><option value="moplus">MO+</option></select></div>
            <div class="field"><label>實際單價</label><input id="unitPrice" inputmode="numeric" placeholder="請確認頁面價格"></div>
            <div class="field"><label>qty_momo 下單組數</label><input id="qty" type="number" min="1" step="1" value="1"></div>
            <div class="field"><label>MO+ 運費（無免運時）</label><input id="shipping" inputmode="numeric" value="0"></div>
          </div>
          <label class="check"><input id="priceIncluded" type="checkbox"><span>頁面價格已套用上方折扣活動，不要重複計入 discount_momo</span></label>
          <label class="check"><input id="limitOne" type="checkbox"><span>頁面顯示限購 1 組／只能下單一次</span></label>
        </div>
        <div class="section">
          <h3>2. 自動掃描優惠</h3>
          <div class="mini">「自動展開＋掃描」只會嘗試點開下單再折、折扣活動／活動說明、查看可使用的折價券／抵用券與單品折價券分頁；不會領券、登入、選規格或購買。</div>
          <div class="buttons three"><button class="btn secondary" id="autoScan">自動展開＋掃描</button><button class="btn secondary" id="rescan">只重新掃描</button><button class="btn primary" id="calculate">計算 8 欄位</button></div>
          <div id="autoStatus" class="mini"></div>
          <div id="offerSummary" class="mini"></div>
          <details><summary style="cursor:pointer;margin-top:7px">查看掃描項目</summary><div id="offers"></div></details>
        </div>
        <div class="section hidden" id="resultSection">
          <h3>3. 建議填寫</h3>
          <table class="results" id="results"></table>
          <div class="buttons"><button class="btn copy" id="copyValues">複製一列數值</button><button class="btn secondary" id="copyDetail">複製欄位明細</button></div>
          <div id="audit" class="mini"></div>
        </div>
      </div>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  const panel = $('.panel');

  function renderFacts() {
    $('#titleText').textContent = state.facts.title || '未讀到商品名稱';
    $('#mode').value = state.facts.mode;
    $('#unitPrice').value = state.facts.likelyPrice || '';
    $('#priceIncluded').checked = state.facts.priceIncludesPromotion;
    const messages = [];
    if (!state.facts.isMomo) messages.push('目前頁面不像 MOMO 商品頁，請確認網址。');
    if (!state.facts.likelyPrice) messages.push('未可靠讀到售價，請手動填入「實際單價」。');
    if (state.facts.priceRange) messages.push('頁面有價格區間；請先選妥正確規格，再手動確認單價。');
    if (state.facts.orderDiscount?.exists && !state.facts.orderDiscount.expanded) {
      messages.push('偵測到「下單再折」但尚未讀到明細；可先按「自動展開＋掃描」。');
    }
    $('#siteNotice').innerHTML = messages.length
      ? `<div class="notice warn">${messages.map(escapeHtml).join('<br>')}</div>`
      : '<div class="notice good">已讀取頁面基本資料；價格與規格仍請人工確認一次。</div>';
  }

  function renderOffers() {
    const counts = state.offers.reduce((acc, offer) => {
      acc[offer.status] = (acc[offer.status] || 0) + 1;
      return acc;
    }, {});
    $('#offerSummary').textContent = `共掃描 ${state.offers.length} 項：可用 ${counts.usable || 0}、忽略 ${counts.ignore || 0}、只備註 ${counts.note || 0}、排除 ${counts.reject || 0}、待確認 ${counts.review || 0}。`;
    $('#offers').innerHTML = state.offers.length ? state.offers.map((offer) => `
      <div class="offer">
        <div class="offer-top"><span class="tag ${offer.status}">${escapeHtml(offer.status === 'usable' ? '可用' : offer.status === 'reject' ? '排除' : offer.status === 'note' ? '備註' : offer.status === 'ignore' ? '忽略' : '待確認')}</span><span class="tag">${escapeHtml(CATEGORY_LABELS[offer.category])}</span></div>
        <div class="offer-text">${escapeHtml(offer.text)}</div><div class="reason">${escapeHtml(offer.reason)}</div>
      </div>`).join('') : '<div class="mini" style="margin-top:8px">未掃描到可辨識的優惠文字。請先展開「活動說明／優惠券／查看贈品」後重新掃描。</div>';
  }


  function renderAutoStatus() {
    const node = $('#autoStatus');
    if (!node) return;
    if (state.autoExpanding) {
      node.textContent = '正在嘗試展開優惠內容並等待 MOMO 載入…';
      return;
    }
    if (!state.autoExpandLog?.length) {
      node.textContent = '';
      return;
    }
    node.textContent = state.autoExpandLog.map((item) => {
      if (!item.found) return `${item.label}：找不到入口`;
      if (!item.clicked) return `${item.label}：找到但無法點擊`;
      const capture = item.captured ? `，擷取 ${item.captured} 段文字` : '';
      return `${item.label}：已點擊${item.changed ? '並偵測到頁面變化' : ''}${capture}`;
    }).join(' ｜ ');
  }

  async function autoExpandAndRescan() {
    if (state.autoExpanding) return;
    const button = $('#autoScan');
    if (button) button.disabled = true;
    const statusNode = $('#autoStatus');
    if (statusNode) statusNode.textContent = '正在嘗試展開優惠內容並等待 MOMO 載入…';

    try {
      await autoExpandOffers();
      state.facts = getPageFacts();

      // 尊重使用者目前手動選擇的賣場類型；只有第一次未變更時才採自動偵測。
      const selectedMode = $('#mode')?.value;
      if (selectedMode === 'momo' || selectedMode === 'moplus') {
        state.facts.mode = selectedMode;
      }

      state.offers = scanOfferTexts(state.facts.mode);
      renderFacts();
      renderOffers();
    } finally {
      state.autoExpanding = false;
      if (button) button.disabled = false;
      renderAutoStatus();
    }
  }

  function bestDiscount(offers, base, qty) {
    return offers.map((offer) => ({ offer, amount: discountAmount(offer, base, qty) }))
      .sort((a, b) => b.amount - a.amount)[0] || { offer: null, amount: 0 };
  }

  function selectedUsable(category) {
    return state.offers.filter((offer) => offer.status === 'usable' && (Array.isArray(category) ? category.includes(offer.category) : offer.category === category));
  }


  function offerMeetsConditions(offer, base, qty) {
    const facts = offer.facts || parseFacts(offer.text);
    if (facts.threshold && base < facts.threshold) return false;
    if (facts.minQty && qty < facts.minQty) return false;
    return true;
  }

  function sequentialDiscountPlan(offers, base, qty) {
    let remaining = base;
    const used = [];
    for (const offer of offers) {
      if (!offerMeetsConditions(offer, remaining, qty)) continue;
      const amount = discountAmount(offer, remaining, qty);
      if (!amount) continue;
      used.push({ offer, amount });
      remaining = Math.max(0, remaining - amount);
    }
    return { amount: base - remaining, used };
  }

  function rewardAmount(offer, base, qty) {
    if (!offerMeetsConditions(offer, base, qty)) return 0;
    const facts = offer.facts || parseFacts(offer.text);
    let amount = facts.rewardRate
      ? roundMoney(base * facts.rewardRate / 100)
      : roundMoney(facts.rewardFixed || 0);
    if (facts.cap) amount = Math.min(amount, facts.cap);
    return amount;
  }

  function isBonusReward(offer) {
    return /(加碼|另加碼|再加碼|可疊加|可併用)/.test(offer.text);
  }

  function isMocoinFullGift(offer) {
    return /(?:滿額贈|滿[^。；，]{0,24}(?:送|贈)[^。；，]{0,18}(?:MO|mo|momo)\s*幣)/i.test(offer.text);
  }

  function rewardNote(offer, unit, prefix = '') {
    const facts = offer.facts || parseFacts(offer.text);
    if (facts.rewardRate) return `${unit}${prefix}${facts.rewardRate}%`;
    if (facts.rewardFixed) return `${unit}${prefix}${facts.rewardFixed}`;
    return `${unit}${prefix}`.trim();
  }

  function discountOfferNote(offer, amount) {
    if (!offer) return '';
    const facts = offer.facts || parseFacts(offer.text);
    const label = CATEGORY_LABELS[offer.category] || '優惠';
    const threshold = facts.threshold ? `滿${facts.threshold}` : '';
    if (facts.fold) return `${label}${threshold ? threshold + '，' : ''}${facts.fold}折`;
    if (facts.fixed) return `${label}${threshold ? threshold : ''}折${facts.fixed}`;
    if (offer.category === 'order-discount') return `下單再折 ${amount}元`;
    const activityNote = activityNoteFrom(offer);
    return activityNote || `${label} ${amount}元`;
  }

  function calculate() {
    const mode = $('#mode').value;
    const unitPrice = toNumber($('#unitPrice').value);
    const qty = Math.max(1, Math.floor(toNumber($('#qty').value) || 1));
    const gross = roundMoney(unitPrice * qty);
    const notes = [];
    const warnings = [];

    if (!$('#commonPassed').checked) warnings.push('尚未確認共同主流程與特殊品類例外；本助手不能代替品牌、規格、效期、貨源與組數判斷。');
    if (!unitPrice) warnings.push('售價未填，無法可靠計算。');
    if (state.facts.priceRange) warnings.push('偵測到價格區間，請確認目前規格對應的單價。');
    if ($('#limitOne').checked) notes.push('限購一組／僅限下單一次');

    // MoPro 價差獨立填 discount_mopro，不重複寫入 note_momo。
    const moProChoice = selectedUsable('mopro')
      .map((offer) => ({
        offer,
        amount: roundMoney((offer.facts.moProSave || offer.facts.fixed || 0) * qty),
      }))
      .sort((a, b) => b.amount - a.amount)[0] || { offer: null, amount: 0 };
    const discountMopro = Math.min(gross, moProChoice.amount);

    let discountMomo = 0;
    const usedOffers = [];

    if (mode === 'moplus') {
      // MO+：促銷價為基準；第一層只比較「單品券 vs 單店活動」。
      const itemCoupon = bestDiscount(selectedUsable('item-coupon'), gross, qty);
      const storeActivity = bestDiscount(selectedUsable('store-activity'), gross, qty);
      const first = itemCoupon.amount >= storeActivity.amount ? itemCoupon : storeActivity;
      if (first.offer && first.amount) {
        discountMomo = first.amount;
        usedOffers.push(first);
      }

      // 單店券門檻只用上一層一般折扣後金額，不先扣 discount_mopro。
      const afterFirst = Math.max(0, gross - discountMomo);
      const store = bestDiscount(selectedUsable('store-coupon'), afterFirst, qty);
      if (store.offer && store.amount) {
        discountMomo += store.amount;
        usedOffers.push(store);
      }

      // 跨店活動再依最新折後金額重新判斷。
      const afterStore = Math.max(0, gross - discountMomo);
      const cross = bestDiscount(selectedUsable('cross-store'), afterStore, qty);
      if (cross.offer && cross.amount) {
        discountMomo += cross.amount;
        usedOffers.push(cross);
      }
    } else {
      // 一般 MOMO：複數折扣活動依頁面掃描順序逐層計算，
      // 再和「折價券方案」擇優；兩個方案不可疊加。
      if ($('#priceIncluded').checked) {
        const visibleActivity = selectedUsable(['page-discount', 'order-discount', 'store-activity'])[0] || null;
        const activityNote = visibleActivity ? discountOfferNote(visibleActivity, 0) : '';
        if (activityNote) notes.push(activityNote);
        notes.push('頁面價已含上方折扣活動，未再疊加下方折價券或重複計入 discount_momo');
      } else {
        const activityOffers = selectedUsable(['page-discount', 'order-discount', 'store-activity']);
        const activityPlan = sequentialDiscountPlan(activityOffers, gross, qty);
        const couponPlan = bestDiscount(selectedUsable(['item-coupon', 'store-coupon']), gross, qty);

        if (activityPlan.amount >= couponPlan.amount) {
          discountMomo = activityPlan.amount;
          usedOffers.push(...activityPlan.used);
        } else if (couponPlan.offer && couponPlan.amount) {
          discountMomo = couponPlan.amount;
          usedOffers.push(couponPlan);
        }
      }
    }

    discountMomo = Math.min(gross, roundMoney(discountMomo));
    usedOffers.forEach(({ offer, amount }) => {
      const note = discountOfferNote(offer, amount);
      if (note) notes.push(note);
    });

    // 回饋與 MO+ 免運門檻使用實際付款基礎：一般折扣 + MoPro 價差均已扣除。
    const paidBase = Math.max(0, gross - discountMomo - discountMopro);

    // MO幣：預設 3% 與其他「非加碼」回饋擇優；明示加碼才相加。
    // 滿額贈 MO幣獨立加回，可使總 MO幣超過一般 2,000 上限。
    const coinOffers = selectedUsable('mocoin');
    const baseCoinCandidates = [{
      offer: null,
      amount: roundMoney(paidBase * 0.03),
      note: 'MO幣3%回饋',
    }];

    const bonusCoin = [];
    const fullGiftCoin = [];
    coinOffers.forEach((offer) => {
      const amount = rewardAmount(offer, paidBase, qty);
      if (!amount) return;
      if (isMocoinFullGift(offer)) {
        fullGiftCoin.push({ offer, amount });
      } else if (isBonusReward(offer)) {
        bonusCoin.push({ offer, amount });
      } else {
        baseCoinCandidates.push({ offer, amount, note: rewardNote(offer, 'MO幣', '回饋') });
      }
    });

    const baseCoin = baseCoinCandidates.sort((a, b) => b.amount - a.amount)[0];
    let cappedCoin = baseCoin?.amount || 0;
    if (baseCoin?.note) notes.push(baseCoin.note);

    bonusCoin.forEach(({ offer, amount }) => {
      cappedCoin += amount;
      notes.push(rewardNote(offer, 'MO幣', '加碼'));
    });

    cappedCoin = Math.min(cappedCoin, 2000);
    let conback = cappedCoin;
    fullGiftCoin.forEach(({ offer, amount }) => {
      conback += amount;
      notes.push(rewardNote(offer, 'MO幣', '滿額贈'));
    });

    // MO點：不自行把所有活動相加。非加碼活動只取較高者；
    // 只有明示「加碼／可疊加」者再相加。MO點沒有一般 2,000 上限。
    const pointOffers = selectedUsable('mopoint');
    const pointBaseCandidates = [];
    const pointBonus = [];
    pointOffers.forEach((offer) => {
      const amount = rewardAmount(offer, paidBase, qty);
      if (!amount) return;
      if (isBonusReward(offer)) pointBonus.push({ offer, amount });
      else pointBaseCandidates.push({ offer, amount });
    });

    let pointBack = 0;
    if (pointBaseCandidates.length) {
      const bestPoint = pointBaseCandidates.sort((a, b) => b.amount - a.amount)[0];
      pointBack += bestPoint.amount;
      notes.push(rewardNote(bestPoint.offer, 'MO點', '回饋'));
    }
    pointBonus.forEach(({ offer, amount }) => {
      pointBack += amount;
      notes.push(rewardNote(offer, 'MO點', '加碼'));
    });

    // moPro 訂閱會員 MO點依決策圖只備註，不計入 Pointsback_platform_momo。
    state.offers.filter((offer) => offer.status === 'note' && offer.category === 'mopro-note')
      .forEach((offer) => notes.push(normalize(offer.text).slice(0, 90)));

    let shipping = 0;
    if (mode === 'moplus') {
      const shippingCoupon = selectedUsable('shipping-coupon')
        .find((offer) => offerMeetsConditions(offer, paidBase, qty));
      const shippingRuleMet = selectedUsable('shipping-rule').some((offer) => (
        offerMeetsConditions(offer, paidBase, qty)
      ));
      if (shippingCoupon) notes.push('使用免運券');
      else if (!shippingRuleMet) shipping = roundMoney(toNumber($('#shipping').value));
    }

    const reviewCount = state.offers.filter((offer) => offer.status === 'review').length;
    if (reviewCount) warnings.push(`有 ${reviewCount} 項優惠無法自動分類，需人工確認。`);
    if (state.offers.some((offer) => /登入|登錄/.test(offer.text))) warnings.push('部分優惠可能需登入後才完整顯示。');
    if (!state.offers.length) warnings.push('尚未讀到優惠；請先展開頁面活動內容後重新掃描。');

    state.output = {
      price_momo: gross,
      qty_momo: qty,
      discount_mopro: discountMopro,
      discount_momo: discountMomo,
      conback_momo: conback,
      Pointsback_platform_momo: pointBack,
      shipping_fee_mo_plus: shipping,
      note_momo: unique(notes).join(' / '),
    };
    renderResults(warnings);
  }

  function renderResults(warnings) {
    const labels = {
      price_momo: 'price_momo', qty_momo: 'qty_momo', discount_mopro: 'discount_mopro',
      discount_momo: 'discount_momo', conback_momo: 'conback_momo',
      Pointsback_platform_momo: 'Pointsback_platform_momo',
      shipping_fee_mo_plus: 'shipping_fee_mo_plus', note_momo: 'note_momo',
    };
    $('#results').innerHTML = Object.entries(state.output).map(([key, value]) => `
      <tr><td>${escapeHtml(labels[key])}</td><td>${escapeHtml(value)}</td><td><button class="btn secondary one-copy" data-key="${escapeHtml(key)}" style="padding:4px 7px">複製</button></td></tr>`).join('');
    $('#resultSection').classList.remove('hidden');
    $('#audit').innerHTML = warnings.length
      ? `<div class="notice bad" style="margin-top:8px">${warnings.map(escapeHtml).join('<br>')}</div>`
      : '<div class="notice good" style="margin-top:8px">未發現阻擋計算的問題；送出前仍請核對價格、規格與優惠門檻。</div>';
    $('#resultSection').scrollIntoView({ block: 'nearest' });
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(String(text));
      const original = button.textContent;
      button.textContent = '已複製';
      setTimeout(() => { button.textContent = original; }, 900);
    } catch (_) {
      prompt('請手動複製：', String(text));
    }
  }

  $('#calculate').addEventListener('click', calculate);
  $('#autoScan').addEventListener('click', autoExpandAndRescan);
  $('#mode').addEventListener('change', (event) => {
    state.facts.mode = event.currentTarget.value;
    state.offers = scanOfferTexts(state.facts.mode);
    renderOffers();
  });
  $('#rescan').addEventListener('click', () => {
    const selectedMode = $('#mode').value;
    state.facts = getPageFacts();
    state.facts.mode = selectedMode;
    state.offers = scanOfferTexts(state.facts.mode);
    renderFacts(); renderOffers(); renderAutoStatus();
  });
  $('#copyValues').addEventListener('click', (event) => {
    if (!state.output) return;
    copyText(Object.values(state.output).join('\t'), event.currentTarget);
  });
  $('#copyDetail').addEventListener('click', (event) => {
    if (!state.output) return;
    copyText(Object.entries(state.output).map(([key, value]) => `${key}\t${value}`).join('\n'), event.currentTarget);
  });
  $('#results').addEventListener('click', (event) => {
    const button = event.target.closest('.one-copy');
    if (button && state.output) copyText(state.output[button.dataset.key], button);
  });
  $('#collapse').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    panel.classList.toggle('collapsed', state.collapsed);
    $('#collapse').textContent = state.collapsed ? '+' : '−';
  });
  $('#close').addEventListener('click', () => window.MomoJudgementHelper.destroy());

  let drag = null;
  $('.head').addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    $('.head').setPointerCapture(event.pointerId);
  });
  $('.head').addEventListener('pointermove', (event) => {
    if (!drag) return;
    host.style.left = `${Math.max(0, Math.min(innerWidth - host.offsetWidth, event.clientX - drag.x))}px`;
    host.style.top = `${Math.max(0, Math.min(innerHeight - 40, event.clientY - drag.y))}px`;
    host.style.right = 'auto';
  });
  $('.head').addEventListener('pointerup', () => { drag = null; });

  window.MomoJudgementHelper = {
    version: VERSION,
    async autoExpandAndRescan() { await autoExpandAndRescan(); },
    rescan() {
      const selectedMode = $('#mode')?.value || state.facts.mode;
      state.facts = getPageFacts();
      state.facts.mode = selectedMode;
      state.offers = scanOfferTexts(state.facts.mode);
      renderFacts(); renderOffers(); renderAutoStatus();
    },
    calculate,
    getState: () => JSON.parse(JSON.stringify(state)),
    destroy() { host.remove(); delete window.MomoJudgementHelper; },
  };

  renderFacts();
  renderOffers();
  renderAutoStatus();
})();
