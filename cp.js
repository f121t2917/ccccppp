(async () => {
  const selector = '#mainContent [id^="item_"]';
  let item = document.querySelector(selector);
  if (!item) return null;

  const itemId = item.id;
  const getItem = () => document.getElementById(itemId);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 未勾選時，先勾選商品
  const checkbox = item.querySelector('input[type="checkbox"]');
  if (!checkbox) throw new Error('找不到商品勾選框');

  if (!checkbox.checked) {
    if (checkbox.disabled) throw new Error('這件商品目前無法勾選');

    checkbox.click();

    // 等待勾選成功且訂單金額穩定，最多等 10 秒
    const start = Date.now();
    let previous = '';
    let stableSince = Date.now();
    let ready = false;

    while (Date.now() - start < 10000) {
      await sleep(250);

      const checked = getItem()
        ?.querySelector('input[type="checkbox"]')?.checked;

      const summary = document.querySelector('#rightFloat');
      const total = summary?.querySelector('#finalOrderPrice')
        ?.getAttribute('data-final-order-price');

      const state = summary?.textContent ?? '';

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
  }

  // 更新後重新取得商品 DOM
  item = getItem();
  if (!item) return null;

  const keyword = item.querySelector(
    'a[href*="/products/"] > span'
  )?.textContent.trim();
  if (!keyword) return null;

  // 酷澎幣
  const coinsText = item.textContent
    .match(/\$\s*([\d,]+)\s*酷澎幣回饋/)?.[1];

  const coins = coinsText
    ? Number(coinsText.replace(/,/g, ''))
    : null;

  // 商品對應的優惠券
  const tip = [...document.querySelectorAll('.coupon-condition .d1')]
    .find(el => el.textContent.includes(keyword));

  let row = tip?.parentElement;
  while (row && !row.querySelector('input[name="coupon"]')) {
    row = row.parentElement;
  }

  const amount = row?.querySelector('label strong')?.textContent;
  const coupon = amount
    ? Number(amount.replace(/[^\d.]/g, ''))
    : null;

  // 最後金額
  const summary = document.querySelector('#rightFloat');
  const finalText = summary?.querySelector('#finalOrderPrice')
    ?.getAttribute('data-final-order-price');
  if (!finalText) return null;

  let price = Number(finalText.replace(/,/g, ''));

  // 逐一判斷：只加回這兩種折扣
  const priceSummary = summary.querySelector(
    '[data-component-id="total-price"]'
  );

  for (const label of ['首購優惠折扣', '優惠券折扣']) {
    const labelElement = [...(priceSummary?.querySelectorAll('div') ?? [])]
      .find(el =>
        el.children.length === 0 &&
        el.textContent.trim() === label
      );

    const discountText = labelElement?.parentElement.textContent
      .match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1];

    if (discountText) {
      price += Number(discountText.replace(/,/g, ''));
    }
  }

  const rewards = [coins, coupon]
    .filter(value => value !== null)
    .join('+') || 'null';

  const result = `${keyword} $${price}， 回饋+優惠 ${rewards} (酷澎幣${coins}，優惠券${coupon})，原始價格(特價折扣需扣掉)不使用首購、wow會員價`;

  console.log(result);
  return result;
})();
