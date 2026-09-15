(() => {
  const item = document.querySelector('#mainContent [id^="item_"]');
  const keyword = item?.querySelector(
    'a[href*="/products/"] > span'
  )?.textContent.trim();

  if (!keyword) return null;

  const tip = [...document.querySelectorAll('.coupon-condition .d1')]
    .find(el => el.textContent.includes(keyword));

  if (!tip) return null;

  let row = tip.parentElement;
  while (row && !row.querySelector('input[name="coupon"]')) {
    row = row.parentElement;
  }

  const amount = row?.querySelector('label strong')?.textContent;
  if (!amount) return null;

  const coupon = Number(amount.replace(/[^\d.]/g, ''));
  const coins = item.textContent
    .match(/\$\s*([\d,]+)\s*酷澎幣回饋/)?.[1]
    ?.replace(/,/g, '');

  return coins ? `${coins}+${coupon}` : coupon;
})();
