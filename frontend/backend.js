/* The Grove × AWS: loads data from API Gateway and sends every change back to it.
   Loaded last. The screens keep reading the same `state` object as before; this file
   fills it from the API instead of from browser storage.

   Route → Lambda map
     POST  /auth/signup                      User_Signup
     POST  /auth/login                       Login
     GET   /businesses                       Get_HBB_Data
     GET   /me                               Get_Customer_Data
     PATCH /me                               Update_User
     POST  /visits                           New_Transaction
     POST  /chain/new                        New_Chain_Session
     POST  /appointments                     New_Appointment
     PATCH /appointments/{id}                Update_Appointment
     POST  /business                         New_HBB
     PATCH /business                         Update_HBB
     GET   /business/dashboard               Get_HBB_Dashboard
     POST  /business/transactions            New_Transaction
     PATCH /business/transactions/{id}       Update_Transaction
*/

/* ---------------------------------------------------------------- reference data */
const AREA_REGION={'Woodlands':'North','Yishun':'North','Sembawang':'North','Tiong Bahru':'South','Queenstown':'West','Bukit Merah':'South','Telok Blangah':'South','Outram':'South','Tampines':'East','Bedok':'East','Pasir Ris':'East','Simei':'East','Jurong East':'West','Clementi':'West','Bukit Batok':'West','Choa Chu Kang':'West','Bishan':'Central','Toa Payoh':'Central','Ang Mo Kio':'Central','Serangoon':'Central'};
const CATEGORY_PHOTO={'Food & Beverage':imgs.bread,'Health & Beauty':imgs.beauty,'Arts & Crafts':imgs.pottery,'Fashion & Accessories':imgs.jewellery};
let groveReady=false,groveLoadError='';
const busy=new Set();

/* ---------------------------------------------------------------- business ids
   The screens use small numeric ids (data-id="3"); the API uses businessId strings.
   Numbers are handed out once per page load, so they stay stable while you browse. */
const bizNumbers=new Map();let nextBizNumber=1;
function bizNum(businessId){if(!bizNumbers.has(businessId))bizNumbers.set(businessId,nextBizNumber++);return bizNumbers.get(businessId)}
function bizIdOf(num){return businesses.find(b=>b.id===num)?.businessId||''}
function myBusinessNum(){return state.business?.businessId?bizNum(state.business.businessId):0}
function storeLink(num=myBusinessNum()){return `${location.origin}${location.pathname}#/customer/store/${encodeURIComponent(bizIdOf(num))}`}
function resolveStoreId(part){if(!part)return 0;if(/^\d+$/.test(part))return Number(part);const id=decodeURIComponent(part);return businesses.some(b=>b.businessId===id)?bizNum(id):0}

function toUiBusiness(r){
    const id=bizNum(r.businessId),key='biz-'+r.businessId;
    imgs[key]=r.imageUrl||CATEGORY_PHOTO[r.category]||imgs.bread;
    const fallback=regionGeo[r.region]||[1.352,103.82];
    const lat=Number(r.lat),lng=Number(r.lng);
    coordinates[id]=Number.isFinite(lat)&&Number.isFinite(lng)&&lat&&lng?[lat,lng]:fallback;
    const [clat,clng]=coordinates[id];
    return {id,businessId:r.businessId,name:r.name||'',category:r.category||'',area:r.area||'',region:r.region||'',
        distance:Math.round(Math.hypot(clat-1.347,clng-103.839)*1110)/10,rating:r.rating??'New',reviews:Number(r.reviews)||0,
        price:Number(r.price)||0,image:key,tag:r.tag||'',description:r.description||'',owner:r.ownerName||'',
        phone:r.phone||'',email:r.email||'',website:r.website||'',accent:r.accent||'#2d6650',note:r.note||'',x:50,y:50};
}
function upsertBusiness(r){const ui=toUiBusiness(r),i=businesses.findIndex(b=>b.businessId===r.businessId);if(i<0)businesses.push(ui);else businesses[i]=ui;return ui}
async function loadDirectory(){
    const list=((await GroveAPI.listBusinesses()).businesses||[]).filter(b=>b&&typeof b.businessId==='string'&&b.businessId);
    list.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))||a.businessId.localeCompare(b.businessId));
    businesses.splice(0,businesses.length,...list.map(toUiBusiness));
}

/* ---------------------------------------------------------------- API -> state */
const known=num=>businesses.some(b=>b.id===num);
function toUiAppointment(a){
    return {id:a.appointmentId,appointmentId:a.appointmentId,name:a.customerName||'',service:a.service||'',date:a.date,time:a.time,
        status:a.status,reminder:!!a.reminder,businessId:bizNum(a.businessId),businessName:a.businessName||'',
        businessAddress:a.businessAddress||'',amountSpent:a.amountSpent!=null?Number(a.amountSpent):null,visitLogged:!!a.visitLogged,
        mine:!!a.customerUserId&&a.customerUserId===state.userId,atMyBusiness:!!state.business?.businessId&&a.businessId===state.business.businessId};
}
function mergeAppointments(list){
    const byId=new Map(state.appointments.map(a=>[a.appointmentId,a]));
    list.forEach(a=>{const ui=toUiAppointment(a);byId.set(ui.appointmentId,{...byId.get(ui.appointmentId),...ui})});
    state.appointments=[...byId.values()];
}
function applyMe(me){
    const u=me.user||{};
    state.userId=u.userId;
    state.profile={name:u.name||'',email:u.email||'',phone:u.phone||'',region:u.region||'Central',interests:u.interests||[],
        reminders:u.reminders!==false,recommendations:u.recommendations!==false};
    state.isBusiness=!!u.isBusiness;
    state.cashbackBalance=Number(u.cashbackBalance)||0;
    if(u.businessId&&state.business.businessId!==u.businessId)state.business={...state.business,businessId:u.businessId};
    state.chain=(me.chain?.businessIds||[]).map(bizNum).filter(known);
    state.visits=(me.visits||[]).map(v=>({business:bizNum(v.businessId),date:v.date,amount:Number(v.amount)||0,cashback:Number(v.cashback)||0,cashbackUsed:Number(v.cashbackUsed)||0})).filter(v=>known(v.business));
    state.appointments=state.appointments.filter(a=>!a.mine);
    mergeAppointments(me.appointments||[]);
    authUser={email:u.email,name:u.name};
}
function applyDashboard(d){
    const b=d.business||{};
    upsertBusiness(b);
    state.business={businessId:b.businessId,name:b.name||'',description:b.description||'',phone:b.phone||'',email:b.email||'',
        website:b.website||'',accent:b.accent||'#2d6650',note:b.note||'',price:Number(b.price)||0,tag:b.tag||'',category:b.category,area:b.area,region:b.region,
        address:b.address||'',postalCode:b.postalCode||''};
    state.transactions=(d.transactions||[]).map(t=>({transactionId:t.transactionId,date:t.date,description:t.description||'',type:t.type,
        amount:Number(t.amount)||0,status:t.status,kind:t.kind,customer:t.customerName||'',product:t.product||'',quantity:Number(t.quantity)||0,createdAt:t.createdAt||''}));
    state.orders=state.transactions.filter(t=>t.kind==='order').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
        .map(t=>({id:t.transactionId,customer:t.customer,product:t.product,quantity:t.quantity,total:t.amount,date:t.date}));
    state.customers=(d.customers||[]).map(c=>({name:c.name,phone:c.phone||'—',email:c.email||'—',visits:Number(c.visits)||0,spent:Number(c.spent)||0,first:c.first,last:c.last,next:c.next}));
    state.appointments=state.appointments.filter(a=>!a.atMyBusiness||a.mine);
    mergeAppointments(d.appointments||[]);
}
async function loadMe(){applyMe(await GroveAPI.getMe())}
async function loadDashboard(){if(state.isBusiness)applyDashboard(await GroveAPI.getDashboard())}
async function loadAccount(){await loadMe();await loadDashboard()}

