(() => {
  'use strict';

  /* ============================================================
   * Rakuten 優惠擷取助手
   * 依據：「Rakuten 執行步驟」簡報（15 頁）之規則，未加入任何額外判斷標準。
   * 只讀取、分類、填欄位；不做任何金額計算（計算交給 Excel）。
   * 例外：頁面上「一鍵全領」屬於會改變帳號狀態的動作，需手動按面板按鈕。
   * ============================================================ */

  const APP_ID = 'rakuten-judgement-helper';
  const VERSION = '1.0.0';

  if (window.RakutenJudgementHelper?.destroy) window.RakutenJudgementHelper.destroy();
  else document.getElementById(APP_ID)?.remove();

  /* ---------------- 共用工具 ---------------- */

  const normalize = (value) => String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const escapeHtml = (value) => normalize(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);

  const unique = (items) => [...new Set(items.map(normalize).filter(Boolean))];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const num = (value) => normalize(value).replace(/,/g, '');

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

  const textOf = (element) => normalize(element?.innerText || element?.textContent);

  // 元素自身的直接文字（不含子節點），用來精準定位「配送」「優惠券」「活動」等欄位標籤
  const ownText = (element) => normalize([...element.childNodes]
    .filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' '));

  const visibleAll = () => [...document.querySelectorAll('*')].filter(isVisible);

  // 找出「標籤列」：自身文字剛好等於標籤字的元素，往上取一層當整列，取最短的一列
  function rowByLabel(labels) {
    let best = null;
    let bestLength = Infinity;
    for (const element of visibleAll()) {
      if (!labels.includes(ownText(element))) continue;
      const row = element.parentElement;
      if (!row || !isVisible(row)) continue;
      const length = textOf(row).length;
      if (length > 6000 || length < 2) continue;
      if (length < bestLength) { best = row; bestLength = length; }
    }
    return best;
  }

  // 找出「自身文字等於某個標記字」的元素所屬的最小區塊（用於 商品折扣／訂單折扣 標籤）
  function blocksByTag(tag, minLength = 6, maxLength = 800) {
    const blocks = [];
    for (const element of visibleAll()) {
      if (ownText(element) !== tag) continue;
      let node = element.parentElement;
      while (node && textOf(node).length < minLength) node = node.parentElement;
      if (!node || !isVisible(node)) continue;
      const text = textOf(node);
      if (text.length > maxLength) continue;
      blocks.push({ element: node, text });
    }
    // 去除彼此重複／互相包含的區塊
    const seen = new Set();
    return blocks.filter(({ text }) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  function clickableByText(pattern, root = document) {
    return [...root.querySelectorAll('a, button, span, div, [role="button"]')]
      .filter(isVisible)
      .find((element) => pattern.test(ownText(element) || textOf(element)) && textOf(element).length <= 20);
  }

  /* ---------------- 原文解析（只抽字，不計算） ---------------- */

  function parseMoneyFacts(text) {
    const value = normalize(text).replace(/，/g, ',').replace(/％/g, '%').replace(/＄/g, '$');
    const out = {};
    const threshold = value.match(/滿\s*\$?\s*([\d,]+)\s*元?/);
    if (threshold) out.門檻 = num(threshold[1]);
    if (/無門檻/.test(value)) out.門檻 = '無門檻';
    const cutAmount = value.match(/(?:折|減|抵)\s*\$\s*([\d,]+)/);
    if (cutAmount) { out.折抵 = num(cutAmount[1]); out.單位 = '元'; }
    const cutPercent = value.match(/(?:折|減|抵)\s*([\d.]+)\s*%/);
    if (!out.折抵 && cutPercent) { out.折抵 = cutPercent[1]; out.單位 = '%'; }
    const zhe = value.match(/([\d.]+)\s*折(?:\D|$)/);
    if (!out.折抵 && zhe) { out.折抵 = zhe[1]; out.單位 = '折'; }
    const cap = value.match(/最高(?:折抵|抵|折)\s*\$?\s*([\d,]+)/);
    if (cap) out.上限 = num(cap[1]);
    const deadline = value.match(/(\d{4}\/\d{1,2}\/\d{1,2}(?:\s*\d{2}:\d{2})?)\s*截止/);
    if (deadline) out.截止 = deadline[1];
    return out;
  }

  const factsLine = (facts) => Object.entries(facts)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`).join('｜');

  /* ---------------- 步驟 1：賣場是否可採用 ---------------- */

  function getSellerStatus() {
    const tagTexts = unique([...document.querySelectorAll('a, button, span, div, [role="button"], img')]
      .filter(isVisible)
      .map((element) => element.tagName === 'IMG' ? element.alt : ownText(element))
      .filter((text) => normalize(text).length > 0 && normalize(text).length <= 24));

    const rejects = [];
    if (tagTexts.some((text) => text === '海外進貨')) rejects.push('賣場標示「海外進貨」→ 不採用');
    if (tagTexts.some((text) => /^(已售完|售完|補貨中)$/.test(text))) rejects.push('賣場已售完 → 不採用');
    if (tagTexts.some((text) => /^預購/.test(text))) rejects.push('預購賣場 → 不採用');

    // 評價：頁面出現 5.0 (11) 這類星等或「則評價」即視為有評價
    const bodyText = textOf(document.body);
    const hasReview = /\b\d(?:\.\d)?\s*\(\s*\d+\s*\)/.test(bodyText) || /\d+\s*則評價/.test(bodyText);

    return { rejects: unique(rejects), hasReview, tagTexts };
  }

  /* ---------------- 步驟 2：價格 ---------------- */

  function getPriceFacts() {
    const title = normalize([...document.querySelectorAll('h1')].find(isVisible)?.innerText || document.title);

    // 售價：頁面最上方、字最大的 $ 金額
    let current = '';
    let currentSize = 0;
    let original = '';
    for (const element of visibleAll()) {
      const text = ownText(element);
      const match = text.match(/^\$\s*([\d,]+)$/);
      if (!match) continue;
      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize) || 0;
      const struck = /line-through/.test(style.textDecorationLine) || ['DEL', 'S'].includes(element.tagName)
        || Boolean(element.closest('del, s'));
      if (struck) { if (!original) original = num(match[1]); continue; }
      if (size > currentSize) { currentSize = size; current = num(match[1]); }
    }

    const body = textOf(document.body);
    const afterDiscount = body.match(/折扣後價格\s*\$?\s*([\d,]+)/);
    const limit = body.match(/限購\s*([\d,]+)\s*(件|組|盒|個|入)/);

    return {
      title,
      url: location.href,
      isRakuten: /(^|\.)rakuten\.com\.tw$/i.test(location.hostname),
      售價: current,
      原價: original,
      折扣後價格: afterDiscount ? num(afterDiscount[1]) : '',
      限購: limit ? `${num(limit[1])}${limit[2]}` : '',
      限購數: limit ? num(limit[1]) : '',
    };
  }

  /* ---------------- 步驟 3：折扣活動（商品折扣／訂單折扣） ---------------- */

  async function expandMoreActivities(onProgress) {
    const more = clickableByText(/^更多活動/);
    if (!more) return false;
    onProgress('展開「更多活動」…');
    more.click();
    await sleep(500);
    return true;
  }

  function captureActivities() {
    const offers = [];
    for (const tag of ['商品折扣', '訂單折扣']) {
      for (const block of blocksByTag(tag)) {
        const summary = normalize(block.text.replace(new RegExp(`^${tag}`), ''));
        if (!summary) continue;
        const offer = {
          source: 'activity',
          category: tag,
          label: tag,
          summary,
          facts: parseMoneyFacts(summary),
        };
        if (tag === '商品折扣') {
          offer.status = 'review';
          offer.reason = '賣場出現「商品折扣」→ 依規則須加入購物車確認售價是否已套用，助手無法代為確認';
          offer.field = 'price_rakuten（確認後可直接填折後價）';
        } else {
          offer.status = 'usable';
          offer.reason = '訂單折扣：商品折扣計算完後才可再套用（多個活動達門檻可疊加）';
          offer.field = 'discount_seller_rakuten';
        }
        offers.push(offer);
      }
    }
    // 活動列上的短標（折12%、滿$500折5%）作為佐證，不重複判定
    const row = rowByLabel(['活動']);
    const inline = row ? unique(textOf(row).replace(/^活動/, '').split('\n')) : [];
    return { offers, inline };
  }

  /* ---------------- 步驟 4：優惠券 ---------------- */

  function claimAllButton() {
    return clickableByText(/^一鍵全領/);
  }

  function couponRow() {
    return rowByLabel(['優惠券', '優惠卷']);
  }

  function couponCards(row) {
    if (!row) return [];
    const cards = [...row.querySelectorAll('*')].filter((element) => {
      if (!isVisible(element)) return false;
      const text = textOf(element);
      if (text.length < 4 || text.length > 300) return false;
      // 券卡特徵：有「折」金額或百分比
      if (!/(折\s*\$?\s*[\d,.]+\s*%?|兌換完畢)/.test(text)) return false;
      // 排除外層包住多張券的容器
      const childSame = [...element.querySelectorAll('*')]
        .filter((child) => isVisible(child) && textOf(child) === text);
      return childSame.length === 0;
    });
    // 只留最內層、彼此不重複的卡片
    const kept = [];
    for (const card of cards) {
      if (kept.some((other) => other.contains(card) || card.contains(other))) {
        const index = kept.findIndex((other) => other.contains(card));
        if (index >= 0) kept[index] = card;
        continue;
      }
      kept.push(card);
    }
    const seen = new Set();
    return kept.filter((card) => {
      const text = textOf(card);
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  function couponIssuer(card) {
    const images = [...card.querySelectorAll('img')];
    const imageText = normalize(images.map((img) => `${img.alt || ''} ${img.src || ''}`).join(' '));
    if (/獨享/.test(`${imageText} ${textOf(card)}`)) return '獨享券';
    if (!images.length) return '未知';
    if (/rakuten|樂天市場/i.test(imageText)) return '樂天市場';
    return '賣場';
  }

  function classifyCoupon(card, claimedAll) {
    const summary = textOf(card);
    const issuer = couponIssuer(card);
    const facts = parseMoneyFacts(summary);
    const base = { source: 'coupon', label: '優惠券', summary, facts, issuer };

    if (issuer === '獨享券') {
      return { ...base, category: '獨享券', status: 'reject', reason: '圖片／文字提及「獨享」→ 不可採用' };
    }
    if (/兌換完畢/.test(summary)) {
      return { ...base, category: '優惠券', status: 'reject', reason: '優惠券出現「兌換完畢」→ 不可採用' };
    }
    if (issuer === '未知') {
      return { ...base, category: '未分類優惠券', status: 'review', reason: '無法從券圖判定發行方，不自行分類' };
    }

    let category;
    if (issuer === '樂天市場') category = /限\s*APP/i.test(summary) ? 'APP優惠券' : '平台優惠券';
    else category = '賣場優惠券';

    const field = category === '賣場優惠券' ? 'discount_seller_rakuten' : 'discount_platform_rakuten';
    const limited = /限量/.test(summary);
    const status = claimedAll ? 'usable' : 'review';
    const reason = claimedAll
      ? (limited ? '正常顯示且僅出現「限量」提示詞 → 可採用' : '正常顯示 → 可採用')
      : '尚未點擊「一鍵全領」，無法確認是否為已領取完畢的券';
    return { ...base, category, field, status, reason };
  }

  function captureCoupons(claimedAll) {
    const row = couponRow();
    if (!row) return { offers: [], note: '頁面未出現優惠券欄位' };
    const offers = couponCards(row).map((card) => classifyCoupon(card, claimedAll));
    return {
      offers,
      note: offers.length ? '' : '優惠券欄位存在，但未能切出個別券卡，請人工確認',
    };
  }

  /* ---------------- 步驟 5：點數回饋 ---------------- */

  async function capturePoints(onProgress) {
    // 依規則：只依「回饋欄位」顯示為主；賣場首圖的加碼資訊不採用（首圖為圖片，innerText 不會讀到）
    let scopeText = '';
    const trigger = [...document.querySelectorAll('a, button, div, span, [role="button"]')]
      .filter(isVisible)
      .find((element) => /APP\s*下單/i.test(textOf(element)) && /最高賺/.test(textOf(element)) && textOf(element).length <= 40);
    if (trigger) {
      onProgress('展開「APP下單點數」明細…');
      trigger.click();
      const popup = await waitFor(() => [...document.querySelectorAll('[role="dialog"], div')]
        .filter(isVisible).find((element) => /最高可賺/.test(textOf(element)) && textOf(element).length <= 400), 3000);
      if (popup) scopeText = textOf(popup);
      const close = document.querySelector('[role="dialog"] button[aria-label*="close" i], [role="dialog"] [aria-label="關閉"]');
      close?.click();
      await sleep(200);
    }
    if (!scopeText) {
      const holder = visibleAll().find((element) => /一般點數/.test(ownText(element) || textOf(element))
        && textOf(element).length <= 400);
      scopeText = holder ? textOf(holder) : textOf(document.body);
    }

    const offers = [];
    const general = scopeText.match(/一般點數\s*([\d.]+)\s*%/);
    const appBonus = scopeText.match(/APP\s*下單加碼\s*([\d.]+)\s*%/i);
    const max = scopeText.match(/最高可賺\s*([\d.]+)\s*%/);

    if (general) {
      offers.push({
        source: 'point', category: '一般點數', label: '一般點數',
        summary: `一般點數${general[1]}%`, facts: { 比例: `${general[1]}%` },
        field: 'coinback_platform_rakuten', status: 'usable',
        reason: '依實際回饋欄位顯示填寫（預設 1%，須依賣場實際顯示修改公式與名稱）',
      });
    } else {
      offers.push({
        source: 'point', category: '一般點數', label: '一般點數',
        summary: '未讀到一般點數', facts: {},
        field: 'coinback_platform_rakuten', status: 'review',
        reason: '回饋欄位未讀到「一般點數 X%」，請人工確認（規則：預設 1%，仍須依實際顯示填寫）',
      });
    }
    if (appBonus) {
      offers.push({
        source: 'point', category: 'APP下單加碼', label: 'APP下單加碼',
        summary: `APP下單加碼${appBonus[1]}%`, facts: { 比例: `${appBonus[1]}%` },
        field: 'coinback_platform_rakuten', status: 'usable',
        reason: '回饋欄位出現「APP下單加碼 XX%」→ 可與一般點數疊加，NOTE 分開備註名稱',
      });
    }
    return { offers, 最高可賺: max ? `${max[1]}%` : '', scopeText };
  }

  /* ---------------- 步驟 6：運費 ---------------- */

  async function captureShipping(onProgress) {
    const row = rowByLabel(['配送', '運費']);
    if (!row) return { options: [], status: 'review', reason: '未讀到配送欄位', note: '' };
    const more = clickableByText(/^看更多/, row) || clickableByText(/^看更多/);
    if (more) { onProgress('展開配送方式…'); more.click(); await sleep(450); }

    const holder = rowByLabel(['配送', '運費']) || row;
    const lines = unique(textOf(holder).split('\n')).filter((line) => line !== '配送' && line !== '運費');

    const options = [];
    for (const line of lines) {
      const free = line.match(/滿\s*\$?\s*([\d,]+)\s*免運/);
      const range = line.match(/\$\s*([\d,]+)\s*[-~－]\s*\$?\s*([\d,]+)/);
      const fees = [...line.matchAll(/\$\s*([\d,]+)/g)].map((match) => num(match[1]));
      const allFree = /(^|\s)免運(\s|$)/.test(line) && !fees.length;
      if (!fees.length && !allFree && !free) continue;
      options.push({
        方式: normalize(line.replace(/\$\s*[\d,]+(\s*[-~－]\s*\$?\s*[\d,]+)?/g, '').replace(/滿\s*\$?[\d,]+\s*免運/, '').trim()) || line,
        原文: line,
        免運門檻: free ? num(free[1]) : '',
        浮動: Boolean(range),
        費用候選: fees,
        最終費用: range ? '' : (fees.length ? fees[fees.length - 1] : (allFree ? '0' : '')),
      });
    }

    const hasFloating = options.some((option) => option.浮動);
    const settled = options.map((option) => option.最終費用).filter((fee) => fee !== '');
    let status = 'usable';
    let reason = '出現多種配送方式，統一採「運費最低價」';
    let value = '';

    if (!options.length) { status = 'review'; reason = '未能切出配送方式，請人工確認'; }
    else if (hasFloating) {
      status = 'review';
      reason = '運費欄位出現「浮動運費」→ 需加入購物車，於結帳畫面點擊「配送」確認各方式運費後採最低價';
    } else if (settled.includes('0')) { value = '0'; reason = '運費標示為 0 → 免運'; }
    else if (settled.length) { value = String(Math.min(...settled.map(Number))); }
    else { status = 'review'; reason = '未讀到明確運費數字，請人工確認'; }

    const thresholds = options.filter((option) => option.免運門檻)
      .map((option) => `${option.方式}：滿${option.免運門檻}免運`);
    const note = thresholds.length
      ? `免運門檻（達門檻即免運，且無須備註於 NOTE）：${thresholds.join('、')}` : '';

    return { options, status, reason, value, note };
  }

  /* ---------------- 步驟 7：NOTE 組裝 ---------------- */

  function buildNote(result) {
    const parts = [];
    if (!result.seller.hasReview) parts.push('賣場無評價');
    const points = result.offers.filter((offer) => offer.source === 'point' && offer.status === 'usable');
    points.forEach((offer) => parts.push(offer.summary));
    result.offers.filter((offer) => offer.source === 'activity' && offer.status !== 'reject')
      .forEach((offer) => parts.push(offer.summary));
    result.offers.filter((offer) => offer.source === 'coupon' && offer.status === 'usable')
      .forEach((offer) => parts.push(offer.summary.replace(/\n/g, ' ')));
    if (result.price.限購) parts.push(`最高上限${result.price.限購}`);
    return unique(parts).join('/');
  }

  /* ---------------- 面板 ---------------- */

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
        justify-content: space-between; gap: 8px; padding: 11px 12px; color: #fff; background: #bf0000;
        cursor: move; user-select: none; touch-action: none; }
      header strong { font-size: 15px; }
      header button { width: 28px; height: 28px; padding: 0; color: #fff; background: transparent;
        border: 1px solid rgba(255,255,255,.5); border-radius: 6px; cursor: pointer; }
      main { padding: 12px; }
      section { margin: 0 0 12px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; }
      h2 { margin: 0 0 8px; font-size: 14px; } p { margin: 6px 0; }
      .muted { color: #64748b; font-size: 12px; }
      .status { padding: 8px; border-radius: 7px; font-weight: 700; overflow-wrap: anywhere; }
      .ok { color: #166534; background: #dcfce7; } .bad { color: #991b1b; background: #fee2e2; }
      .warn { color: #92400e; background: #fef3c7; } .info { color: #1e3a8a; background: #dbeafe; }
      .facts { display: grid; grid-template-columns: 96px 1fr; gap: 4px 8px; } .facts b { overflow-wrap: anywhere; }
      label { display: block; margin-top: 8px; color: #334155; font-size: 12px; }
      textarea { width: 100%; min-height: 46px; margin-top: 3px; padding: 7px 8px; resize: vertical;
        color: #111827; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button.action { padding: 8px 11px; color: #fff; background: #bf0000; border: 0;
        border-radius: 6px; cursor: pointer; font: inherit; font-weight: 700; }
      button.action:disabled { opacity: .55; cursor: wait; }
      button.secondary { color: #334155; background: #f1f5f9; }
      button.claim { background: #b45309; }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 12px; }
      details { margin-top: 7px; } summary { cursor: pointer; font-weight: 700; }
      ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 7px 0; overflow-wrap: anywhere; }
      .usable { color: #166534; } .reject { color: #bf0000; } .review { color: #92400e; }
      .evidence { color: #475569; font-size: 12px; } .hidden { display: none !important; }
    </style>
    <div class="panel">
      <header title="按住拖曳；雙擊回到右上角"><strong>Rakuten 優惠擷取助手 v${VERSION}</strong><button id="close" title="關閉">×</button></header>
      <main>
        <section id="pageSection"></section>
        <div id="progress" class="status info">尚未擷取。建議先按「一鍵全領優惠券」，再按「自動抓取」。</div>
        <div class="actions">
          <button class="action claim" id="claim">一鍵全領優惠券</button>
          <button class="action" id="capture">自動抓取</button>
          <button class="action secondary" id="copyFill" disabled>複製表單欄位</button>
          <button class="action secondary" id="copyAll" disabled>複製完整判斷</button>
        </div>
        <section id="fillSection" class="hidden">
          <h2>表單欄位（原文擷取，未計算）</h2>
          <label>price_rakuten<textarea id="fPrice" readonly></textarea></label>
          <label>qty_rakuten<textarea id="fQty" readonly></textarea></label>
          <label>discount_platform_rakuten（平台券／APP券 · 擇一最優惠）<textarea id="fDiscountPlatform" readonly></textarea></label>
          <label>discount_seller_rakuten（賣場券 + 訂單折扣）<textarea id="fDiscountSeller" readonly></textarea></label>
          <label>coinback_platform_rakuten（一般點數 + APP下單加碼）<textarea id="fCoinPlatform" readonly></textarea></label>
          <label>coinback_seller_rakuten<textarea id="fCoinSeller" readonly></textarea></label>
          <label>shipping_fee_rakuten<textarea id="fShipping" readonly></textarea></label>
          <label>note_rakuten<textarea id="fNote" readonly></textarea></label>
          <p class="muted">優惠券欄位僅採用一張最優惠、且不可填券後價 → 上方列出所有可採用的券，由你／Excel 擇一。
            dealid／optionid 依規則暫不填寫。</p>
        </section>
        <section id="decisionSection" class="hidden"></section>
      </main>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  let latest = null;
  let busy = false;
  let claimedAll = false;

  function setProgress(message, type = 'info') {
    $('#progress').className = `status ${type}`;
    $('#progress').textContent = message;
  }

  function renderPage() {
    const price = getPriceFacts();
    const seller = getSellerStatus();
    const domain = price.isRakuten ? '' : '<div class="status warn">目前不是 rakuten.com.tw 網域</div>';
    const sellerStatus = seller.rejects.length
      ? `<div class="status bad">賣場不採用：${escapeHtml(seller.rejects.join('、'))}</div>`
      : '<div class="status ok">未偵測到「海外進貨／已售完／預購」等不採用條件</div>';
    const review = seller.hasReview
      ? '<div class="status info">賣場有顧客評價</div>'
      : '<div class="status warn">未偵測到顧客評價 → 可正常採用，NOTE 需備註「賣場無評價」</div>';
    $('#pageSection').innerHTML = `<h2>賣場總覽</h2>${domain}${sellerStatus}${review}
      <div class="facts">
        <span>商品</span><b>${escapeHtml(price.title)}</b>
        <span>售價</span><b>${price.售價 ? `$${escapeHtml(price.售價)}` : '未讀到'}</b>
        <span>原價</span><b>${price.原價 ? `$${escapeHtml(price.原價)}` : '未讀到'}</b>
        <span>折扣後價格</span><b>${price.折扣後價格 ? `$${escapeHtml(price.折扣後價格)}（不可直接填寫）` : '無'}</b>
        <span>限購</span><b>${price.限購 ? escapeHtml(price.限購) : '無'}</b>
      </div>`;
    return { price, seller };
  }

  function offerLine(offer) {
    const extras = [factsLine(offer.facts || {}), offer.issuer ? `發行=${offer.issuer}` : ''].filter(Boolean);
    return `${offer.label ? `[${offer.label}] ` : ''}${normalize(offer.summary).replace(/\n/g, ' ')}${extras.length ? `｜${extras.join('｜')}` : ''}`;
  }

  function renderOfferList(items, cssClass) {
    if (!items.length) return '<p class="muted">無</p>';
    return `<ul>${items.map((offer) => `<li class="${cssClass}">
      <b>${escapeHtml(offer.category)}${offer.field ? `｜${escapeHtml(offer.field)}` : ''}</b><br>
      ${escapeHtml(offerLine(offer))}
      <div class="evidence">${escapeHtml(offer.reason || '')}</div></li>`).join('')}</ul>`;
  }

  function renderResults(result) {
    const usable = result.offers.filter((offer) => offer.status === 'usable');
    const review = result.offers.filter((offer) => offer.status === 'review');
    const reject = result.offers.filter((offer) => offer.status === 'reject');
    const byField = (field) => usable.filter((offer) => offer.field === field).map(offerLine).join('\n');

    $('#fPrice').value = result.price.售價
      ? `${result.price.售價}${result.offers.some((o) => o.category === '商品折扣') ? '（賣場有商品折扣：須加入購物車確認是否已套用）' : ''}`
      : '';
    $('#fQty').value = result.price.限購數 || '';
    $('#fDiscountPlatform').value = byField('discount_platform_rakuten');
    $('#fDiscountSeller').value = byField('discount_seller_rakuten');
    $('#fCoinPlatform').value = byField('coinback_platform_rakuten');
    $('#fCoinSeller').value = '';
    $('#fShipping').value = result.shipping.status === 'usable'
      ? result.shipping.value : `（需人工確認）${result.shipping.reason}`;
    $('#fNote').value = buildNote(result);
    $('#fillSection').classList.remove('hidden');

    const shippingRows = result.shipping.options.map((option) =>
      `<li>${escapeHtml(option.原文)}${option.浮動 ? '<b>（浮動運費）</b>' : ''}</li>`).join('');

    $('#decisionSection').innerHTML = `<h2>逐項判斷</h2>
      ${claimedAll ? '' : '<div class="status warn">尚未點擊「一鍵全領」：優惠券可能含已領取完畢的券，判定一律列為需人工確認。</div>'}
      ${result.couponNote ? `<div class="status warn">${escapeHtml(result.couponNote)}</div>` : ''}
      <div class="status ${result.shipping.status === 'usable' ? 'ok' : 'warn'}">運費：${escapeHtml(result.shipping.reason)}</div>
      ${shippingRows ? `<details open><summary>配送方式（${result.shipping.options.length}）</summary><ul>${shippingRows}</ul>
        ${result.shipping.note ? `<p class="muted">${escapeHtml(result.shipping.note)}</p>` : ''}</details>` : ''}
      <details open><summary class="usable">可採用（${usable.length}）</summary>${renderOfferList(usable, 'usable')}</details>
      <details open><summary class="review">需人工確認（${review.length}）</summary>${renderOfferList(review, 'review')}</details>
      <details><summary class="reject">不可採用（${reject.length}）</summary>${renderOfferList(reject, 'reject')}</details>
      ${result.inline.length ? `<details><summary>活動列原文</summary><ul>${result.inline.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></details>` : ''}`;
    $('#decisionSection').classList.remove('hidden');
    $('#copyFill').disabled = false;
    $('#copyAll').disabled = result.offers.length === 0;
  }

  function toFillTsv(result) {
    const header = ['url_rakuten', 'price_rakuten', 'qty_rakuten', 'discount_platform_rakuten',
      'discount_seller_rakuten', 'coinback_platform_rakuten', 'coinback_seller_rakuten',
      'shipping_fee_rakuten', 'note_rakuten'];
    const clean = (value) => normalize(value).replace(/[\t\r\n]+/g, ' / ');
    const data = [result.price.url, $('#fPrice').value, $('#fQty').value, $('#fDiscountPlatform').value,
      $('#fDiscountSeller').value, $('#fCoinPlatform').value, $('#fCoinSeller').value,
      $('#fShipping').value, $('#fNote').value].map(clean);
    return [header.join('\t'), data.join('\t')].join('\n');
  }

  function toAllTsv(result) {
    const header = ['網址', '商品', '售價', '原價', '判定', '類型', '對應欄位', '原文', '發行方', '解析', '理由'];
    const clean = (value) => normalize(value).replace(/[\t\r\n]+/g, ' ');
    const rows = result.offers.map((offer) => [result.price.url, result.price.title, result.price.售價,
      result.price.原價, offer.status, offer.category, offer.field || '', offer.summary,
      offer.issuer || '', factsLine(offer.facts || {}), offer.reason].map(clean).join('\t'));
    return [header.join('\t'), ...rows].join('\n');
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
      console.error('[Rakuten 優惠擷取助手] 複製失敗', error);
      button.textContent = '複製失敗';
    } finally { setTimeout(() => { button.textContent = original; }, 1200); }
  }

  async function claimAll() {
    const button = claimAllButton();
    if (!button) { setProgress('頁面找不到「一鍵全領」按鈕。', 'warn'); return; }
    button.click();
    await sleep(1200);
    claimedAll = true;
    setProgress('已點擊「一鍵全領」，請再按「自動抓取」。', 'ok');
  }

  async function capture() {
    if (busy) return latest;
    busy = true;
    $('#capture').disabled = true;
    try {
      const base = renderPage();
      setProgress('讀取折扣活動…');
      await expandMoreActivities((message) => setProgress(message));
      const activities = captureActivities();
      setProgress('讀取優惠券…');
      const coupons = captureCoupons(claimedAll);
      setProgress('讀取點數回饋…');
      const points = await capturePoints((message) => setProgress(message));
      setProgress('讀取運費…');
      const shipping = await captureShipping((message) => setProgress(message));

      latest = {
        price: base.price,
        seller: base.seller,
        offers: [...activities.offers, ...coupons.offers, ...points.offers],
        inline: activities.inline,
        couponNote: coupons.note,
        shipping,
        最高可賺: points.最高可賺,
      };
      renderResults(latest);
      const usable = latest.offers.filter((offer) => offer.status === 'usable').length;
      const review = latest.offers.filter((offer) => offer.status === 'review').length;
      setProgress(`擷取完成：可採用 ${usable} 項；需人工確認 ${review} 項。未做任何金額計算。`, usable ? 'ok' : 'warn');
      return latest;
    } catch (error) {
      console.error('[Rakuten 優惠擷取助手] 擷取失敗', error);
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

  function destroy() {
    host.remove();
    if (window.RakutenJudgementHelper?.version === VERSION) delete window.RakutenJudgementHelper;
  }

  $('#close').addEventListener('click', destroy);
  $('#claim').addEventListener('click', claimAll);
  $('#capture').addEventListener('click', capture);
  $('#copyFill').addEventListener('click', () => latest && copyText(toFillTsv(latest), $('#copyFill')));
  $('#copyAll').addEventListener('click', () => latest && copyText(toAllTsv(latest), $('#copyAll')));
  enableDragging();
  renderPage();
  window.RakutenJudgementHelper = { version: VERSION, capture, claimAll, result: () => latest, destroy };
  console.info(`[Rakuten 優惠擷取助手 v${VERSION}] 已啟動。只讀取與分類，不計算金額；「一鍵全領」需手動點擊面板按鈕。`);
})();
