/* momo / mo+ 商品頁查核器 — 整份貼到 Chrome / Edge Console。
 * 僅讀取頁面；不登入、不領券、不購買、不呼叫私有 API。
 * 教材計算與平台結帳不同；未核對的條件不輸出為確定金額。
 */
(function (global) {
  'use strict';
  const VERSION = '1.1.0';
  const norm = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const num = s => Number(String(s).replace(/,/g, ''));
  const round = n => Math.round((n + Number.EPSILON) * 1);
  const unique = xs => [...new Set(xs)];
  const money = '(\\d[\\d,]*(?:\\.\\d+)?)';
  function detect(url) {
    const u = new URL(url);
    if (!/(^|\.)momoshop\.com\.tw$/i.test(u.hostname)) return {type:'unknown', reason:'不是 momo 網域'};
    const p = u.pathname.match(/^\/TP\/(TP\d+)\/goodsDetail\/(TP\d+)\/?$/i);
    if (p) return {type:'mo+', shopId:p[1], productId:p[2], reason:'MO+ 商品路徑'};
    const m = u.pathname.match(/^\/product\/(\d+)\/?$/i);
    if (m) return {type:'momo', productId:m[1], reason:'一般 MOMO 商品路徑（旗艦店同計算規則）'};
    if (/\/goods\/GoodsDetail\.jsp$/i.test(u.pathname) && /^\d+$/.test(u.searchParams.get('i_code') || ''))
      return {type:'momo', productId:u.searchParams.get('i_code'), reason:'一般 MOMO 舊版路徑；版型須核對'};
    return {type:'unknown', reason:'非已校準商品路徑；不以全頁 mo+ / moPro 文案猜測'};
  }
  function parsePrice(raw) {
    const s = norm(raw);
    const label = s.match(/^(促銷價|折扣後價格|折扣後價|市售價|售價)/)?.[1];
    if (!label) return {raw:s, value:null, reason:'缺價格標籤'};
    const rest = s.slice(label.length).replace(/^(?:\s|:|NT\$|\$)+/gi, '');
    if (/\d\s*(?:元)?\s*[~～至-]\s*\$?\s*\d|\d\s*(?:元)?\s*起/.test(rest))
      return {label, raw:s, value:null, reason:'區間／起價，須先選規格'};
    const m = rest.match(/^(\d[\d,]*(?:\.\d+)?)(?:\s*元)?\s*$/);
    return {label, raw:s, value:m ? num(m[1]) : null, reason:m ? '商品價格標籤相鄰金額' : '金額不唯一或格式不支援'};
  }
  function parseOrderDiscount(headers, cells) {
    const result={shown:true,status:'needs_review',promotionPrice:null,discountAmount:null,priceAfterDiscount:null,
      source:'下單再折價格明細',basis:'頁面顯示金額，未自行乘購買數量',alreadyRepresentedByActivities:true,
      note:'此金額為頁面活動折扣摘要，不可再與同一筆95折／滿額折等活動相加',raw:{headers,cells}};
    const labels=headers.map(norm), values=cells.map(norm);
    const indexes=['促銷價','折扣金額','折扣後價格'].map(label=>labels.indexOf(label));
    if(indexes.some(i=>i<0)||new Set(labels).size!==labels.length||labels.length!==values.length){result.reason='價格明細欄位不完整';return result;}
    const amounts=indexes.map(i=>/^(?:NT\$|\$)?\s*\d[\d,]*(?:\.\d+)?\s*(?:元)?$/.test(values[i])?num(values[i].replace(/NT\$|\$|元|\s/g,'')):null);
    if(amounts.some(n=>n===null||!Number.isFinite(n))){result.reason='價格區間或數字不明';return result;}
    const [p,d,s]=amounts;
    if(d>p||Math.abs(p-d-s)>0.011){result.reason='促銷價－折扣金額與折後價不一致，等待頁面更新';return result;}
    Object.assign(result,{status:'read_from_page',promotionPrice:p,discountAmount:d,priceAfterDiscount:s});
    return result;
  }
  function readOrderDiscountDOM(root, visible) {
    const txt=e=>norm(e?.innerText??e?.textContent??'');
    const triggers=Array.from(root.querySelectorAll('span,button,[role=button],div')).filter(e=>visible(e)&&/^下單再折\s*[▼▲▾▴]?$/.test(txt(e))&&!Array.from(e.children).some(c=>/^下單再折/.test(txt(c))));
    const results=[];
    for(const trigger of triggers){
      // 只讀入口旁的表格；不掃推薦商品、不以市售價相減。
      const box=trigger.parentElement;
      for(const header of box.querySelectorAll('div,tr')){
        if(!visible(header))continue;
        const headers=Array.from(header.children).map(txt);
        if(!['促銷價','折扣金額','折扣後價格'].every(s=>headers.includes(s)))continue;
        const values=header.nextElementSibling;
        if(values&&visible(values))results.push(parseOrderDiscount(headers,Array.from(values.children).map(txt)));
      }
    }
    if(results.length===1)return results[0];
    return {shown:triggers.length>0,status:results.length?'needs_review':triggers.length?'not_expanded':'not_shown',
      promotionPrice:null,discountAmount:null,priceAfterDiscount:null,
      reason:results.length?'價格明細不唯一':triggers.length?'請執行 await MomoAudit.readOrderDiscount() 展開讀取':'本次未顯示下單再折',candidates:results};
  }
  // 只解析可明確表達的單一門檻；複雜階梯、第二件、多分支保留原文待核對。
  function parseOffer(raw, kind = 'unknown') {
    const s = norm(raw), problems = [];
    const o = {kind, name:s, raw:s, threshold:0, minQty:1, repeat:false, amount:null, rate:null, cap:null, verified:false};
    const amounts = [...s.matchAll(new RegExp('(?:每)?滿\\s*\\$?' + money + '\\s*(元|件|組)?', 'g'))];
    for (const m of amounts) {
      if (/件|組/.test(m[2] || '')) o.minQty = num(m[1]); else o.threshold = num(m[1]);
    }
    if (amounts.filter(m=> !/件|組/.test(m[2] || '')).length > 1) problems.push('多個金額門檻');
    if (/第二件|第\s*\d+\s*件|任選|擇一|累積|最高\s*\d+(?:\.\d+)?\s*%|最低.*折/.test(s)) problems.push('階梯、累積或最高值不能直接採用');
    o.repeat = /每滿/.test(s);
    const pct = [...s.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    const zhe = [...s.matchAll(/(\d+(?:\.\d+)?)\s*折(?!\s*\$?\s*\d)/g)];
    const fixed = s.match(new RegExp('(?:再折|現折|折抵|折|減)\\s*\\$?' + money));
    const rewardFixed = s.match(/(?:送|贈)\s*(?:momo|mo)\s*[幣點]\s*\$?\s*(\d[\d,]*)\s*(?:元)?/i)
      || s.match(/(?:送|贈)\s*\$?\s*(\d[\d,]*)\s*(?:元)?\s*(?:momo|mo)\s*[幣點]/i);
    if (kind === 'shippingCoupon') o.amount = 0;
    else if (/^(card|coin|points)/.test(kind)) {
      if (pct.length === 1) o.rate = num(pct[0][1]) / 100;
      else if (rewardFixed) o.amount = num(rewardFixed[1]);
      else problems.push('回饋金額／百分比不明');
      if (pct.length > 1) problems.push('多個回饋百分比');
    } else if (zhe.length === 1) {
      const z = num(zhe[0][1]); o.rate = 1 - z / (z <= 10 ? 10 : 100);
      if (o.rate < 0 || o.rate > 1) problems.push('折數不合理');
    } else if (fixed) o.amount = num(fixed[1]);
    else problems.push('折扣額不明');
    const cap = s.match(/(?:上限(?:翻倍至)?|最高折抵|最多折抵|最高折)\s*\$?\s*(\d[\d,]*)\s*(千)?/);
    if (cap) o.cap = num(cap[1]) * (cap[2] ? 1000 : 1);
    if (o.repeat && (!o.threshold || o.rate !== null)) problems.push('每滿折數／件數需另核算法');
    o.parseProblems = problems;
    return o;
  }
  function eligibility(o, platform) {
    const reasons = [], s = norm(o.raw || o.name), labels = norm(o.qualification || '');
    if (o.kind === 'storeCoupon') reasons.push('商店抵用券不可採用');
    if (/新客|新用|追蹤商店|回購/.test(labels)) reasons.push('專屬資格不可採用');
    if (o.requiresRegistration === true || /登記送|須登記|需登記|限登記/.test(s.replace(/免登記|不需登記|無須登記/g,''))) reasons.push('需要登記');
    const quota = o.quota ?? (s.match(/(?:限量|限額|名額|限前)\s*(\d[\d,]*)\s*(?:名|人|份|張)?/)?.[1]);
    const plusException = platform === 'mo+' && ['productCoupon','shopCoupon','shippingCoupon'].includes(o.kind);
    if (!plusException && quota != null && num(quota) < 1000) reasons.push('名額少於 1000');
    if (!plusException && quota == null && /限量/.test(s)) reasons.push('限量未標名額');
    if (platform === 'momo' && /Coupon$/.test(o.kind) && /\d{1,2}月|限定|限時|秘密|專屬|獨家|會員/.test(o.name || '')) reasons.push('一般 MOMO 券名稱限制');
    if (o.valid === false || o.applicable === false) reasons.push('過期、尚未生效或不適用');
    if (o.paymentAllowed === false) reasons.push('不採用的支付條件');
    if (reasons.length) return {status:'excluded', reasons};
    if (!o.verified || (o.parseProblems || []).length) return {status:'pending', reasons:['須核對完整期限、資格、適用範圍、上限、免登記與是否已含折扣', ...(o.parseProblems || [])]};
    return {status:'eligible', reasons:[]};
  }
  function valueOf(o, base, qty) {
    if (base < (o.threshold || 0) || qty < (o.minQty || 1)) return 0;
    let v = o.rate != null ? round(base * o.rate) : (o.amount || 0);
    if (o.repeat) v *= Math.floor(base / o.threshold);
    if (o.cap != null) v = Math.min(v, o.cap);
    return Math.max(0, v);
  }
  function calculate(input) {
    const warnings = [], trace = [], notes = [];
    const out = {status:'needs_review', fields:{price_momo:null, qty_momo:input.qtyTotal ?? null, discount_momo:null, discount_mopro:null, coinback_momo:null, Pointsback_platform_momo:null, shipping:null}, trace, warnings};
    if (!['momo','mo+'].includes(input.platform)) { warnings.push('未知賣場'); return out; }
    const p = input.price, qty = input.quantity ?? 1;
    if (!Number.isFinite(p) || p < 0 || !Number.isInteger(qty) || qty < 1 || input.priceVerified !== true) { warnings.push('須核對選定規格、數量及折扣前基礎總價'); return out; }
    out.fields.price_momo = p;
    const all = input.offers || [];
    const allowedKinds = ['activity','productCoupon','shopActivity','shopCoupon','crossActivity','shippingCoupon','storeCoupon','card','coin','points','pointsMopro'];
    for (const o of all) {
      if (!allowedKinds.includes(o.kind)) throw new Error('未知優惠種類：' + o.kind);
      for (const k of ['threshold','minQty','amount','rate','cap']) if (o[k] != null && (!Number.isFinite(o[k]) || o[k] < 0)) throw new Error('優惠數值不合法：' + k);
      if (o.rate != null && o.rate > 1) throw new Error('rate 必須介於 0 與 1');
      if (o.repeat && (!(o.threshold > 0) || o.rate != null)) throw new Error('每滿僅支援明確金額門檻的固定折抵');
      if (o.verified && o.amount == null && o.rate == null && !['shippingCoupon','pointsMopro'].includes(o.kind)) throw new Error('優惠缺少 amount 或 rate');
    }
    const audited = all.map(o=>({...o, eligibility:eligibility(o,input.platform)}));
    out.offers = audited;
    const good = audited.filter(o=>o.eligibility.status==='eligible');
    const pending = audited.filter(o=>o.eligibility.status==='pending');
    if (pending.length) warnings.push('仍有未核對優惠；數值僅為已確認方案試算');
    const best = (items,base) => items.reduce((a,o)=> {const v=Math.min(base,valueOf(o,base,qty));return v>a.discount?{discount:v,offers:[o]}:a;},{discount:0,offers:[]});
    const seq = (items,base) => {let s=base;const used=[];for(const o of items){const v=Math.min(s,valueOf(o,s,qty));if(v){used.push({o,before:s,discount:v});s-=v;}}return {discount:base-s,used};};
    let s=p;
    function apply(label,selection) {const before=s;s-=selection.discount;trace.push({step:label,before,discount:selection.discount,after:s,offers:selection.offers.map(o=>o.name)});notes.push(...selection.offers.map(o=>o.name));}
    if (input.platform==='mo+') {
      apply('單品券 vs 單店活動擇優',best(good.filter(o=>['productCoupon','shopActivity'].includes(o.kind)),s));
      apply('單店抵用券',best(good.filter(o=>o.kind==='shopCoupon'),s));
      const cross=good.filter(o=>o.kind==='crossActivity');
      if(cross.length>1 && input.crossStackable!==true) warnings.push('複數跨店活動併用關係未確認；暫採單一最優惠');
      if(cross.length>1 && input.crossStackable===true){for(const o of cross) apply('跨店活動（已核對順序）',best([o],s));}
      else apply('跨店活動',best(cross,s));
    } else {
      const acts=good.filter(o=>o.kind==='activity');
      let a;
      if(acts.length>1 && input.activitiesStackable!==true){warnings.push('複數活動併用關係未確認；暫採單一最優惠');a=best(acts,p);}
      else {const t=seq(acts,p);a={discount:t.discount,offers:t.used.map(x=>x.o)};out.activitySteps=t.used.map(x=>({name:x.o.name,before:x.before,discount:x.discount}));}
      const c=best(good.filter(o=>['productCoupon','shopCoupon'].includes(o.kind)),p);
      apply('活動方案 vs 券方案擇優',c.discount>a.discount?c:a);
    }
    out.fields.discount_momo=p-s;
    const pro=input.moproDiscount;
    if(pro!=null&&(!Number.isFinite(pro)||pro<0||pro>s))throw new Error('moPro 折扣必須介於 0 與普通折扣後金額');
    out.fields.discount_mopro=Number.isFinite(pro)&&pro>=0?pro:null;
    if(out.fields.discount_mopro===null) warnings.push('moPro 折扣尚未確認（確認未顯示時填 0）');
    const rewardBase = pro>0 && !['include','exclude'].includes(input.moproRewardBasis) ? null : (pro>0&&input.moproRewardBasis==='include'?s-pro:s);
    const shippingBase = pro>0 && !['include','exclude'].includes(input.moproShippingBasis) ? null : (pro>0&&input.moproShippingBasis==='include'?s-pro:s);
    if(rewardBase===null) warnings.push('教材未定義 moPro 是否扣入回饋基礎');
    if(rewardBase!==null && rewardBase>=0) {
      const defaultCard={name:'教材預設 mo卡3%（非已驗證帳戶權益）',rate:0.03,cap:2000};
      const cards=[defaultCard,...good.filter(o=>o.kind==='card')];
      const chosen=cards.reduce((a,o)=>valueOf(o,rewardBase,qty)>valueOf(a,rewardBase,qty)?o:a,defaultCard);
      const bonus=good.filter(o=>o.kind==='coin'), points=good.filter(o=>o.kind==='points');
      const cardValue=valueOf(chosen,rewardBase,qty);
      const coinRows=[{name:chosen.name,amount:cardValue},...bonus.map(o=>({name:o.name,amount:valueOf(o,rewardBase,qty)}))];
      const percentTotal=cardValue+bonus.filter(o=>o.rate!=null).reduce((n,o)=>n+valueOf(o,rewardBase,qty),0);
      out.rewardDetails={base:rewardBase,coins:coinRows,points:points.map(o=>({name:o.name,amount:valueOf(o,rewardBase,qty)}))};
      out.fields.coinback_momo=coinRows.reduce((n,o)=>n+o.amount,0);
      if(percentTotal>2000 && input.coinPercentCapConfirmed!==true){out.fields.coinback_momo=null;warnings.push('百分比 mo幣合計超過 2000，共同上限口徑需確認');}
      out.fields.Pointsback_platform_momo=out.rewardDetails.points.reduce((n,o)=>n+o.amount,0);
      if(points.length>1&&input.pointsStackable!==true){out.fields.Pointsback_platform_momo=null;warnings.push('複數 mo點活動須確認非同活動互斥資格分支，且可併用');}
      notes.push(...coinRows.filter(o=>o.amount>0).map(o=>o.name),...out.rewardDetails.points.filter(o=>o.amount>0).map(o=>o.name));
    }
    notes.push(...good.filter(o=>o.kind==='pointsMopro').map(o=>'僅備註：'+o.name));
    if(input.platform==='momo') {out.fields.shipping=0;out.shippingReason='教材作業不计運費，並非平台保證免運';}
    else if(shippingBase!==null && input.shippingVerified===true) {
      const methods=(input.shippingMethods||[]).filter(m=>m.available===true);
      const choices=methods.map(m=>{
        const coupons=good.filter(o=>o.kind==='shippingCoupon'&&o.methods?.includes(m.id)&&shippingBase>=(o.threshold||0)&&qty>=(o.minQty||1));
        const free=m.freeThreshold!=null&&shippingBase>=m.freeThreshold;
        return {id:m.id, fee:free||coupons.length?0:(Number.isFinite(m.fee)&&m.fee>=0?m.fee:null), coupon:!free?coupons[0]?.name:null};
      });
      if(choices.length && choices.every(m=>m.fee!==null)) {const chosen=choices.reduce((a,b)=>a.fee<=b.fee?a:b);out.fields.shipping=chosen.fee;out.shippingChoice=chosen;if(chosen.coupon)notes.push('免運券：'+chosen.coupon);}
      else warnings.push('可用配送方式／未達門檻的原始運費不完整');
    } else warnings.push('MO+ 運費或 moPro 免運計算基礎未確認');
    out.goodsAfterDiscount=s;
    out.goodsPlusShipping=out.fields.shipping===null?null:s+out.fields.shipping;
    out.goodsPlusShippingMeaning='普通折扣後商品額加運費，尚未扣獨立 moPro 欄及回饋；不是保證結帳價';
    out.note_momo=unique(notes).join('/');
    if(input.complete!==true)warnings.push('折價券、活動及贈品明細尚未確認全部讀取');
    if(input.productEligible!==true)warnings.push('商品特色、規格與不採用條件尚未確認');
    if(!warnings.length)out.status='confirmed_under_training_rules';
    return out;
  }

  function scan(doc = document, url = location.href) {
    const platform=detect(url), warnings=[], all=Array.from(doc.querySelectorAll('*'));
    const visible=e=> !e.closest('[data-momo-audit],script,style,template') && e.getClientRects().length>0 && doc.defaultView.getComputedStyle(e).visibility!=='hidden';
    const txt=e=>norm(e?.innerText ?? e?.textContent ?? '');
    const exact=(label,root=doc)=>Array.from(root.querySelectorAll('*')).filter(e=>visible(e)&&txt(e)===label&&!Array.from(e.children).some(c=>txt(c)===label));
    // 展開表格也有「促銷價」表頭，不能把它誤認成另一個商品價格。
    const priceNodes=exact('促銷價').filter(e=>!e.closest('aside,header,footer,nav')&&/^促銷價\s*(?:NT\$|\$)?\s*\d/.test(txt(e.parentElement)));
    let root=platform.type==='mo+'?doc.querySelector('.goods-detail-right'):null;
    if(!root && priceNodes.length===1){let e=priceNodes[0];while(e&&e!==doc.body){if(/數量/.test(txt(e))&&/結帳方式|配送方式/.test(txt(e))){root=e;break;}e=e.parentElement;}}
    if(!root){warnings.push('找不到唯一商品交易區；請等待載入，或此版型尚未支援');return {version:VERSION,url,platform,status:'unsupported_or_loading',warnings};}
    const raw=txt(root), prices=[];
    for(const label of ['促銷價','折扣後價格','折扣後價','市售價','售價'])for(const e of exact(label,root)) {
      if(new RegExp('^'+label+'\\s*(?:NT\\$|\\$)?\\s*\\d').test(txt(e.parentElement)))prices.push(parsePrice(txt(e.parentElement)));
    }
    const orderDiscount=readOrderDiscountDOM(root,visible);
    const promotions=[], used=new Set();
    // 活動群組可能位於圖片下方，限定商品主內容並排除導覽與推薦區。
    const main=doc.querySelector('main')||doc.querySelector('#goods')||root.parentElement;
    for(const a of main.querySelectorAll('a[href*="promoNo="],a[href*="func=18"]')) {
      if(!visible(a)||a.closest('aside,header,footer,nav'))continue;
      let name=txt(a);if(!name||/^(前往活動賣場|登記活動)$/.test(name))continue;
      let group=a.parentElement;
      for(let i=0;i<3&&group.parentElement;i++){if(/登記送|免登記|滿件贈|满額贈|贈品/.test(txt(group)))break;if(txt(group.parentElement).length>2500)break;group=group.parentElement;}
      const context=txt(group), href=a.getAttribute('href');
      if(/^\d+(?:\.\d+)?折$/.test(name))name=context.replace(/\(說明\)|說明/g,'').replace(/^\d+(?:\.\d+)?折\s*/,'').trim()||name;
      const key=href+'|'+name;
      if(used.has(key))continue;used.add(key);
      let kind=/mo(?:mo)?\s*點/i.test(name)?(/moPro/i.test(name)?'pointsMopro':'points'):/mo(?:mo)?\s*幣/i.test(name)?'coin':/送|贈/.test(name)?'gift':platform.type==='mo+'?(/跨店/.test(context)?'crossActivity':'shopActivity'):'activity';
      const offer=parseOffer(name,kind);
      if(/登記送/.test(context)||/[?&]func=18(?:&|$)/.test(href))offer.requiresRegistration=true;
      promotions.push({...offer,source:href,context,eligibility:eligibility(offer,platform.type)});
    }
    // 價格上方的折扣連結可能只有「95折」，改取同列完整門檻。
    for(const e of all.filter(e=>visible(e)&&e.childElementCount===0&&/^滿.*(?:折|減)/.test(txt(e))&&root.contains(e))) {
      const t=txt(e);if(t.length>200)continue;
      if(promotions.some(o=>o.raw===t))continue;
      const o=parseOffer(t,platform.type==='mo+'?(/跨店/.test(t)?'crossActivity':'shopActivity'):'activity');
      promotions.push({...o,context:txt(e.parentElement),eligibility:eligibility(o,platform.type)});
    }
    const shippingLabels=exact('配送方式',root), shipping=[];
    for(const label of shippingLabels){let block=label.parentElement;for(let i=0;i<3&&block&&!block.querySelector('input[type=radio]');i++)block=block.parentElement;
      if(!block)continue;
      for(const radio of block.querySelectorAll('input[type=radio]')){
        const row=radio.closest('label')?.parentElement||radio.parentElement;
        const text=txt(row), fee=text.match(/運費\s*\$?\s*(\d[\d,]*)/), threshold=text.match(/滿\s*\$?\s*(\d[\d,]*)\s*(?:元)?\s*免運/);
        shipping.push({id:radio.value,raw:text,displayedFee:fee?num(fee[1]):null,freeThreshold:threshold?num(threshold[1]):null,disabled:radio.disabled,selected:radio.checked,verified:false});
      }
    }
    const cards=Array.from(root.querySelectorAll('a')).filter(e=>/刷mo卡|mo卡.*回饋/i.test(txt(e))).map(e=>parseOffer(txt(e),'card'));
    const proTexts=unique([...promotions.map(o=>o.raw),...Array.from(root.querySelectorAll('*')).filter(e=>visible(e)&&txt(e).length<180&&/mopro/i.test(txt(e))).map(txt)].filter(s=>/mopro/i.test(s)));
    const proAmounts=unique(proTexts.flatMap(s=>{const m=s.match(/mopro.{0,30}?(?:再省|現省|再折)\s*\$?\s*(\d[\d,]*)/i);return m?[num(m[1])]:[];}));
    const quantitySelect=root.querySelector('select[aria-label="選擇數量"]')||Array.from(root.querySelectorAll('select')).find(e=>Array.from(e.options).every(o=>/^\d+$/.test(o.value)));
    const selectedOptions=Array.from(root.querySelectorAll('[aria-checked="true"],[aria-pressed="true"],option:checked')).map(txt).filter(Boolean);
    const dialogs=all.filter(e=>visible(e)&&(e.matches('[role=dialog],[aria-modal=true],dialog')||/^(?:折扣活動說明|贈品明細|折價券明細|配送說明)$/.test(txt(e))))
      .map(e=>txt(e.matches('[role=dialog],[aria-modal=true],dialog')?e:e.parentElement.parentElement)).filter(t=>t.length>15);
    // 新版贈品浮層沒有 dialog role，以已展開的活動期間／辦法區定位。
    for(const label of exact('活動期間')){
      let box=label.parentElement;
      for(let i=0;i<5&&box&&txt(box).length<20000;i++,box=box.parentElement){
        if(/活動辦法/.test(txt(box))&&/注意事項/.test(txt(box))){dialogs.push(txt(box));break;}
      }
    }
    const rewardBranches=[];
    for(const member of all.filter(e=>visible(e)&&/^會員條件\s*[:：]/.test(txt(e))&&txt(e).length<60&&!Array.from(e.children).some(c=>/^會員條件\s*[:：]/.test(txt(c))))){
      let box=member.parentElement;
      for(let i=0;i<4&&box&&txt(box).length<1200;i++,box=box.parentElement){
        if(/mo(?:mo)?\s*[點幣]\s*\d/i.test(txt(box))){
          const branchText=txt(box), kind=/mopro/i.test(txt(member))?'pointsMopro':/mo(?:mo)?\s*點/i.test(branchText)?'points':'coin';
          let group=box, thresholdText='';
          for(let j=0;j<4&&group&&txt(group).length<8000;j++,group=group.parentElement){const m=txt(group).match(/滿\s*\$?\d[\d,]*(?:元)?(?:且滿\d+件)?即贈送/);if(m){thresholdText=m[0];break;}}
          const o=parseOffer(thresholdText+' '+branchText,kind);
          rewardBranches.push({...o,qualification:txt(member),exclusive:true,eligibility:eligibility(o,platform.type)});break;
        }
      }
    }
    const couponNodes=all.filter(e=>visible(e)&&/^(?:單品折價券|單品券|單店抵用券|商店抵用券|免運券|商店免運券)$/.test(txt(e))&&!Array.from(e.children).some(c=>txt(c)===txt(e)));
    const coupons=couponNodes.map(e=>{let box=e.parentElement;for(let i=0;i<4&&box.parentElement&&!/滿\s*\$?\s*\d|無門檻/.test(txt(box));i++){if(txt(box.parentElement).length>1800)break;box=box.parentElement;}
      const label=txt(e),kind=/商店抵用券/.test(label)?'storeCoupon':/免運/.test(label)?'shippingCoupon':/單店/.test(label)?'shopCoupon':'productCoupon';
      const o=parseOffer(txt(box),kind);
      o.qualification=['新客專屬優惠','新用專屬優惠','追蹤商店專屬優惠','回購專屬優惠'].filter(t=>exact(t,box).length>0).join('/');
      return {...o,formalType:label,eligibility:eligibility(o,platform.type)};});
    const actions=unique(Array.from(main.querySelectorAll('button,[role=button],span,div')).filter(e=>visible(e)&&/^(?:\(說明\)|說明|活動說明|查看贈品|查看可使用的折價券(?: \/ 抵用券)?)$/.test(txt(e))).map(txt));
    warnings.push('所有優惠明細須核對；未讀到不等於不存在。登入後逐一展開折價券／贈品／活動說明，再執行 scan() 或 capture()。');
    if(prices.some(p=>p.value===null))warnings.push('有價格區間或不明價格，請先選規格');
    if(platform.type==='mo+')warnings.push('配送顯示的運費可能已套免運；折扣後跌破門檻時不能沿用顯示的 0 元');
    const result={version:VERSION,capturedAt:new Date().toISOString(),url,platform,status:'needs_review',
      title:txt(doc.querySelector('#goods-detail-goods-title'))||doc.title,
      prices,orderDiscount,quantity:quantitySelect?num(quantitySelect.value):null,selectedOptions,
      priceIncludesDiscount:/下單再折/.test(raw)?'頁面標示下單再折；促銷價與活動折後價分開':prices.some(p=>/^折扣後/.test(p.label))?'有折後價；勿重複扣同筆優惠':'待核對',
      discountActivities:promotions.filter(o=>/Activity|activity/.test(o.kind)),
      rewardActivities:promotions.filter(o=>/^(coin|points)/.test(o.kind)),rewardBranches,physicalGifts:promotions.filter(o=>o.kind==='gift'),cards,coupons,
      couponStatus:'unknown_until_all_details_checked',
      mopro:{shown:proTexts.length>0,meaning:proTexts.length?'本商品區出現 moPro 文案，未必有直接折扣':'本次未看到 moPro，非會員資格判定',discountPerUnit:proAmounts.length===1?proAmounts[0]:null,evidence:proTexts},
      shipping:{auditFee:platform.type==='momo'?0:null,methods:shipping,reason:platform.type==='momo'?'依教材填 0，不代表平台訂單免運':'需以普通折扣後金額重新判定'},
      productWarnings:unique(raw.match(/有貨通知|已售完|售完補貨|無庫存|缺貨|預購|福利品|限購[^。\n]{0,30}/g)||[]),
      detailTexts:unique(dialogs),detailActions:actions,warnings};
    return result;
  }
  const api={version:VERSION,detect,parsePrice,parseOrderDiscount,readOrderDiscountDOM,parseOffer,eligibility,calculate,extract:scan};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  global.MomoAudit?.stop?.();
  let captures=[], timer=null, observer=null, identity='';
  api.scan=()=>{
    const r=scan();const next=(r.platform?.productId||r.url)+'|'+JSON.stringify(r.selectedOptions)+'|'+JSON.stringify(r.prices)+'|'+r.quantity;
    if(identity&&identity!==next)captures=[];
    identity=next;api.last=r;console.group('MOMO 查核 — '+r.platform.type+'（未核對欄位不是 0）');
    console.table(r.prices||[]);
    if(r.orderDiscount?.shown)console.table([{'項目':'下單再折','促銷價':r.orderDiscount.promotionPrice,'折扣金額':r.orderDiscount.discountAmount,'折扣後價格':r.orderDiscount.priceAfterDiscount,'狀態':r.orderDiscount.status}]);
    console.log('完整結果',r);console.log('用法：MomoAudit.capture() 保存已展開明細；MomoAudit.json() 匯出；MomoAudit.calculate({...}) 教材試算');console.groupEnd();return r;
  };
  api.capture=()=>{const r=api.scan();captures.push({capturedAt:r.capturedAt,productId:r.platform.productId,selectedOptions:r.selectedOptions,orderDiscount:r.orderDiscount,coupons:r.coupons,rewardBranches:r.rewardBranches,details:r.detailTexts});api.captures=captures;console.log('已保存本次可讀明細；仍需核對完整性',captures);return captures;};
  api.json=()=>JSON.stringify({page:api.last||api.scan(),captures},null,2);
  api.stop=()=>{observer?.disconnect();clearTimeout(timer);};
  api.watch=()=>{api.stop();observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>api.scan(),1200);});observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-pressed','aria-checked','value']});console.log('已開啟變更重掃；MomoAudit.stop() 停止');};
  let reading=null;
  api.readOrderDiscount=()=>{
    if(reading)return reading;
    reading=(async()=>{
      const url=location.href;
      if(detect(url).type==='unknown')return api.scan();
      // 只展開價格說明；不點購物、登入、領券或結帳按鈕。
      for(let attempt=0;attempt<25;attempt++){
        if(location.href!==url)return api.scan();
        const r=scan();
        if(r.orderDiscount?.status==='read_from_page')return api.scan();
        if(r.orderDiscount?.status==='not_expanded'){
          const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
          const triggers=Array.from(document.querySelectorAll('span,button,[role=button],div')).filter(e=>visible(e)&&!e.closest('aside,header,footer,nav')&&/^下單再折\s*[▼▲▾▴]?$/.test(norm(e.innerText))&&!Array.from(e.children).some(c=>/^下單再折/.test(norm(c.innerText))));
          if(triggers.length===1){
            // 此版型可能以滑鼠移入開啟；單純 HTMLElement.click() 不會產生 hover。
            triggers[0].dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
            triggers[0].dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
            await new Promise(resolve=>setTimeout(resolve,100));
            if(scan().orderDiscount?.status==='not_expanded')triggers[0].click();
            break;
          }
        }
        if(r.orderDiscount?.status==='needs_review')return api.scan();
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      for(let attempt=0;attempt<20&&location.href===url;attempt++){
        if(scan().orderDiscount?.status==='read_from_page')break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return api.scan();
    })().finally(()=>{reading=null;});
    return reading;
  };
  global.MomoAudit=api;
  api.ready=api.readOrderDiscount();
})(globalThis);
