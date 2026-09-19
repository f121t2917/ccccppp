(() => {
  'use strict';

  const APP_ID = 'pchome-judgement-helper';
  const VERSION = '2.3.1';

  if (window.PCHomeJudgementHelper?.destroy) window.PCHomeJudgementHelper.destroy();
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
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };

  async function waitFor(check, timeout = 3500, interval = 80) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function textOf(selector, root = document) {
    const element = root.querySelector(selector);
    return normalize(element?.innerText || element?.textContent);
  }

  function getTitle() {
    const titleElement = [...document.querySelectorAll('h1')].find(isVisible);
    return normalize(titleElement?.innerText || document.title);
  }

  function numberText(value) {
    const match = normalize(value).match(/[\d,]+/);
    return match ? match[0].replace(/,/g, '') : '';
  }

  const toNumber = (value) => {
    const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const roundMoney = (value) => Math.max(0, Math.round(Number(value) || 0));

  function money(value) {
    return roundMoney(value).toLocaleString('zh-TW');
  }

  function getPageFacts() {
    const currentPriceElement = document.querySelector('[data-regression="prod_redPrice"]');
    const priceArea = currentPriceElement?.closest('.c-prodInfoV2__price, .c-prodInfo__price')
      || currentPriceElement?.parentElement?.parentElement;
    const priceContext = normalize(priceArea?.innerText || priceArea?.textContent);
    return {
      title: getTitle(),
      url: location.href,
      currentPrice: numberText(textOf('[data-regression="prod_redPrice"]')),
      originalPrice: numberText(textOf('[data-regression="prodPage_originalPrice"]')),
      priceContext,
      priceIncludesPromotion: /(折扣價|點我再折扣|促銷價|特價)/.test(priceContext),
      isPChome: /(^|\.)pchome\.com\.tw$/i.test(location.hostname),
    };
  }

  function getPageExclusions() {
    const title = getTitle();
    const primaryActions = unique(
      [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')]
        .filter(isVisible)
        .map((element) => element.value || element.innerText || element.textContent)
        .filter((text) => normalize(text).length <= 80),
    );
    const linksAndActions = unique(
      [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(isVisible)
        .map((element) => element.innerText || element.textContent)
        .filter((text) => normalize(text).length <= 80),
    );
    const reasons = [];
    if (/(電子票券|電子憑證)/.test(title)) reasons.push('商品標題為電子票券／電子憑證');
    if (primaryActions.some((text) => /^(售完|已售完)$/.test(text))) reasons.push('頁面顯示售完');
    if (primaryActions.some((text) => text.includes('有貨通知我'))) reasons.push('頁面顯示有貨通知我');
    if (linksAndActions.some((text) => text.includes('前往活動賣場'))) reasons.push('頁面只能前往活動賣場');
    if (primaryActions.some((text) => text === '選購')) reasons.push('購買按鈕為選購');
    return unique(reasons);
  }

  function parseFacts(text) {
    const value = normalize(text).replace(/，/g, ',').replace(/％/g, '%');
    const threshold = value.match(/(?:單筆(?:消費)?[^。；，]{0,18}?滿|滿)\s*(?:\$\s*([\d,]+)|([\d,]+)\s*元)/);
    const minQty = value.match(/(?:滿|任選)\s*([\d,]+)\s*(?:件|入|組|包|盒|罐|瓶|個)/);
    const pcoinFixed = value.match(/送\s*([\d,]+)\s*P幣/i);
    const pcoinRate = value.match(/(?:送|回饋)?\s*([\d.]+)\s*%\s*P幣/i);
    const cap = value.match(/(?:最高|上限)\s*\$?\s*([\d,]+)\s*(P幣|元)?/i);
    const finalPrice = value.match(/(?:折扣後(?:金額|價格)|券後(?:價|金額)|優惠價)\s*\$?\s*([\d,]+)/);
    const fullDiscount = value.match(/([\d.]+)\s*折(?:\D|$)/);
    const fixedDiscount = value.match(/(?:滿\s*\$?\s*[\d,]+\s*(?:元)?\s*)?(?:現折|現抵|折抵|折)\s*\$?\s*([\d,]+)\s*(?:元)?/);
    const percent = value.match(/(?:現折|現抵|折抵|省|回饋)\s*([\d.]+)\s*%/);
    let benefit = '';
    let unit = '';
    if (pcoinFixed) [benefit, unit] = [pcoinFixed[1].replace(/,/g, ''), 'P幣'];
    else if (pcoinRate) [benefit, unit] = [pcoinRate[1], '% P幣'];
    else if (finalPrice) [benefit, unit] = [finalPrice[1].replace(/,/g, ''), '折後價'];
    else if (fullDiscount) [benefit, unit] = [fullDiscount[1], '折'];
    else if (fixedDiscount) [benefit, unit] = [fixedDiscount[1].replace(/,/g, ''), '元'];
    else if (percent) [benefit, unit] = [percent[1], '%'];
    return {
      threshold: threshold ? (threshold[1] || threshold[2]).replace(/,/g, '') : '',
      minQty: minQty ? minQty[1].replace(/,/g, '') : '',
      benefit,
      unit,
      cap: cap ? cap[1].replace(/,/g, '') : '',
    };
  }

  function quotaFrom(text) {
    const match = normalize(text).match(/(?:限量|限前)\s*([\d,]+)\s*(人|名|份|筆)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function classifyOffer(offer) {
    const main = normalize(`${offer.label || ''} ${offer.summary || ''}`);
    const condition = normalize([
      offer.fields?.['贈送條件'], offer.fields?.['活動條件'],
      offer.fields?.['優惠內容'], offer.fields?.['使用條件'],
      offer.fields?.['活動折扣'], offer.fields?.['活動說明'], offer.fields?.['注意事項'],
    ].filter(Boolean).join(' '));
    const payment = normalize(offer.fields?.['付款方式'] || '');
    const relevant = normalize(`${main} ${condition}`);
    const noRegistration = /(免登記|不需登記|無須登記)/.test(relevant);
    const registration = !noRegistration && /(登記送|須登記|需登記|限登記|登記回饋|登記抽|登記)/.test(relevant);
    const thursdayTwoPercent = /週四.{0,24}(2\s*%|2％)|(2\s*%|2％).{0,24}週四/.test(relevant);
    const memberOnly = /(會員專屬|指定會員|會員限時)/.test(relevant);
    const couponContext = /券/.test(offer.category || '') || offer.source === 'coupon';
    const quota = quotaFrom(relevant);
    const couponLimited = couponContext && /限量/.test(relevant)
      && (!Number.isFinite(quota) || quota < 1000);
    const underThousand = Number.isFinite(quota) && quota < 1000;
    const vagueLimited = /限量/.test(relevant) && !Number.isFinite(quota);
    const prime = /(星展\s*(PChome)?\s*(Prime)?\s*聯名卡|星展\s*Prime|PChome\s*聯名卡)/i.test(main);
    const paymentText = normalize(`${main} ${payment}`);
    const anyPayment = /任一付款方式/.test(payment);
    const paymentRestricted = !anyPayment
      && (/(限|僅限|指定).{0,20}(支付|PAY|Pay|pay|卡別|信用卡)/.test(paymentText)
        || /刷.{0,18}卡/.test(paymentText))
      && !prime;
    const gift = /(贈品|贈.{0,20}(好禮|商品|禮物))/.test(main) && !/P幣/.test(main);
    const unavailable = /(已領完|已使用|已失效|不可領取)/.test(relevant);

    if (thursdayTwoPercent) return { status: 'reject', reason: '週四 2% 加碼不採用' };
    if (memberOnly) return { status: 'reject', reason: '會員限定不採用' };
    if (registration) return { status: 'reject', reason: '登記類不採用' };
    if (unavailable) return { status: 'reject', reason: '頁面顯示此券目前不可使用' };
    if (couponLimited) return { status: 'reject', reason: '寫有「限量」的折價券不採用' };
    if (underThousand) return { status: 'reject', reason: `名額 ${quota}，少於 1,000` };
    if (vagueLimited) return { status: 'reject', reason: '只寫「限量」但未標明名額' };
    if (paymentRestricted) return { status: 'reject', reason: '限定付款方式不採用' };
    if (gift) return { status: 'ignore', reason: '贈品忽略' };
    if (['promotion', 'discount'].includes(offer.source) && offer.detailRequired && !offer.detailLoaded) {
      return { status: 'review', reason: '未讀到官方活動明細，無法確認隱藏條件' };
    }
    if (offer.source === 'coupon' && !['單品券', '滿折券'].includes(offer.category)) {
      return { status: 'review', reason: '頁面未明示為單品券或滿折券，不自行分類' };
    }
    if (offer.source === 'coupon' && offer.category === '單品券'
      && offer.checkFound && !offer.checkSelectable) {
      return { status: 'review', reason: '右側勾選存在但不可操作；頁面未明示原因' };
    }
    if (!['折扣活動', '單品券', '滿折券', 'P幣'].includes(offer.category)) {
      return { status: 'review', reason: '不屬於四種指定優惠類型，需人工確認' };
    }
    if (offer.source === 'coupon' && offer.category === '單品券' && offer.checkSelectable) {
      return { status: 'usable', reason: '右側勾選可操作，且未觸發排除規則' };
    }
    return { status: 'usable', reason: '符合既有規則，可填入' };
  }

  function promotionCategory(label, summary) {
    const combined = normalize(`${label} ${summary}`);
    if (/P幣/i.test(combined)) return 'P幣';
    if (/(現折|現抵|折扣|滿.{0,16}折|\d+(?:\.\d+)?\s*折)/.test(combined)) return '折扣活動';
    if (/(星展\s*(PChome)?\s*(Prime)?\s*聯名卡|星展\s*Prime|PChome\s*聯名卡)/i.test(combined)) return '折扣活動';
    return '其他活動';
  }

  function couponCategory(text) {
    const value = normalize(text);
    if (/(單品券|單品折價券)/.test(value)
      || (/指定單品/.test(value) && /(折價券|現抵|現折|折抵)/.test(value))) return '單品券';
    if (/(滿折券|滿額券|滿額折價券)/.test(value)) return '滿折券';
    return '未分類折價券';
  }

  function couponCheckState(element) {
    const row = element.closest('li, [data-regression*="couponItem" i], [class*="couponItem" i], [class*="coupon-item" i]')
      || element.parentElement
      || element;
    const selector = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[aria-checked]:not([role="tab"])',
      '[data-regression*="checkbox" i]',
      '[class*="checkbox" i]',
      'button[class*="check" i]',
      '[role="button"][class*="check" i]',
    ].join(',');
    const controls = [...row.querySelectorAll(selector)];
    if (row.matches?.(selector)) controls.unshift(row);
    if (!controls.length) return { checkFound: false, checkSelectable: false };

    const control = controls.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.right - leftRect.right;
    })[0];
    const nestedCheckbox = control.querySelector('input[type="checkbox"], [role="checkbox"]');
    const disabledAncestor = control.closest('[aria-disabled="true"], [disabled], .is-disabled, .is-disable, .disabled');
    const classText = normalize(`${control.className || ''} ${control.parentElement?.className || ''}`);
    const disabledClass = /(^|\s)is-?disabled?(\s|$)|(^|\s)disabled?(\s|$)/i.test(classText);
    const disabled = Boolean(control.disabled)
      || control.getAttribute('aria-disabled') === 'true'
      || Boolean(nestedCheckbox?.disabled)
      || nestedCheckbox?.getAttribute('aria-disabled') === 'true'
      || Boolean(disabledAncestor)
      || disabledClass;
    const nativeCheckbox = control.matches('input[type="checkbox"]');
    const semanticControl = nativeCheckbox
      || control.matches('button, [role="checkbox"], [role="button"], label')
      || control.hasAttribute('aria-checked')
      || control.tabIndex >= 0
      || Boolean(nestedCheckbox);
    return {
      checkFound: true,
      checkSelectable: semanticControl && !disabled,
    };
  }

  function fieldsFromDialog(dialog) {
    const fields = {};
    dialog.querySelectorAll('.c-detailGrid__item').forEach((item) => {
      const title = normalize(item.querySelector('.c-detailGrid__title')?.innerText);
      const content = normalize(item.querySelector('.c-detailGrid__content')?.innerText);
      if (title && content && !fields[title]) fields[title] = content;
    });
    return fields;
  }

  function visibleLoginExists() {
    return [...document.querySelectorAll('a, button, [role="button"]')]
      .some((element) => isVisible(element) && normalize(element.innerText || element.textContent) === '登入');
  }

  async function closeOfficialPopup() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const close = dialog.querySelector('[data-regression="prod_popupEndBtn"], button[aria-label="close button"]');
    close?.click();
    await waitFor(() => !document.querySelector('[role="dialog"]'), 1800);
  }

  function mainPromotionRows() {
    return [...document.querySelectorAll('[data-regression="prod_promotions"] [data-regression="prod_promoItem"]')];
  }

  function promotionSummary(row) {
    const label = normalize(row.querySelector('[data-regression="prod_promoTag"]')?.innerText);
    const summary = normalize(row.querySelector('[data-regression="prod_promoText"]')?.innerText);
    return { label, summary: summary || normalize(row.innerText) };
  }

  async function readPromotionDetail(index) {
    await closeOfficialPopup();
    const row = mainPromotionRows()[index];
    if (!row) return { loaded: false, fields: {}, detailTitle: '', detailText: '' };
    const target = row.querySelector('.c-discountEvent, [role="button"]') || row;
    target.click();
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 3500);
    if (!dialog) return { loaded: false, fields: {}, detailTitle: '', detailText: '' };
    await sleep(180);
    const detail = {
      loaded: true,
      fields: fieldsFromDialog(dialog),
      detailTitle: textOf('.c-popUp__headText', dialog),
      detailText: normalize(dialog.innerText),
    };
    await closeOfficialPopup();
    return detail;
  }

  function discountActivityRows() {
    const rows = [...document.querySelectorAll('[data-regression="prod_discount_title"]')]
      .map((title) => title.closest('.c-discountEvent') || title.parentElement)
      .filter((row) => row && isVisible(row));
    return [...new Set(rows)];
  }

  function discountActivitySummary(row) {
    return {
      label: normalize(row.querySelector('.c-label__text')?.innerText) || '折扣',
      summary: textOf('[data-regression="prod_discount_title"]', row),
      date: normalize(row.querySelector('.c-discountEvent__date')?.innerText),
      inlineDetail: normalize(row.querySelector('.c-discountEvent__text')?.innerText),
    };
  }

  async function readDiscountActivityDetail(index) {
    await closeOfficialPopup();
    const row = discountActivityRows()[index];
    if (!row) return { loaded: false, fields: {}, detailTitle: '', detailText: '' };
    const button = row.querySelector('button[data-regression="prod_infoBtn"], [data-regression="prod_infoBtn"] button');
    if (!button) return { loaded: false, fields: {}, detailTitle: '', detailText: '' };
    button.click();
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 3500);
    if (!dialog) return { loaded: false, fields: {}, detailTitle: '', detailText: '' };
    await sleep(180);
    const detail = {
      loaded: true,
      fields: fieldsFromDialog(dialog),
      detailTitle: textOf('.c-popUp__headText', dialog),
      detailText: normalize(dialog.innerText),
    };
    await closeOfficialPopup();
    return detail;
  }

  async function captureDiscountActivities(onProgress) {
    const summaries = discountActivityRows().map(discountActivitySummary);
    const offers = [];
    for (let index = 0; index < summaries.length; index += 1) {
      const base = summaries[index];
      onProgress(`讀取折扣活動 ${index + 1}/${summaries.length}：${base.summary}`);
      const detail = await readDiscountActivityDetail(index);
      const inlineFields = {
        ...(base.date ? { 活動期間: base.date } : {}),
        ...(base.inlineDetail ? { 活動折扣: base.inlineDetail } : {}),
      };
      const fields = { ...inlineFields, ...detail.fields };
      const offer = {
        source: 'discount',
        category: '折扣活動',
        label: base.label,
        summary: base.summary,
        fields,
        detailRequired: true,
        detailLoaded: detail.loaded,
        detailTitle: detail.detailTitle,
        detailText: detail.detailText,
        facts: parseFacts(`${base.summary} ${Object.values(fields).join(' ')}`),
      };
      Object.assign(offer, classifyOffer(offer));
      offers.push(offer);
    }
    return offers;
  }

  async function capturePromotions(onProgress) {
    const summaries = mainPromotionRows().map(promotionSummary);
    const offers = [];
    for (let index = 0; index < summaries.length; index += 1) {
      const base = summaries[index];
      onProgress(`讀取優惠活動 ${index + 1}/${summaries.length}：${base.label || base.summary}`);
      const preOffer = {
        source: 'promotion', category: promotionCategory(base.label, base.summary),
        label: base.label, summary: base.summary, fields: {},
        detailRequired: true, detailLoaded: false,
      };
      const obvious = classifyOffer({ ...preOffer, detailRequired: false });
      const detail = ['reject', 'ignore'].includes(obvious.status)
        ? { loaded: false, fields: {}, detailTitle: '', detailText: '' }
        : await readPromotionDetail(index);
      const offer = {
        ...preOffer,
        fields: detail.fields,
        detailLoaded: detail.loaded,
        detailTitle: detail.detailTitle,
        detailText: detail.detailText,
        facts: parseFacts(`${base.summary} ${Object.values(detail.fields).join(' ')}`),
      };
      Object.assign(offer, classifyOffer(offer));
      offers.push(offer);
    }
    return offers;
  }

  function couponRowsFromDialog(dialog, forcedCategory = '') {
    const selector = '.c-discountEvent, [data-regression*="coupon"], li';
    const all = [...dialog.querySelectorAll(selector)].filter(isVisible);
    const candidates = all.filter((element) => {
      const text = normalize(element.innerText || element.textContent);
      if (text.length < 4 || text.length > 600) return false;
      if (/^(看全部|查看折價券|折價券|單品券|滿折券|滿額券)$/.test(text)) return false;
      const sameChild = [...element.querySelectorAll(selector)]
        .filter((child) => child !== element && isVisible(child))
        .some((child) => normalize(child.innerText || child.textContent) === text);
      return !sameChild;
    });
    const seen = new Set();
    const rows = [];
    for (const element of candidates) {
      const summary = normalize(element.innerText || element.textContent);
      const label = normalize(element.querySelector('.c-label__text, [data-regression="prod_promoTag"]')?.innerText);
      const category = forcedCategory || couponCategory(`${label} ${summary}`);
      const check = couponCheckState(element);
      const key = `${category}\u0000${summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ label, summary, category, availableCount: 1, ...check });
    }
    return rows;
  }

  function couponTabLabels(dialog) {
    return unique(
      [...dialog.querySelectorAll('button, [role="tab"], [role="button"]')]
        .filter(isVisible)
        .map((element) => normalize(element.innerText || element.textContent))
        .filter((text) => /^(單品券|單品折價券|滿折券|滿額券|滿額折價券)$/.test(text)),
    );
  }

  async function clickCouponTab(label) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const target = [...dialog.querySelectorAll('button, [role="tab"], [role="button"]')]
      .find((element) => isVisible(element) && normalize(element.innerText || element.textContent) === label);
    target?.click();
    if (target) await sleep(220);
    return document.querySelector('[role="dialog"]');
  }

  async function captureCoupons(onProgress) {
    const entry = document.querySelector('[data-regression="prod_coupon"] button[data-regression="prod_lookall"], [data-regression="prod_coupon"] [data-regression="prod_lookall"]');
    if (!entry) return { offers: [], note: '頁面未顯示折價券入口' };
    if (visibleLoginExists()) return { offers: [], note: '折價券明細需先登入 PChome，再重新執行助手' };
    onProgress('開啟折價券清單（不會領券）');
    await closeOfficialPopup();
    entry.click();
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
    if (!dialog) return { offers: [], note: '未能開啟折價券清單，請人工確認' };
    await sleep(250);
    const collected = [];
    const tabs = couponTabLabels(dialog);
    if (tabs.length) {
      for (const tabLabel of tabs) {
        onProgress(`讀取折價券：${tabLabel}`);
        const current = await clickCouponTab(tabLabel);
        if (current) collected.push(...couponRowsFromDialog(current, couponCategory(tabLabel)));
      }
    } else collected.push(...couponRowsFromDialog(dialog));

    const offers = [];
    const uniqueRows = new Map();
    for (const row of collected) {
      const key = `${row.category}\u0000${row.summary}`;
      const existing = uniqueRows.get(key);
      if (existing) {
        existing.availableCount += row.availableCount || 1;
        existing.checkFound = existing.checkFound || row.checkFound;
        existing.checkSelectable = existing.checkSelectable || row.checkSelectable;
      } else uniqueRows.set(key, { ...row });
    }
    for (const row of uniqueRows.values()) {
      const offer = {
        source: 'coupon', category: row.category, label: row.label, summary: row.summary,
        fields: {}, detailRequired: false, detailLoaded: true, facts: parseFacts(row.summary),
        availableCount: row.availableCount || 1,
        checkFound: row.checkFound, checkSelectable: row.checkSelectable,
      };
      Object.assign(offer, classifyOffer(offer));
      offers.push(offer);
    }
    await closeOfficialPopup();
    return {
      offers,
      note: offers.length ? '' : '已開啟折價券清單，但無法明確切出券別與內容，請人工確認',
    };
  }

  const host = document.createElement('div');
  host.id = APP_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; } * { box-sizing: border-box; }
      .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 500px;
        max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto;
        color: #17202a; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px;
        box-shadow: 0 18px 50px rgba(15,23,42,.28); font: 13px/1.45 system-ui, sans-serif; }
      header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
        justify-content: space-between; gap: 8px; padding: 11px 12px; color: #fff; background: #b42318;
        cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      .header-actions { display: flex; align-items: center; gap: 6px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.5); border-radius: 6px; cursor: pointer; }
      .panel.is-collapsed { width: 310px; max-height: none; overflow: hidden; }
      .panel.is-collapsed header { position: static; }
      .panel.is-collapsed main { display: none; }
      main { padding: 12px; } section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 90px 1fr; gap: 4px 8px; } .facts b { overflow-wrap: anywhere; }
      label { display: block; margin-top: 8px; color: #334155; font-size: 12px; }
      input[type="number"], input[type="text"], select, textarea { width: 100%; margin-top: 3px; padding: 7px 8px;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      textarea { min-height: 58px; resize: vertical; }
      input[readonly] { color: #0f172a; background: #f1f5f9; font-weight: 700; }
      .calc-grid, .result-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; }
      .checkline { display: flex; align-items: center; gap: 7px; margin-top: 24px; font-size: 12px; }
      .checkline input { width: auto; margin: 0; }
      .formula { margin-top: 8px; padding: 8px; color: #334155; background: #f8fafc;
        border: 1px dashed #cbd5e1; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
      @media (max-width: 520px) { .calc-grid, .result-grid { grid-template-columns: 1fr; } .checkline { margin-top: 4px; } }
      button.action { padding: 8px 11px; color: #fff; background: #b42318; border: 0;
        border-radius: 6px; cursor: pointer; font: inherit; font-weight: 700; }
      button.action:disabled { opacity: .55; cursor: wait; } button.secondary { color: #334155; background: #f1f5f9; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .usable { color: #166534; } .reject { color: #b42318; } .review { color: #92400e; }
      .ignore { color: #64748b; } .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回到右上角"><strong>PChome 優惠擷取助手 v${VERSION}</strong><span class="header-actions"><button id="collapse" type="button" title="收合" aria-controls="helperContent" aria-expanded="true">−</button><button id="close" type="button" title="關閉">×</button></span></header>
      <main id="helperContent">
        <section id="pageSection"></section>
        <div id="progress" class="status info">尚未擷取。按下「自動抓取優惠」。</div>
        <div class="actions">
          <button class="action" id="capture">自動抓取優惠</button>
          <button class="action secondary" id="copyUsable" disabled>複製可填資料</button>
          <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
        </div>
        <section id="calculatorSection">
          <h2>五欄位計算</h2>
          <div class="calc-grid">
            <label>qty_pchome（PChome 下單數量）
              <input id="qtyInput" type="number" min="1" step="1" value="1">
            </label>
            <label class="checkline"><input id="priceIncludesPromotion" type="checkbox">目前售價已包含頁面折扣活動</label>
          </div>
          <div class="actions">
            <button class="action" id="calculate" disabled>計算五欄位</button>
            <button class="action secondary" id="copyFields" disabled>複製五欄位</button>
          </div>
          <div id="calcMessage" class="status warn">請先執行「自動抓取優惠」。</div>
          <div id="fieldResults" class="hidden">
            <div class="result-grid">
              <label>price_pchome<input id="priceOutput" type="text" readonly></label>
              <label>qty_pchome<input id="qtyOutput" type="text" readonly></label>
              <label>discount_pchome<input id="discountOutput" type="text" readonly></label>
              <label>conback_pchome<input id="coinbackOutput" type="text" readonly></label>
            </div>
            <label>note_pchome<textarea id="noteOutput" readonly></textarea></label>
            <div id="formulaOutput" class="formula"></div>
            <label>計算明細（供檢查）<textarea id="calculationNote" readonly></textarea></label>
          </div>
        </section>
        <section id="filledSection" class="hidden">
          <h2>符合規則，可填入</h2>
          <label>折扣活動<textarea id="activityOutput" readonly></textarea></label>
          <label>單品券<textarea id="itemCouponOutput" readonly></textarea></label>
          <label>滿折券<textarea id="orderCouponOutput" readonly></textarea></label>
          <label>P 幣<textarea id="pcoinOutput" readonly></textarea></label>
          <p class="muted">保留網頁原文，不計算、不選最高值；空白代表沒有明確合格項目。</p>
        </section>
        <section id="decisionSection" class="hidden"></section>
      </main>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;
  let busy = false;

  function discountFromFacts(offer, baseAmount, orderQty = 1) {
    const facts = offer.facts || {};
    const threshold = toNumber(facts.threshold);
    const minQty = toNumber(facts.minQty);
    const base = Math.max(0, toNumber(baseAmount));
    if (threshold && base < threshold) return null;
    if (minQty && orderQty < minQty) return null;

    let amount = 0;
    let formula = '';
    const benefit = toNumber(facts.benefit);
    if (!benefit) return null;

    if (facts.unit === '元') {
      amount = benefit;
      formula = `${money(benefit)} 元`;
    } else if (facts.unit === '折後價') {
      if (benefit >= base) return null;
      amount = base - benefit;
      formula = `${money(base)} - 折後價 ${money(benefit)}`;
    } else if (facts.unit === '折') {
      const fold = benefit > 10 ? benefit / 10 : benefit;
      if (fold <= 0 || fold >= 10) return null;
      const rate = (10 - fold) / 10;
      amount = roundMoney(base * rate);
      formula = `ROUND(${money(base)} × ${(rate * 100).toFixed(1).replace(/\.0$/, '')}%, 0)`;
    } else if (facts.unit === '%') {
      amount = roundMoney(base * benefit / 100);
      formula = `ROUND(${money(base)} × ${benefit}%, 0)`;
    } else return null;

    const cap = toNumber(facts.cap);
    if (cap) {
      amount = Math.min(amount, cap);
      formula = `MIN(${formula}, ${money(cap)})`;
    }
    return { amount: roundMoney(amount), formula, threshold, minQty };
  }

  function cashbackFromFacts(offer, netAmount, orderQty = 1) {
    const facts = offer.facts || {};
    const threshold = toNumber(facts.threshold);
    const minQty = toNumber(facts.minQty);
    const net = Math.max(0, toNumber(netAmount));
    if (threshold && net < threshold) return null;
    if (minQty && orderQty < minQty) return null;

    const benefit = toNumber(facts.benefit);
    if (!benefit) return null;
    let amount = 0;
    let formula = '';
    if (facts.unit === 'P幣') {
      amount = benefit;
      formula = `${money(benefit)} P幣`;
    } else if (facts.unit === '% P幣') {
      amount = roundMoney(net * benefit / 100);
      formula = `ROUND(${money(net)} × ${benefit}%, 0)`;
    } else return null;

    const cap = toNumber(facts.cap);
    if (cap) {
      amount = Math.min(amount, cap);
      formula = `MIN(${formula}, ${money(cap)})`;
    }
    return { amount: roundMoney(amount), formula, threshold, minQty };
  }

  function offerName(offer) {
    return normalize(offer.label ? `[${offer.label}] ${offer.summary}` : offer.summary) || offer.category;
  }

  function chooseDiscount(offers, unitPrice, qty, subtotal, priceIncludesPromotion) {
    const usable = offers.filter((offer) => offer.status === 'usable');
    const candidates = [{ amount: 0, name: '無額外折扣', note: '無額外折扣', formula: '0', source: 'none' }];

    const itemUnits = [];
    usable.filter((offer) => offer.category === '單品券').forEach((offer) => {
      const result = discountFromFacts(offer, unitPrice, qty);
      if (!result?.amount) return;
      const count = Math.max(1, Math.floor(toNumber(offer.availableCount) || 1));
      for (let index = 0; index < count; index += 1) {
        itemUnits.push({ ...result, name: offerName(offer), offer });
      }
    });
    const selectedItemUnits = itemUnits.sort((a, b) => b.amount - a.amount).slice(0, qty);
    if (selectedItemUnits.length) {
      const amount = selectedItemUnits.reduce((sum, item) => sum + item.amount, 0);
      const groups = new Map();
      selectedItemUnits.forEach((item) => {
        const key = `${item.name}\u0000${item.amount}`;
        const entry = groups.get(key) || { name: item.name, amount: item.amount, count: 0 };
        entry.count += 1;
        groups.set(key, entry);
      });
      const formula = [...groups.values()].map((item) => `${money(item.amount)} × ${item.count}`).join(' + ');
      const note = [...groups.values()].map((item) => `${item.name} × ${item.count} 張`).join('；');
      candidates.push({ amount, name: `單品券 ${selectedItemUnits.length} 張`, note, formula, source: 'item-coupon' });
    }

    usable.filter((offer) => offer.category === '滿折券').forEach((offer) => {
      const result = discountFromFacts(offer, subtotal, qty);
      if (result?.amount) candidates.push({ ...result, name: offerName(offer), note: offerName(offer), source: 'order-coupon' });
    });

    if (!priceIncludesPromotion) {
      usable.filter((offer) => offer.category === '折扣活動').forEach((offer) => {
        const result = discountFromFacts(offer, subtotal, qty);
        if (result?.amount) candidates.push({ ...result, name: offerName(offer), note: offerName(offer), source: 'activity' });
      });
    }

    candidates.sort((a, b) => b.amount - a.amount);
    return { selected: candidates[0], candidates };
  }

  function chooseCashback(offers, netAmount, qty) {
    const candidates = [{
      amount: roundMoney(netAmount * 0.04),
      name: 'PChome 聯名卡預設 4%',
      note: 'PChome 聯名卡 4% 回饋',
      formula: `ROUND(${money(netAmount)} × 4%, 0)`,
      source: 'default',
    }];
    offers.filter((offer) => offer.status === 'usable' && offer.category === 'P幣').forEach((offer) => {
      const result = cashbackFromFacts(offer, netAmount, qty);
      if (result) candidates.push({ ...result, name: offerName(offer), note: offerName(offer), source: 'offer' });
    });
    candidates.sort((a, b) => b.amount - a.amount);
    return { selected: candidates[0], candidates };
  }

  function calculateFiveFields() {
    if (!latest) return null;
    if (latest.pageExclusions?.length) {
      $('#calcMessage').className = 'status bad';
      $('#calcMessage').textContent = `賣場不採用：${latest.pageExclusions.join('、')}。不產生五欄位。`;
      $('#fieldResults').classList.add('hidden');
      $('#copyFields').disabled = true;
      return null;
    }

    const unitPrice = toNumber(latest.page.currentPrice);
    const qty = Math.floor(toNumber($('#qtyInput').value));
    if (!unitPrice || qty < 1) {
      $('#calcMessage').className = 'status bad';
      $('#calcMessage').textContent = !unitPrice ? '未讀到目前售價，請人工確認頁面價格。' : 'qty_pchome 必須是大於 0 的整數。';
      $('#fieldResults').classList.add('hidden');
      $('#copyFields').disabled = true;
      return null;
    }

    const subtotal = roundMoney(unitPrice * qty);
    const priceIncludesPromotion = $('#priceIncludesPromotion').checked;
    const discountChoice = chooseDiscount(latest.offers, unitPrice, qty, subtotal, priceIncludesPromotion);
    const discount = Math.min(subtotal, roundMoney(discountChoice.selected.amount));
    const net = Math.max(0, subtotal - discount);
    const cashbackChoice = chooseCashback(latest.offers, net, qty);
    const cashback = roundMoney(cashbackChoice.selected.amount);
    const reviewCount = latest.offers.filter((offer) => offer.status === 'review').length;
    const includedPromotionNote = priceIncludesPromotion
      ? `售價已含頁面折扣活動${latest.page.priceContext ? `（${latest.page.priceContext.slice(0, 120)}）` : ''}`
      : '';
    const notePchome = [
      `折扣：${includedPromotionNote || discountChoice.selected.note || discountChoice.selected.name}`,
      `回饋：${cashbackChoice.selected.note || cashbackChoice.selected.name}`,
    ].join('；');

    const fields = {
      price_pchome: subtotal,
      qty_pchome: qty,
      discount_pchome: discount,
      conback_pchome: cashback,
      note_pchome: notePchome,
      discountName: discountChoice.selected.name,
      cashbackName: cashbackChoice.selected.name,
      note: [
        `售價 ${money(unitPrice)} × ${qty} = ${money(subtotal)}`,
        `折扣採用：${discountChoice.selected.name}；${discountChoice.selected.formula} = ${money(discount)}`,
        `回饋採用：${cashbackChoice.selected.name}；${cashbackChoice.selected.formula} = ${money(cashback)}`,
        priceIncludesPromotion ? '目前售價已含頁面折扣活動，因此未重複計算折扣活動。' : '目前售價未標記為已含折扣活動。',
        reviewCount ? `另有 ${reviewCount} 項優惠需人工確認，尚未納入計算。` : '',
      ].filter(Boolean).join('\n'),
    };

    latest.fields = fields;
    $('#priceOutput').value = String(fields.price_pchome);
    $('#qtyOutput').value = String(fields.qty_pchome);
    $('#discountOutput').value = String(fields.discount_pchome);
    $('#coinbackOutput').value = String(fields.conback_pchome);
    $('#noteOutput').value = fields.note_pchome;
    $('#formulaOutput').textContent = `價格：${money(unitPrice)} × ${qty} = ${money(subtotal)}\n折扣：${discountChoice.selected.formula} = ${money(discount)}\n回饋：${cashbackChoice.selected.formula} = ${money(cashback)}`;
    $('#calculationNote').value = fields.note;
    $('#fieldResults').classList.remove('hidden');
    $('#copyFields').disabled = false;
    $('#calcMessage').className = `status ${reviewCount ? 'warn' : 'ok'}`;
    $('#calcMessage').textContent = reviewCount
      ? `已計算五欄位；另有 ${reviewCount} 項需人工確認，未納入。`
      : '五欄位計算完成。';
    return fields;
  }

  function fiveFieldText(fields) {
    return [fields.price_pchome, fields.qty_pchome, fields.discount_pchome,
      fields.conback_pchome, fields.note_pchome].join('\t');
  }

  function renderPage() {
    const page = getPageFacts();
    const exclusions = getPageExclusions();
    const domain = page.isPChome ? '' : '<div class="status warn">目前不是 PChome 網域</div>';
    const pageStatus = exclusions.length
      ? `<div class="status bad">賣場不採用：${escapeHtml(exclusions.join('、'))}</div>`
      : '<div class="status ok">未偵測到既有規則中的賣場排除條件</div>';
    $('#pageSection').innerHTML = `<h2>商品頁</h2>${domain}${pageStatus}
      <div class="facts"><span>商品</span><b>${escapeHtml(page.title)}</b>
      <span>目前售價</span><b>${page.currentPrice ? `$${escapeHtml(page.currentPrice)}` : '未讀到'}</b>
      <span>原價</span><b>${page.originalPrice ? `$${escapeHtml(page.originalPrice)}` : '未讀到'}</b>
      <span>價格提示</span><b>${page.priceIncludesPromotion ? '偵測到折扣價／點我再折扣文字' : '未偵測到已含折扣提示'}</b></div>`;
    return { page, exclusions };
  }

  function setProgress(message, type = 'info') {
    $('#progress').className = `status ${type}`;
    $('#progress').textContent = message;
  }

  function outputLine(offer) {
    const facts = offer.facts || {};
    const extras = [facts.threshold ? `門檻=${facts.threshold}` : '',
      facts.minQty ? `件數門檻=${facts.minQty}` : '',
      facts.benefit ? `優惠=${facts.benefit}${facts.unit}` : '',
      facts.cap ? `上限=${facts.cap}` : '',
      offer.category === '單品券' ? `可辨識張數=${offer.availableCount || 1}` : '',
      offer.checkFound ? `右側勾選=${offer.checkSelectable ? '可選' : '不可選'}` : '',
      offer.fields?.['活動折扣'] ? `說明=${offer.fields['活動折扣']}` : '',
      offer.fields?.['活動期間'] ? `期間=${offer.fields['活動期間']}` : ''].filter(Boolean);
    return `${offer.label ? `[${offer.label}] ` : ''}${offer.summary}${extras.length ? `｜${extras.join('｜')}` : ''}`;
  }

  function evidenceFor(offer) {
    const fields = offer.fields || {};
    return unique([
      fields['活動期間'] ? `活動期間：${fields['活動期間']}` : '',
      fields['贈送條件'] ? `贈送條件：${fields['贈送條件']}` : '',
      fields['活動條件'] ? `活動條件：${fields['活動條件']}` : '',
      fields['優惠內容'] ? `優惠內容：${fields['優惠內容']}` : '',
      fields['使用條件'] ? `使用條件：${fields['使用條件']}` : '',
      fields['活動折扣'] ? `活動折扣：${fields['活動折扣']}` : '',
      fields['活動說明'] ? `活動說明：${fields['活動說明']}` : '',
      fields['注意事項'] ? `注意事項：${fields['注意事項']}` : '',
      fields['付款方式'] ? `付款方式：${fields['付款方式']}` : '',
      offer.checkFound ? `右側勾選：${offer.checkSelectable ? '可選' : '不可選'}` : '',
    ]).join('；');
  }

  function renderOfferList(items, cssClass) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((offer) => `<li class="${cssClass}"><b>${escapeHtml(offer.category)}｜${escapeHtml(offer.reason)}</b><br>
      ${escapeHtml(offer.label ? `[${offer.label}] ${offer.summary}` : offer.summary)}
      ${evidenceFor(offer) ? `<div class="evidence">${escapeHtml(evidenceFor(offer))}</div>` : ''}</li>`).join('')}</ul>`;
  }

  function renderResults(result) {
    const usable = result.offers.filter((offer) => offer.status === 'usable');
    const rejected = result.offers.filter((offer) => offer.status === 'reject');
    const review = result.offers.filter((offer) => offer.status === 'review');
    const ignored = result.offers.filter((offer) => offer.status === 'ignore');
    const byCategory = (category) => usable.filter((offer) => offer.category === category).map(outputLine).join('\n');
    $('#activityOutput').value = byCategory('折扣活動');
    $('#itemCouponOutput').value = byCategory('單品券');
    $('#orderCouponOutput').value = byCategory('滿折券');
    $('#pcoinOutput').value = byCategory('P幣');
    $('#filledSection').classList.remove('hidden');
    $('#decisionSection').innerHTML = `<h2>逐項判斷</h2>
      ${result.couponNote ? `<div class="status warn">${escapeHtml(result.couponNote)}</div>` : ''}
      <details open><summary class="usable">可填入（${usable.length}）</summary>${renderOfferList(usable, 'usable')}</details>
      <details open><summary class="review">需人工確認（${review.length}）</summary>${renderOfferList(review, 'review')}</details>
      <details><summary class="reject">不採用（${rejected.length}）</summary>${renderOfferList(rejected, 'reject')}</details>
      <details><summary class="ignore">忽略（${ignored.length}）</summary>${renderOfferList(ignored, 'ignore')}</details>`;
    $('#decisionSection').classList.remove('hidden');
    $('#copyUsable').disabled = usable.length === 0;
    $('#copyAll').disabled = result.offers.length === 0;
  }

  function toTsv(result, onlyUsable) {
    const rows = onlyUsable ? result.offers.filter((offer) => offer.status === 'usable') : result.offers;
    const header = ['網址', '商品', '售價', '原價', '判定', '類型', '標籤', '優惠原文', '金額門檻', '件數門檻', '優惠值', '單位', '上限', '右側勾選', '活動期間', '網頁備註', '理由'];
    const clean = (value) => normalize(value).replace(/[\t\r\n]+/g, ' ');
    const data = rows.map((offer) => [result.page.url, result.page.title, result.page.currentPrice,
      result.page.originalPrice, offer.status, offer.category, offer.label, offer.summary,
      offer.facts?.threshold, offer.facts?.minQty, offer.facts?.benefit, offer.facts?.unit, offer.facts?.cap,
      offer.checkFound ? (offer.checkSelectable ? '可選' : '不可選') : '',
      offer.fields?.['活動期間'], evidenceFor(offer), offer.reason].map(clean).join('\t'));
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
      console.error('[PChome 優惠擷取助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally { setTimeout(() => { button.textContent = original; }, 1200); }
  }

  async function capture() {
    if (busy) return latest;
    busy = true;
    $('#capture').disabled = true; $('#copyUsable').disabled = true; $('#copyAll').disabled = true;
    $('#calculate').disabled = true; $('#copyFields').disabled = true;
    try {
      const base = renderPage();
      setProgress('開始讀取頁面優惠…');
      const discounts = await captureDiscountActivities((message) => setProgress(message));
      const promotions = await capturePromotions((message) => setProgress(message));
      const couponResult = await captureCoupons((message) => setProgress(message));
      latest = { page: base.page, pageExclusions: base.exclusions,
        offers: [...discounts, ...promotions, ...couponResult.offers], couponNote: couponResult.note };
      renderResults(latest);
      $('#priceIncludesPromotion').checked = Boolean(latest.page.priceIncludesPromotion);
      $('#calculate').disabled = false;
      calculateFiveFields();
      const usableCount = latest.offers.filter((offer) => offer.status === 'usable').length;
      const reviewCount = latest.offers.filter((offer) => offer.status === 'review').length;
      setProgress(`擷取完成：可用 ${usableCount} 項；人工確認 ${reviewCount} 項。已依目前 qty 產生五欄位。`, usableCount ? 'ok' : 'warn');
      return latest;
    } catch (error) {
      console.error('[PChome 優惠擷取助手] 擷取失敗', error);
      setProgress(`擷取失敗：${normalize(error?.message || error)}`, 'bad');
      return null;
    } finally { busy = false; $('#capture').disabled = false; }
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

  function setCollapsed(collapsed) {
    const panel = $('.panel');
    const button = $('#collapse');
    panel.classList.toggle('is-collapsed', collapsed);
    button.textContent = collapsed ? '+' : '−';
    button.title = collapsed ? '展開' : '收合';
    button.setAttribute('aria-expanded', String(!collapsed));
  }

  function destroy() {
    host.remove();
    if (window.PCHomeJudgementHelper?.version === VERSION) delete window.PCHomeJudgementHelper;
  }

  $('#collapse').addEventListener('click', () => setCollapsed(!$('.panel').classList.contains('is-collapsed')));
  $('#close').addEventListener('click', destroy);
  $('#capture').addEventListener('click', capture);
  $('#copyUsable').addEventListener('click', () => latest && copyText(toTsv(latest, true), $('#copyUsable')));
  $('#copyAll').addEventListener('click', () => latest && copyText(toTsv(latest, false), $('#copyAll')));
  $('#calculate').addEventListener('click', calculateFiveFields);
  $('#qtyInput').addEventListener('change', () => latest && calculateFiveFields());
  $('#priceIncludesPromotion').addEventListener('change', () => latest && calculateFiveFields());
  $('#copyFields').addEventListener('click', () => latest?.fields
    && copyText(fiveFieldText(latest.fields), $('#copyFields')));
  setCollapsed(false);
  enableDragging();
  renderPage();
  window.PCHomeJudgementHelper = {
    version: VERSION, capture, calculate: calculateFiveFields, result: () => latest, destroy,
  };
  console.info(`[PChome 優惠擷取助手 v${VERSION}] 已啟動。只讀取頁面，不領券；可計算五個 PChome 欄位。`);
})();