/* ---------------------------------------------------------------- session */
function blankState(){const s=structuredClone(initial);s.motion=state.motion;return s}
function signOut(message){
    GroveAPI.setToken(null);authStatus='signed-out';authUser=null;state=blankState();accountMenuOpen=false;document.querySelector('#account-menu')?.remove();
    if(message)toast(message);
    location.hash='/login';
}
window.addEventListener('grove:signed-out',()=>{if(authStatus==='signed-in')signOut('Your session has ended. Please log in again.')});

persist=function(){try{localStorage.setItem('grove-prefs',JSON.stringify({motion:state.motion}))}catch{}};

/* ---------------------------------------------------------------- loading + guards */
const renderBeforeBackend=renderPage;
renderPage=function(){
    const content=$('#content');
    if(content&&!groveReady){content.innerHTML='<div class="empty" role="status">Loading your Grove…</div>';return}
    if(content&&groveLoadError){content.innerHTML=`<div class="empty" role="alert"><h2>We couldn’t load The Grove.</h2><p>${esc(groveLoadError)}</p><button class="btn" data-backend="retry">Try again</button></div>`;return}
    if(mode==='owner'&&!state.isBusiness){location.replace('#/customer/register-business');return}
    if(mode==='customer'&&route==='chain'){location.replace('#/customer/wallet');return}
    if(mode==='customer'&&route==='profile'){location.replace('#/customer/home');return}
    renderBeforeBackend();
    if(route==='editor')renderQR();
    paintAccountMenu();
};

/* run fn once at a time per key, show errors as toasts */
async function once(key,fn){
    if(busy.has(key))return;
    busy.add(key);
    try{return await fn()}
    catch(err){toast(err.message||'Something went wrong. Please try again.');if(err.status===409||err.status===404)await loadAccount().catch(()=>{});renderPage();}
    finally{busy.delete(key)}
}
function closeModal(){if($('#modal').open)$('#modal').close()}
function formBusy(form,on,label){const b=form?.querySelector('button:not([type="button"]),[type="submit"]');if(!b)return;if(on){b.dataset.label=b.textContent;b.disabled=true;b.textContent=label||'Saving…'}else{b.disabled=false;b.textContent=b.dataset.label||b.textContent}}

/* ---------------------------------------------------------------- auth form (User_Signup / Login) */
window.addEventListener('submit',async e=>{
    const form=e.target;if(form.id!=='real-auth-form')return;
    e.preventDefault();e.stopImmediatePropagation();
    if(authBusy)return;
    const fd=new FormData(form),signup=form.dataset.kind==='signup',error=$('#auth-error');
    const email=String(fd.get('email')||'').trim().toLowerCase(),password=String(fd.get('password')||'');
    authBusy=true;error.hidden=true;formBusy(form,true,'Opening your Grove…');
    try{
        const res=signup
            ?await GroveAPI.signup({name:String(fd.get('account-name')||'').trim(),email,password,interests:fd.getAll('interests')})
            :await GroveAPI.login({email,password});
        GroveAPI.setToken(res.token);
        authStatus='signed-in';
        state=blankState();
        await loadAccount();
        category=entryIntent.category||'All';region='All';
        location.hash=/^\/customer\/store\//.test(entryIntent.route||'')?entryIntent.route:'/customer/home';
        toast(signup?'Your Grove is ready. Welcome!':`Welcome back, ${state.profile.name.split(' ')[0]}!`);
    }catch(err){
        if(GroveAPI.hasToken()&&authStatus!=='signed-in')GroveAPI.setToken(null);
        error.textContent=err.message;error.hidden=false;
    }finally{authBusy=false;formBusy(form,false)}
},true);

