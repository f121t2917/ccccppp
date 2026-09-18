(() => {
  'use strict';

  const APP_ID = 'shopee-judgement-helper';
  const VERSION = '1.0.0';

  if (window.ShopeeJudgementHelper?.destroy) window.ShopeeJudgementHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  const normalize = (value) => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const normalizeLines = (value) => String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);

  const unique = (items) => [...new Set(items.map(normalize).filter(Boolean))];
  const uniqueLines = (items) => unique(items.flatMap((item) => normalizeLines(item).split('\n')));

  const isVisible = (element) => {
    if (!(element instanceof Element) || element.closest(`#${APP_ID}`)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  const elementText = (element) => normalizeLines(element?.innerText || element?.textContent || '');
  const productRoot = () => document.querySelector('main') || document.body;

  function mainText() {
    return elementText(productRoot());
  }

  function topProductText() {
    const text = mainText();
    const marker = text.search(/\n商品詳情(?:\n|$)/);
    return marker >= 0 ? text.slice(0, marker) : text;
  }

  function linesOf(text) {
    return normalizeLines(text).split('\n').map(normalize).filter(Boolean);
  }

  function matchingLines(text, pattern, maxLength = 260) {
    return unique(linesOf(text).filter((line) => line.length <= maxLength && pattern.test(line)));
  }

  function getTitle() {
    const heading = [...productRoot().querySelectorAll('h1')].find(isVisible);
    const meta = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector('meta[name="twitter:title"]')?.content;
    return normalize(heading?.innerText || meta || document.title)
      .replace(/\s*[|｜]\s*蝦皮購物.*$/i, '');
  }

  function getCanonicalUrl() {
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    return canonical || location.href;
  }

  function jsonLdProducts() {
    const products = [];
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const type = value['@type'];
      if ((Array.isArray(type) && type.includes('Product')) || type === 'Product') products.push(value);
      Object.values(value).forEach(visit);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try { visit(JSON.parse(script.textContent)); } catch (_) { /* 非有效 JSON-LD 就略過 */ }
    });
    return products;
  }

  function structuredPriceCandidates() {
    const values = [];
    jsonLdProducts().forEach((product) => {
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      offers.filter(Boolean).forEach((offer) => {
        ['price', 'lowPrice', 'highPrice'].forEach((key) => {
          if (offer[key] !== undefined && offer[key] !== null) values.push(String(offer[key]));
        });
      });
    });
    [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]',
      '[itemprop="price"]',
    ].forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        const value = element.getAttribute('content') || element.getAttribute('value') || elementText(element);
        if (value) values.push(value);
      });
    });
    return unique(values.map((value) => {
      const match = normalize(value).match(/[\d,]+(?:\.\d+)?/);
      return match ? match[0].replace(/,/g, '') : '';
    }));
  }

  function visiblePriceCandidates() {
    const exactMoney = /^\$\s*[\d,]+(?:\.\d+)?(?:\s*[-–~至]\s*\$?\s*[\d,]+(?:\.\d+)?)?$/;
    return unique(linesOf(topProductText())
      .filter((line) => exactMoney.test(line))
      .map((line) => line.replace(/\s+/g, ' ')));
  }

  function originalPriceCandidates() {
    const candidates = [];
    productRoot().querySelectorAll('del, s, [aria-label*="原價"], [title*="原價"]').forEach((element) => {
      if (isVisible(element)) candidates.push(elementText(element));
    });
    const limited = [...productRoot().querySelectorAll('span, div')].slice(0, 5000);
    limited.forEach((element) => {
      const rawText = normalize(element.textContent);
      if (!/^\$\s*[\d,]+(?:\.\d+)?$/.test(rawText) || !isVisible(element)) return;
      const text = normalize(elementText(element));
      if (!/^\$\s*[\d,]+(?:\.\d+)?$/.test(text)) return;
      const decoration = getComputedStyle(element).textDecorationLine || '';
      if (decoration.includes('line-through')) candidates.push(text);
    });
    return unique(candidates);
  }

  function parseLocalizedCount(value) {
    const text = normalize(value).replace(/,/g, '');
    const match = text.match(/([\d.]+)\s*(萬|千)?/);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    if (match[2] === '萬') return Math.round(base * 10000);
    if (match[2] === '千') return Math.round(base * 1000);
    return base;
  }

  function soldFact(text) {
    const patterns = [
      /([\d,.]+\s*(?:萬|千)?)\s*(?:件)?\s*已售出/,
      /已售出\s*([\d,.]+\s*(?:萬|千)?)/,
      /已售\s*([\d,.]+\s*(?:萬|千)?)/,
    ];
    for (const line of linesOf(text)) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) return { raw: line, count: parseLocalizedCount(match[1]) };
      }
    }
    const combined = normalizeLines(text);
    const combinedMatch = combined.match(/([\d,.]+\s*(?:萬|千)?)[ \t\n]*(?:件)?[ \t\n]*已售出/)
      || combined.match(/已售出[ \t\n]*([\d,.]+\s*(?:萬|千)?)/);
    if (combinedMatch) return { raw: normalize(combinedMatch[0]), count: parseLocalizedCount(combinedMatch[1]) };
    return { raw: '', count: null };
  }

  function shopLinkFact() {
    const links = [...productRoot().querySelectorAll('a[href]')];
    const exact = links.find((link) => isVisible(link) && normalize(elementText(link)) === '查看賣場');
    const fallback = links.find((link) => isVisible(link)
      && /(?:\/shop\/|shopid=|seller)/i.test(link.getAttribute('href') || '')
      && !/seller\.shopee/i.test(link.href));
    const link = exact || fallback || null;
    if (!link) return { url: '', text: '', block: '' };
    let container = link;
    let best = elementText(link);
    while (container.parentElement && container.parentElement !== productRoot()) {
      const parentText = elementText(container.parentElement);
      if (parentText.length > 700) break;
      if (parentText.length >= best.length) best = parentText;
      container = container.parentElement;
    }
    return { url: link.href, text: elementText(link), block: best };
  }

  function nonFulfilmentFact(text) {
    const lines = matchingLines(text, /(?:賣場|訂單)?不成立率/, 180);
    for (const line of lines) {
      const match = line.match(/不成立率\s*[:：]?\s*([<>＜＞]?)\s*([\d.]+)\s*%/);
      if (!match) continue;
      return { raw: line, operator: match[1].replace('＜', '<').replace('＞', '>'), rate: Number(match[2]) };
    }
    const combined = normalizeLines(text);
    const match = combined.match(/不成立率[ \t\n]*[:：]?[ \t\n]*([<>＜＞]?)[ \t\n]*([\d.]+)[ \t\n]*%/);
    if (match) return {
      raw: normalize(match[0]),
      operator: match[1].replace('＜', '<').replace('＞', '>'),
      rate: Number(match[2]),
    };
    return { raw: lines[0] || '', operator: '', rate: null };
  }

  function locationFact(text, shopBlock) {
    const combined = `${shopBlock || ''}\n${text}`;
    const patterns = [
      /出貨地[ \t]*[:：]?[ \t]*(?:\n[ \t]*)?([^\n]{1,50})/,
      /商品所在地[ \t]*[:：]?[ \t]*(?:\n[ \t]*)?([^\n]{1,50})/,
      /賣家所在地[ \t]*[:：]?[ \t]*(?:\n[ \t]*)?([^\n]{1,50})/,
    ];
    for (const pattern of patterns) {
      const match = combined.match(pattern);
      if (match) return normalize(match[1]);
    }
    const city = normalize(shopBlock).match(/(基隆市|臺北市|台北市|新北市|桃園市|新竹市|新竹縣|苗栗縣|臺中市|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|臺南市|台南市|高雄市|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/);
    return city ? city[1] : '';
  }

  function locationKind(locationText) {
    const value = normalize(locationText);
    if (!value) return 'unknown';
    if (/(海外|中國大陸|香港|澳門|日本|韓國|美國|新加坡|馬來西亞|泰國|越南|印尼|菲律賓)/.test(value)) return 'overseas';
    if (/(台灣|臺灣|基隆市|臺北市|台北市|新北市|桃園市|新竹[市縣]|苗栗縣|臺中市|台中市|彰化縣|南投縣|雲林縣|嘉義[市縣]|臺南市|台南市|高雄市|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/.test(value)) return 'taiwan';
    return 'unknown';
  }

  function findAIListing(text) {
    const aiPattern = /(?:此頁面內容.*(?:AI|人工智慧).*生成|AI\s*賣場)/i;
    const isAI = aiPattern.test(text);
    if (!isAI) return { isAI: false, link: '', evidence: '' };
    const evidence = matchingLines(text, aiPattern, 300)[0] || '頁面出現 AI 生成／AI 賣場文字';
    const links = [...productRoot().querySelectorAll('a[href]')]
      .filter((link) => /\/product\//.test(link.href) && link.href !== location.href);
    const productLink = links.find((link) => normalize(elementText(link)) === '商品')
      || links.find((link) => /商品/.test(elementText(link)));
    return { isAI: true, link: productLink?.href || '', evidence };
  }

  function interactionTexts() {
    return [...productRoot().querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(isVisible)
      .map((element) => normalize(element.value || elementText(element)))
      .filter(Boolean);
  }

  function stockFact(text) {
    const controls = interactionTexts();
    const unavailableText = linesOf(text).filter((line) => line.length <= 100
      && (/^(?:此商品不存在|此商品已售完|已售完|售完|無庫存|暫無庫存|無法購買)$/.test(line)
        || /商品.{0,12}(?:已售完|無庫存|暫無庫存|無法購買)/.test(line)));
    const soldOutControl = controls.find((value) => /^(?:已售完|售完|無庫存|暫無庫存)$/.test(value));
    const purchaseControl = [...productRoot().querySelectorAll('button, a, [role="button"]')]
      .find((element) => isVisible(element) && !element.disabled
        && /^(?:加入購物車|直接購買)$/.test(normalize(elementText(element))));
    const stockLines = matchingLines(text, /(?:庫存|剩餘|還剩|僅剩)\s*[:：]?\s*\d+\s*件?|已達購買上限/, 160);
    return {
      unavailable: Boolean(soldOutControl || unavailableText.length),
      evidence: soldOutControl || unavailableText[0] || stockLines[0] || '',
      purchaseAvailable: Boolean(purchaseControl),
      stockLines,
    };
  }

  function distributionRestrictionLines(text) {
    return matchingLines(text, /(?:配送地區|不配送|無法配送|僅配送|配送限制|離島.*(?:不|限制)|偏遠地區.*(?:不|限制))/, 220);
  }

  function quantityRestrictionFacts(text) {
    const lines = matchingLines(text,
      /(?:最低購買|至少購買|須購買至少|最高購買|最多購買|限購|購買上限|每筆結帳.*可購買|已達購買上限|新增更多件.*單價.*更新)/,
      260);
    let minimum = null;
    let maximum = null;
    for (const line of lines) {
      const minMatch = line.match(/(?:最低購買(?:數量)?|至少購買|須購買至少)\s*[:：]?\s*(\d+)\s*件?/);
      const maxMatch = line.match(/(?:最高購買(?:數量)?|最多(?:可)?購買|限購|每筆結帳.*?可購買)\s*[:：]?\s*(\d+)\s*件?/);
      if (minimum === null && minMatch) minimum = Number(minMatch[1]);
      if (maximum === null && maxMatch) maximum = Number(maxMatch[1]);
    }
    return {
      lines,
      minimum,
      maximum,
      dynamicUnitPrice: lines.some((line) => /新增更多件.*單價.*更新/.test(line)),
    };
  }

  function shippingLines(text) {
    const candidates = matchingLines(text, /(?:運費|免運)/, 260)
      .filter((line) => !/^(?:運費補助|免運券)$/.test(line));
    const withAmount = candidates.filter((line) => /\$\s*[\d,]+/.test(line));
    return unique(withAmount.length ? withAmount : candidates);
  }

  function priceBreakdownLines(text) {
    const strong = matchingLines(text,
      /(?:價格優惠試算|原始價格|商品折扣|品牌會員折扣|預估金額)/,
      240);
    if (!strong.length) return [];
    return unique([...strong, ...matchingLines(text, /賣場優惠券/, 240)]);
  }

  function exactLabelElements(labels) {
    const wanted = new Set(labels.map(normalize));
    const selector = 'div, span, p, label, dt, th, h2, h3, h4';
    return [...productRoot().querySelectorAll(selector)].filter((element) => {
      const rawText = normalize(element.textContent);
      if (!wanted.has(rawText) || !isVisible(element)) return false;
      const text = normalize(elementText(element));
      if (!wanted.has(text)) return false;
      return ![...element.children].some((child) => wanted.has(normalize(elementText(child))));
    });
  }

  function labelSectionRoots(labels, maxLength = 1300) {
    const roots = [];
    exactLabelElements(labels).forEach((labelElement) => {
      let current = labelElement;
      let selected = labelElement;
      const labelText = normalize(elementText(labelElement));
      while (current.parentElement && current.parentElement !== productRoot()) {
        const parent = current.parentElement;
        const text = elementText(parent);
        if (text.length > maxLength) break;
        const otherSection = /(?:賣場優惠券|賣家優惠券|多件優惠|促銷組合|運送|分期0利率|服務與保障|數量)/g;
        const sectionLabels = unique(text.match(otherSection) || []);
        const includesDifferentSection = sectionLabels.some((value) => !labels.includes(value));
        if (selected !== labelElement && includesDifferentSection) break;
        if (text.length > labelText.length + 2) {
          selected = parent;
          if (BENEFIT_PATTERN.test(text) || hasVoucherDetail(text)) break;
        }
        current = parent;
      }
      roots.push(selected);
    });
    return roots.filter((root, index) => !roots.some((other, otherIndex) => otherIndex < index && other === root));
  }

  const BENEFIT_PATTERN = /(?:現折\s*(?:NT)?\$?\s*[\d,]+|折\s*(?:NT)?\$?\s*[\d,]+|\d+(?:\.\d+)?\s*折|蝦幣\s*(?:\d+(?:\.\d+)?\s*%\s*)?回饋|回饋\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*蝦幣)/i;
  const BENEFIT_TOKEN_PATTERN = /(?:現折\s*(?:NT)?\$?\s*[\d,]+|折\s*(?:NT)?\$?\s*[\d,]+|\d+(?:\.\d+)?\s*折|蝦幣\s*(?:\d+(?:\.\d+)?\s*%\s*)?回饋\s*\d*(?:\.\d+)?\s*%?|回饋\s*\d+(?:\.\d+)?\s*%)/gi;

  function benefitCount(text) {
    return (normalize(text).match(BENEFIT_TOKEN_PATTERN) || []).length;
  }

  function hasVoucherDetail(text) {
    return /(?:低消|滿\s*\$?\s*[\d,]+|有效日期|生效|指定商品|全店適用|會員|新客|最高|上限|每人|限用)/.test(text);
  }

  function expandedOfferRow(element, root) {
    let current = element;
    let best = element;
    let bestText = elementText(element);
    while (current.parentElement && root.contains(current.parentElement)) {
      const parent = current.parentElement;
      const parentText = elementText(parent);
      if (parentText.length > 650) break;
      const currentBenefits = benefitCount(bestText);
      const parentBenefits = benefitCount(parentText);
      if (currentBenefits && parentBenefits > Math.max(1, currentBenefits)) break;
      if (parentText.length >= bestText.length && (hasVoucherDetail(parentText) || !hasVoucherDetail(bestText))) {
        best = parent;
        bestText = parentText;
      }
      current = parent;
    }
    return best;
  }

  function offerRowsFromRoots(roots) {
    const rows = [];
    roots.forEach((root) => {
      const elements = [...root.querySelectorAll('div, li, button, [role="button"], span, p')]
        .filter((element) => {
          if (!isVisible(element)) return false;
          const text = elementText(element);
          return text.length >= 3 && text.length <= 650 && BENEFIT_PATTERN.test(text);
        });
      const leafCandidates = elements.filter((element) => ![...element.children].some((child) => {
        const text = elementText(child);
        return isVisible(child) && text.length >= 3 && BENEFIT_PATTERN.test(text);
      }));
      leafCandidates.forEach((element) => {
        const row = expandedOfferRow(element, root);
        const text = elementText(row);
        if (text && text.length <= 650) rows.push(text);
      });
      if (!leafCandidates.length) {
        const rootText = elementText(root);
        if (rootText.length <= 650 && BENEFIT_PATTERN.test(rootText)) rows.push(rootText);
      }
    });
    const sorted = unique(rows).sort((left, right) => right.length - left.length);
    return sorted.filter((text, index) => !sorted.some((other, otherIndex) => {
      if (otherIndex >= index || other === text) return false;
      return other.includes(text) && benefitCount(other) === benefitCount(text);
    }));
  }

  function futureEffectiveDate(text) {
    const value = normalize(text);
    if (/(?:尚未生效|尚未開始|未生效|活動未開始|即將生效)/.test(value)) return true;
    const match = value.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})\s*(?:日)?\s*(?:起生效|起適用|開始)/);
    if (!match) return false;
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return start.getTime() > today.getTime();
  }

  function voucherCategory(text) {
    return /(?:蝦幣\s*(?:\d+(?:\.\d+)?\s*%\s*)?回饋|回饋\s*\d+(?:\.\d+)?\s*%\s*蝦幣|\d+(?:\.\d+)?\s*%\s*蝦幣)/i.test(text)
      ? '賣場回饋' : '賣場折扣';
  }

  function classifyVoucher(text) {
    const value = normalize(text);
    const memberRestricted = /(?:新客|新戶|新用戶|媽咪會|媽咪會員|吃貨會員|會員(?:專屬|限定|資格)|限(?:定)?會員)/.test(value);
    if (memberRestricted) return { status: 'reject', reason: '限定會員資格／新客優惠券不採用' };
    if (futureEffectiveDate(value)) return { status: 'reject', reason: '尚未生效／活動尚未開始的優惠券不採用' };
    if (!hasVoucherDetail(value)) return { status: 'review', reason: '目前只讀到優惠摘要；須展開明細確認資格、門檻與生效狀態' };
    return { status: 'usable', reason: /指定商品/.test(value)
      ? '指定商品不屬於限定會員；未觸發排除規則'
      : '未觸發既有優惠券排除規則' };
  }

  function captureSellerVouchers() {
    const roots = labelSectionRoots(['賣場優惠券', '賣家優惠券']);
    return offerRowsFromRoots(roots).map((summary) => {
      const decision = classifyVoucher(summary);
      return {
        source: 'seller-coupon', category: voucherCategory(summary),
        label: '賣場優惠券', summary, ...decision,
      };
    });
  }

  function cleanSectionSummary(text, labels) {
    const labelSet = new Set(labels.map(normalize));
    return unique(linesOf(text).filter((line) => !labelSet.has(normalize(line)))).join('｜');
  }

  function captureSellerPromotion(labels, label) {
    const roots = labelSectionRoots(labels, 1000);
    const summaries = unique(roots.map((root) => cleanSectionSummary(elementText(root), labels))
      .filter(Boolean));
    return summaries.map((summary) => {
      const meaningful = /(?:\d|折|買|件|優惠)/.test(summary);
      return {
        source: label === '多件優惠' ? 'multi-buy' : 'promotion-combo',
        category: '賣場折扣', label, summary,
        status: meaningful ? 'usable' : 'review',
        reason: meaningful
          ? '頁面明確顯示此賣場折扣；列為候選，不計算最優惠方案'
          : '只讀到區塊名稱，未讀到優惠內容',
      };
    });
  }

  function leafTextsMatching(pattern, maxLength = 280) {
    const elements = [...productRoot().querySelectorAll('div, span, p, li, button, a')]
      .filter((element) => {
        const rawText = normalize(element.textContent);
        if (rawText.length < 2 || rawText.length > maxLength || !pattern.test(rawText) || !isVisible(element)) return false;
        const text = elementText(element);
        return text.length >= 2 && text.length <= maxLength && pattern.test(text);
      });
    return elements.filter((element) => ![...element.children].some((child) => {
      const text = elementText(child);
      return isVisible(child) && text.length >= 2 && pattern.test(text);
    }));
  }

  function capturePlatformCashback() {
    const voucherRoots = labelSectionRoots(['賣場優惠券', '賣家優惠券']);
    const pattern = /(?:蝦幣\s*(?:\d+(?:\.\d+)?\s*%\s*)?回饋\s*\d*(?:\.\d+)?\s*%?|\d+(?:\.\d+)?\s*%\s*蝦幣\s*回饋|回饋\s*\d+(?:\.\d+)?\s*%\s*蝦幣)/i;
    const texts = leafTextsMatching(pattern)
      .filter((element) => !voucherRoots.some((root) => root.contains(element)))
      .map(elementText);
    return unique(texts).map((summary) => ({
      source: 'platform-cashback', category: '平台回饋', label: '蝦幣回饋', summary,
      status: 'usable', reason: '正式網頁文字顯示平台蝦幣回饋；圖片文字未列入',
    }));
  }

  function imageBenefitWarnings() {
    const pattern = /(?:蝦幣|回饋\s*\d+(?:\.\d+)?\s*%|免運)/i;
    return unique([...productRoot().querySelectorAll('img')].map((image) => {
      const text = normalize(`${image.alt || ''} ${image.title || ''}`);
      return pattern.test(text) ? text : '';
    }).filter(Boolean));
  }

  function getPageFacts() {
    const fullText = mainText();
    const topText = topProductText();
    const shop = shopLinkFact();
    const sold = soldFact(topText);
    const nonFulfilment = nonFulfilmentFact(`${shop.block}\n${topText}`);
    const locationText = locationFact(fullText, shop.block);
    const ai = findAIListing(fullText);
    const stock = stockFact(topText);
    const quantity = quantityRestrictionFacts(topText);
    const structuredPrices = structuredPriceCandidates();
    const visiblePrices = visiblePriceCandidates();
    return {
      title: getTitle(),
      url: getCanonicalUrl(),
      isShopee: /(^|\.)shopee\.tw$/i.test(location.hostname),
      displayPrice: structuredPrices[0] || visiblePrices[0] || '',
      structuredPrices,
      visiblePrices,
      originalPrices: originalPriceCandidates(),
      priceBreakdown: priceBreakdownLines(`${topText}\n${elementText(document.querySelector('[role="dialog"]'))}`),
      sold,
      shop,
      nonFulfilment,
      locationText,
      locationKind: locationKind(locationText),
      ai,
      stock,
      distributionRestrictions: distributionRestrictionLines(topText),
      quantity,
      shipping: shippingLines(topText),
      imageBenefitWarnings: imageBenefitWarnings(),
    };
  }

  function pageChecks(page) {
    const checks = [];
    checks.push(page.isShopee
      ? { status: 'usable', label: '網站', evidence: location.hostname, reason: '目前為 Shopee 台灣網域' }
      : { status: 'review', label: '網站', evidence: location.hostname, reason: '目前不是 Shopee 台灣網域' });

    if (page.ai.isAI) {
      checks.push({ status: 'review', label: 'AI 賣場', evidence: page.ai.evidence,
        reason: page.ai.link
          ? `須開啟商品描述中的一般賣場連結後重新判斷：${page.ai.link}`
          : '須在商品描述找到最右側「商品」連結，跳轉一般賣場後重新判斷' });
    } else {
      checks.push(page.shop.url
        ? { status: 'usable', label: '賣場類型', evidence: page.shop.text || page.shop.url, reason: '讀到一般賣場連結' }
        : { status: 'review', label: '賣場類型', evidence: '', reason: '未讀到「查看賣場」或一般賣場連結' });
    }

    if (page.sold.count === 0) {
      checks.push({ status: 'review', label: '售出數量', evidence: page.sold.raw,
        reason: '原始規則要求檢查 0 售出，但未定義 0 售出的採用結果' });
    } else if (Number.isFinite(page.sold.count)) {
      checks.push({ status: 'usable', label: '售出數量', evidence: page.sold.raw, reason: '頁面不是 0 售出' });
    } else {
      checks.push({ status: 'review', label: '售出數量', evidence: '', reason: '頁面未讀到售出數量' });
    }

    if (page.locationKind === 'overseas') {
      checks.push({ status: 'reject', label: '出貨地', evidence: page.locationText, reason: '海外賣場不採用' });
    } else if (page.locationKind === 'taiwan') {
      checks.push({ status: 'usable', label: '出貨地', evidence: page.locationText, reason: '讀到台灣出貨地' });
    } else {
      checks.push({ status: 'review', label: '出貨地', evidence: page.locationText, reason: '未能明確確認是否為非海外賣場' });
    }

    const rate = page.nonFulfilment;
    if (Number.isFinite(rate.rate)) {
      if (rate.operator === '<' && rate.rate <= 10) {
        checks.push({ status: 'usable', label: '賣場不成立率', evidence: rate.raw, reason: '頁面明示不成立率小於 10%' });
      } else if (!rate.operator && rate.rate < 10) {
        checks.push({ status: 'usable', label: '賣場不成立率', evidence: rate.raw, reason: '不成立率小於 10%' });
      } else if (!rate.operator && rate.rate >= 10) {
        checks.push({ status: 'reject', label: '賣場不成立率', evidence: rate.raw, reason: '不成立率未小於 10%' });
      } else if (rate.operator === '>' && rate.rate >= 10) {
        checks.push({ status: 'reject', label: '賣場不成立率', evidence: rate.raw, reason: '頁面明示不成立率高於 10%' });
      } else {
        checks.push({ status: 'review', label: '賣場不成立率', evidence: rate.raw, reason: '目前文字不足以證明不成立率小於 10%' });
      }
    } else {
      checks.push({ status: 'review', label: '賣場不成立率', evidence: rate.raw,
        reason: page.ai.isAI ? 'AI 賣場須先跳轉一般賣場確認' : '商品頁未讀到；須到賣場資訊確認小於 10%' });
    }

    if (page.stock.unavailable) {
      checks.push({ status: 'reject', label: '庫存', evidence: page.stock.evidence, reason: '頁面明示商品不存在、售完或無庫存' });
    } else if (page.stock.purchaseAvailable) {
      checks.push({ status: 'usable', label: '庫存', evidence: page.stock.stockLines.join('｜') || '購買按鈕可用', reason: '可購買；剩餘庫存數量不作淘汰標準' });
    } else {
      checks.push({ status: 'review', label: '庫存', evidence: page.stock.evidence, reason: '未能由目前頁面明確確認庫存至少 1 件' });
    }

    if (page.distributionRestrictions.length) {
      checks.push({ status: 'review', label: '配送地區', evidence: page.distributionRestrictions.join('｜'),
        reason: '頁面出現配送限制；原始規則沒有定義淘汰條件' });
    } else {
      checks.push({ status: 'usable', label: '配送地區', evidence: '', reason: '目前頁面未讀到配送地區限制' });
    }
    return checks;
  }

  function captureAll() {
    const page = getPageFacts();
    const offers = [
      ...captureSellerVouchers(),
      ...captureSellerPromotion(['多件優惠'], '多件優惠'),
      ...captureSellerPromotion(['促銷組合'], '促銷組合'),
      ...capturePlatformCashback(),
    ];
    const checks = pageChecks(page);
    const rejectedChecks = checks.filter((check) => check.status === 'reject');
    const reviewChecks = checks.filter((check) => check.status === 'review');
    const overall = rejectedChecks.length ? 'reject' : reviewChecks.length ? 'review' : 'usable';
    const manual = [];

    if (!page.priceBreakdown.length) manual.push('若價格旁有圖標，先手動點開價格明細，再重新掃描；助手不會自行假設顯示價是否已套券。');
    if (page.quantity.dynamicUnitPrice) manual.push('頁面提示多件單價會更新：依酷澎數量加入購物車確認單價；助手不會更動購物車。');
    if (page.quantity.minimum !== null) manual.push('最低購買數量需交由 Excel／人工套用一般商品 110% 或嬰幼兒尿布 150% 規則，並確認酷澎無相同組數庫存。');
    if (page.quantity.maximum !== null || page.quantity.lines.some((line) => /購買上限/.test(line))) manual.push('最高購買數量不直接淘汰；超過單次上限時須拆單並分別計算運費。');
    if (page.imageBenefitWarnings.length) manual.push('圖片替代文字疑似含免運／回饋字樣；圖片內容不列為平台回饋，須以正式優惠文字為準。');
    if (!offers.some((offer) => offer.category === '平台回饋')) manual.push('未讀到正式平台回饋文字；商品主圖上的蝦幣回饋圖示不採用。');
    if (offers.filter((offer) => offer.status === 'usable' && offer.category === '賣場折扣').length > 1) manual.push('有多個可用賣場折扣候選；由 Excel／人工選折扣最多者，賣場優惠券只能使用一張。');
    offers.filter((offer) => offer.status === 'review').forEach((offer) => manual.push(`${offer.label}：${offer.reason}`));
    reviewChecks.forEach((check) => manual.push(`${check.label}：${check.reason}`));

    return { page, checks, offers, overall, manual: unique(manual) };
  }

  const host = document.createElement('div');
  host.id = APP_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; } * { box-sizing: border-box; }
      .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 560px;
        max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto;
        color: #17202a; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px;
        box-shadow: 0 18px 50px rgba(15,23,42,.28); font: 13px/1.45 system-ui, sans-serif; }
      header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
        justify-content: space-between; gap: 8px; padding: 11px 12px; color: #fff; background: #ee4d2d;
        cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.55); border-radius: 6px; cursor: pointer; }
      main { padding: 12px; } section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 112px 1fr; gap: 5px 8px; }
      .facts b { overflow-wrap: anywhere; }
      label { display: block; margin-top: 8px; color: #334155; font-size: 12px; }
      textarea { width: 100%; min-height: 54px; margin-top: 3px; padding: 7px 8px; resize: vertical;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button.action { padding: 8px 11px; color: #fff; background: #ee4d2d; border: 0;
        border-radius: 6px; cursor: pointer; font: inherit; font-weight: 700; }
      button.secondary { color: #334155; background: #f1f5f9; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .usable { color: #166534; } .reject { color: #b42318; } .review { color: #92400e; }
      .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回到右上角"><strong>Shopee 資訊擷取助手 v${VERSION}</strong><button id="close" title="關閉">×</button></header>
      <main>
        <section id="pageSection"></section>
        <div id="progress" class="status info">準備掃描。請先手動展開價格圖標與優惠券明細。</div>
        <div class="actions">
          <button class="action" id="capture">重新掃描頁面</button>
          <button class="action secondary" id="copyUsable">複製可用項目</button>
          <button class="action secondary" id="copyAll">複製完整判斷</button>
        </div>
        <section id="outputSection" class="hidden">
          <h2>可填候選（保留網頁原文）</h2>
          <label>價格資料<textarea id="priceOutput" readonly></textarea></label>
          <label>平台折扣<textarea id="platformDiscountOutput" readonly></textarea></label>
          <label>賣場折扣<textarea id="sellerDiscountOutput" readonly></textarea></label>
          <label>平台回饋<textarea id="platformCashbackOutput" readonly></textarea></label>
          <label>賣場回饋<textarea id="sellerCashbackOutput" readonly></textarea></label>
          <label>運費原文<textarea id="shippingOutput" readonly></textarea></label>
          <label>最低／最高購買量原文<textarea id="quantityOutput" readonly></textarea></label>
          <p class="muted">平台折扣依原始規則不採用，所以保持空白。本助手不計算、不選最高值、不領券、不加購物車。</p>
        </section>
        <section id="decisionSection" class="hidden"></section>
        <section id="manualSection" class="hidden"></section>
      </main>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;

  function statusLabel(status) {
    return ({ usable: '可用', review: '需人工確認', reject: '不採用' })[status] || status;
  }

  function renderPage(result) {
    const { page, overall } = result;
    const overallHtml = overall === 'reject'
      ? '<div class="status bad">賣場不採用：有明確淘汰條件</div>'
      : overall === 'review'
        ? '<div class="status warn">尚不能判定可採用：仍有必要資訊需確認</div>'
        : '<div class="status ok">已讀到的賣場資格均符合原始規則</div>';
    const prices = unique([
      page.displayPrice ? `主要價格：${page.displayPrice}` : '',
      ...page.visiblePrices.map((value) => `頁面：${value}`),
      ...page.originalPrices.map((value) => `刪除線／原價：${value}`),
    ]).join('｜') || '未讀到';
    $('#pageSection').innerHTML = `<h2>商品頁</h2>${overallHtml}
      <div class="facts"><span>商品</span><b>${escapeHtml(page.title || '未讀到')}</b>
      <span>網址</span><b>${escapeHtml(page.url)}</b>
      <span>價格</span><b>${escapeHtml(prices)}</b>
      <span>售出</span><b>${escapeHtml(page.sold.raw || '未讀到')}</b>
      <span>出貨地</span><b>${escapeHtml(page.locationText || '未讀到')}</b>
      <span>不成立率</span><b>${escapeHtml(page.nonFulfilment.raw || '未讀到')}</b></div>`;
  }

  function offerText(offer) {
    return `${offer.label ? `[${offer.label}] ` : ''}${offer.summary}`;
  }

  function renderList(items, type) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((item) => `<li class="${type}"><b>${escapeHtml(item.label)}｜${escapeHtml(item.reason)}</b>${item.evidence ? `<div class="evidence">${escapeHtml(item.evidence)}</div>` : ''}${item.summary ? `<div>${escapeHtml(item.summary)}</div>` : ''}</li>`).join('')}</ul>`;
  }

  function renderResult(result) {
    renderPage(result);
    const usable = result.offers.filter((offer) => offer.status === 'usable');
    const review = result.offers.filter((offer) => offer.status === 'review');
    const rejected = result.offers.filter((offer) => offer.status === 'reject');
    const categoryText = (category) => usable.filter((offer) => offer.category === category).map(offerText).join('\n');
    const priceLines = unique([
      result.page.displayPrice ? `頁面主要價格：${result.page.displayPrice}` : '',
      ...result.page.visiblePrices.map((value) => `頁面顯示：${value}`),
      ...result.page.originalPrices.map((value) => `原價／刪除線：${value}`),
      ...result.page.priceBreakdown,
    ]);
    $('#priceOutput').value = priceLines.join('\n');
    $('#platformDiscountOutput').value = '';
    $('#sellerDiscountOutput').value = categoryText('賣場折扣');
    $('#platformCashbackOutput').value = categoryText('平台回饋');
    $('#sellerCashbackOutput').value = categoryText('賣場回饋');
    $('#shippingOutput').value = result.page.shipping.join('\n');
    $('#quantityOutput').value = result.page.quantity.lines.join('\n');
    $('#outputSection').classList.remove('hidden');

    const usableChecks = result.checks.filter((check) => check.status === 'usable');
    const reviewChecks = result.checks.filter((check) => check.status === 'review');
    const rejectedChecks = result.checks.filter((check) => check.status === 'reject');
    $('#decisionSection').innerHTML = `<h2>逐項判斷</h2>
      <details open><summary class="reject">賣場不採用（${rejectedChecks.length}）</summary>${renderList(rejectedChecks, 'reject')}</details>
      <details open><summary class="review">賣場需人工確認（${reviewChecks.length}）</summary>${renderList(reviewChecks, 'review')}</details>
      <details><summary class="usable">賣場符合（${usableChecks.length}）</summary>${renderList(usableChecks, 'usable')}</details>
      <details open><summary class="usable">可用優惠候選（${usable.length}）</summary>${renderList(usable, 'usable')}</details>
      <details open><summary class="review">優惠需確認（${review.length}）</summary>${renderList(review, 'review')}</details>
      <details><summary class="reject">優惠不採用（${rejected.length}）</summary>${renderList(rejected, 'reject')}</details>`;
    $('#decisionSection').classList.remove('hidden');

    $('#manualSection').innerHTML = `<h2>後續必要動作</h2>${result.manual.length
      ? `<ul>${result.manual.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="muted">無</p>'}`;
    $('#manualSection').classList.remove('hidden');

    const counts = `${usable.length} 個可用優惠候選；${review.length} 個優惠需確認`;
    $('#progress').className = `status ${result.overall === 'reject' ? 'bad' : result.overall === 'review' ? 'warn' : 'ok'}`;
    $('#progress').textContent = `掃描完成：賣場${statusLabel(result.overall)}；${counts}。未做任何金額計算。`;
  }

  function cleanCell(value) {
    return normalize(value).replace(/[\t\r\n]+/g, ' ');
  }

  function toTsv(result, onlyUsable) {
    const header = ['網址', '商品', '頁面價格', '項目', '判定', '原文證據', '理由'];
    const rows = [];
    if (!onlyUsable) {
      result.checks.forEach((check) => rows.push([
        result.page.url, result.page.title, result.page.displayPrice, check.label,
        statusLabel(check.status), check.evidence, check.reason,
      ]));
    }
    result.offers.filter((offer) => !onlyUsable || offer.status === 'usable').forEach((offer) => rows.push([
      result.page.url, result.page.title, result.page.displayPrice, offer.category,
      statusLabel(offer.status), offerText(offer), offer.reason,
    ]));
    if (!onlyUsable) {
      result.page.shipping.forEach((value) => rows.push([
        result.page.url, result.page.title, result.page.displayPrice, '運費原文', '交由 Excel', value, '免運門檻統一 49 元；助手不計算',
      ]));
      result.page.quantity.lines.forEach((value) => rows.push([
        result.page.url, result.page.title, result.page.displayPrice, '購買數量限制', '交由 Excel／人工', value, '依最低／最高購買數量規則處理',
      ]));
    }
    return [header, ...rows].map((row) => row.map(cleanCell).join('\t')).join('\n');
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      button.textContent = '已複製';
    } catch (error) {
      console.error('[Shopee 資訊擷取助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally {
      setTimeout(() => { button.textContent = original; }, 1200);
    }
  }

  function capture() {
    try {
      $('#progress').className = 'status info';
      $('#progress').textContent = '正在掃描頁面文字…';
      latest = captureAll();
      renderResult(latest);
      return latest;
    } catch (error) {
      console.error('[Shopee 資訊擷取助手] 掃描失敗', error);
      $('#progress').className = 'status bad';
      $('#progress').textContent = `掃描失敗：${normalize(error?.message || error)}`;
      return null;
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
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
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
      handle.releasePointerCapture?.(event.pointerId);
      drag = null;
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      panel.style.left = 'auto';
      panel.style.right = '12px';
      panel.style.top = '12px';
    });
  }

  function destroy() {
    host.remove();
    if (window.ShopeeJudgementHelper?.version === VERSION) delete window.ShopeeJudgementHelper;
  }

  $('#close').addEventListener('click', destroy);
  $('#capture').addEventListener('click', capture);
  $('#copyUsable').addEventListener('click', () => latest && copyText(toTsv(latest, true), $('#copyUsable')));
  $('#copyAll').addEventListener('click', () => latest && copyText(toTsv(latest, false), $('#copyAll')));
  enableDragging();
  capture();

  window.ShopeeJudgementHelper = {
    version: VERSION,
    capture,
    result: () => latest,
    destroy,
  };
  console.info(`[Shopee 資訊擷取助手 v${VERSION}] 已啟動。只讀取並分類頁面資訊；不計算、不領券、不加購物車。`);
})();
