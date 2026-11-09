/* The Grove: recommendations (21 Oct; side rail, receipt and search 22 Oct). Loaded last, after bookings.js.

   The model is Amos's preference hybrid, run by the Get_Recommendations Lambda (GET /recommendations):
   80% the customer's own ratings + 20% what other customers bought next, never an item they already bought.
   The Lambda ranks businesses by the best item each sells, in three parts: open now and new to you, then new
   but not open now (or no opening hours set), then ones you've visited before (they earn no cash back).
   - A rail on the right, 3 businesses at a time with photos; Refresh shows the next 3:
     My wallet ("Grow your chain"), Discover and the Visit logged page.
     On Discover, a search or a category chip swaps the rail for the businesses that match.
   - Log a visit (from a booking or a business page): "What did you get?" saves the item (New_Transaction),
     then the Visit logged page (#/customer/visit-logged) shows a receipt and your next stops.
     The item teaches the model and records where it was in your picks (live Hit@K, tools/live_hit_rate.py).
   - Cash back: only a business you've never visited earns it (not in this chain, not in an older one).
   - Settings: "Your tastes": a 1–5 rating for each item, how far you'll go, your area (Update_User).
   - My storefront: "Menu" (22 Oct, renamed 23 Oct): the owner types their own products (no practical cap), each with a few
     words. Update_HBB auto-matches each one by its wording to the closest item types (common.match_product),
     so unique products still feed the model. The editor shows what each was matched as, after saving.
     Storefronts list the products; "What did you get?" offers them.
   - Product tables (23 Oct): each product has a price. The editor is a table (name, description, price, ✕),
     storefronts show a name / description / price table, and Log a visit and Book a visit show a table to
     tick products and set how many. The amount is worked out from the prices (the server works it out
     again from its own copy, so it can't be changed in the browser). All of these tables have no lines.
*/

/* Keep in step with ITEMS in lambdas/common.py */
const REC_ITEMS={
    matcha_latte:['Matcha latte','Food & Beverage'],coffee:['Coffee','Food & Beverage'],tea:['Tea','Food & Beverage'],
    cookies:['Cookies','Food & Beverage'],brownies:['Brownies','Food & Beverage'],home_cooked_meal:['Home-cooked meal','Food & Beverage'],
    custom_tshirt:['Custom T-shirt','Fashion & Accessories'],crochet_keychain:['Crochet keychain','Fashion & Accessories'],handmade_jewellery:['Handmade jewellery','Fashion & Accessories'],
    stickers:['Stickers','Arts & Crafts'],scented_candle:['Scented candle','Arts & Crafts'],pottery_workshop:['Pottery workshop','Arts & Crafts'],
    flower_bouquet:['Flower bouquet','Arts & Crafts'],personalised_gift_box:['Personalised gift box','Arts & Crafts'],flower_arranging_workshop:['Flower arranging workshop','Arts & Crafts'],
    preserved_flowers:['Preserved flowers','Arts & Crafts'],greeting_card:['Greeting card','Arts & Crafts'],crochet_flower_bouquet:['Crochet flower bouquet','Arts & Crafts'],
    manicure:['Manicure','Health & Beauty'],facial:['Facial','Health & Beauty'],eyelash_extensions:['Eyelash extensions','Health & Beauty'],
    eyebrow_grooming:['Eyebrow grooming','Health & Beauty'],hair_styling:['Hair styling','Health & Beauty'],yoga_session:['Yoga session','Health & Beauty']
};
const REC_CATEGORIES=['Food & Beverage','Health & Beauty','Arts & Crafts','Fashion & Accessories'];
const REC_RATINGS=['Not for me','Rarely','Sometimes','Often','Love it'];
const recLabel=k=>REC_ITEMS[k]?.[0]||k;
const recByCategory=keys=>REC_CATEGORIES.map(c=>[c,keys.filter(k=>REC_ITEMS[k][1]===c)]).filter(([,ks])=>ks.length);

/* ---------------------------------------------------------------- data: carry the new fields */
const toUiBusinessBeforeRecs=toUiBusiness;
const recPrice=v=>v===null||v===undefined||v===''||isNaN(Number(v))?null:Number(v);
const recProducts=list=>(list||[]).filter(p=>p&&p.name).map(p=>({name:p.name,description:p.description||'',price:recPrice(p.price),types:p.types||{},matchedBy:p.matchedBy||''}));
// The products customers can tick (older products saved before 23 Oct may have no price yet)
const recPriced=b=>(b?.products||[]).filter(p=>p.price!==null);
toUiBusiness=function(r){const ui=toUiBusinessBeforeRecs(r);ui.items=(r.items||[]).filter(k=>REC_ITEMS[k]);ui.products=recProducts(r.products);return ui};
const applyMeBeforeRecs=applyMe;
applyMe=function(me){
    applyMeBeforeRecs(me);
    const u=me.user||{};
    state.profile.itemRatings=u.itemRatings||{};
    state.profile.travel=u.travel==='near'?'near':'anywhere';
    state.lastVisit=(me.visits||[])[0]||null;   // newest first
};
const applyDashboardBeforeRecs=applyDashboard;
applyDashboard=function(d){applyDashboardBeforeRecs(d);state.business.items=(d.business?.items||[]).filter(k=>REC_ITEMS[k]);state.business.products=recProducts(d.business?.products)};
// What a business sells, for showing: its own products, else the catalog items it picked (older listings)
const recSold=b=>(b?.products?.length?b.products:(b?.items||[]).map(k=>({name:recLabel(k),description:'',types:{[k]:1}})));
// The type a product was matched to best ('' when it matched nothing)
const recTopType=p=>Object.entries(p?.types||{}).sort((a,b)=>Number(b[1])-Number(a[1]))[0]?.[0]||'';
// How the recommender places a product. One no word list knows borrows the shop's other products, else its category (23 Oct).
const recMatchText=p=>{const t=Object.entries(p.types||{}).sort((a,b)=>Number(b[1])-Number(a[1]));
    const list=t.map(([k,w])=>`${recLabel(k)} ${Math.round(Number(w)*100)}%`).join(' · ');
    if(p.matchedBy==='category')return `Recommended to people who like ${REC_ITEMS[t[0]?.[0]]?.[1]||'your category'}. A few words about it can make this sharper.`;
    if(p.matchedBy==='shop')return 'Recommended like your other products: '+list;
    return t.length?'Matched as '+list:'We’ll recommend it with your shop’s category once you save.'};

/* ---------------------------------------------------------------- picks (GET /recommendations) */
const REC_PAGE=3;
let recs={status:'idle',list:[],key:''},recPages={};   // which 3 each rail shows; back to the top on new picks
// Ask again whenever something the picks depend on changes
function recKey(){
    const p=state.profile;
    return [state.userId,geo?`${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`:'',state.visits.length,JSON.stringify(p.itemRatings||{}),p.travel,p.region,p.interests.join(','),p.recommendations].join('|');
}
function loadRecommendations(){
    if(recs.status==='loading'||authStatus!=='signed-in')return;
    const key=recKey();recs={...recs,status:'loading',key};paintRecRails();
    GroveAPI.getRecommendations(geo?{lat:geo.lat.toFixed(5),lng:geo.lon.toFixed(5)}:{})
        .then(r=>{recs={status:'ready',key,list:r.recommendations||[],off:!!r.off,parent:r.parent||'',basis:r.basis||'',travel:r.travel||''};recPages={}})
        .catch(err=>{recs={status:'error',key,list:[],message:err.message}})
        .finally(()=>{paintRecRails();if(recs.key!==recKey()&&document.querySelector('.rec-rail'))setTimeout(loadRecommendations)});
}
function recWhen(r){
    if(r.openNow)return `Open until ${bkAmPm(r.closesAt)}`;
    if(!r.opensAt)return 'Hours not listed';
    const [day,time]=r.opensAt.includes(' ')?r.opensAt.split(' '):['',r.opensAt];
    return `Opens ${bkAmPm(time)}${day?' '+day:''}`;
}
// Been there before: in this chain, or a visit logged there in an older one. Those earn no cash back.
const recBeen=num=>state.chain.includes(num)||state.visits.some(v=>v.business===num);
function recCash(num,been){
    if(been||recBeen(num))return '<span class="muted">Visited before · no cash back</span>';
    return state.chain.length?`<span class="rec-cash">+${money(CHAIN_CASHBACK)} cash back</span>`:'';
}
// One business: its photo on the left; its name (opens its page), where, opening hours and cash back on the right
function bizCard(o){
    const open=(html,cls='')=>o.num?`<button class="${cls}" data-new="open-store" data-id="${o.num}">${html}</button>`:html;
    return `<article class="rec-card">${open(`<img src="${o.img}" alt="" loading="lazy">`,'rec-thumb')}<div class="rec-card-text"><h3>${open(esc(o.name))}</h3><p class="rec-card-meta">${esc(o.meta)}</p><p class="rec-card-when ${o.isOpen?'rec-open':'rec-later'}">${esc(o.when)}</p>${o.cash?`<p class="rec-card-why">${o.cash}</p>`:''}${o.locate&&o.num?`<button class="text-btn rec-locate" data-new="focus-pin" data-id="${o.num}">Show on map</button>`:''}</div></article>`;
}
function recCard(r,kind){
    const b=r.business||{},ui=businesses.find(x=>x.businessId===b.businessId),num=ui?ui.id:0;
    return bizCard({num,name:b.name||'',img:ui?imgs[ui.image]:(b.imageUrl||CATEGORY_PHOTO[b.category]||imgs.bread),
        meta:[b.category,b.area,r.distanceKm!=null?`${r.distanceKm} km`:''].filter(Boolean).join(' · '),
        when:recWhen(r),isOpen:r.openNow,cash:recCash(num,r.inChain),locate:kind==='discover'});
}
// A search result on Discover (b = business(id)): the same card, with its opening hours worked out here
function resultCard(b){
    const s=bkOpenStatus(b),d=distanceTo(b.id),listed=bkHasHours(b);
    return bizCard({num:b.id,name:b.name,img:imgs[b.image],meta:[b.category,b.area,d!=null?`${d.toFixed(1)} km`:''].filter(Boolean).join(' · '),
        when:!listed?'Hours not listed':s.open?s.detail.replace(/^Closes /,'Open until '):(s.detail||'Closed'),isOpen:s.open,cash:recCash(b.id,false),locate:true});
}
const REC_RAILS={wallet:'Grow your chain',discover:'Recommended for you',visit:'Your next stop'};
function recRailInner(kind){
    const near=state.profile.travel==='near';
    if(recs.key!==recKey()&&recs.status!=='loading')setTimeout(loadRecommendations);
    const ready=recs.status==='ready'&&recs.key===recKey(),list=ready?recs.list:[];
    const pages=Math.max(1,Math.ceil(list.length/REC_PAGE)),page=(recPages[kind]||0)%pages,shown=list.slice(page*REC_PAGE,page*REC_PAGE+REC_PAGE);
    let body,foot='';
    if(recs.status==='error')body=`<p class="muted">${esc(recs.message||'We couldn’t load your picks.')}</p><button class="btn small secondary" data-rec="retry">Try again</button>`;
    else if(!ready)body='<p class="muted" role="status">Finding your next stop…</p>';
    else if(!list.length)body=`<p class="muted">There’s nothing to recommend ${near?'within 5 km ':''}yet. ${near?'Try “Anywhere in Singapore” in <a href="#/customer/settings">Your tastes</a>.':'Come back a little later.'}</p>`;
    else{
        body=shown.map(r=>recCard(r,kind)).join('');
        foot=`<p class="subtle rec-rail-foot">${list.length>REC_PAGE?`Showing ${page*REC_PAGE+1}–${page*REC_PAGE+shown.length} of ${list.length} · `:''}${recs.basis==='interests'?'<a href="#/customer/settings">Rate a few items</a> to make these yours':'<a href="#/customer/settings">Your tastes</a>'}</p>`;
    }
    return `<div class="rec-rail-head"><h2>${REC_RAILS[kind]}</h2><button class="btn small secondary rec-refresh" data-rec="refresh" ${ready&&list.length?'':'disabled'} aria-label="Show other recommendations">↻ Refresh</button></div><div class="rec-cards" aria-live="polite">${body}</div>${foot}`;
}
function recRail(kind,cls=''){return `<aside class="rec-rail panel ${cls}" data-rail="${kind}" aria-label="Recommended businesses">${recRailInner(kind)}</aside>`}
function paintRecRails(){document.querySelectorAll('.rec-rail[data-rail]').forEach(el=>{el.innerHTML=recRailInner(el.dataset.rail);polishCopy()})}
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-rec]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    if(el.dataset.rec==='clear-search'){query='';category='All';renderPage();return}
    const kind=el.closest('.rec-rail')?.dataset.rail,next=(recPages[kind]||0)+1;
    if(el.dataset.rec==='refresh'&&kind&&next*REC_PAGE<recs.list.length){recPages[kind]=next;paintRecRails();return}
    recs.status='idle';loadRecommendations();   // past the last picks: back to the top, freshly asked (opening hours move on)
},true);
// Left: the page; right: the rail (below it on narrow screens)
function withRail(html,kind){
    const t=document.createElement('template');t.innerHTML=html;
    const head=t.content.querySelector('.page-heading');head?.remove();
    return `${head?head.outerHTML:''}<div class="rec-layout"><div class="rec-main">${t.innerHTML}</div>${recRail(kind)}</div>`;
}