/* ---------------------------------------------------------------- clicks */
window.addEventListener('click',e=>{
    const retry=e.target.closest('[data-backend="retry"]');
    if(retry){e.preventDefault();boot();return}
    const logBtn=e.target.closest('[data-backend="log-visit"]');
    if(logBtn){e.preventDefault();e.stopImmediatePropagation();const a=state.appointments.find(x=>x.appointmentId===logBtn.dataset.appt);if(a)openVisitLog(a.businessId,a);return}
    const signout=e.target.closest('[data-motion="signout"]');
    if(signout){e.preventDefault();e.stopImmediatePropagation();signOut('You’ve logged out. See you soon.');return}

    const el=e.target.closest('[data-action],[data-new]');if(!el)return;
    const action=el.dataset.action||el.dataset.new,num=Number(el.dataset.id);
    const handlers={
        // Customer: confirm a visit (New_Transaction via POST /visits)
        visit:()=>openVisitLog(num),
        'confirm-visit':()=>openVisitLog(num),
        // Customer: start a fresh chain (New_Chain_Session)
        'new-chain':()=>once('new-chain',async()=>{await GroveAPI.startNewChain();await loadMe();renderPage();toast('A fresh chain is ready. Choose your first stop.')}),
        // Customer: interests (Update_User)
        interest:()=>{
            const c=el.dataset.category,before=state.profile.interests;
            state.profile.interests=before.includes(c)?before.filter(x=>x!==c):[...before,c];renderPage();
            once('interests',async()=>{try{await GroveAPI.updateMe({interests:state.profile.interests})}catch(err){state.profile.interests=before;throw err}});
        },
        // Owner: mark a pending payment paid (Update_Transaction)
        paid:()=>{const t=state.transactions[Number(el.dataset.index)];if(t)once('txn-'+t.transactionId,async()=>{await GroveAPI.updateTransaction(t.transactionId,{status:'Paid'});await loadDashboard();renderPage();toast('Payment recorded')})},
        // Owner: appointment reminder / cancel (Update_Appointment)
        reminder:()=>{const id=el.dataset.id,a=state.appointments.find(x=>x.appointmentId===id);if(a)once('appt-'+id,async()=>{await GroveAPI.updateAppointment(id,{reminder:!a.reminder});await loadDashboard();renderPage();toast('Reminder preference updated')})},
        'cancel-appointment':()=>{const id=el.dataset.id;once('appt-'+id,async()=>{await GroveAPI.updateAppointment(id,{status:'Cancelled'});await loadAccount();renderPage();toast('Appointment cancelled')})},
        // Owner: storefront preview uses your own listing
        'preview-business':()=>previewStore(),
        // Owner: new appointment, picking from past customers (type to filter) or a new name
        'add-appointment':()=>openAppointmentForm(),
        'add-customer':()=>{}
    };
    if(!handlers[action])return;
    e.preventDefault();e.stopImmediatePropagation();
    handlers[action]();
},true);

/* Log a visit: asks what you spent, then POST /visits (New_Transaction).
   appt = one of your bookings, which is then marked Completed. */
function openVisitLog(num,appt=null){
    const b=businesses.find(x=>x.id===num);if(!b)return;
    const inChain=state.chain.includes(num);
    const reward=inChain?0:(state.chain.length?CHAIN_CASHBACK:0);
    const note=inChain?'This business is already in your chain, so this visit earns no cash back.'
        :reward?`This visit earns ${money(reward)} cash back.`:'This is the first stop in your chain. Your next different business earns cash back.';
    closeModal();
    showModal(`<div class="modal-body"><div class="eyebrow">LOG YOUR VISIT</div><h2>${esc(b.name)}</h2>${appt?`<p class="muted">${esc(appt.service)} · ${date(appt.date)} · ${esc(appt.time)}${appt.businessAddress?`<br>${esc(appt.businessAddress)}`:''}</p>`:''}<form id="visit-log-form" data-id="${num}" data-appt="${appt?esc(appt.appointmentId):''}"><div class="field"><label for="visit-amount">How much did you spend? (S$)</label><input id="visit-amount" name="amount" type="text" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" placeholder="0.00" required autofocus></div>${walletToggle()}<p class="subtle">${note}</p><button class="btn full">Log visit</button></form></div>`);
    updateCashbackPreview();
}
function walletToggle(){
    const bal=state.cashbackBalance||0;
    return `<label class="toggle-row" style="border-top:1px solid var(--line)"><span>Use my cash back<small class="muted" style="display:block">${bal>0?`You have ${money(bal)} in your wallet`:'Your wallet is empty for now'}</small></span><input type="checkbox" role="switch" class="switch" id="use-cashback" name="useCashback" ${bal>0?'':'disabled'}></label><p id="cashback-preview" class="subtle" aria-live="polite"></p>`;
}
function updateCashbackPreview(){
    const box=$('#cashback-preview'),on=$('#use-cashback')?.checked;if(!box)return;
    const amount=Number($('#visit-amount')?.value)||0,bal=state.cashbackBalance||0,used=Math.min(bal,amount);
    box.textContent=on?(amount>0?`Using ${money(used)} cash back · you pay ${money(amount-used)}`:`Enter what you spent to see how much cash back is used.`):'';
}
document.addEventListener('input',e=>{if(e.target.id==='visit-amount')updateCashbackPreview()});
document.addEventListener('change',e=>{if(e.target.id==='use-cashback')updateCashbackPreview()});
async function logVisitOnServer(num,amount,appointmentId,useCashback=false){
    const b=businesses.find(x=>x.id===num);if(!b)return;
    const res=await GroveAPI.recordVisit(b.businessId,{amount,useCashback,...(appointmentId?{appointmentId}:{})});
    await loadMe();
    closeModal();
    const reward=Number(res.cashback)||0;
    if(appointmentId)renderPage();else if(route==='wallet')renderPage();else go('wallet');
    const usedNote=Number(res.cashbackUsed)>0?` Used ${money(res.cashbackUsed)} from your wallet.`:'';
    toast((res.repeat?`Visit logged. ${b.name} is already in your chain, so no cash back this time.`
        :reward?`Visit logged · ${money(reward)} cash back earned!`:'Visit logged. Your next different stop earns cash back.')+usedNote);
    celebrate();
}
confirmVisit=num=>openVisitLog(num);

