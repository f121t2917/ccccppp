(() => {
  const keyword = document.querySelector(
    '#mainContent [id^="item_"] a[href*="/products/"] > span'
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
  return amount ? Number(amount.replace(/[^\d.]/g, '')) : null;
})();