// My wallet: "Grow your chain" becomes the rail of picks
const walletPageBeforeRecs=walletPage;
walletPage=function(){
    const html=walletPageBeforeRecs();
    if(!state.profile.recommendations)return html;
    const t=document.createElement('template');t.innerHTML=html;
    const grow=[...t.content.querySelectorAll('.section-title')].find(el=>el.querySelector('h2')?.textContent==='Grow your chain');
    if(grow){if(grow.nextElementSibling?.classList.contains('cards'))grow.nextElementSibling.remove();grow.remove()}
    return withRail(t.innerHTML,'wallet');
};
// Discover: the right-hand column is the rail of picks. A search or a category chip swaps it for the
// businesses that match (the map pins follow the same search); Clear brings the picks back.
const discoverBeforeRecs=discover;
discover=function(){
    const html=discoverBeforeRecs();
    if(!state.profile.recommendations)return html;
    const t=document.createElement('template');t.innerHTML=html;
    const col=t.content.querySelector('.island-results');if(!col)return html;
    t.content.querySelector('[data-v10="search-area"]')?.remove();
    const holder=document.createElement('div');
    holder.innerHTML=query.trim()||category!=='All'?searchResults():recRail('discover','island-results');
    col.replaceWith(holder.firstElementChild);
    return t.innerHTML;
};
function searchResults(){
    const list=practicalList(),q=query.trim(),cat=category!=='All'?category:'';
    const count=`${list.length} ${list.length===1?'business':'businesses'}${q&&cat?' in '+esc(cat):''}`;
    return `<aside class="rec-rail rec-results panel island-results" aria-label="Search results"><div class="rec-rail-head"><div><h2>${q?`Results for “${esc(q)}”`:esc(cat)}</h2><p class="muted">${count}</p></div><button class="btn small secondary" data-rec="clear-search">Clear</button></div><div class="rec-cards rec-results-list">${list.map(resultCard).join('')||'<p class="muted">Nothing matches. Try another word, or clear the search to see your recommendations.</p>'}</div></aside>`;
}

/* ---------------------------------------------------------------- tick what you bought: Log a visit and Book a visit
   chosen = {product name: quantity} to tick in advance (a booking's order, or what was ticked before a repaint) */
function orderTable(products,chosen={},totalLabel='Total',what='Product'){
    const rows=products.map((p,i)=>{const q=chosen[p.name];
        return `<tr class="order-row ${q?'picked':''}"><td class="order-tick"><input type="checkbox" id="order-${i}" data-order-name="${esc(p.name)}" data-order-price="${p.price}" ${q?'checked':''}></td><td><label for="order-${i}"><b>${esc(p.name)}</b>${p.description?`<small>${esc(p.description)}</small>`:''}</label></td><td class="num">${money(p.price)}</td><td class="num order-qty"><input type="number" min="1" max="99" step="1" inputmode="numeric" value="${q||1}" aria-label="How many ${esc(p.name)}"></td></tr>`}).join('');
    return `<table class="plain-table order-table"><thead><tr><th><span class="sr-only">Tick</span></th><th>${what}</th><th class="num">Price</th><th class="num">Qty</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td></td><th scope="row">${totalLabel}</th><td class="num" colspan="2" data-order-total>${money(0)}</td></tr></tfoot></table>`;
}
// The ticked rows as [{name, quantity}]; strict: a quantity must be a whole number from 1 to 99
function readOrder(form,strict=true){
    return [...form.querySelectorAll('.order-row')].filter(r=>r.querySelector('[data-order-name]').checked).map(r=>{
        const name=r.querySelector('[data-order-name]').dataset.orderName,raw=r.querySelector('.order-qty input').value.trim(),quantity=Number(raw);
        if(strict&&!(/^\d+$/.test(raw)&&quantity>=1&&quantity<=99))throw new GroveAPI.ApiError(400,`How many ${name}? Use a whole number from 1 to 99.`);
        return {name,quantity};
    });
}
// Work out the total from the prices shown; Log a visit also gets it as the amount spent
function orderRecalc(form){
    if(!form)return;
    const cents=[...form.querySelectorAll('.order-row')].reduce((sum,r)=>{
        const box=r.querySelector('[data-order-name]'),q=Number(r.querySelector('.order-qty input').value);
        r.classList.toggle('picked',box.checked);
        return box.checked&&Number.isInteger(q)&&q>0?sum+Math.round(Number(box.dataset.orderPrice)*100)*q:sum;
    },0);
    const cell=form.querySelector('[data-order-total]');if(cell)cell.textContent=money(cents/100);
    const amount=form.querySelector('#visit-amount');if(amount){amount.value=(cents/100).toFixed(2);updateCashbackPreview()}
}
['input','change'].forEach(type=>document.addEventListener(type,e=>{
    const row=e.target.closest?.('.order-row');if(!row)return;
    // Typing a quantity ticks the product
    if(e.target.matches('.order-qty input')&&Number(e.target.value)>0)row.querySelector('[data-order-name]').checked=true;
    orderRecalc(row.closest('form'));
}));
const updateCashbackPreviewBeforeRecs=updateCashbackPreview;
updateCashbackPreview=function(){
    updateCashbackPreviewBeforeRecs();
    const box=$('#cashback-preview');
    if(box&&$('#visit-log-form .order-table')&&$('#use-cashback')?.checked&&!(Number($('#visit-amount')?.value)>0))box.textContent='Tick what you bought to see how much cash back is used.';
};

/* ---------------------------------------------------------------- log a visit: what did you get? */
function recProductOptions(products){
    return `<option value="">Something else, or rather not say</option>${products.map((p,i)=>`<option value="${i}" ${products.length===1?'selected':''}>${esc(p.name)}</option>`).join('')}`;
}
function recItemOptions(sold){
    const others=Object.keys(REC_ITEMS).filter(k=>!sold.includes(k));
    const opts=keys=>keys.map(k=>`<option value="${k}" ${sold.length===1&&k===sold[0]?'selected':''}>${esc(recLabel(k))}</option>`).join('');
    return `<option value="">Something else, or rather not say</option>${sold.length?`<optgroup label="Sold here">${opts(sold)}</optgroup>`:''}${recByCategory(others).map(([c,ks])=>`<optgroup label="${esc(sold.length?'Other · '+c:c)}">${opts(ks)}</optgroup>`).join('')}`;
}
const openVisitLogBeforeRecs=openVisitLog;
openVisitLog=function(num,appt=null){
    openVisitLogBeforeRecs(num,appt);
    $('#modal').classList.remove('bk-modal');   // a booking popup opened earlier leaves its wide layout behind
    const amountField=$('#visit-log-form #visit-amount')?.closest('.field');if(!amountField)return;
    const b=businesses.find(x=>x.id===num),priced=recPriced(b);
    if(priced.length){
        // Tick what you got; the amount is worked out from the prices. From a booking, its order is ticked already.
        const chosen=Object.fromEntries((appt?.lines||[]).map(l=>[l.name,Number(l.quantity)||1]));
        amountField.outerHTML=`<fieldset class="order-field"><legend>What did you get?</legend>${orderTable(priced,chosen,'Total',bkType(b)==='service'?'Service':'Product')}<input type="hidden" id="visit-amount" name="amount" value="0.00"></fieldset>`;
        orderRecalc($('#visit-log-form'));
    }else{
        const own=b?.products?.length?b.products:null;
        amountField.insertAdjacentHTML('beforebegin',`<div class="field"><label for="visit-item">What did you get? <span class="muted">(helps us pick your next stop)</span></label><select id="visit-item" name="${own?'product':'item'}">${own?recProductOptions(own):recItemOptions(b?.items||[])}</select></div>`);
    }
    // Visited in an older chain: no cash back either
    const note=$('#visit-log-form > p.subtle:not(#cashback-preview)');
    if(note&&!state.chain.includes(num)&&recBeen(num))note.textContent='You’ve visited this business before, so this visit earns no cash back.';
};
logVisitOnServer=async function(num,amount,appointmentId,useCashback=false,item='',product='',lines=null){
    const b=businesses.find(x=>x.id===num);if(!b)return;
    // With lines, the server works out the amount from the business's prices
    const res=await GroveAPI.recordVisit(b.businessId,{...(lines?{lines}:{amount}),useCashback,...(appointmentId?{appointmentId}:{}),...(item?{item}:{}),...(product?{product}:{})});
    visitDone=res;
    closeModal();
    try{await loadMe()}catch{}   // the visit is saved; the receipt comes from the reply even if this refresh fails
    showVisitLogged();
    celebrate();
};