/* Home: your booked visits, each with a title you can click to log the visit */
function myVisitsSection(){
    const list=state.appointments.filter(a=>a.mine&&(a.status==='Confirmed'||(a.status==='Completed'&&!a.visitLogged))).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
    if(!list.length)return '';
    const today=localDate();
    return `<section class="panel my-visits" style="margin:24px 0"><div class="section-title" style="margin-top:0"><div><h2>Your booked visits</h2><p>Been already? Tap the visit to log what you spent.</p></div><span class="pill">${list.length} booked</span></div>${list.map(a=>`<div class="list-row"><div><button class="text-btn" style="font-size:17px;padding:0;text-align:left" data-backend="log-visit" data-appt="${esc(a.appointmentId)}">${esc(a.businessName||business(a.businessId).name)} · Log this visit</button><p>${esc(a.service)} · ${date(a.date)} · ${esc(a.time)}${a.businessAddress?` · ${esc(a.businessAddress)}`:''}</p></div><span class="pill">${a.date===today?'Today':a.date<today?'Not logged yet':'Upcoming'}</span></div>`).join('')}</section>`;
}
const homeBeforeVisits=home;
function profileSummary(){
    const p=state.profile,initials=esc((p.name||'?').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase());
    return `<div class="profile-experience home-profile"><section class="profile-hero"><span class="profile-avatar">${initials}</span><div><div class="eyebrow">WELCOME BACK</div><h2>Hey ${esc((p.name||'').split(' ')[0])}, what’s your kind of good?</h2><p>${esc(p.email)}${p.phone?' · '+esc(p.phone):''}</p><div class="categories">${p.interests.map(c=>`<button type="button" class="pill interest-jump ${category===c?'active':''}" data-interest-jump="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>${mascot('profile-mascot')}</section><div class="stats home-stats"><a class="stat" href="#/customer/wallet"><span>Cash back available</span><strong>${money(state.cashbackBalance||0)}</strong></a><a class="stat" href="#/customer/wallet"><span>Current chain</span><strong>${state.chain.length+(state.chain.length===1?' stop':' stops')}</strong></a></div></div>`;
}
home=function(){
    const t=document.createElement('template');t.innerHTML=homeBeforeVisits();
    t.content.querySelector('.page-heading')?.remove();
    t.content.querySelector('.local-chain-strip')?.remove();
    t.content.querySelector('#search-form')?.remove();
    t.content.querySelector('.discovery-intro')?.remove();
    // "Picked for your interests": no Fresh picks button, no line under the title, no note under the cards
    t.content.querySelector('[data-action="refresh"]')?.remove();
    t.content.querySelectorAll('.section-title p').forEach(el=>{if(el.closest('.section-title')?.querySelector('h2')?.textContent.match(/Picked for|Explore the community/))el.remove()});
    t.content.querySelector('.directory-note')?.remove();
    t.content.firstElementChild?.insertAdjacentHTML('beforebegin',profileSummary()+myVisitsSection());
    // "Picked for your interests" is where the interest buttons at the top jump to
    const picked=t.content.querySelector('.categories[aria-label="Business categories"]')?.previousElementSibling;
    if(picked?.classList.contains('section-title'))picked.id='picked';
    return t.innerHTML;
};
// Clicking one of your interests at the top shows that category in "Picked for your interests" and scrolls there
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-interest-jump]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    category=el.dataset.interestJump;renderPage();
    requestAnimationFrame(()=>$('#picked')?.scrollIntoView({behavior:'smooth',block:'start'}));
},true);

// Page titles: plain names, no eyebrow line ("Your neighbourhood, reimagined" / "Your business, growing"),
// no tagline under the title and no full stops
const PAGE_TITLES={
    'owner/dashboard':()=>`Overview of ${esc(state.business.name||'your business')}`,
    'owner/editor':()=>'Edit your storefront',
    'owner/calendar':()=>'Business calendar',
    'owner/customers':()=>'Your customers',
    'owner/insights':()=>'Business Insights',
    'owner/finance':()=>'Finances',
    'customer/discover':()=>'Discover new businesses',
    'customer/history':()=>'Your History'
};
heading=function(title,subtitle,action=''){
    const named=PAGE_TITLES[mode+'/'+route];
    const text=named?named():String(title).replace(/\.(?![^<]*>)/g,'');
    return `<div class="page-heading"><div><h1>${text}</h1></div>${action}</div>`;
};

// Discover: no Region or "Or start near" pickers, and no "Allow location…" hint (Use my location stays)
const discoverBeforeTrim=discover;
discover=function(){
    const t=document.createElement('template');t.innerHTML=discoverBeforeTrim();
    t.content.querySelectorAll('.practical-map-toolbar .region-select').forEach(el=>el.remove());
    const status=t.content.querySelector('#geo-status');
    if(status&&!geoMessage)status.textContent='';
    return t.innerHTML.replace('Choose a starting point to see distances','Tap “Use my location” to see distances');
};

/* My wallet: cash back you can spend + the chain you're building */
function walletPage(){
    const balance=state.cashbackBalance||0,earned=state.visits.filter(v=>v.cashback>0);
    const moves=state.visits.flatMap(v=>[...(v.cashbackUsed>0?[{v,amt:-v.cashbackUsed}]:[]),...(v.cashback>0?[{v,amt:v.cashback}]:[])]);
    const n=state.chain.length;
    return heading('Your wallet.','Cash back you’ve earned, and the chain that’s earning it.')+
    `<div class="reward-summary"><div><span class="eyebrow">CASH BACK AVAILABLE</span><strong>${money(balance)}</strong><p>Earned from ${earned.length} chain ${earned.length===1?'visit':'visits'}</p></div><div><span class="eyebrow">NEXT VISIT</span><strong>${money(nextReward())}<small> cash back</small></strong><p>${n?'At your next different business.':'Your first visit starts a chain. The one after earns cash back.'}</p></div>${mascot('reward-mascot')}</div>`+
    `<section class="panel"><div class="section-title" style="margin-top:0"><h2>Your current chain</h2><span class="pill">${n} ${n===1?'stop':'stops'} so far</span></div><div class="chain-track">${n?state.chain.map((id,i)=>{const b=business(id);return `<div class="chain-node completed"><span>✓</span><h3>${esc(b.name)}</h3><p>${i===0?'First stop':money(CHAIN_CASHBACK)+' cash back'}</p></div>`}).join(''):'<p class="muted">Log a visit at any business to start a chain.</p>'}</div></section>`+
    `<section class="panel" style="margin-top:24px"><h2>Cash back history</h2>${moves.length?moves.map(({v,amt})=>{const b=business(v.business);return `<div class="list-row"><div><strong>${esc(b.name)}</strong><p>${date(v.date)} · ${amt<0?'used on a':'earned on a'} ${money(v.amount)} visit</p></div><span class="pill" style="${amt<0?'background:#faf0dc;color:#996c29':''}">${amt<0?'−':'+'}${money(Math.abs(amt))}</span></div>`}).join(''):'<p class="muted">Cash back you earn and use will show here.</p>'}</section>`+
    `<div class="section-title"><h2>Grow your chain</h2><span class="muted">A different business. Another ${money(CHAIN_CASHBACK)} back.</span></div><div class="cards">${businesses.filter(b=>!state.chain.includes(b.id)).slice(0,3).map(b=>card(business(b.id))).join('')}</div>`;
}

