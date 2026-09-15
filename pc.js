(() => {
  if (window.innerWidth < 1024) {
    throw new Error(
      `目前頁面寬度 ${window.innerWidth}px，折價券區塊可能未載入。請調整到至少 1024px，等待頁面更新後再執行。`
    );
  }
  const name = document.querySelector('h1')?.textContent.trim();
  const el = document.querySelector('[data-regression="prod_redPrice"]');

  if (!name || !el) {
    throw new Error('找不到商品名稱或售價，請等頁面載入完成再執行');
  }

  const readPrice = node => {
    const value = node?.querySelector(
      '.c-prodPrice__price, .c-prodPrice__originalPrice'
    ) || node;
    const match = value?.textContent.match(/\$\s*([\d,]+(?:\.\d+)?)/);

    if (!match) throw new Error('無法辨識價格');
    return Number(match[1].replace(/,/g, ''));
  };

  const hasDiscount = el.textContent.includes('折扣價');
  const redPrice = readPrice(el);
  const original = document.querySelector(
    '[data-regression="prodPage_originalPrice"]'
  );

  const price = hasDiscount && original?.textContent.includes('網路價')
    ? readPrice(original)
    : redPrice;

  const notes = [];
  if (hasDiscount) notes.push(`折扣價後${redPrice}`);

  // 目前只讀取商品頁折價券橫幅顯示的金額
  const couponAmounts = [
    ...document.querySelectorAll(
      '[data-regression="prod_coupon"] .c-label__coupon'
    )
  ].flatMap(node => {
    const match = node.textContent.match(/現折\s*\$\s*([\d,]+)/);
    return match ? [Number(match[1].replace(/,/g, ''))] : [];
  });

  const coupon = couponAmounts.length
    ? Math.max(...couponAmounts)
    : null;

  if (coupon !== null) notes.push(`折價券現折${coupon}`);

  const note = notes.length ? `（${notes.join('；')}）` : '';
  console.log(`${name}：${price} 元${note}`);

  return { name, price, note, coupon };
})();