/* ---------------------------------------------------------------- Visit logged: a whole page (#/customer/visit-logged)
   Every visit logged ends here (from a booking or a business page, repeat visits too).
   Left: the visit as a receipt, with the business's photo on top. Right: the rail of next stops. */
let visitDone=null;   // the server's reply for the visit just logged
// Open the page, even when it's already showing (the hash doesn't change then, so nothing else would redraw it)
function showVisitLogged(){
    if(location.hash==='#/customer/visit-logged'){mode='customer';route='visit-logged';shell()}
    else location.hash='#/customer/visit-logged';
    window.scrollTo(0,0);
}
const shellBeforeRecs=shell;
shell=function(){
    if(/^#\/customer\/visit-logged(\/|$)/.test(location.hash)){mode='customer';route='visit-logged'}
    shellBeforeRecs();
};
function visitTime(raw){
    const t=raw.createdAt?new Date(raw.createdAt):null;
    return t&&!isNaN(t)?t.toLocaleString('en-SG',{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Asia/Singapore'}):date(raw.date);
}
function visitLoggedPage(){
    // The visit just logged, or (after a reload) the newest visit on record
    const raw=visitDone?.transaction||state.lastVisit,num=raw?bizNum(raw.businessId):0,b=num&&businesses.find(x=>x.id===num);
    if(!b)return `<div class="page-heading"><div><h1>Visit logged</h1></div></div><div class="empty"><p>You haven’t logged a visit yet.</p><a class="btn" href="#/customer/discover">Discover businesses</a></div>`;
    const fresh=!!visitDone?.transaction,spent=Number(raw.amount)||0,used=Number(raw.cashbackUsed)||0,earned=Number(raw.cashback)||0;
    const repeat=fresh?!!visitDone.repeat:(!earned&&state.visits.filter(x=>x.business===num).length>1);
    const balance=fresh&&visitDone.cashbackBalance!=null?Number(visitDone.cashbackBalance):(state.cashbackBalance||0);
    const stops=(fresh?visitDone.chain?.businessIds?.length:null)??state.chain.length;
    const no=String(raw.transactionId||'').replace(/^visit-/,'').replace(/[^a-z0-9]/gi,'').slice(-8).toUpperCase();
    const row=(k,v,cls='')=>`<div class="receipt-row ${cls}"><span>${k}</span><span>${v}</span></div>`;
    const note=repeat?`You’ve visited ${esc(b.name)} before, so this visit earns no cash back.`
        :earned>0?`You earned ${money(earned)} cash back. It’s in your wallet.`:'This is the first stop in your chain.';
    const photo=imgs[b.image]?`<img class="receipt-photo" src="${imgs[b.image]}" alt="${esc(b.name)}">`:'';
    const receipt=`<section class="receipt" aria-label="Visit receipt">${photo}<header class="receipt-head"><span class="receipt-check" aria-hidden="true">✓</span><span class="eyebrow">VISIT LOGGED</span><h2>${esc(b.name)}</h2><p>${esc([b.category,b.area].filter(Boolean).join(' · '))}</p><p class="receipt-meta">${esc(visitTime(raw))}${no?`<br>Receipt no. ${no}`:''}</p></header>`
        +`<div class="receipt-rows">${raw.lines?.length?raw.lines.map(l=>row(`${Number(l.quantity)} × ${esc(l.name)}`,money(Number(l.price)*Number(l.quantity)))).join('')
            :row(raw.product?esc(raw.product):raw.item?esc(recLabel(raw.item)):'Your purchase',money(spent))}${used>0?row('Paid from your wallet','−'+money(used)):''}</div>`
        +`<div class="receipt-rows">${row('Total paid',money(spent-used),'receipt-total')}</div>`
        +`<div class="receipt-rows">${row('Cash back earned',earned>0?'+'+money(earned):money(0))}${row('Wallet balance',money(balance))}${row('Your chain',`${stops} ${stops===1?'stop':'stops'}`)}</div>`
        +`<footer class="receipt-foot"><p>${note}</p><p class="receipt-nudge">Visit a new business to earn ${money(CHAIN_CASHBACK)} cash back.</p><p class="muted">Thank you for shopping local.</p></footer></section>`;
    const left=`<div class="visit-logged">${receipt}<div class="visit-logged-actions"><a class="btn" href="#/customer/wallet">Go to My wallet</a><a class="btn secondary" href="#/customer/home">Back to Home</a></div></div>`;
    const head=`<div class="page-heading"><div><h1>You visited <button class="visit-title-link" data-new="open-store" data-id="${num}" title="Open ${esc(b.name)}’s page">${esc(b.name)}</button></h1></div></div>`;
    return state.profile.recommendations?withRail(head+left,'visit'):head+left;
}
const renderBeforeRecs=renderPage;
renderPage=function(){
    const content=$('#content');
    if(content&&groveReady&&!groveLoadError&&mode==='customer'&&route==='visit-logged'){
        if(leafMap){leafMap.remove();leafMap=null}
        content.innerHTML=visitLoggedPage();polishCopy();paintAccountMenu();bkPaintBadges();return;
    }
    renderBeforeRecs();
};
formHandlers['visit-log-form']=async(d,form)=>{
    if(form.querySelector('.order-table')){
        const lines=readOrder(form);
        if(!lines.length)throw new GroveAPI.ApiError(400,'Tick what you bought.');
        await logVisitOnServer(Number(form.dataset.id),null,form.dataset.appt||null,!!form.querySelector('#use-cashback')?.checked,'','',lines);
        return;
    }
    const amount=Number(d.amount);
    if(!(amount>=0)||String(d.amount).trim()==='')throw new GroveAPI.ApiError(400,'Enter how much you spent.');
    // One of the business's own products: send its name, plus the type it matched best so the model learns
    const b=businesses.find(x=>x.id===Number(form.dataset.id)),p=d.product!==undefined&&d.product!==''?b?.products?.[Number(d.product)]:null;
    await logVisitOnServer(Number(form.dataset.id),amount.toFixed(2),form.dataset.appt||null,!!form.querySelector('#use-cashback')?.checked,p?recTopType(p):(d.item||''),p?p.name:'');
};

/* ---------------------------------------------------------------- Settings: your tastes */
function tastesPanel(){
    const p=state.profile,r=p.itemRatings||{},near=p.travel==='near';
    const sel=k=>`<select name="rate-${k}" id="rate-${k}"><option value="">Not rated</option>${REC_RATINGS.map((t,i)=>`<option value="${i+1}" ${Number(r[k])===i+1?'selected':''}>${i+1} · ${t}</option>`).join('')}</select>`;
    const groups=recByCategory(Object.keys(REC_ITEMS)).map(([c,ks])=>`<h3>${esc(c)}</h3><div class="taste-grid">${ks.map(k=>`<label class="taste" for="rate-${k}"><span>${esc(recLabel(k))}</span>${sel(k)}</label>`).join('')}</div>`).join('');
    const regions=['North','South','East','West','Central'];
    return `<section class="panel tastes-panel" style="margin-top:24px"><h2>Your tastes</h2><p class="muted">Your recommendations are picked mostly from these ratings. Anything you don’t rate goes by your interests.</p><form id="tastes-form"><fieldset class="travel-choice"><legend>How far will you go?</legend><label><input type="radio" name="travel" value="near" ${near?'checked':''}> Near me (within 5 km)</label><label><input type="radio" name="travel" value="anywhere" ${near?'':'checked'}> Anywhere in Singapore</label><div class="field"><label for="taste-region">Your area <span class="muted">(used for distances unless you tap “Use my location” in Discover)</span></label><select id="taste-region" name="region">${regions.map(x=>`<option ${p.region===x?'selected':''}>${x}</option>`).join('')}</select></div></fieldset>${groups}<button class="btn">Save my tastes</button></form></section>`;
}
const settingsBeforeRecs=settings;
settings=function(){
    const html=settingsBeforeRecs();
    return html;   // "Your tastes" removed from Settings (27 Oct); saved ratings still feed recommendations
};
formHandlers['tastes-form']=async(d)=>{
    const itemRatings={};
    Object.keys(REC_ITEMS).forEach(k=>{const v=Number(d['rate-'+k]);if(v>=1&&v<=5)itemRatings[k]=v});
    await GroveAPI.updateMe({itemRatings,travel:d.travel==='near'?'near':'anywhere',region:d.region});
    await loadMe();renderPage();toast('Your tastes are saved. Your recommendations are updated.');
};

/* ---------------------------------------------------------------- My storefront: what you sell (your own products) */
const REC_MAX_PRODUCTS=200; // no practical cap (23 Oct); matches common.MAX_PRODUCTS
function productRow(p={name:'',description:'',price:null,types:null}){
    // The recommender still matches each product when it's saved (common.match_product); the editor no longer shows it (23 Oct)
    return `<tr class="product-row"><td class="product-name-cell"><input name="product-name" maxlength="60" value="${esc(p.name)}" placeholder="Name" aria-label="Name"></td>`
        +`<td><input name="product-desc" maxlength="200" value="${esc(p.description)}" placeholder="Description" aria-label="Description"></td>`
        +`<td class="num"><input name="product-price" type="text" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" maxlength="9" value="${p.price!=null?Number(p.price).toFixed(2):''}" placeholder="Price" aria-label="Price (S$)"></td>`
        +`<td class="product-x-cell"><button type="button" class="product-x" data-product="remove" aria-label="Delete this product" title="Delete">✕</button></td></tr>`;
}
const editorBeforeRecs=editor;
editor=function(){
    const t=document.createElement('template');t.innerHTML=editorBeforeRecs();
    const mine=recSold(state.business).map(p=>({...p,types:state.business.products?.length?p.types:null}));
    const html=`<fieldset class="items-editor"><legend>Menu</legend><table class="plain-table product-table"><thead><tr><th><span class="sr-only">Name</span></th><th><span class="sr-only">Description</span></th><th class="num">Price (S$)</th><th><span class="sr-only">Delete</span></th></tr></thead><tbody class="product-rows">${(mine.length?mine:[undefined]).map(p=>productRow(p)).join('')}</tbody></table><button type="button" class="btn small secondary" data-product="add">Add a product</button></fieldset>`;
    t.content.querySelector('#editor-form button.btn:not([data-product])')?.insertAdjacentHTML('beforebegin',html);
    // No "A note to your customers" (23 Oct); the type of home business sits under the name
    t.content.querySelector('#note')?.closest('.field')?.remove();
    const kind=bkType(state.business);
    t.content.querySelector('#name')?.closest('.field')?.insertAdjacentHTML('afterend',`<div class="field"><label for="business-type">Type of home business</label><select id="business-type" name="businessType"><option value="product" ${kind==='product'?'selected':''}>Product</option><option value="service" ${kind==='service'?'selected':''}>Service</option></select></div>`);
    return t.innerHTML;
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-product]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const rows=el.closest('.items-editor')?.querySelector('.product-rows');if(!rows)return;
    if(el.dataset.product==='add'){
        if(rows.children.length>=REC_MAX_PRODUCTS){toast(`Add up to ${REC_MAX_PRODUCTS} products.`);return}
        rows.insertAdjacentHTML('beforeend',productRow());rows.lastElementChild.querySelector('input')?.focus();
    }
    if(el.dataset.product==='remove'){el.closest('.product-row').remove();if(!rows.children.length)rows.insertAdjacentHTML('beforeend',productRow())}
},true);
// Editing a product: its old match no longer applies until it's saved again
function readProducts(form){
    const value=(r,n)=>r.querySelector(`[name="${n}"]`).value.trim();
    return [...form.querySelectorAll('.product-row')].map(r=>({name:value(r,'product-name'),description:value(r,'product-desc'),price:value(r,'product-price').replace(/^\$/,'')}))
        .filter(p=>p.name||p.description||p.price).map(p=>{
            if(!p.name)throw new GroveAPI.ApiError(400,'Give each product a name.');
            if(!/^\d+(\.\d{1,2})?$/.test(p.price))throw new GroveAPI.ApiError(400,`Please give ${p.name} a price, like 4.50.`);
            return {...p,price:Number(p.price).toFixed(2)};
        });
}
formHandlers['editor-form']=async(d,form)=>{
    // A mistake in the form (400) only shows a message: the usual error path redraws the page and would wipe what was typed
    try{await saveStorefront(d,form)}catch(err){if(err.status===400){toast(err.message);return}throw err}
};
async function saveStorefront(d,form){
    if(d.website&&!/^https?:\/\//.test(d.website))throw new GroveAPI.ApiError(400,'Please use an http or https website address.');
    const products=readProducts(form);
    if(d.imageUrl&&!/^https?:\/\//.test(d.imageUrl))throw new GroveAPI.ApiError(400,'Please paste a photo link that starts with http or https.');
    // Public email and phone moved to Settings (27 Oct)
    const {business}=await GroveAPI.updateBusiness({name:d.name,description:d.description||'',
        website:d.website||'',websiteLabel:d.websiteLabel||'',imageUrl:d.imageUrl||'',businessType:d.businessType==='service'?'service':'product',...schedPayload(),products,
        address:d.address,postalCode:String(d.postalCode||'').trim()});
    upsertBusiness(business);await loadDashboard();renderPage();
    toast('Your storefront is updated');
}

/* Storefront (23 Oct): contact details in the dark green top, a Menu (or Services) button that lists what the
   business sells, and the actions together in the box below, by type of business:
   - product: Place an order (while open, to collect today) and Log a visit (any time);
   - service: Book an appointment, and Log a visit once a confirmed appointment has started.
   Visited in an older chain: no cash back, as in the chain. */
function menuTable(sold){
    const prices=sold.some(p=>p.price!=null);
    return `<table class="plain-table menu-table"><thead><tr><th>Name</th><th>Description</th>${prices?'<th class="num">Price</th>':''}</tr></thead><tbody>${sold.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.description||'')}</td>${prices?`<td class="num">${p.price!=null?money(p.price):''}</td>`:''}</tr>`).join('')}</tbody></table>`;
}
// The customer's confirmed booking here that's due to be logged: started (service) or today (product), not logged yet
function storeDueBooking(id){
    const now=`${localDate()} ${bkNowHHMM()}`;
    return state.appointments.filter(a=>a.mine&&a.businessId===id&&a.status==='Confirmed'&&!a.visitLogged)
        .filter(bkCanLog)   // 29 Oct: any day
        .sort((x,y)=>`${y.date}${y.time}`.localeCompare(`${x.date}${x.time}`))[0]||null;
}
function storeActions(id){
    const b=business(id),service=bkType(b)==='service',hours=bkHasHours(b),open=bkOpenStatus(b),due=storeDueBooking(id);
    // One button (23 Oct): Book appointment (service) or Place an order (product). Logging a due booking is a text link.
    const log=due?` <a href="#" data-backend="log-visit" data-appt="${esc(due.appointmentId)}">${service?'Done? Log your visit':'Collected it? Log your visit'}</a>`:'';
    let main,hint;
    if(service){
        main=hours?`<button class="btn" data-action="book" data-id="${id}">Book appointment</button>`:'<button class="btn" disabled>Not taking bookings yet</button>';
        const next=state.appointments.filter(a=>a.mine&&a.businessId===id&&['Pending','Confirmed'].includes(a.status)&&!a.visitLogged&&`${a.date} ${a.time}`>`${localDate()} ${bkNowHHMM()}`).sort((x,y)=>`${x.date}${x.time}`.localeCompare(`${y.date}${y.time}`))[0];
        hint=due?`Your appointment is on ${bkWhen(due)}. Log your visit when you’re done.`
            :next?`Your appointment on ${bkWhen(next)} is waiting for the business to confirm.`:'Book an appointment first, then log your visit.';
    }else{
        const can=hours&&open.open&&bkPickupTimes(b).length;
        main=can?`<button class="btn" data-store="order" data-id="${id}">Place an order</button>`:'<button class="btn" disabled>Place an order</button>';
        hint=can?'Order now and collect it from their home today. They’ll know when you’re coming.'
            :hours?`Closed right now${open.detail?' · '+open.detail:''}. You can order while they’re open.`:'Not taking orders yet.';
    }
    return {main,hint:hint+log};
}
const storefrontMarkupBeforeRecs=storefrontMarkup;
storefrontMarkup=function(id,preview=false){
    const b=business(id),t=document.createElement('template');t.innerHTML=storefrontMarkupBeforeRecs(id,preview);
    t.content.querySelector('.store-hero h1 > span')?.remove();   // no "." after the name (27 Oct)
    const src=preview?{...b,...state.business}:b,sold=recSold(src),service=bkType(src)==='service';
    // Top: contact details, then Menu / Services (in the owner's preview the list shows on the page instead)
    const hero=t.content.querySelector('.store-hero > div');
    hero?.querySelector('.modal-actions')?.remove();
    const contact=[src.phone?`<a href="tel:${esc(String(src.phone).replace(/\s+/g,''))}">${esc(src.phone)}</a>`:'',src.email?`<a href="mailto:${esc(src.email)}">${esc(src.email)}</a>`:'',
        src.website?`<a href="${safeUrl(src.website)}" target="_blank" rel="noopener noreferrer">${esc(src.websiteLabel||business(id)?.websiteLabel||'Website')}</a>`:''].filter(Boolean);
    const at=hero?.querySelector('.store-hours')||hero?.querySelector('.store-meta');
    at?.insertAdjacentHTML('afterend',(contact.length?`<div class="store-contact">${contact.join('')}</div>`:'')
        +(sold.length&&!preview?`<div class="store-hero-actions"><button class="btn soft" data-store="menu" data-id="${id}">${service?'Services':'Menu'}</button></div>`:''));
    // Below: no note; the actions sit together
    const bottom=t.content.querySelector('.store-bottom');
    bottom?.querySelector(':scope > div:not(.store-chain)')?.remove();
    bottom?.classList.add('single');
    if(preview&&sold.length)t.content.querySelector('.store-body')?.insertAdjacentHTML('afterbegin',`<section class="store-menu"><h3>${service?'Services':'Menu'}</h3>${menuTable(sold)}</section>`);
    const box=t.content.querySelector('.store-chain');
    if(box&&!preview){
        const {main,hint}=storeActions(id),been=state.chain.includes(id)||recBeen(id);
        box.querySelector('.btn')?.remove();box.querySelector('p.subtle')?.remove();
        if(been)box.querySelector('h3').textContent='Welcome back.';
        box.insertAdjacentHTML('beforeend',`<div class="store-actions">${main}</div><p class="subtle">${hint}${been?` You’ve been here before, so this visit doesn’t earn cash back. Each new business earns ${money(CHAIN_CASHBACK)}.`:''}</p>`);
    }
    return t.innerHTML;
};
function storeMenu(id){
    const b=business(id),service=bkType(b)==='service',{main}=storeActions(id);
    showModal(`<div class="modal-body store-menu-modal"><div class="eyebrow">${esc(b.name).toUpperCase()}</div><h2>${service?'Services':'Menu'}</h2>${menuTable(recSold(b))}<div class="modal-actions">${main}</div></div>`);
}
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-store]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const id=Number(el.dataset.id);
    if(el.dataset.store==='menu')storeMenu(id);
    if(el.dataset.store==='order')bkOrder(id);
},true);

/* ---------------------------------------------------------------- Final round (27 Oct)
   - Home → Your booked visits: the business name opens its storefront; "Log this visit" sits on the right
     (only once it can be logged: an order today, or an appointment that has started).
   - Scanning a business's QR code (the link has its businessId, in-app links use a number) with an order or a
     confirmed appointment there today opens it straight away with a Pay button.
   - After signing up, "Tell us a little about you" asks for gender and age (Update_User). Businesses
     only ever see these as totals on Insights. Editable later in Settings → Your details.
   - Insights (owner) uses real data from GET /business/dashboard → insights: who the customers are, popular
     products, and chain neighbours: which businesses customers visit just before and just after this one. */
const ABOUT_GENDERS=['Male','Female'];   // Male and Female only (27 Oct)
const applyMeBeforeAbout=applyMe;
applyMe=function(me){applyMeBeforeAbout(me);state.profile.gender=me.user?.gender||'';state.profile.ageGroup=me.user?.ageGroup||'';state.profile.age=me.user?.age!=null?Number(me.user.age):null};
const applyDashboardBeforeInsights=applyDashboard;
applyDashboard=function(d){applyDashboardBeforeInsights(d);state.insights=d.insights||null};

myVisitsSection=function(){
    const list=state.appointments.filter(a=>a.mine&&(a.status==='Confirmed'||(a.status==='Completed'&&!a.visitLogged))).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
    if(!list.length)return '';
    const today=localDate();
    return `<section class="panel my-visits" style="margin:24px 0"><div class="section-title" style="margin-top:0"><div><h2>Your booked visits</h2><p>Tap a business to open its storefront.</p></div><span class="pill">${list.length} booked</span></div>${list.map(a=>{
        const name=a.businessName||business(a.businessId)?.name||'Business',can=bkCanLog(a);
        return `<div class="list-row my-visit"><div><a class="my-visit-name" href="#/customer/store/${a.businessId}">${esc(name)}</a><p>${a.type==='pickup'?'Order to collect · ':''}${esc(a.service)} · ${date(a.date)} · ${bkAmPm(a.time)}${a.businessAddress?` · ${esc(a.businessAddress)}`:''}</p></div><div class="my-visit-side">${can?`<button type="button" class="btn small" data-backend="log-visit" data-appt="${esc(a.appointmentId)}">Log this visit</button>`:`<span class="pill">${a.date===today?'Today':a.date<today?'Not logged yet':'Upcoming'}</span>`}</div></div>`;
    }).join('')}</section>`;
};

// QR scan: open what you booked here today, ready to pay
let scanPrompted='';
function scanPrompt(){
    const m=location.hash.match(/^#\/customer\/store\/([^/?#]+)/);
    if(!m){scanPrompted='';return}
    if(/^\d+$/.test(m[1])||scanPrompted===location.hash||authStatus!=='signed-in'||$('#modal').open)return;
    const num=selectedBusinessId,b=business(num),today=localDate();if(!b)return;
    const a=state.appointments.filter(x=>x.mine&&x.businessId===num&&x.status==='Confirmed'&&!x.visitLogged&&x.date===today)
        .sort((x,y)=>x.time.localeCompare(y.time))[0];
    if(!a)return;   // nothing booked here today (or not loaded yet: try again on the next render)
    scanPrompted=location.hash;
    if(!bkCanLog(a)){
        showModal(`<div class="modal-body"><div class="eyebrow">YOUR APPOINTMENT</div><h2>${esc(b.name)}</h2><p>${esc(a.service)} · today at ${bkAmPm(a.time)}</p><p class="muted">You can pay here once your appointment starts.</p><div class="modal-actions"><button class="btn" data-store-close>OK</button></div></div>`);
        return;
    }
    openVisitLog(num,a);
    const eyebrow=$('#modal .eyebrow');if(eyebrow)eyebrow.textContent=a.type==='pickup'?'YOUR ORDER':'YOUR APPOINTMENT';
    const pay=$('#visit-log-form > button.btn');if(pay)pay.textContent='Pay';
    const legend=$('#visit-log-form .order-field legend');if(legend)legend.textContent='Your order';
}
document.addEventListener('click',e=>{if(e.target.closest('[data-store-close]'))closeModal()});

// Tell us a little about you (after sign-up, and in Settings)
let aboutPending=false;
const signupBeforeAbout=GroveAPI.signup;
GroveAPI.signup=async body=>{const res=await signupBeforeAbout(body);aboutPending=true;return res};
// Gender and age (a number since 27 Oct pm; Insights groups ages into the usual buckets)
function aboutFields(p=state.profile){
    return `<div class="form-grid"><div class="field"><label for="about-gender">Gender</label><select id="about-gender" name="about-gender"><option value="">Choose…</option>${ABOUT_GENDERS.map(o=>`<option ${o===p.gender?'selected':''}>${o}</option>`).join('')}</select></div><div class="field"><label for="about-age">Age</label><input id="about-age" name="about-age" type="number" inputmode="numeric" min="5" max="120" step="1" value="${p.age??''}"></div></div>`;
}
function aboutBody(d){
    const body={};
    if(d['about-gender'])body.gender=d['about-gender'];
    if(String(d['about-age']??'').trim()!=='')body.age=Number(d['about-age']);
    return body;
}
function aboutPrompt(){
    aboutPending=false;
    showModal(`<div class="modal-body"><div class="eyebrow">ONE LAST THING</div><h2>Tell us a little about you</h2><p class="muted">It helps the businesses you visit understand who their customers are.</p><form id="about-form" data-prompt="1">${aboutFields()}<div class="modal-actions"><button class="btn">Save</button><button type="button" class="btn secondary" data-store-close>Skip for now</button></div></form></div>`);
}
formHandlers['about-form']=async(d,form)=>{
    const body=aboutBody(d);
    if(!Object.keys(body).length){closeModal();return}
    await GroveAPI.updateMe(body);await loadMe();closeModal();
    if(!form.dataset.prompt)renderPage();
    toast('Thanks! Saved.');
};
const settingsBeforeAbout=settings;
settings=function(){
    const html=settingsBeforeAbout();
    // About you sits inside "Your details" (27 Oct): one form, one Save. Owners get the same page, with the
    // storefront's public email and phone on the right instead of interests.
    const t=document.createElement('template');t.innerHTML=html;
    t.content.querySelector('#settings-v2 > button.btn')?.insertAdjacentHTML('beforebegin',`<div class="about-you">${aboutFields()}</div>`);
    if(mode==='owner'){
        const pub=business(myBusinessNum())||state.business;
        const right=t.content.querySelector('.grid2 > section.panel');
        if(right)right.outerHTML=`<form class="panel" id="business-contact-form"><h2>Business contact</h2><p class="muted">Shown on your storefront. It starts as your own email and phone, and can be different.</p><div class="field"><label for="public-email">Public email</label><input id="public-email" name="email" type="email" value="${esc(pub.email||'')}" required></div><div class="field"><label for="public-phone">Public phone number <span class="muted">(optional)</span></label><input id="public-phone" name="phone" type="tel" value="${esc(pub.phone||'')}"></div><button class="btn">Save business contact</button></form>`;
    }
    return t.innerHTML;
};
formHandlers['settings-v2']=async d=>{
    const body={name:d.name,phone:d.phone||'',...aboutBody(d)};
    if(!body.age&&state.profile.age!=null&&String(d['about-age']??'').trim()==='')body.age=null;   // cleared
    await GroveAPI.updateMe(body);await loadMe();shell();toast('Your changes are saved');
};

const renderBeforeFinal=renderPage;
renderPage=function(){
    renderBeforeFinal();
    if(authStatus!=='signed-in'||['landing','login','signup'].includes(route))return;
    if(aboutPending&&mode==='customer'&&!$('#modal').open){aboutPrompt();return}
    scanPrompt();
};

// Insights: real customers, products and chain neighbours. The timeframe picker asks the dashboard for that window.
const INSIGHT_RANGES=[[30,'Last month'],[90,'Last 3 months'],[180,'Last 6 months'],[365,'Last year'],[0,'All time']];
let insightRange=180;
const getDashboardBeforeRange=GroveAPI.getDashboard;
GroveAPI.getDashboard=days=>getDashboardBeforeRange(days??insightRange);
document.addEventListener('change',e=>{
    if(e.target.id!=='insight-range')return;
    insightRange=Number(e.target.value);
    once('insight-range',async()=>{await loadDashboard();renderPage()});
});
insights=function(){
    const i=state.insights;
    const picker=`<label class="insight-range"><span class="sr-only">Timeframe</span><select id="insight-range">${INSIGHT_RANGES.map(([d,l])=>`<option value="${d}" ${d===insightRange?'selected':''}>${l}</option>`).join('')}</select></label>`;
    const head=heading('Get to know your customers.','',picker);
    if(!i)return head+'<div class="empty"><p>Your insights will show here once customers start logging visits.</p></div>';
    const total=Number(i.customers)||0,list=rows=>rows.map(([l,c])=>[l,Number(c)]);
    const when=INSIGHT_RANGES.find(([d])=>d===Number(i.days))?.[1]||`Last ${i.days} days`;
    const listed=r=>businesses.some(b=>b.businessId===r.businessId);
    const nb=(rows,empty)=>{rows=rows.filter(listed);return rows.length?rows.map(r=>`<div class="neighbour-row"><div><strong>${esc(r.name)}</strong><small>${esc(r.category||'')}</small></div><span class="pill">${r.customers} ${Number(r.customers)===1?'customer':'customers'}</span><button type="button" class="text-btn" data-neighbour="${bizNum(r.businessId)}">View storefront</button></div>`).join(''):`<p class="muted">${empty}</p>`};
    return head+`<div class="stats">${stat('Customers',total,when)}${stat('Visits logged',i.visits,when)}${stat('Came back',total?Math.round(i.repeatCustomers/total*100)+'%':'—',`${i.repeatCustomers} of ${total} visited more than once`)}${stat('Spent with you',money(Number(i.spent)||0),'From logged visits')}</div>
    <div class="insights-layout"><div class="insights-left">
        <section class="panel"><h2>Gender</h2>${bars(list(i.genders),total)}</section>
        <section class="panel"><h2>Age Groups</h2>${bars(list(i.ages),total)}</section>
        <section class="panel"><h2>Popular Products</h2>${i.products.length?i.products.map(([n,q],k)=>`<div class="product-ranking"><span>0${k+1}</span><div><strong>${esc(n)}</strong><p>${q} sold</p></div></div>`).join(''):'<p class="muted">Products show here once customers tick what they bought when logging a visit.</p>'}</section>
    </div><section class="panel chain-neighbours"><h2>Business Neighbours</h2>
        <h3>Where they come from</h3>${nb(i.cameFrom,'No one has come to you from another business yet.')}
        <h3>Where they go next</h3>${nb(i.wentTo,'No one has gone on to another business yet.')}
    </section></div>`;
};

// Insights → chain neighbours: their storefront opens in a popup, staying in the business studio
function neighbourStore(num){
    const b=business(num);if(!b)return;
    showModal(`<div class="preview-heading"><span class="pill">${esc(b.name).toUpperCase()}</span><p>A business your customers also visit. You’re still in your business studio.</p></div>${storefrontMarkup(num)}`);
    const m=$('#modal');m.classList.add('wide-modal');
    m.querySelector('.store-hero-actions')?.remove();m.querySelector('.store-bottom')?.remove();
    m.querySelector('.store-reviews [data-review]')?.remove();
    const sold=recSold(b);
    if(sold.length)m.querySelector('.store-body')?.insertAdjacentHTML('afterbegin',`<section class="store-menu"><h3>${bkType(b)==='service'?'Services':'Menu'}</h3>${menuTable(sold)}</section>`);
}
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-neighbour]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();neighbourStore(Number(el.dataset.neighbour));
},true);

/* ---------------------------------------------------------------- 27 Oct: reviews, link text, photo links
   - Reviews: one per customer per business, editable (PATCH /me {"review"} → Update_User). The business keeps
     them as reviewList; each has "by" (a key, not the userId) and the site knows its own as state.reviewKey.
   - My storefront: "Link text" for the website, and "Photo link" (an image address) instead of a random photo.
     Public email and phone moved to Settings → Business contact. */
const toUiBusinessBeforeReviews=toUiBusiness;
toUiBusiness=function(r){const ui=toUiBusinessBeforeReviews(r);ui.websiteLabel=r.websiteLabel||'';ui.imageUrl=r.imageUrl||'';ui.reviewList=Array.isArray(r.reviewList)?r.reviewList:[];return ui};
const applyMeBeforeReviews=applyMe;
applyMe=function(me){applyMeBeforeReviews(me);state.reviewKey=me.user?.reviewKey||''};
formHandlers['business-contact-form']=async d=>{
    const {business}=await GroveAPI.updateBusiness({email:d.email,phone:d.phone||''});
    upsertBusiness(business);await loadDashboard();renderPage();toast('Your business contact is saved');
};
const editorBeforeLinks=editor;
editor=function(){
    const t=document.createElement('template');t.innerHTML=editorBeforeLinks();
    const b=business(myBusinessNum())||{};
    t.content.querySelector('#editor-form #phone')?.closest('.form-grid')?.remove();
    t.content.querySelector('#editor-form #website')?.closest('.field')?.insertAdjacentHTML('afterend',
        `<div class="field"><label for="websiteLabel">Link text <span class="muted">(optional, shown instead of “Website”)</span></label><input id="websiteLabel" name="websiteLabel" maxlength="40" value="${esc(b.websiteLabel||'')}" placeholder="e.g. Order on Instagram"></div>`
        +`<div class="field"><label for="imageUrl">Photo link <span class="muted">(optional)</span></label><input id="imageUrl" name="imageUrl" type="url" value="${esc(b.imageUrl||'')}" placeholder="https://…/photo.jpg"><small class="muted">Paste the address of a photo that’s online (right-click a photo → Copy image address). Leave empty for a stock photo.</small></div>`);
    return t.innerHTML;
};
const stars=n=>'★'.repeat(n)+'☆'.repeat(5-n);
function reviewsSection(id){
    const b=business(id),list=b.reviewList||[],mine=list.find(r=>r.by&&r.by===state.reviewKey),own=state.isBusiness&&b.businessId===state.business.businessId;
    const avg=list.length?(list.reduce((s,r)=>s+Number(r.rating),0)/list.length).toFixed(1):null;
    return `<section class="store-reviews"><div class="section-title"><div><h2>Reviews</h2><p>${avg?`★ ${avg} · ${list.length} ${list.length===1?'review':'reviews'}`:'No reviews yet.'}</p></div>${own?'':`<button type="button" class="btn secondary small" data-review="${id}">${mine?'Edit your review':'Write a review'}</button>`}</div>
        ${list.map(r=>`<article class="review ${r===mine?'mine':''}"><div><span class="review-stars" aria-label="${r.rating} out of 5 stars">${stars(Number(r.rating))}</span> <strong>${esc(r.name)}</strong>${r===mine?' <span class="pill">You</span>':''}<small>${date(String(r.at).slice(0,10))}${r.edited?' · edited':''}</small></div>${r.text?`<p>${esc(r.text)}</p>`:''}</article>`).join('')}</section>`;
}
function reviewForm(id){
    const b=business(id),mine=(b.reviewList||[]).find(r=>r.by&&r.by===state.reviewKey),cur=Number(mine?.rating)||0;
    showModal(`<div class="modal-body"><div class="eyebrow">${mine?'EDIT YOUR REVIEW':'WRITE A REVIEW'}</div><h2>${esc(b.name)}</h2><form id="review-form" data-id="${id}"><fieldset class="star-pick"><legend>Your rating</legend>${[1,2,3,4,5].map(n=>`<label><input type="radio" name="rating" value="${n}" ${n===cur?'checked':''} required><span aria-hidden="true">★</span><span class="sr-only">${n} star${n>1?'s':''}</span></label>`).join('')}</fieldset><div class="field"><label for="review-text">Your review <span class="muted">(optional)</span></label><textarea id="review-text" name="text" maxlength="500" placeholder="What did you like?">${esc(mine?.text||'')}</textarea></div><p class="subtle">You can leave one review per business, and edit it any time.</p><button class="btn full">${mine?'Save review':'Post review'}</button></form></div>`);
}
formHandlers['review-form']=async(d,form)=>{
    const id=Number(form.dataset.id),b=business(id);
    if(!d.rating)throw new GroveAPI.ApiError(400,'Please pick 1 to 5 stars.');
    const res=await GroveAPI.updateMe({review:{businessId:b.businessId,rating:Number(d.rating),text:d.text||''}});
    if(res.business)upsertBusiness(res.business);
    closeModal();renderPage();toast('Thanks for your review!');
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-review]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();reviewForm(Number(el.dataset.review));
},true);
const storefrontBeforeReviews=storefrontMarkup;
storefrontMarkup=function(id,preview=false){
    const html=storefrontBeforeReviews(id,preview);
    const t=document.createElement('template');t.innerHTML=html;
    // "★ 4.5 · 2 reviews" from the real reviews (older listings keep their own numbers)
    const b=business(id),list=b?.reviewList||[],meta=[...t.content.querySelectorAll('.store-meta span')].find(x=>x.textContent.startsWith('★'));
    const n=list.length||Number(b?.reviews)||0,avg=list.length?(list.reduce((a,r)=>a+Number(r.rating),0)/list.length).toFixed(1):(isNaN(Number(b?.rating))?null:Number(b.rating).toFixed(1));
    if(meta)meta.textContent=n&&avg?`★ ${avg} · ${n} ${n===1?'review':'reviews'}`:'★ New · no reviews yet';
    if(preview)return t.innerHTML;
    t.content.querySelector('.store-body')?.insertAdjacentHTML('beforeend',reviewsSection(id));
    return t.innerHTML;
};

/* Business type and an empty menu (27 Oct)
   - Registering a business asks Product or Service (New_HBB needs businessType).
   - A business with nothing on its menu takes no orders or bookings (New_Appointment refuses them too),
     and My storefront tells the owner to add a product or service. */
const businessPageBeforeType=businessPage;
businessPage=function(){
    const html=businessPageBeforeType();if(state.isBusiness)return html;
    const t=document.createElement('template');t.innerHTML=html;
    t.content.querySelector('#business-signup #business-category')?.closest('.field')?.insertAdjacentHTML('afterend',
        `<fieldset class="field type-pick"><legend>What do you offer?</legend>`
        +`<label><input type="radio" name="businessType" value="product" required><span><b>Products</b><small>Customers order and collect from you</small></span></label>`
        +`<label><input type="radio" name="businessType" value="service" required><span><b>Services</b><small>Customers book an appointment</small></span></label></fieldset>`);
    return t.innerHTML;
};
formHandlers['business-signup']=async d=>{
    if(!['product','service'].includes(d.businessType))throw new GroveAPI.ApiError(400,'Please choose Products or Services.');
    const {business}=await GroveAPI.createBusiness({name:d.name,category:d.category,businessType:d.businessType,address:d.address,postalCode:String(d.postalCode||'').trim()});
    upsertBusiness(business);
    await loadAccount();
    location.hash='/customer/settings';
    toast(`Your business is registered. Open your business studio from Settings, then add your ${d.businessType==='service'?'services':'products'} in My storefront.`);celebrate();
};
const sellsNothing=b=>!recSold(b).length;
const storeActionsBeforeEmpty=storeActions;
storeActions=function(id){
    const b=business(id);if(!sellsNothing(b))return storeActionsBeforeEmpty(id);
    const service=bkType(b)==='service',{hint}=storeActionsBeforeEmpty(id),log=hint.match(/ <a [\s\S]*$/)?.[0]||'';
    return {main:`<button class="btn" disabled>${service?'Not taking bookings yet':'Not taking orders yet'}</button>`,
        hint:`${esc(b.name)} hasn’t added any ${service?'services':'products'} yet.`+log};
};
const bookingBeforeEmpty=booking;
booking=function(id){
    const b=business(id);
    if(b?.businessId&&sellsNothing(b)){toast(`${b.name} hasn’t added any ${bkType(b)==='service'?'services':'products'} yet.`);return}
    return bookingBeforeEmpty(id);
};
const bkOrderBeforeEmpty=bkOrder;
bkOrder=function(id){
    const b=business(id);
    if(sellsNothing(b)){toast(`${b.name} hasn’t added any products yet.`);return}
    return bkOrderBeforeEmpty(id);
};
const editorBeforeEmpty=editor;
editor=function(){
    const html=editorBeforeEmpty();if(!sellsNothing(state.business))return html;
    const service=bkType(state.business)==='service';
    const t=document.createElement('template');t.innerHTML=html;
    const alert=`<div class="empty-menu-alert" role="alert"><strong>Customers can’t ${service?'book you':'order from you'} yet.</strong> Add at least one ${service?'service':'product'} with a price to your Menu below, then click Save storefront.</div>`;
    const form=t.content.querySelector('#editor-form'),box=form?.closest('.grid2')||form;
    if(box)box.insertAdjacentHTML('beforebegin',alert);else t.content.prepend(document.createRange().createContextualFragment(alert));
    return t.innerHTML;
};

/* Empty menu, part 2 (27 Oct): a red 1 on My storefront in the sidebar, the same note at the top of Overview,
   and My storefront can't be saved without at least one product or service (Update_HBB refuses it too). */
const emptyMenuNote=()=>{
    const service=bkType(state.business)==='service';
    return `<div class="empty-menu-alert" role="alert"><strong>Customers can’t ${service?'book you':'order from you'} yet.</strong> Add at least one ${service?'service':'product'} with a price to your Menu in <a href="#/owner/editor">My storefront</a>, then click Save storefront.</div>`;
};
const ownerMenuEmpty=()=>state.isBusiness&&!!state.business?.businessId&&sellsNothing(state.business);
const dashboardBeforeEmpty=dashboard;
dashboard=function(){
    const html=dashboardBeforeEmpty();if(!ownerMenuEmpty())return html;
    const t=document.createElement('template');t.innerHTML=html;
    const head=t.content.querySelector('.page-heading');
    if(head)head.insertAdjacentHTML('afterend',emptyMenuNote());else t.content.prepend(document.createRange().createContextualFragment(emptyMenuNote()));
    return t.innerHTML;
};
const bkPaintBadgesBeforeEmpty=bkPaintBadges;
bkPaintBadges=function(){
    bkPaintBadgesBeforeEmpty();
    document.querySelectorAll('.menu-badge').forEach(el=>el.remove());
    if(authStatus!=='signed-in'||!groveReady||!ownerMenuEmpty())return;
    document.querySelectorAll('.nav a[href="#/owner/editor"]').forEach(a=>a.insertAdjacentHTML('beforeend','<span class="menu-badge" aria-label="1 thing to do: add a product or service">1</span>'));
};
const saveStorefrontBeforeEmpty=saveStorefront;
saveStorefront=async function(d,form){
    if(!readProducts(form).length)throw new GroveAPI.ApiError(400,`Add at least one ${d.businessType==='service'?'service':'product'} to your Menu before saving.`);
    return saveStorefrontBeforeEmpty(d,form);
};

/* 28 Oct
   1. Owner's "+ New appointment" follows the business type, like customer bookings: a service business picks a
      free 30-minute slot on its own week; a product business picks a pickup time later today. No "Booking type"
      box, and the service / order is ticked from the business's own Menu.
   2. Once logged in there is no front page: the logo and #/landing go to Home (or Overview in the business studio).
   3. Discover: tapping a pin shows that business in the right-hand column instead of a popup on the map.
   4. Visit logged: the receipt sits in the middle of its column. */
function ownerApptPeople(){
    const people=new Map();
    state.customers.forEach(c=>{if(c.name&&!people.has(c.name))people.set(c.name,c.userId||'')});
    state.appointments.filter(a=>a.atMyBusiness&&a.name).forEach(a=>{if(!people.has(a.name)||(!people.get(a.name)&&a.customerUserId))people.set(a.name,a.customerUserId||'')});
    return people;
}
function ownerApptCustomerField(people,value=''){
    const names=[...people.keys()].sort((a,b)=>a.localeCompare(b));
    return `<div class="field"><label for="name">Customer</label><input id="name" name="name" list="past-customers" autocomplete="off" required value="${esc(value)}" placeholder="${names.length?'Start typing a name…':'Customer name'}"><datalist id="past-customers">${names.map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist><small class="muted">Past customers with an account get it as a request to confirm. Anyone else is booked straight away.</small></div>`;
}
openAppointmentForm=function(){
    const b=state.business,people=ownerApptPeople(),priced=recPriced(b);
    if(!priced.length){toast(`Add your ${bkType(b)==='service'?'services':'products'} in My storefront first.`);return}
    if(bkType(b)==='product'){
        const times=bkPickupTimes(b);
        showModal(`<div class="modal-body bk-order"><div class="eyebrow">ORDER TO COLLECT</div><h2>New order</h2><p class="muted">${times.length?'For collecting later today, like orders from your storefront.':'You’re closed for the rest of today. Orders are for collecting today, within your opening hours.'}</p>
            <form id="owner-order-form" data-raw>${ownerApptCustomerField(people)}<fieldset class="order-field"><legend>What are they getting?</legend>${orderTable(priced,{},'Estimated total')}</fieldset>
            <div class="field"><label for="order-time">Collect at</label><select id="order-time" name="time" ${times.length?'':'disabled'}>${times.map(t=>`<option value="${t}">${bkAmPm(t)}</option>`).join('')||'<option>Closed</option>'}</select></div>
            <button class="btn full" ${times.length?'':'disabled'}>Add order</button></form></div>`);
        $('#owner-order-form').dataset.people=JSON.stringify(Object.fromEntries(people));
        orderRecalc($('#owner-order-form'));$('#name')?.focus();return;
    }
    const start=selectedDate>localDate()?selectedDate:localDate();
    bkDraft={owner:true,num:myBusinessNum(),businessId:b.businessId,schedule:bkOwnSchedule(),start,selected:null,lines:{},name:'',people};
    paintBookingModal(true);
};
const paintBookingModalBeforeOwner=paintBookingModal;
paintBookingModal=function(first=false){
    if(!bkDraft?.owner)return paintBookingModalBeforeOwner(first);
    const sel=bkDraft.selected,form=$('#owner-appt-form');
    if(form){bkDraft.name=form.querySelector('#name')?.value||'';bkDraft.lines=Object.fromEntries(readOrder(form,false).map(l=>[l.name,l.quantity]))}
    const html=`<div class="modal-body bk-book"><section class="bk-book-schedule"><div class="eyebrow">YOUR SCHEDULE</div><h2>Pick a free 30-minute slot</h2><p class="muted">Open ${esc(bkHoursText(state.business))}. Your other appointments show as “Booked”.</p><div id="bk-grid">${bkWeekGrid(bkDraft.schedule,bkDraft.start,sel)}</div></section>
        <section class="bk-book-form"><div class="eyebrow">NEW APPOINTMENT</div><h2>Add an appointment</h2>
        <form id="owner-appt-form" data-raw>${ownerApptCustomerField(bkDraft.people,bkDraft.name)}
            <fieldset class="order-field"><legend>Which service?</legend>${orderTable(recPriced(state.business),bkDraft.lines,'Estimated total','Service')}</fieldset>
            <div class="field"><label>Date &amp; time</label><div class="bk-chosen ${sel?'':'empty'}">${sel?`${bkWhen(sel)} <small>· 30 min</small>`:'Pick a free slot on the schedule'}</div></div>
            <button class="btn full" ${sel?'':'disabled'}>Add appointment</button>
        </form></section></div>`;
    if(first||!$('#modal').open){if($('#modal').open)$('#modal').close();showModal(html)}
    else{$('#modal .modal-body').outerHTML=html;polishCopy()}
    $('#modal').classList.add('bk-modal');
    orderRecalc($('#owner-appt-form'));
};
async function ownerApptSave(d,form,extra,done){
    const people=JSON.parse(form.dataset.people||'{}'),name=String(d.name||'').trim(),customerUserId=people[name]||'';
    const lines=readOrder(form);if(!lines.length)throw new GroveAPI.ApiError(400,`Tick at least one ${bkType(state.business)==='service'?'service':'product'}.`);
    const {appointment}=await GroveAPI.bookAppointment({customerName:name,lines,...extra,...(customerUserId?{customerUserId}:{})});
    bkReplace(appointment);bkDraft=null;moveCalendarTo(appointment.date);closeModal();await loadDashboard();renderPage();
    toast(customerUserId?`Sent to ${name} · it’s confirmed once they accept`:done);
}
formHandlers['owner-appt-form']=async(d,form)=>{
    if(!bkDraft?.selected)throw new GroveAPI.ApiError(400,'Pick a free slot on the schedule first.');
    form.dataset.people=JSON.stringify(Object.fromEntries(bkDraft.people));
    await ownerApptSave(d,form,{type:'visit',date:bkDraft.selected.date,time:bkDraft.selected.time},'Appointment added');
};
formHandlers['owner-order-form']=async(d,form)=>{
    if(!d.time)throw new GroveAPI.ApiError(400,'Pick a time to collect.');
    await ownerApptSave(d,form,{type:'pickup',date:localDate(),time:d.time},`Order added · collect at ${bkAmPm(d.time)}`);
};
// Closing the popup forgets the owner's draft, so a customer booking later starts clean
document.addEventListener('close',e=>{if(e.target.id==='modal'&&bkDraft?.owner)bkDraft=null},true);

let lastSignedInMode='customer';
const shellBeforeNoLanding=shell;
shell=function(){
    const front=route==='landing'||/^#\/business-owner(\/|$)/.test(location.hash);
    if(authStatus==='signed-in'&&front){location.replace(lastSignedInMode==='owner'&&state.isBusiness?'#/owner/dashboard':'#/customer/home');return}
    if(authStatus==='signed-in')lastSignedInMode=mode;
    shellBeforeNoLanding();
};
const logoBeforeSession=logo;
logo=function(light=false){
    const html=logoBeforeSession(light);
    if(authStatus!=='signed-in')return html;
    return html.replace('href="#/landing"',`href="${mode==='owner'?'#/owner/dashboard':'#/customer/home'}"`).replace('aria-label="The Grove homepage"','aria-label="The Grove home"');
};

let mapPickId=null,mapPickSaved=null;
function mapPickPanel(id){
    const b=business(id),s=bkOpenStatus(b),listed=bkHasHours(b),d=distanceTo(id);
    const rating=Number(b.reviews)>0&&!isNaN(Number(b.rating))?`★ ${Number(b.rating).toFixed(1)} · ${b.reviews} ${Number(b.reviews)===1?'review':'reviews'}`:'★ New';
    return `<aside class="rec-rail panel island-results map-pick" aria-label="${esc(b.name)}" aria-live="polite">
        <button type="button" class="text-btn map-pick-back" data-map-pick="back">‹ Back</button>
        <img class="map-pick-photo" src="${imgs[b.image]||imgs.bread}" alt="${esc(b.name)}">
        <small class="map-pick-meta">${esc(b.category)} · ${esc(b.area)}</small>
        <h2>${esc(b.name)}</h2>
        <p class="map-pick-line">${rating}</p>
        <p class="map-pick-line"><span class="hours-status ${listed?(s.open?(s.soon?'soon':'open'):'closed'):'closed'}">${listed?s.label:'Hours not listed'}</span>${listed&&s.detail?` · ${esc(s.detail)}`:''}</p>
        ${b.tag?`<p class="map-pick-tag">${esc(b.tag)}</p>`:''}${b.description?`<p class="map-pick-desc">${esc(b.description)}</p>`:''}
        <p class="map-pick-line muted">${d!=null?`${d<.1?'<0.1':'~'+d.toFixed(1)} km away`:'Tap “Use my location” to see the distance'}</p>
        <div class="map-pick-actions"><button class="btn" data-new="open-store" data-id="${id}">View storefront</button><a class="btn secondary" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(b.area+' Singapore')}" target="_blank" rel="noopener noreferrer">Directions ↗</a></div>
    </aside>`;
}
function showMapPick(id){
    const col=$('.island-results');if(!col)return;
    if(!col.classList.contains('map-pick'))mapPickSaved=col;
    const holder=document.createElement('div');holder.innerHTML=mapPickPanel(id);
    col.replaceWith(holder.firstElementChild);mapPickId=id;
    Object.entries(mapMarkers||{}).forEach(([k,m])=>m.getElement?.()?.classList.toggle('active',Number(k)===id));
    if(innerWidth<=1000)$('.map-pick')?.scrollIntoView({block:'start',behavior:'smooth'});
}
const initMapBeforePick=initMap;
initMap=function(){
    initMapBeforePick();mapPickId=null;mapPickSaved=null;
    Object.entries(mapMarkers||{}).forEach(([k,m])=>{
        const id=Number(k);m.unbindPopup();
        m.on('click',()=>showMapPick(id));
        m.openPopup=()=>{showMapPick(id);return m};   // "Show on map" on a card also shows the details
    });
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-map-pick="back"]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const col=$('.map-pick');if(!col)return;
    if(mapPickSaved)col.replaceWith(mapPickSaved);else renderPage();
    mapPickId=null;Object.values(mapMarkers||{}).forEach(m=>m.getElement?.()?.classList.remove('active'));
},true);

/* 28 Oct: signing up as a business ends in the business studio with a welcome popup;
   owners can shut their business down from Settings (Update_HBB with shutDown). */
formHandlers['business-signup']=async d=>{
    if(!['product','service'].includes(d.businessType))throw new GroveAPI.ApiError(400,'Please choose Products or Services.');
    const {business}=await GroveAPI.createBusiness({name:d.name,category:d.category,businessType:d.businessType,address:d.address,postalCode:String(d.postalCode||'').trim()});
    upsertBusiness(business);
    await loadAccount();
    location.hash='/owner/dashboard';
    const what=d.businessType==='service'?'services':'products';
    setTimeout(()=>{
        showModal(`<div class="modal-body business-welcome">${mascot('welcome-mascot')}<div class="eyebrow">WELCOME TO THE GROVE</div><h2>${esc(business.name)} is ready</h2><p>This is your business studio. Before customers can ${d.businessType==='service'?'book you':'order from you'}, set up two things in <b>My storefront</b>:</p><ol class="welcome-steps"><li>Add your ${what} with prices to your <b>Menu</b>, then click <b>Save storefront</b></li><li>Set your <b>Opening hours</b> on the weekly calendar, then click <b>Save opening hours</b></li></ol><p class="muted">You can switch back to your customer view any time from the bottom of the sidebar.</p><div class="modal-actions"><a class="btn" href="#/owner/editor" data-welcome="go">Set up my storefront</a><button type="button" class="btn secondary" data-welcome="later">Later</button></div></div>`);
        celebrate();
    },150);
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-welcome]');if(!el)return;
    if(el.dataset.welcome==='later')e.preventDefault();
    closeModal();
},true);
const settingsBeforeShutDown=settings;
settings=function(){
    const html=settingsBeforeShutDown();
    if(mode!=='owner'||!state.isBusiness)return html;
    return html+`<section class="panel shut-down-panel"><h2>Shut down your business</h2><p class="muted">Your storefront leaves The Grove for good. Open bookings from today on are cancelled and the customers are told. Your account stays as a customer account, and you can register a business again later.</p><button type="button" class="btn danger-btn" data-shut-down>Shut down ${esc(state.business.name||'my business')}</button></section>`;
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-shut-down]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const name=state.business.name||'';
    showModal(`<div class="modal-body"><div class="eyebrow">THIS CAN’T BE UNDONE</div><h2>Shut down ${esc(name)}?</h2><p>Your storefront, menu, opening hours and reviews are removed, and open bookings from today on are cancelled. Past visits and payments stay in your customers’ history.</p><form id="shut-down-form"><div class="field"><label for="shut-down-name">Type <b>${esc(name)}</b> to confirm</label><input id="shut-down-name" name="confirmName" autocomplete="off" required></div><div class="modal-actions"><button class="btn danger-btn">Shut down for good</button><button type="button" class="btn secondary" data-welcome="later">Keep my business</button></div></form></div>`);
    $('#shut-down-name')?.focus();
},true);
formHandlers['shut-down-form']=async d=>{
    const name=state.business.name||'';
    if(String(d.confirmName||'').trim().toLowerCase()!==name.trim().toLowerCase())throw new GroveAPI.ApiError(400,`Type ${name} exactly to confirm.`);
    await GroveAPI.updateBusiness({shutDown:true,confirmName:d.confirmName});
    closeModal();
    await loadDirectory();await loadAccount();
    location.hash='/customer/home';
    toast(`${name} has been shut down. You’re back in your customer view.`);
};

/* 28 Oct
   - Setting up: the note on Overview and My storefront (and the red number) also asks for opening hours.
   - Log a visit from a booking: the order is as booked and can't be changed (New_Transaction uses it too).
   - Your booked visits: every confirmed visit has a Log this visit button; a service one works from its day.
   - No double bookings for customers: your own bookings elsewhere show as Booked, and pickup times you're
     already booked at are left out (New_Appointment / Update_Appointment refuse them too). */
function ownerTodo(){
    if(!state.isBusiness||!state.business?.businessId)return [];
    const service=bkType(state.business)==='service',todo=[];
    if(sellsNothing(state.business))todo.push(`Add at least one ${service?'service':'product'} with a price to your <b>Menu</b>, then click Save storefront`);
    if(!bkHasHours(state.business))todo.push('Set your <b>Opening hours</b> on the weekly calendar, then click Save opening hours');
    return todo;
}
function setupNote(){
    const todo=ownerTodo();if(!todo.length)return '';
    const service=bkType(state.business)==='service';
    return `<div class="empty-menu-alert" role="alert"><strong>Customers can’t ${service?'book you':'order from you'} yet.</strong> To finish setting up in <a href="#/owner/editor">My storefront</a>:<ul class="setup-steps">${todo.map(t=>`<li>${t}</li>`).join('')}</ul></div>`;
}
const swapSetupNote=(html,place)=>{
    const t=document.createElement('template');t.innerHTML=html;
    t.content.querySelectorAll('.empty-menu-alert').forEach(el=>el.remove());
    const note=setupNote();
    if(note){const at=place(t.content);if(at)at.insertAdjacentHTML('beforebegin',note);else t.content.prepend(document.createRange().createContextualFragment(note))}
    return t.innerHTML;
};
const dashboardBeforeSetup=dashboard;
dashboard=function(){return swapSetupNote(dashboardBeforeSetup(),c=>c.querySelector('.page-heading')?.nextElementSibling)};
const editorBeforeSetup=editor;
editor=function(){return swapSetupNote(editorBeforeSetup(),c=>{const f=c.querySelector('#editor-form');return f?.closest('.grid2')||f})};
bkPaintBadges=function(){
    bkPaintBadgesBeforeEmpty();
    document.querySelectorAll('.menu-badge').forEach(el=>el.remove());
    const n=authStatus==='signed-in'&&groveReady?ownerTodo().length:0;if(!n)return;
    document.querySelectorAll('.nav a[href="#/owner/editor"]').forEach(a=>a.insertAdjacentHTML('beforeend',`<span class="menu-badge" aria-label="${n} ${n===1?'thing':'things'} to set up">${n}</span>`));
};
// Saving opening hours doesn't redraw the page: refresh the note and the number once it's saved
// (mousedown: the opening-hours click handler stops other click listeners)
window.addEventListener('mousedown',e=>{
    if(!e.target.closest('[data-sched="save"]'))return;
    [800,2000].forEach(ms=>setTimeout(()=>{
        bkPaintBadges();const el=$('.empty-menu-alert');if(!el)return;
        const note=setupNote();if(note)el.outerHTML=note;else el.remove();
    },ms));
},true);

const openVisitLogBeforeLock=openVisitLog;
openVisitLog=function(num,appt=null){
    openVisitLogBeforeLock(num,appt);
    if(appt)$('#modal .modal-body > h2 + p.muted')?.remove();   // 30 Oct: no booking line (what, when, address) above the order
    const form=$('#visit-log-form');if(!form||!appt?.lines?.length||!form.querySelector('.order-table'))return;
    form.querySelectorAll('.order-row').forEach(r=>{
        const box=r.querySelector('[data-order-name]');
        if(!box.checked){r.remove();return}
        box.disabled=true;const q=r.querySelector('.order-qty input');q.readOnly=true;q.tabIndex=-1;
    });
    form.classList.add('order-locked');
    const legend=form.querySelector('.order-field legend');if(legend)legend.textContent='Your order';
    orderRecalc(form);
};

myVisitsSection=function(){
    const list=state.appointments.filter(a=>a.mine&&(a.status==='Confirmed'||(a.status==='Completed'&&!a.visitLogged))).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
    if(!list.length)return '';
    return `<section class="panel my-visits" style="margin:24px 0"><div class="section-title" style="margin-top:0"><div><h2>Your booked visits</h2><p>Tap a business to open its storefront.</p></div><span class="pill">${list.length} booked</span></div>${list.map(a=>{
        const name=a.businessName||business(a.businessId)?.name||'Business',can=bkCanLog(a);
        const side=can?`<button type="button" class="btn small" data-backend="log-visit" data-appt="${esc(a.appointmentId)}">Log this visit</button>`
            :a.status==='Confirmed'?`<button type="button" class="btn small" disabled title="You can log it on ${esc(date(a.date))}">Log this visit</button><small class="muted">From ${esc(date(a.date))}</small>`
            :'<span class="pill">Not logged yet</span>';
        return `<div class="list-row my-visit"><div><a class="my-visit-name" href="#/customer/store/${a.businessId}">${esc(name)}</a><p>${a.type==='pickup'?'Order to collect · ':''}${esc(a.service)} · ${date(a.date)} · ${bkAmPm(a.time)}${a.businessAddress?` · ${esc(a.businessAddress)}`:''}</p></div><div class="my-visit-side">${side}</div></div>`;
    }).join('')}</section>`;
};

// The customer's own open bookings at other businesses, as {date, time}
const myBusySlots=exceptBusinessId=>state.appointments.filter(a=>a.mine&&['Pending','Confirmed'].includes(a.status)&&a.businessId!==exceptBusinessId).map(a=>({date:a.date,time:a.time,mine:true}));
const paintBookingModalBeforeBusy=paintBookingModal;
paintBookingModal=function(first=false){
    if(bkDraft&&!bkDraft.owner&&bkDraft.schedule){
        bkDraft.schedule={...bkDraft.schedule,taken:(bkDraft.schedule.taken||[]).filter(x=>!x.mine).concat(myBusySlots(bkDraft.businessId))};
    }
    paintBookingModalBeforeBusy(first);
    if(bkDraft&&!bkDraft.owner){const p=$('.bk-book-schedule > p.muted');if(p&&!p.dataset.busy){p.dataset.busy='1';p.insertAdjacentHTML('beforeend',' Times you’re booked elsewhere show as “Booked” too.')}}
};
// The schedule arrives after the popup opens: merge your own bookings into it as well
const bkScheduleBeforeBusy=bkSchedule;
bkSchedule=async function(businessId,fresh=false){
    const s=await bkScheduleBeforeBusy(businessId,fresh);
    return {...s,taken:(s.taken||[]).filter(x=>!x.mine).concat(myBusySlots(businessId))};
};
const bkOrderBeforeBusy=bkOrder;
bkOrder=function(id){
    const res=bkOrderBeforeBusy(id);
    const sel=$('#order-form #order-time');if(!sel)return res;
    const busy=new Set(myBusySlots(business(id)?.businessId).filter(x=>x.date===localDate()).map(x=>x.time));
    [...sel.options].forEach(o=>{if(busy.has(o.value))o.remove()});
    if(busy.size)sel.closest('.field')?.insertAdjacentHTML('beforeend','<small class="muted">Times you’re booked elsewhere are left out.</small>');
    if(!sel.options.length){sel.innerHTML='<option value="">No free time left today</option>';sel.disabled=true;$('#order-form button.btn')?.setAttribute('disabled','')}
    return res;
};