/* Account menu: click your name at the bottom-left of the sidebar (a small button on phones).
   Holds Settings, Business studio / Sign up as a business, and Log out. */
let accountMenuOpen=false;
function paintAccountMenu(){
    document.querySelector('#account-menu')?.remove();
    const trigger=document.querySelector('.sidebar .side-user');
    if(authStatus!=='signed-in'||['landing','login','signup'].includes(route))return;
    const p=state.profile,initials=esc((p.name||'?').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase());
    if(trigger){
        trigger.classList.add('account-trigger');
        trigger.dataset.backend='account';
        trigger.setAttribute('role','button');trigger.setAttribute('tabindex','0');
        trigger.setAttribute('aria-label','Account menu: settings and log out');
        trigger.setAttribute('aria-expanded',String(accountMenuOpen));
    }
    const host=document.createElement('div');host.id='account-menu';
    host.innerHTML=`<button class="account-fab" data-backend="account" aria-label="Account menu" aria-expanded="${accountMenuOpen}">${initials}</button>${accountMenuOpen?`<div class="account-pop" role="menu" aria-label="Account"><div class="account-who"><strong>${esc(p.name)}</strong><small>${esc(p.email)}</small></div><a role="menuitem" href="#/${mode}/settings">${icon('edit')} Settings</a>${state.isBusiness?'':`<a role="menuitem" href="#/customer/register-business">${icon('leaf')} Sign up as a business</a>`}<button role="menuitem" data-motion="signout">${icon('close')} Log out</button></div>`:''}`;
    document.body.append(host);
    const pop=host.querySelector('.account-pop');
    if(pop){
        const anchor=trigger&&trigger.offsetParent?trigger:host.querySelector('.account-fab');
        const r=anchor.getBoundingClientRect();
        pop.style.left=Math.max(8,Math.min(r.left,innerWidth-258))+'px';
        pop.style.bottom=(innerHeight-r.top+8)+'px';
        pop.querySelector('a,button')?.focus();
    }
}
window.addEventListener('hashchange',()=>{accountMenuOpen=false;paintAccountMenu()});
window.addEventListener('click',e=>{
    if(e.target.closest('[data-backend="account"]')){e.preventDefault();e.stopImmediatePropagation();accountMenuOpen=!accountMenuOpen;paintAccountMenu();return}
    if(accountMenuOpen&&!e.target.closest('#account-menu')){accountMenuOpen=false;paintAccountMenu()}
},true);
window.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&accountMenuOpen){accountMenuOpen=false;paintAccountMenu();document.querySelector('.side-user.account-trigger')?.focus();return}
    if((e.key==='Enter'||e.key===' ')&&e.target.closest?.('.side-user.account-trigger')){e.preventDefault();accountMenuOpen=!accountMenuOpen;paintAccountMenu()}
});
window.addEventListener('resize',()=>{if(accountMenuOpen)paintAccountMenu()});

