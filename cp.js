(() => {
  const item = document.querySelector('#mainContent [id^="item_"]');
  if (!item) return null;

  const keyword = item.querySelector(
    'a[href*="/products/"] > span'
  )?.textContent.trim();

  const coinsText = item.textContent
    .match(/\$\s*([\d,]+)\s*酷澎幣回饋/)?.[1];

  const coins = coinsText
    ? Number(coinsText.replace(/,/g, ''))
    : null;

  const tip = keyword
    ? [...document.querySelectorAll('.coupon-condition .d1')]
        .find(el => el.textContent.includes(keyword))
    : null;

  let row = tip?.parentElement;
  while (row && !row.querySelector('input[name="coupon"]')) {
    row = row.parentElement;
  }

  const amount = row?.querySelector('label strong')?.textContent;
  const coupon = amount
    ? Number(amount.replace(/[^\d.]/g, ''))
    : null;

  const result = [coins, coupon]
    .filter(value => value !== null)
    .join('+') || 'null';

  return `${result} (酷澎幣${coins}，優惠券${coupon})`;
})();
