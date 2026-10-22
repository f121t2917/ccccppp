(async () => {
  const selector = '#mainContent [id^="item_"]';
  let item = document.querySelector(selector);
  if (!item) return null;

  const itemId = item.id;
  const getItem = () => document.getElementById(itemId);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = text =>
    (text ?? '').replace(/\s+/g, ' ').trim();

  // 未勾選時，先勾選商品
  const checkbox = item.querySelector('input[type="checkbox"]');
  if (!checkbox) throw new Error('找不到商品勾選框');

  if (!checkbox.checked) {
    if (checkbox.disabled) throw new Error('這件商品目前無法勾選');
    checkbox.click();
  }

  // 不論原本是否勾選，都等待商品、金額與優惠券資料穩定
  const start = Date.now();
  let previous = '';
  let stableSince = start;
  let ready = false;

  while (Date.now() - start < 10000) {
    await sleep(250);

    const currentItem = getItem();
    const checked = currentItem
      ?.querySelector('input[type="checkbox"]')?.checked;

    const summary = document.querySelector('#rightFloat');
    const total = summary?.querySelector('#finalOrderPrice')
      ?.getAttribute('data-final-order-price');

    // 不包含商品倒數計時，避免每秒變動導致無法穩定
    const state = JSON.stringify([
      checked,
      total,
      summary?.textContent ?? '',
      currentItem?.querySelector('[data-component-id="benefit"]')
        ?.textContent ?? '',
      [...document.querySelectorAll(
        'input[name="coupon"][type="checkbox"]'
      )].map(input => {
        const row = input.closest('.list');

        return [
          input.value,
          input.checked,
          input.disabled,
          row?.querySelector('label strong')?.textContent ?? '',
          [...(row?.querySelectorAll('.coupon-condition .d1') ?? [])]
            .map(el => normalize(el.textContent))
        ];
      })
    ]);

    if (state !== previous) {
      previous = state;
      stableSince = Date.now();
    }

    if (
      checked &&
      Number(total?.replace(/,/g, '')) > 0 &&
      Date.now() - start >= 1500 &&
      Date.now() - stableSince >= 1000
    ) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    throw new Error('商品或金額尚未更新完成，請稍後重新執行');
  }

  // 更新後重新取得商品 DOM
  item = getItem();
  if (!item) return null;

  const keyword = normalize(
    item.querySelector('a[href*="/products/"] > span')?.textContent
  );

  if (!keyword) return null;

  // 酷澎幣
  const coinsText = item.textContent
    .match(/\$\s*([\d,]+(?:\.\d+)?)\s*酷澎幣回饋/)?.[1];

  const coins = coinsText
    ? Number(coinsText.replace(/,/g, ''))
    : null;

  // 商品編號
  const productLink = item.querySelector('a[href*="/products/"]');

  const vendorItemId =
    item.getAttribute('data-vid') ||
    (productLink
      ? new URL(productLink.href, location.href)
          .searchParams.get('vendorItemId')
      : null);

  // 收集優惠券列，不排除「條件不符」
  const rows = [...new Set(
    [...document.querySelectorAll(
      'input[name="coupon"][type="checkbox"]'
    )]
      .map(input => input.closest('.list'))
      .filter(Boolean)
  )];

  // 優先用商品編號比對，避免名稱與規格順序不同
  let row = vendorItemId
    ? rows.find(candidate =>
        [...candidate.querySelectorAll('[data-ccm-manage-code]')]
          .some(el => {
            const code = el.getAttribute('data-ccm-manage-code') ?? '';
            return code.split('_').pop() === vendorItemId;
          })
      )
    : null;

  // 找不到商品編號時，退回統一空白後的名稱比對
  if (!row) {
    row = rows.find(candidate =>
      [...candidate.querySelectorAll('.coupon-condition .d1')]
        .some(el => normalize(el.textContent).includes(keyword))
    );
  }

  // 優惠券金額：百分比券不當成金額
  const amount = row?.querySelector('label strong')?.textContent;
  const couponMatch = amount?.match(/\$\s*([\d,]+(?:\.\d+)?)/);

  const coupon = couponMatch
    ? Number(couponMatch[1].replace(/,/g, ''))
    : null;

  // 保留原本的文案規則，並非判斷實際登入狀態
  const couponText = row?.textContent ?? '';
  const needLogin = !couponText.includes('酷澎首購');

  // 最後金額
  const summary = document.querySelector('#rightFloat');

  const finalText = summary?.querySelector('#finalOrderPrice')
    ?.getAttribute('data-final-order-price');

  if (!finalText) return null;

  let price = Number(finalText.replace(/,/g, ''));

  // 只加回首購優惠折扣與優惠券折扣
  const priceSummary = summary.querySelector(
    '[data-component-id="total-price"]'
  );

  for (const label of ['首購優惠折扣', '優惠券折扣']) {
    const labelElement = [...(priceSummary?.querySelectorAll('div') ?? [])]
      .find(el =>
        el.children.length === 0 &&
        normalize(el.textContent) === label
      );

    const discountText = labelElement?.parentElement?.textContent
      ?.match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1];

    if (discountText) {
      price += Number(discountText.replace(/,/g, ''));
    }
  }

  const rewards = [coins, coupon]
    .filter(value => value !== null)
    .join('+') || 'null';

  const loginText = needLogin ? '，需登入會員' : '';

  const result =
    `${keyword} $${price}， 回饋+優惠 ${rewards} ` +
    `(酷澎幣${coins}，優惠券${coupon})` +
    `${loginText}，原始價格(特價折扣需扣掉)不使用首購、wow會員價`;

  console.log(result);
  return result;
})();