/* Front page wording (27 Oct). The business studio preview moved to #/business-owner (not linked yet) */
let businessOwnerPage=false;
const shellBeforeOwnerPage=shell;
shell=function(){
    businessOwnerPage=/^#\/business-owner(\/|$)/.test(location.hash);
    if(businessOwnerPage){mode='customer';route='landing'}
    shellBeforeOwnerPage();
};
// The interest tabs: no story text or footnote, more businesses instead
curiosityView=function(){
    const i=curiosityIndex,c=interests[i],matches=businesses.filter(b=>b.category===c).slice(0,6);
    return `<div class="curiosity-photo"><img src="${curiosityPhotos[i]}" alt="${esc(c)}"><span class="curiosity-photo-label">${['SOMETHING DELICIOUS','A MOMENT FOR YOU','MADE WITH IMAGINATION','YOUR OWN KIND OF STYLE'][i]}</span></div><div class="curiosity-story">${matches.length?`<div class="curiosity-makers">${matches.map(b=>`<a href="#/login" data-entry="customer" data-entry-store="${b.id}" data-entry-category="${c}"><span>${esc(b.area)}</span><strong>${esc(b.name)} ↗</strong><small>${esc(b.tag)}</small></a>`).join('')}</div>`:'<p class="curiosity-new">Choose this interest when you sign up to personalise your discoveries.</p>'}${entryButton('Explore '+c.toLowerCase(),'customer','btn secondary',c)}</div>`;
};
// Business Owner page: the header buttons go to that part of the front page
window.addEventListener('click',e=>{
    const a=businessOwnerPage&&e.target.closest('[data-section]');if(!a)return;
    e.preventDefault();e.stopImmediatePropagation();
    const id=a.dataset.section;location.hash='#/landing';
    setTimeout(()=>document.getElementById(id)?.scrollIntoView({behavior:'smooth'}),150);
},true);
const landingBeforeWording=landing;
landing=function(){
    const t=document.createElement('template');t.innerHTML=landingBeforeWording();const d=t.content;
    const studio=d.querySelector('.tools-showcase');
    if(businessOwnerPage){
        const page=d.querySelector('.landing');page.classList.add('business-owner-page');
        // Expanded: all four studio previews side by side instead of one rotating panel
        const intro=studio.querySelector(':scope>div:first-child');
        intro.querySelector('.tool-tabs')?.remove();intro.querySelector('[data-motion="tools"]')?.remove();intro.querySelector('.eyebrow')?.remove();
        intro.querySelector('h2').innerHTML='Tools for <em>Home Business Owners</em>';
        intro.querySelector(':scope>p')?.insertAdjacentHTML('afterend',`<ul class="owner-benefits">${[['Expand','Reach beyond your regulars'],['Maintain','Less juggling, more creating'],['Connect','Grow alongside your neighbours']].map(([h,p])=>`<li><strong>${h}</strong><span>${p}</span></li>`).join('')}</ul>`);
        const forCustomers='<a class="btn outline-pill" href="#/landing">Back to main page</a>';
        const actions=intro.querySelector('.studio-actions');if(actions)actions.innerHTML=entryButton('Grow your business','owner','btn coral')+forCustomers;
        const shown=toolTab,tools=[['customers','Customers','Remember the people behind each order.'],['calendar','Appointments','Give every order its own time and place.'],['finance','Finances','Know what comes in, what goes out, and what’s left.'],['insights','Insights','Understand interests and popular products.']];
        const cards=tools.map(([tab,h,p])=>{toolTab=tab;return `<article class="owner-tool-card"><div class="owner-tool-head"><span>${icon(tab==='customers'?'user':tab==='insights'?'compass':tab)}</span><div><strong>${h}</strong><small>${p}</small></div></div><div class="tool-preview">${toolPreview()}</div></article>`}).join('');
        toolTab=shown;
        const closing=d.querySelector('.final-invitation');
        const scene=`<div class="seamless-neighbourhood" role="img" aria-label="Grove waves in a gently moving neighbourhood scene">${[0,1,2,3].map(i=>`<span class="scene-frame frame-${i}"></span>`).join('')}</div>`;
        page.querySelector('main').innerHTML=`<section class="landing-section tools-showcase owner-tools-page"><div class="owner-tools-top"><div class="owner-tools-intro">${intro.innerHTML}</div><div class="owner-tools-scene">${scene}</div></div><div class="owner-tools-grid">${cards}</div></section>`;
        // Closing panel, like the one at the bottom of the front page
        if(closing){
            closing.querySelector('.eyebrow')?.remove();
            closing.querySelector('h2').innerHTML='Ready to discover your customers<br>and start growing?';
            closing.querySelector('.hero-ctas').innerHTML=entryButton('Grow your business','owner','btn coral')+forCustomers;
            const note=closing.querySelector('.closing-note');if(note)note.innerHTML='BIG DREAMS<br>LITTLE BEGINNINGS';
            page.querySelector('main').append(closing);
        }
        page.querySelector('.landing-footer')?.remove();
        return t.innerHTML;
    }
    const gone=sel=>d.querySelectorAll(sel).forEach(el=>el.remove());
    // Hero
    gone('.hero-text>.eyebrow, .scene-badge, .hero-text>.story-link, .hero-note');
    d.querySelector('.hero-text h1').innerHTML='Discover local<br>Support local<br><em>Grow together</em>';
    d.querySelector('#hero-scene-caption').textContent='Discover Home Businesses around you';
    d.querySelector('.hero-ctas').insertAdjacentHTML('beforeend','<a class="btn outline-pill" href="#/business-owner">For Home Business owners</a>');
    // Our story
    gone('.v3-about .eyebrow');
    d.querySelector('.v3-about h2').innerHTML='Supporting local businesses<br>through <em>business chaining</em>';
    d.querySelector('.v3-about p').textContent='Our mission: Support home business owners simplifying their workflow and discoverability';
    const cinemaNote=d.querySelector('.mission-cinema-note');if(cinemaNote)cinemaNote.innerHTML='Your next favourite<br>Someone’s next big chapter';
    // How it works
    gone('.chain-showcase .eyebrow, .chain-showcase .section-title>button');
    d.querySelector('.chain-showcase h2').textContent='How business chaining works';
    const steps=[['Your first spark','Find something you love','Your first visit'],['A new connection','Discover another business','$1 cashback'],['Keep exploring','Continue discovering new businesses','Incremental cashbacks']];
    d.querySelectorAll('.connection-stop').forEach((el,i)=>{const [h,p,r]=steps[i];el.querySelector('h3').textContent=h;el.querySelector('p').textContent=p;el.querySelector('.reward-ticket').textContent=r});
    // The community
    gone('.category-section .eyebrow, .category-section .section-title>p');
    d.querySelector('.category-section h2').innerHTML='Discover <em>home businesses</em>';
    // Business studio preview, FAQ, closing invitation, footer
    studio.remove();
    gone('.faq-section .eyebrow, .faq-section .host-caption');
    d.querySelector('.faq-section h2').textContent='FAQ';
    gone('.final-invitation .eyebrow, .final-invitation [data-entry="owner"], .landing-footer');
    const closingNote=d.querySelector('.final-invitation .closing-note');if(closingNote)closingNote.innerHTML='BIG DREAMS<br>LITTLE BEGINNINGS';
    return t.innerHTML;
};

/* Front page while logged in: "Log in" becomes "Back to my Grove"; #/login and #/signup go home */
const landingBeforeSession=landing;
landing=function(){
    const html=landingBeforeSession();
    if(authStatus!=='signed-in')return html;
    const t=document.createElement('template');t.innerHTML=html;
    t.content.querySelectorAll('a[href="#/login"],a[href="#/signup"]').forEach(a=>{a.setAttribute('href','#/customer/home');a.textContent='Back to my Grove'});
    return t.innerHTML;
};
const authPageBeforeSession=authPage;
authPage=function(){
    if(authStatus==='signed-in'){setTimeout(()=>location.replace('#/customer/home'));return ''}
    return authPageBeforeSession();
};
/* Log in and sign up wording (27 Oct). The left panel is shared by both pages */
const authPageBeforeWording=authPage;
authPage=function(){
    const html=authPageBeforeWording();if(!html)return html;
    const t=document.createElement('template');t.innerHTML=html;const d=t.content,signup=route==='signup';
    d.querySelectorAll('.auth-scene .eyebrow, .welcome-ticket, .welcome-pill, .auth-card>.eyebrow').forEach(el=>el.remove());
    const h1=d.querySelector('.auth-scene h1');if(h1)h1.innerHTML='Be a part of<br><em>the Grove</em>';
    const lead=d.querySelector('.auth-scene h1+p');if(lead)lead.textContent='Discover businesses around you';
    const h2=d.querySelector('.auth-card h2');if(h2)h2.textContent=signup?'Join the Grove':'Welcome to the Grove';
    return t.innerHTML;
};

/* Business side ---------------------------------------------------------------- */
// Business & QR page removed: the QR lives on My storefront now
ownerNav.splice(0,ownerNav.length,...ownerNav.filter(n=>n[0]!=='business'));

// Overview: no Orders & sales panel, no Edit storefront button; visits instead of orders
const dashboardBeforeTrim=dashboard;
dashboard=function(){
    const t=document.createElement('template');t.innerHTML=dashboardBeforeTrim();
    t.content.querySelectorAll('.orders-panel').forEach(el=>el.remove());
    t.content.querySelector('.page-heading a.btn')?.remove();
    const tt=totals(financeMonth),visits=state.transactions.filter(x=>x.kind==='visit'&&x.date.startsWith(financeMonth)).length;
    const stats=t.content.querySelector('.stats');
    if(stats)stats.innerHTML=stat('Customer visits',visits,monthLabel(financeMonth)+' · logged by customers')+stat('Paid income',money(tt.income),monthLabel(financeMonth))+stat('Awaiting payment',money(tt.pending),'Outstanding balances')+stat('Net profit',money(tt.profit),'Income less expenses');
    t.content.querySelector('.grid2')?.style.setProperty('margin-top','0');
    return t.innerHTML;
};

// My storefront: no Brand colour picker (the saved colour stays as it is)
const editorBeforeTrim=editor;
editor=function(){
    const t=document.createElement('template');t.innerHTML=editorBeforeTrim();
    t.content.querySelector('#accent')?.closest('.field')?.remove();
    // No starting price or short tagline; "Purchase website" is just "Website"
    ['#price','#tag'].forEach(s=>t.content.querySelector(s)?.closest('.field')?.remove());
    const site=t.content.querySelector('label[for="website"]');if(site)site.firstChild.textContent='Website ';
    // "A note from you" on your storefront
    const story=t.content.querySelector('#description')?.closest('.field');
    if(story)story.insertAdjacentHTML('afterend',`<div class="field"><label for="note">A note to your customers <span class="muted">(optional, shown as “A note from ${esc((state.profile.name||'').split(' ')[0]||'you')}”)</span></label><textarea id="note" name="note" maxlength="300" rows="3" placeholder="${esc(DEFAULT_NOTE)}">${esc(state.business.note||'')}</textarea></div>`);
    t.content.querySelectorAll('a.underlink').forEach(a=>{if(a.textContent.trim()==='Purchase website')a.textContent='Website'});
    return t.innerHTML;
};

// Storefront pages: the link reads "Website", and "A note from …" shows the owner's own note
const DEFAULT_NOTE='Thank you for supporting a small local dream. Every order means a little more than you know.';
const storefrontMarkupBeforeTrim=storefrontMarkup;
storefrontMarkup=function(id,preview=false){
    const note=business(id).note;
    let html=storefrontMarkupBeforeTrim(id,preview).replace('>Purchase website</a>','>Website</a>');
    if(note)html=html.replace(DEFAULT_NOTE,esc(note));
    return html;
};

// Sidebar order: Calendar sits between My storefront and Customers
{const i=ownerNav.findIndex(n=>n[0]==='calendar');if(i>=0){const [cal]=ownerNav.splice(i,1);ownerNav.splice(ownerNav.findIndex(n=>n[0]==='editor')+1,0,cal)}}

// New appointment: customer name comes from your past customers; typing filters the list
function openAppointmentForm(){
    const names=[...new Set([...state.customers.map(c=>c.name),...state.appointments.filter(a=>a.atMyBusiness).map(a=>a.name)]
        .map(n=>String(n||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    showModal(`<div class="modal-body"><h2>New appointment</h2><form id="appointment-form"><div class="field"><label for="name">Customer</label><input id="name" name="name" list="past-customers" autocomplete="off" required placeholder="${names.length?'Start typing a name…':'Customer name'}"><datalist id="past-customers">${names.map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist><small class="muted">${names.length?'Pick a past customer, or type a new name.':'No past customers yet. Type a name.'}</small></div>${field('Service / order','service')}<div class="form-grid">${field('Date','date',selectedDate,'date')}${field('Time','time','10:00','time')}</div><button class="btn">Add appointment</button></form></div>`);
    $('#name')?.focus();
}

// Finances: no "+ Add transaction" button
const financeBeforeTrim=finance;
finance=function(){
    const t=document.createElement('template');t.innerHTML=financeBeforeTrim();
    t.content.querySelector('[data-action="add-transaction"]')?.remove();
    return t.innerHTML;
};

// Calendar: the month on the left, the chosen day's appointments on the right
const calendarBeforeSplit=calendar;
calendar=function(){
    const t=document.createElement('template');t.innerHTML=calendarBeforeSplit();
    const panels=[...t.content.children].filter(el=>el.matches('section.panel'));
    if(panels.length>=2){
        const split=document.createElement('div');split.className='calendar-split';
        panels[0].before(split);split.append(panels[0],panels[1]);
        panels[1].style.marginTop='0';panels[1].classList.add('calendar-day');
    }
    return t.innerHTML.replaceAll('Reminder enabled (demo)','Reminder on');
};

// Customers: sortable by visits, spend, last visit, next visit or name
let customerSort='visits',customerDir='desc';
const CUSTOMER_SORTS={visits:['Number of visits',c=>c.visits],spent:['Amount spent',c=>c.spent],last:['Last visit',c=>c.last||''],next:['Next visit',c=>c.next||''],name:['Name',c=>c.name.toLowerCase()]};
customers=function(){
    const q=query.toLowerCase(),[,key]=CUSTOMER_SORTS[customerSort],dir=customerDir==='asc'?1:-1;
    const list=state.customers.filter(c=>`${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(q))
        .sort((a,b)=>{const x=key(a),y=key(b);return (x<y?-1:x>y?1:0)*dir||a.name.localeCompare(b.name)});
    const th=(k,label)=>`<th><button type="button" class="sort-head ${customerSort===k?'active':''}" data-sort="${k}" aria-label="Sort by ${label}">${label}${customerSort===k?(customerDir==='asc'?' ↑':' ↓'):''}</button></th>`;
    return heading('Know the people behind every visit.','Customers appear here automatically when they visit or book.')+searchBox('Search customer name, email, or phone…')+
    `<div class="filters customer-sort"><label for="customer-sort">Sort by</label><select id="customer-sort" style="max-width:220px">${Object.entries(CUSTOMER_SORTS).map(([k,[label]])=>`<option value="${k}" ${customerSort===k?'selected':''}>${label}</option>`).join('')}</select><button type="button" class="btn secondary small" data-sort-dir aria-label="Reverse order">${customerDir==='asc'?'↑ Lowest first':'↓ Highest first'}</button></div>`+
    `<section class="panel"><h2>Your community <span class="pill">${list.length} customers</span></h2><div class="table-wrap"><table><thead><tr>${th('name','Name')}<th>Contact number</th><th>Email</th>${th('visits','Visits')}${th('spent','Total spent')}<th>First visit</th>${th('last','Last visit')}${th('next','Next visit')}</tr></thead><tbody>${list.map(c=>`<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${c.visits}</td><td>${money(c.spent)}</td><td>${c.first?date(c.first):'—'}</td><td>${c.last?date(c.last):'—'}</td><td>${c.next?date(c.next):'Not booked'}</td></tr>`).join('')||'<tr><td colspan="8">No customers match your search.</td></tr>'}</tbody></table></div></section>`;
};
document.addEventListener('change',e=>{if(e.target.id==='customer-sort'){customerSort=e.target.value;customerDir=customerSort==='name'?'asc':'desc';renderPage()}});
window.addEventListener('click',e=>{
    const h=e.target.closest('[data-sort]');
    if(h){e.preventDefault();e.stopImmediatePropagation();const k=h.dataset.sort;if(customerSort===k)customerDir=customerDir==='asc'?'desc':'asc';else{customerSort=k;customerDir=k==='name'?'asc':'desc'}renderPage();return}
    if(e.target.closest('[data-sort-dir]')){e.preventDefault();e.stopImmediatePropagation();customerDir=customerDir==='asc'?'desc':'asc';renderPage()}
},true);

/* Navigation: Home · Discover · My wallet · History (Profile is on Home, Settings in the account menu) */
customerNav.splice(0,customerNav.length,['home','home','Home'],['discover','compass','Discover'],['wallet','finance','My wallet'],['history','history','History']);

/* ---------------------------------------------------------------- preference toggles (Update_User) */
window.addEventListener('change',e=>{
    const key=e.target.dataset?.setting;if(!key)return;
    e.stopImmediatePropagation();
    const before=state.profile[key];state.profile[key]=e.target.checked;
    once('setting-'+key,async()=>{try{await GroveAPI.updateMe({[key]:e.target.checked});toast('Preference saved')}catch(err){state.profile[key]=before;e.target.checked=before;throw err}});
},true);

/* ---------------------------------------------------------------- forms */
const formHandlers={
    // Settings → Update_User
    'settings-v2':async d=>{await GroveAPI.updateMe({name:d.name,phone:d.phone||''});await loadMe();shell();toast('Your changes are saved')},
    'profile-form':async d=>{await GroveAPI.updateMe({name:d.name,region:d.region});await loadMe();shell();toast('Profile saved')},

    // Register a business → New_HBB
    'business-signup':async d=>{
        const {business}=await GroveAPI.createBusiness({name:d.name,category:d.category,address:d.address,postalCode:String(d.postalCode||'').trim()});
        upsertBusiness(business);
        await loadAccount();
        location.hash='/customer/settings';
        toast('Your business is registered. Open your business studio from Settings.');celebrate();
    },

    // Storefront editor → Update_HBB
    'editor-form':async d=>{
        if(d.website&&!/^https?:\/\//.test(d.website))throw new GroveAPI.ApiError(400,'Please use an http or https website address.');
        const {business}=await GroveAPI.updateBusiness({name:d.name,description:d.description||'',phone:d.phone,email:d.email,
            website:d.website||'',note:d.note||'',address:d.address,postalCode:String(d.postalCode||'').trim()});
        upsertBusiness(business);await loadDashboard();renderPage();toast('Your storefront is updated');
    },

    // Finance → New_Transaction (ledger)
    'transaction-form':async d=>{
        await GroveAPI.addTransaction({description:d.description,date:d.date,type:d.type,amount:d.amount,status:d.status,kind:'manual'});
        financeMonth=d.date.slice(0,7);closeModal();await loadDashboard();renderPage();toast('Transaction saved');
    },

    // In-store order → New_Transaction (kind: order)
    'order-v2':async d=>{
        const quantity=Number(d.quantity),product=String(d.product||'').trim();
        if(!product||!Number.isInteger(quantity)||quantity<1)throw new GroveAPI.ApiError(400,'Enter a product and a valid order quantity.');
        const total=Number(d.amount);
        if(!(total>0))throw new GroveAPI.ApiError(400,'Enter the order total.');
        await GroveAPI.addTransaction({kind:'order',customerName:d.customer,product,quantity,amount:total.toFixed(2),
            description:`${quantity} × ${product} · ${d.customer}`,type:'Income',status:'Paid',date:localDate()});
        await loadDashboard();renderPage();toast('Order recorded · finances and customers updated');celebrate();
    },

    // Log a visit (store page or booked visit) → New_Transaction
    'visit-log-form':async(d,form)=>{
        const amount=Number(d.amount);
        if(!(amount>=0)||String(d.amount).trim()==='')throw new GroveAPI.ApiError(400,'Enter how much you spent.');
        await logVisitOnServer(Number(form.dataset.id),amount.toFixed(2),form.dataset.appt||null,!!form.querySelector('#use-cashback')?.checked);
    },

    // Owner calendar → New_Appointment (your business)
    'appointment-form':async d=>{
        await GroveAPI.bookAppointment({customerName:d.name,service:d.service,date:d.date,time:d.time});
        moveCalendarTo(d.date);closeModal();await loadDashboard();renderPage();toast('Appointment added');
    },

    // Customer booking → New_Appointment (chosen business)
    'booking-form':async(d,form)=>{
        const businessId=bizIdOf(Number(form.dataset.id));
        await GroveAPI.bookAppointment({businessId,customerName:d.name,service:d.service,date:d.date,time:d.time});
        closeModal();await loadAccount();renderPage();toast('Booking confirmed · find it on your home page');
    }
};
function moveCalendarTo(d){selectedDate=d;calendarMonth=Number(d.slice(5,7))-1;calendarYear=Number(d.slice(0,4))}

window.addEventListener('submit',e=>{
    const form=e.target,run=formHandlers[form.id];if(!run)return;
    e.preventDefault();e.stopImmediatePropagation();
    const d=Object.fromEntries(new FormData(form));
    once('form-'+form.id,async()=>{formBusy(form,true);try{await run(d,form)}finally{formBusy(form,false)}});
},true);

/* ---------------------------------------------------------------- boot */
async function boot(){
    groveReady=false;groveLoadError='';
    if(GroveAPI.hasToken())authStatus='signed-in';
    handleRoute();
    try{
        await loadDirectory();
        if(GroveAPI.hasToken()){
            try{await loadAccount()}
            catch(err){if(err.status===401){groveReady=true;signOut('Please log in again.');return}throw err}
        }
    }catch(err){groveLoadError=err.message}
    groveReady=true;
    handleRoute();
}
boot();
