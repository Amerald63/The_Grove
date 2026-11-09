/* The Grove: bookings (14 Oct). Loaded after backend.js.

   A booking is a visit or an order to collect, in one 30-minute slot.
   - A customer's request is Pending until the business confirms it.
   - Either side can suggest a change (service, date, time). The other side then has to
     confirm, so a booking is Confirmed only once both have agreed to the same version.
   - There is no chat (removed 21 Oct). Each booking has its details and Confirm / Suggest changes /
     Cancel booking: customers open it from the calendar on their Bookings page, owners get the
     "Appointment management" popup (Edit on the Overview or the Calendar).
     The Lambdas still keep a log of each step in `messages`; the site no longer shows it.
   - Customers see each business's schedule with names hidden, inside its opening hours.

   - 23 Oct: each business is a product or a service business (businessType).
     Service: customers book an appointment, and log the visit once it has started.
     Product: customers place an order to collect today while the business is open (a "pickup", which
     doesn't hold the slot), and can log a visit any time.
   - 23 Oct: opening hours are drawn on a weekly calendar on My storefront. "Regular" repeats every week
     (hours: {mon: [[from, to], ...]}); "irregular" is set date by date (dates: {"2026-10-24": [[from, to]]}).
     A day can have several spans. Older listings stored one span a day, {mon: [from, to]}; bkSpans reads both.

   Lambdas: New_Appointment (POST /appointments), Update_Appointment (PATCH /appointments/{id}),
   Get_HBB_Data (GET /businesses/{id}/schedule), Update_HBB (opening hours).
*/

/* ---------------------------------------------------------------- helpers */
const BK_DAYS=['sun','mon','tue','wed','thu','fri','sat'];
const BK_DAY_NAMES={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const BK_WEEK=['mon','tue','wed','thu','fri','sat','sun'];
const BK_TYPES={visit:'Visit / appointment',pickup:'Order pickup'};
const BK_CLOSED=['Cancelled','Declined','Completed'];
const bkMinutes=t=>{const [h,m]=String(t).split(':').map(Number);return h*60+m};
const bkTime=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
function bkSlots(from,to){const out=[];for(let m=bkMinutes(from);m+30<=bkMinutes(to);m+=30)out.push(bkTime(m));return out}
const BK_ALL_TIMES=Array.from({length:48},(_,i)=>bkTime(i*30));
function bkAmPm(t){if(!t)return '';const [h,m]=t.split(':').map(Number);return `${h%12||12}:${String(m).padStart(2,'0')}${h%24<12?'am':'pm'}`}
function bkDayKey(d){return BK_DAYS[new Date(d+'T12:00:00').getDay()]}
function bkAddDays(d,n){const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+n);return x.toLocaleDateString('en-CA')}
function bkWhen(a){return `${new Date(a.date+'T12:00:00').toLocaleDateString('en-SG',{weekday:'short',day:'numeric',month:'short'})}, ${bkAmPm(a.time)}`}
function bkNowHHMM(){const n=new Date();return bkTime(n.getHours()*60+n.getMinutes())}
function bkPast(d,t){const today=localDate();return d<today||(d===today&&t<=bkNowHHMM())}
function bkAgo(iso){
    if(!iso)return '';const s=(Date.now()-new Date(iso).getTime())/1000;
    if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';if(s<86400)return Math.floor(s/3600)+' h ago';
    return new Date(iso).toLocaleDateString('en-SG',{day:'numeric',month:'short'});
}
function bkInitials(n){return esc((n||'?').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase())}
/* Opening hours. src is a business, or a schedule from GET /businesses/{id}/schedule: {hours, hoursMode, dates}. */
const bkNorm=v=>!v||!v.length?[]:(Array.isArray(v[0])?v:[v]);   // [from, to] (before 23 Oct) or [[from, to], ...]
function bkSpans(src,d){return bkNorm(src?.hoursMode==='irregular'?src?.dates?.[d]:src?.hours?.[bkDayKey(d)])}
const bkInSpans=(spans,t)=>spans.some(([a,b])=>bkMinutes(t)>=bkMinutes(a)&&bkMinutes(t)+30<=bkMinutes(b));
const bkSpanText=spans=>spans.map(([a,b])=>a==='00:00'&&b==='24:00'?'24 hours':`${bkAmPm(a)}–${bkAmPm(b)}`).join(', ');
const bkShort=t=>bkAmPm(t).replace(':00','');   // 9am, 1:30pm
function bkHasHours(src){
    if(src?.hoursMode==='irregular')return Object.entries(src.dates||{}).some(([d,v])=>d>=localDate()&&bkNorm(v).length);
    return Object.values(src?.hours||{}).some(v=>bkNorm(v).length);
}
// "service" (by appointment) or "product" (order, then collect); listings from before 23 Oct have no type
const bkType=b=>b?.businessType==='service'||b?.businessType==='product'?b.businessType:(b?.category==='Health & Beauty'?'service':'product');
function bkHoursText(src){
    // "Mon–Fri 9:00am–5:00pm · Sat 10:00am–4:00pm"; irregular: the next open date
    if(src?.hoursMode==='irregular'){
        const next=Object.keys(src.dates||{}).filter(d=>d>=localDate()&&bkNorm(src.dates[d]).length).sort()[0];
        return next?`on set dates, next ${new Date(next+'T12:00:00').toLocaleDateString('en-SG',{weekday:'short',day:'numeric',month:'short'})} ${bkSpanText(bkNorm(src.dates[next]))}`:'on set dates';
    }
    const groups=[];
    BK_WEEK.forEach(d=>{const key=bkSpanText(bkNorm(src?.hours?.[d]));const last=groups[groups.length-1];
        if(key&&last&&last.key===key&&BK_WEEK.indexOf(last.days[last.days.length-1])===BK_WEEK.indexOf(d)-1)last.days.push(d);else if(key)groups.push({key,days:[d]})});
    const cap=d=>d[0].toUpperCase()+d.slice(1);
    return groups.map(g=>`${cap(g.days[0])}${g.days.length>1?'–'+cap(g.days[g.days.length-1]):''} ${g.key}`).join(' · ');
}

/* ---------------------------------------------------------------- data: carry the new booking fields */
const toUiAppointmentBeforeBookings=toUiAppointment;
toUiAppointment=function(a){
    return {...toUiAppointmentBeforeBookings(a),type:a.type||'visit',awaiting:a.awaiting||'',messages:a.messages||[],
        lastActivityAt:a.lastActivityAt||a.createdAt||'',createdAt:a.createdAt||'',seenOwnerAt:a.seenOwnerAt||'',seenCustomerAt:a.seenCustomerAt||'',
        customerUserId:a.customerUserId||'',rawBusinessId:a.businessId,lines:a.lines||[],estimate:a.estimate??null};
};
const toUiBusinessBeforeBookings=toUiBusiness;
toUiBusiness=function(r){const ui=toUiBusinessBeforeBookings(r);ui.hours=r.hours||{};ui.hoursMode=r.hoursMode||'regular';ui.dates=r.dates||{};ui.businessType=r.businessType||'';return ui};
const applyDashboardBeforeBookings=applyDashboard;
applyDashboard=function(d){
    applyDashboardBeforeBookings(d);
    state.business.hours=d.business?.hours||{};state.business.hoursMode=d.business?.hoursMode||'regular';
    state.business.dates=d.business?.dates||{};state.business.businessType=d.business?.businessType||'';
    (d.customers||[]).forEach((c,i)=>{if(state.customers[i])state.customers[i].userId=c.userId||''});
};

/* what a booking needs from each side */
function bkOther(side){return side==='owner'?'customer':'owner'}
function bkNeedsMe(a,side){return a.status==='Pending'&&a.awaiting===side}
// An order to collect is placed straight away (23 Oct); the owner sees it as a new order until they've looked at it
const bkNewOrder=a=>a.type==='pickup'&&a.status==='Confirmed'&&a.atMyBusiness&&!a.seenOwnerAt;
function bkStatus(a,side){
    if(a.type==='pickup'&&a.status==='Confirmed')return side==='owner'&&bkNewOrder(a)?{label:'New order',cls:'bk-need'}:{label:'To collect',cls:'bk-confirmed'};
    if(a.status==='Pending'){
        if(a.awaiting===side)return {label:side==='owner'?'Needs your confirmation':'Needs your reply',cls:'bk-need'};
        return {label:side==='owner'?'Waiting for customer':'Waiting for the business',cls:'bk-wait'};
    }
    return {label:a.status,cls:'bk-'+String(a.status||'').toLowerCase()};
}
function bkMine(side){
    const list=state.appointments.filter(a=>side==='owner'?a.atMyBusiness:a.mine);
    return list.sort((x,y)=>(BK_CLOSED.includes(x.status)-BK_CLOSED.includes(y.status))||String(y.lastActivityAt).localeCompare(String(x.lastActivityAt)));
}
function bkAttention(side){return bkMine(side).filter(a=>bkNeedsMe(a,side)||(side==='owner'&&bkNewOrder(a))).length}
function bkReplace(appointment){mergeAppointments([appointment])}

/* ---------------------------------------------------------------- schedules (hours + taken slots, no names) */
const bkSchedules=new Map();
async function bkSchedule(businessId,fresh=false){
    if(!fresh&&bkSchedules.has(businessId))return bkSchedules.get(businessId);
    const s=await GroveAPI.getSchedule(businessId);bkSchedules.set(businessId,s);return s;
}
function bkOwnSchedule(){
    return {hours:state.business.hours||{},hoursMode:state.business.hoursMode,dates:state.business.dates||{},taken:state.appointments.filter(a=>a.atMyBusiness&&a.type!=='pickup'&&(a.status==='Pending'||a.status==='Confirmed')).map(a=>({date:a.date,time:a.time,status:a.status,id:a.appointmentId}))};
}
function bkIsTaken(s,d,t,exclude){return (s.taken||[]).some(x=>x.date===d&&x.time===t&&!(exclude&&x.date===exclude.date&&x.time===exclude.time))}

/* The censored week: free slots can be picked, booked ones show "Booked" with no name. */
function bkWeekGrid(s,start,selected,exclude){
    const days=Array.from({length:7},(_,i)=>bkAddDays(start,i));
    const open=days.flatMap(d=>bkSpans(s,d));
    const nav=`<div class="bk-week-nav"><button type="button" class="btn secondary small" data-bk="week" data-delta="-7" ${start<=localDate()?'disabled':''} aria-label="Previous week">‹</button><strong>${date(days[0])} – ${date(days[6])}</strong><button type="button" class="btn secondary small" data-bk="week" data-delta="7" aria-label="Next week">›</button></div>`;
    if(!open.length)return nav+'<p class="muted bk-week-empty">Closed all of this week. Try the next one.</p>';
    const first=Math.min(...open.map(h=>bkMinutes(h[0]))),last=Math.max(...open.map(h=>bkMinutes(h[1])));
    const rows=bkSlots(bkTime(first),bkTime(last));
    const head=`<span></span>${days.map(d=>{const x=new Date(d+'T12:00:00');return `<span class="bk-day-head ${d===localDate()?'today':''}">${x.toLocaleDateString('en-SG',{weekday:'short'})}<b>${x.getDate()}</b></span>`}).join('')}`;
    const body=rows.map(t=>`<span class="bk-time">${bkAmPm(t)}</span>`+days.map(d=>{
        if(!bkInSpans(bkSpans(s,d),t))return '<span class="bk-slot closed" aria-hidden="true"></span>';
        if(exclude&&exclude.date===d&&exclude.time===t)return `<button type="button" class="bk-slot current ${selected?.date===d&&selected?.time===t?'selected':''}" data-bk="pick" data-date="${d}" data-time="${t}" aria-label="${date(d)} ${bkAmPm(t)}, this booking">Now</button>`;
        if(bkIsTaken(s,d,t))return `<span class="bk-slot taken" title="Booked">Booked</span>`;
        if(bkPast(d,t))return '<span class="bk-slot past" aria-hidden="true"></span>';
        return `<button type="button" class="bk-slot free ${selected?.date===d&&selected?.time===t?'selected':''}" data-bk="pick" data-date="${d}" data-time="${t}" aria-label="${date(d)} ${bkAmPm(t)}, free"></button>`;
    }).join('')).join('');
    return nav+`<div class="bk-week" style="grid-template-columns:62px repeat(7,minmax(34px,1fr))">${head}${body}</div><div class="bk-legend"><span><i class="free"></i>Free</span><span><i class="taken"></i>Booked</span><span><i class="closed"></i>Closed</span></div>`;
}

/* ---------------------------------------------------------------- customer: book from a storefront */
let bkDraft=null;   // {num, businessId, schedule, start, selected, type, service, lines: {product name: quantity}}
booking=function(id){
    const b=business(id);if(!b.businessId)return;
    if(!bkHasHours(b)){toast(`${b.name} isn’t taking bookings yet.`);return}
    if(bkType(b)==='product'){bkOrder(id);return}
    bkDraft={num:id,businessId:b.businessId,schedule:{hours:b.hours,hoursMode:b.hoursMode,dates:b.dates,taken:[]},start:localDate(),selected:null,type:'visit',service:'',lines:{}};
    paintBookingModal(true);
    once('schedule-'+b.businessId,async()=>{bkDraft.schedule=await bkSchedule(b.businessId,true);paintBookingModal()});
};
function paintBookingModal(first=false){
    if(!bkDraft)return;
    const b=business(bkDraft.num),sel=bkDraft.selected;
    const keep=$('#booking-form-v2')?Object.fromEntries(new FormData($('#booking-form-v2'))):null;
    if(keep)bkDraft.service=keep.service??bkDraft.service;
    if($('#booking-form-v2 .order-table'))bkDraft.lines=Object.fromEntries(readOrder($('#booking-form-v2'),false).map(l=>[l.name,l.quantity]));
    // A business with priced products: tick what you'd like (same table as Log a visit, in recommendations.js)
    const priced=recPriced(b);
    const what=priced.length?`<fieldset class="order-field"><legend>What would you like?</legend>${orderTable(priced,bkDraft.lines,'Estimated total','Service')}</fieldset>`
        :`<div class="field"><label for="bk-service">Service or order</label><input id="bk-service" name="service" maxlength="120" required value="${esc(bkDraft.service)}" placeholder="e.g. Ring fitting, 2 loaves of sourdough…"></div>`;
    const html=`<div class="modal-body bk-book"><section class="bk-book-schedule"><div class="eyebrow">${esc(b.name).toUpperCase()}’S SCHEDULE</div><h2>Pick a free 30-minute slot</h2><p class="muted">Open ${esc(bkHoursText(b))}. Other people’s bookings show as “Booked”, without names.</p><div id="bk-grid">${bkWeekGrid(bkDraft.schedule,bkDraft.start,sel)}</div></section>
        <section class="bk-book-form"><div class="eyebrow">A LITTLE SOMETHING TO LOOK FORWARD TO</div><h2>Book an appointment</h2>
        <form id="booking-form-v2" data-raw>
            ${what}
            <div class="field"><label>Date &amp; time</label><div class="bk-chosen ${sel?'':'empty'}">${sel?`${bkWhen(sel)} <small>· 30 min</small>`:'Pick a free slot on the schedule'}</div></div>
            <p class="subtle">The business confirms your request. You’ll see it, or any change they suggest, under <b>Bookings</b>.</p>
            <button class="btn full" ${sel?'':'disabled'}>Send booking request</button>
        </form></section></div>`;
    if(first||!$('#modal').open){if($('#modal').open)$('#modal').close();showModal(html)}
    else{$('#modal .modal-body').outerHTML=html;polishCopy()}
    $('#modal').classList.add('bk-modal');
    orderRecalc($('#booking-form-v2'));
}
formHandlers['booking-form-v2']=async(d,form)=>{
    if(!bkDraft?.selected)throw new GroveAPI.ApiError(400,'Pick a free slot on the schedule first.');
    // Ticked products: the server writes the service ("2 × Cookies, 1 × Tea") and keeps the order and its estimate
    const lines=form?.querySelector('.order-table')?readOrder(form):null;
    if(lines&&!lines.length)throw new GroveAPI.ApiError(400,'Tick at least one product.');
    const {appointment}=await GroveAPI.bookAppointment({businessId:bkDraft.businessId,...(lines?{lines}:{service:d.service}),
        date:bkDraft.selected.date,time:bkDraft.selected.time,customerName:state.profile.name});
    bkReplace(appointment);bkSchedules.delete(bkDraft.businessId);bkDraft=null;
    closeModal();msgr.selected=appointment.appointmentId;bkCal.day=appointment.date;bkCal.month=appointment.date.slice(0,7);go('bookings');
    toast('Request sent · the business will confirm it here');
};

/* ---------------------------------------------------------------- customer: place an order to collect (product businesses)
   Only while the business is open: tick what you'd like and a time later today to collect it. */
function bkPickupTimes(b){
    const today=localDate(),now=bkMinutes(bkNowHHMM());
    return bkSpans(b,today).flatMap(([a,z])=>bkSlots(a,z)).filter(t=>bkMinutes(t)>now);
}
function bkOrder(id){
    const b=business(id),s=bkOpenStatus(b),times=bkPickupTimes(b);
    if(!s.open||!times.length){toast(`${b.name} is closed right now${s.detail?' · '+s.detail:''}. You can order while it’s open.`);return}
    const priced=recPriced(b);
    const what=priced.length?`<fieldset class="order-field"><legend>What would you like?</legend>${orderTable(priced,{},'Estimated total')}</fieldset>`
        :`<div class="field"><label for="order-what">What would you like?</label><input id="order-what" name="service" maxlength="120" required placeholder="e.g. 2 loaves of sourdough"></div>`;
    closeModal();
    showModal(`<div class="modal-body bk-order"><div class="eyebrow">ORDER TO COLLECT</div><h2>${esc(b.name)}</h2><p class="muted">Open now · ${esc(s.detail)}. Pick it up from their home today.</p>
        <form id="order-form" data-id="${id}" data-raw>${what}
        <div class="field"><label for="order-time">Collect at</label><select id="order-time" name="time">${times.map(t=>`<option value="${t}">${bkAmPm(t)}</option>`).join('')}</select></div>
        <button class="btn full">Place order</button></form></div>`);
    orderRecalc($('#order-form'));
}
formHandlers['order-form']=async(d,form)=>{
    const b=business(Number(form.dataset.id));
    const lines=form.querySelector('.order-table')?readOrder(form):null;
    if(lines&&!lines.length)throw new GroveAPI.ApiError(400,'Tick at least one product.');
    const {appointment}=await GroveAPI.bookAppointment({businessId:b.businessId,...(lines?{lines}:{service:d.service}),
        date:localDate(),time:d.time,customerName:state.profile.name});
    bkReplace(appointment);closeModal();msgr.selected=appointment.appointmentId;bkCal.day=appointment.date;bkCal.month=appointment.date.slice(0,7);go('bookings');
    toast(`Order placed · collect it at ${bkAmPm(appointment.time)}`);
};

/* Storefront: book only when opening hours are set, and show them like a map listing:
   "Open · Closes 5:00pm", tap to see the whole week */
function bkOpenStatus(src,now=new Date()){
    const today=now.toLocaleDateString('en-CA'),t=bkNowHHMM(),spans=bkSpans(src,today);
    const cur=spans.find(([a,z])=>t>=a&&bkMinutes(t)<bkMinutes(z));
    if(cur){
        const soon=bkMinutes(cur[1])-bkMinutes(t)<=60;
        return {open:true,label:soon?'Closes soon':'Open',detail:cur[1]==='24:00'?'Closes at midnight':`Closes ${bkAmPm(cur[1])}`,soon};
    }
    const later=spans.find(([a])=>a>t);
    if(later)return {open:false,label:'Closed',detail:`Opens ${bkAmPm(later[0])}`};
    for(let i=1;i<=7;i++){
        const d=bkAddDays(today,i),n=bkSpans(src,d)[0];
        if(n)return {open:false,label:'Closed',detail:`Opens ${bkAmPm(n[0])} ${i===1?'tomorrow':new Date(d+'T12:00:00').toLocaleDateString('en-SG',{weekday:'short'})}`};
    }
    return {open:false,label:'Closed',detail:''};
}
function bkWeekTable(src){
    // The 7 days from today, today in bold
    const days=Array.from({length:7},(_,i)=>bkAddDays(localDate(),i));
    const name=d=>src?.hoursMode==='irregular'?new Date(d+'T12:00:00').toLocaleDateString('en-SG',{weekday:'short',day:'numeric',month:'short'}):BK_DAY_NAMES[bkDayKey(d)];
    return `<table class="hours-week">${days.map((d,i)=>{const sp=bkSpans(src,d);return `<tr class="${i===0?'today':''}"><th scope="row">${name(d)}</th><td>${sp.length?bkSpanText(sp).replaceAll(', ','<br>'):'Closed'}</td></tr>`}).join('')}</table>`;
}
function bkHoursBlock(src){
    const s=bkOpenStatus(src);
    return `<details class="store-hours"><summary><span class="hours-icon" aria-hidden="true">🕒</span><span class="hours-status ${s.open?(s.soon?'soon':'open'):'closed'}">${s.label}</span>${s.detail?`<span class="hours-detail">· ${s.detail}</span>`:''}<span class="hours-caret" aria-hidden="true"></span><span class="sr-only">Show opening hours for the week</span></summary>${bkWeekTable(src)}</details>`;
}
// Opening hours sit in the top of the storefront only (23 Oct); the actions are built in recommendations.js
const storefrontMarkupBeforeBookings=storefrontMarkup;
storefrontMarkup=function(id,preview=false){
    const b=business(id),t=document.createElement('template');t.innerHTML=storefrontMarkupBeforeBookings(id,preview);
    const meta=t.content.querySelector('.store-meta');
    if(meta&&bkHasHours(b))meta.insertAdjacentHTML('afterend',bkHoursBlock(b));
    return t.innerHTML;
};

/* ---------------------------------------------------------------- one booking: details, then the conversation
   Customers open it from the calendar on their Bookings page; owners get it as a popup. */
const msgr={selected:null,side:'customer',schedule:null};
function bkTimeOptions(a,side,d){
    const b=business(a.businessId),s=side==='owner'?bkOwnSchedule():(msgr.schedule||{hours:b.hours||{},hoursMode:b.hoursMode,dates:b.dates,taken:[]});
    const spans=bkSpans(s,d),exclude={date:a.date,time:a.time};
    const times=side==='owner'?[...BK_ALL_TIMES]:spans.flatMap(([x,z])=>bkSlots(x,z));
    if(!times.includes(a.time)&&d===a.date)times.push(a.time);
    if(!times.length)return '<option value="">Closed this day</option>';
    return times.sort().map(t=>{
        const own=d===a.date&&t===a.time,taken=!own&&a.type!=='pickup'&&bkIsTaken(s,d,t,exclude),past=!own&&bkPast(d,t);
        const outside=!bkInSpans(spans,t);
        const note=own?' · current':taken?' · booked':past?' · passed':outside?' · outside hours':'';
        return `<option value="${t}" ${own?'selected':''} ${taken||past?'disabled':''}>${bkAmPm(t)}${note}</option>`;
    }).join('');
}
// A booking that can be logged: confirmed and not logged yet. 29 Oct: on any day (logging is how the site is tested)
const bkCanLog=a=>a.mine&&a.status==='Confirmed'&&!a.visitLogged;
// The owner can log a confirmed booking at their business too (29 Oct). An order to collect only once it's on
// Today's purchases (30 Oct): the owner has clicked Got it, and it's for today.
const bkOwnerCanLog=a=>a.atMyBusiness&&a.status==='Confirmed'&&!a.visitLogged&&(a.type!=='pickup'||(!!a.seenOwnerAt&&a.date===localDate()));
/* What a booking is for (29 Oct): one row per product or service, each a dropdown of the business's menu with
   the quantity on the right, "×" to remove a row and "+ Add product / service" for another one. */
function bkMenuFor(a,side){return recPriced(side==='owner'?state.business:business(a.businessId))}
function bkLineRow(menu,name='',qty=1,disabled=false){
    const opts=`<option value="">Choose…</option>`+menu.map(p=>`<option value="${esc(p.name)}" ${p.name===name?'selected':''}>${esc(p.name)} · ${money(p.price)}</option>`).join('');
    return `<div class="bk-line"><select name="line-name" aria-label="Product or service" ${disabled?'disabled':''}>${opts}</select><input name="line-qty" type="number" min="1" max="99" step="1" inputmode="numeric" value="${qty}" aria-label="Quantity" ${disabled?'disabled':''}>${disabled?'':`<button type="button" class="bk-line-x" data-bk-line="remove" aria-label="Remove this line">×</button>`}</div>`;
}
function bkLinesField(a,menu,open,what){
    const rows=(a.lines?.length?a.lines:[{name:'',quantity:1}]).map(l=>bkLineRow(menu,l.name,Number(l.quantity)||1,!open)).join('');
    const old=!a.lines?.length&&a.service?`<small class="muted">Booked as “${esc(a.service)}”. Pick from the menu to change it.</small>`:'';
    return `<fieldset class="field bk-lines" data-what="${what}"><legend>${what==='service'?'Services':'Products'}</legend><div class="bk-line-rows">${rows}</div>${open?`<button type="button" class="text-btn bk-line-add" data-bk-line="add">+ Add ${what}</button>`:''}<p class="bk-line-total muted" data-bk-total></p>${old}</fieldset>`;
}
// The rows as [{name, quantity}], the same product twice counts once with both quantities
function bkReadLines(form){
    const sum=new Map();
    form.querySelectorAll('.bk-line').forEach(r=>{const n=r.querySelector('[name="line-name"]').value,q=Number(r.querySelector('[name="line-qty"]').value);if(n)sum.set(n,(sum.get(n)||0)+(Number.isInteger(q)&&q>0?q:0))});
    return [...sum].map(([name,quantity])=>({name,quantity}));
}
function bkLinesTotal(form){
    const el=form?.querySelector('[data-bk-total]');if(!el)return;
    const a=state.appointments.find(x=>x.appointmentId===form.dataset.id),menu=a?bkMenuFor(a,msgr.side):[];
    const cents=bkReadLines(form).reduce((t,l)=>{const p=menu.find(m=>m.name===l.name);return t+(p?Math.round(Number(p.price)*100)*l.quantity:0)},0);
    el.textContent=cents?`Estimated total ${money(cents/100)}`:'';
}
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-bk-line]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const field=el.closest('.bk-lines'),rows=field?.querySelector('.bk-line-rows'),form=el.closest('form');if(!rows)return;
    const a=state.appointments.find(x=>x.appointmentId===form?.dataset.id);if(!a)return;
    if(el.dataset.bkLine==='add'){rows.insertAdjacentHTML('beforeend',bkLineRow(bkMenuFor(a,msgr.side)));rows.lastElementChild.querySelector('select').focus()}
    if(el.dataset.bkLine==='remove'){el.closest('.bk-line').remove();if(!rows.children.length)rows.insertAdjacentHTML('beforeend',bkLineRow(bkMenuFor(a,msgr.side)))}
    bkLinesTotal(form);const b=$('#bk-suggest');if(b)b.disabled=!bkEditChanged();
},true);
function messengerDetail(a,side){
    const st=bkStatus(a,side),open=!BK_CLOSED.includes(a.status),walkIn=!a.customerUserId;
    const who=side==='owner'?['Customer',a.name+(walkIn?' (walk-in)':'')]:['Business',a.businessName||business(a.businessId).name];
    const actions=open?[
        bkNeedsMe(a,side)?`<button type="button" class="btn small" data-bk="confirm" data-id="${esc(a.appointmentId)}">Confirm</button>`:'',
        side==='customer'&&bkCanLog(a)?`<button type="button" class="btn small" data-backend="log-visit" data-appt="${esc(a.appointmentId)}">Log visit</button>`:'',
        side==='owner'&&bkOwnerCanLog(a)?`<button type="button" class="btn small" data-owner-log="${esc(a.appointmentId)}">Log visit</button>`:'',
        `<button type="submit" class="btn secondary small" id="bk-suggest" disabled>${walkIn&&side==='owner'?'Save changes':'Suggest changes'}</button>`,
        `<button type="button" class="text-btn danger" data-bk="cancel" data-id="${esc(a.appointmentId)}">Cancel booking</button>`
    ].join(''):'';
    return `<div class="msgr-detail no-chat" data-id="${esc(a.appointmentId)}">
        <div class="msgr-detail-head"><h2>Appointment management</h2><span class="bk-chip ${st.cls}">${st.label}</span>${side==='customer'?'<button type="button" class="text-btn msgr-close" data-bk="close-detail">Close</button>':''}</div>
        <form id="bk-edit-form" class="bk-edit" data-id="${esc(a.appointmentId)}" data-raw>
            <div class="form-grid"><div class="field"><label>${who[0]}</label><input value="${esc(who[1])}" readonly disabled></div>
            <div class="field"><label>Type</label><input value="${a.type==='pickup'?'Order to collect':'Appointment'}" readonly disabled></div></div>
            ${bkMenuFor(a,side).length?bkLinesField(a,bkMenuFor(a,side),open,bkType(side==='owner'?state.business:business(a.businessId))==='service'?'service':'product')
                :`<div class="field"><label for="bk-edit-service">Service / order</label><input id="bk-edit-service" name="service" maxlength="120" value="${esc(a.service)}" ${open?'':'disabled'} required>${a.estimate!=null?`<small class="muted">Estimated total ${money(a.estimate)}, from the prices when it was booked</small>`:''}</div>`}
            <div class="form-grid"><div class="field"><label for="bk-edit-date">Date</label><input id="bk-edit-date" name="date" type="date" min="${localDate()}" value="${a.date}" ${open?'':'disabled'} required></div>
            <div class="field"><label for="bk-edit-time">Time</label><select id="bk-edit-time" name="time" ${open?'':'disabled'}>${bkTimeOptions(a,side,a.date)}</select></div></div>
            ${open?`<div class="bk-actions">${actions}</div>`:`<p class="muted">This booking is ${a.status.toLowerCase()}, so it can’t be changed.</p>`}
        </form>
    </div>`;
}
function paintMessenger(){
    const host=$('#msgr-host');if(!host)return;
    msgr.side=host.dataset.side;
    if(msgr.side==='owner'){
        const a=state.appointments.find(x=>x.appointmentId===msgr.selected);
        host.innerHTML=a?messengerDetail(a,'owner'):'<p class="muted msgr-gone">This booking isn’t available any more.</p>';
    }else host.innerHTML=bookingsCalendarHTML();
    polishCopy();
    bkLinesTotal($('#bk-edit-form'));
    bkLoadCustomerSchedule();
}
function bkLoadCustomerSchedule(){
    if(msgr.side!=='customer')return;
    const a=state.appointments.find(x=>x.appointmentId===msgr.selected);if(!a)return;
    const businessId=a.rawBusinessId;
    if(msgr.schedule&&msgr.schedule.businessId===businessId)return;
    once('msgr-schedule',async()=>{const s=await bkSchedule(businessId,true);msgr.schedule={...s,businessId};
        const sel=$('#bk-edit-time'),d=$('#bk-edit-date')?.value;if(sel&&d&&msgr.selected===a.appointmentId)sel.innerHTML=bkTimeOptions(a,'customer',d)});
}
function openMessengerModal(id){
    msgr.selected=id||msgr.selected;msgr.schedule=null;
    showModal(`<div class="modal-body msgr-modal-body"><div id="msgr-host" data-side="owner"></div></div>`);
    $('#modal').classList.add('bk-modal','msgr-modal');
    paintMessenger();
}
function bkRepaintAll(){
    renderPage();   // the page underneath (Bookings, Overview or Calendar)
    if($('#modal').open&&$('#msgr-host'))paintMessenger();
    bkPaintBadges();
}

/* Changes in the edit form: enable "Suggest changes" only when something differs */
function bkEditChanged(){
    const f=$('#bk-edit-form');if(!f)return false;
    const a=state.appointments.find(x=>x.appointmentId===f.dataset.id);if(!a)return false;
    const d=Object.fromEntries(new FormData(f));
    const lines=f.querySelector('.bk-lines')?bkReadLines(f):null;
    const what=lines?lines.length&&JSON.stringify(lines)!==JSON.stringify((a.lines||[]).map(l=>({name:l.name,quantity:Number(l.quantity)}))):String(d.service||'').trim()!==a.service;
    return !!what||d.date!==a.date||(d.time&&d.time!==a.time);
}
document.addEventListener('input',e=>{if(e.target.closest?.('#bk-edit-form')){bkLinesTotal($('#bk-edit-form'));const b=$('#bk-suggest');if(b)b.disabled=!bkEditChanged()}});
document.addEventListener('change',e=>{
    if(e.target.id==='bk-edit-date'){
        const f=$('#bk-edit-form'),a=state.appointments.find(x=>x.appointmentId===f?.dataset.id);
        if(a)$('#bk-edit-time').innerHTML=bkTimeOptions(a,msgr.side,e.target.value).replace(' selected','');
        const first=[...$('#bk-edit-time').options].find(o=>!o.disabled);if(first)first.selected=true;
    }
    if(e.target.closest?.('#bk-edit-form')){const b=$('#bk-suggest');if(b)b.disabled=!bkEditChanged()}
});
formHandlers['bk-edit-form']=async(d,form)=>{
    if(!bkEditChanged())throw new GroveAPI.ApiError(400,'Change the service, date or time first.');
    if(!d.time)throw new GroveAPI.ApiError(400,'Please choose a time.');
    const a=state.appointments.find(x=>x.appointmentId===form.dataset.id);
    const lines=form.querySelector('.bk-lines')?bkReadLines(form):null;
    if(lines&&!lines.length)throw new GroveAPI.ApiError(400,'Choose at least one item from the menu.');
    if(lines?.some(l=>!(l.quantity>=1&&l.quantity<=99)))throw new GroveAPI.ApiError(400,'Quantities must be whole numbers from 1 to 99.');
    const {appointment}=await GroveAPI.updateAppointment(a.appointmentId,{action:'propose',...(lines?{lines}:{service:d.service}),date:d.date,time:d.time});
    bkReplace(appointment);
    if(mode==='owner')moveCalendarTo(appointment.date);
    bkRepaintAll();toast(appointment.customerUserId?(msgr.side==='owner'?'Change sent · waiting for the customer to confirm':'Change sent · waiting for the business to confirm'):'Booking updated');
};
/* ---------------------------------------------------------------- clicks on booking controls */
async function bkAct(id,action,done){
    const {appointment}=await GroveAPI.updateAppointment(id,{action});
    bkReplace(appointment);
    if(action!=='confirm')bkSchedules.clear();
    bkRepaintAll();toast(done);
}
// The owner has seen a new order (Update_Appointment "read")
async function bkMarkSeen(id,repaint=false){
    const a=state.appointments.find(x=>x.appointmentId===id);if(a)a.seenOwnerAt=new Date().toISOString();
    bkPaintBadges();if(repaint)bkRepaintAll();
    try{const {appointment}=await GroveAPI.updateAppointment(id,{action:'read'});bkReplace(appointment)}catch{}
}
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-bk]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();
    const id=el.dataset.id,k=el.dataset.bk;
    if(k==='week'){
        if(bkDraft){bkDraft.start=[localDate(),bkAddDays(bkDraft.start,Number(el.dataset.delta))].sort()[1];$('#bk-grid').innerHTML=bkWeekGrid(bkDraft.schedule,bkDraft.start,bkDraft.selected)}
        return;
    }
    if(k==='pick'){
        if(bkDraft){bkDraft.selected={date:el.dataset.date,time:el.dataset.time};paintBookingModal()}
        return;
    }
    if(k==='open'){
        const a=state.appointments.find(x=>x.appointmentId===id);if(a)bkCal.day=a.date;
        msgr.selected=id;msgr.schedule=null;paintMessenger();
        $('.bk-cal-detail')?.scrollIntoView({block:'start',behavior:'smooth'});return;
    }
    if(k==='close-detail'){msgr.selected=null;paintMessenger();return}
    if(k==='cal-month'){bkCalMove(Number(el.dataset.delta));paintMessenger();return}
    if(k==='cal-day'){bkCal.day=el.dataset.date;paintMessenger();return}
    if(k==='edit'){const a=state.appointments.find(x=>x.appointmentId===id);if(a&&bkNewOrder(a))bkMarkSeen(id);openMessengerModal(id);return}
    if(k==='seen')return once('bk-'+id,()=>bkMarkSeen(id,true));
    if(k==='confirm')return once('bk-'+id,()=>bkAct(id,'confirm','Booking confirmed'));
    if(k==='cancel'){if(confirm('Cancel this booking? The other side will see it was cancelled.'))once('bk-'+id,()=>bkAct(id,'cancel','Booking cancelled'));return}
    if(k==='show-cancelled'){showCancelled=!showCancelled;renderPage();return}
},true);

/* ---------------------------------------------------------------- customer: Bookings page (below Discover) */
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('.bk-cal-day')){e.preventDefault();e.target.click()}});
// Sidebar: Home, Discover, Bookings, My wallet, History
{const i=customerNav.findIndex(n=>n[0]==='discover');if(!customerNav.some(n=>n[0]==='bookings'))customerNav.splice(i+1,0,['bookings','calendar','Bookings'])}
function bookingsPage(){
    return heading('Your bookings.','Tap a booking on the calendar to see its details.')+`<div id="msgr-host" data-side="customer"></div>`;
}
/* The calendar of your bookings; the chosen booking opens on the right */
const bkCal={month:null,day:null};   // month "YYYY-MM", day "YYYY-MM-DD"
function bkCalMove(delta){const [y,m]=bkCal.month.split('-').map(Number),d=new Date(y,m-1+delta,1);bkCal.month=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function bkCalPill(a){
    const st=bkStatus(a,'customer');
    return `<button type="button" class="bk-pill ${st.cls} ${a.appointmentId===msgr.selected?'active':''}" data-bk="open" data-id="${esc(a.appointmentId)}" title="${esc(bkAmPm(a.time)+' · '+(a.businessName||'')+' · '+st.label)}"><span>${bkAmPm(a.time)}</span> <b data-raw>${esc(a.businessName||business(a.businessId).name)}</b>${bkNeedsMe(a,'customer')?'<i class="bk-pill-dot" aria-label="Needs you"></i>':''}</button>`;
}
function bookingsCalendarHTML(){
    const list=bkMine('customer'),sel=list.find(a=>a.appointmentId===msgr.selected);
    if(!sel)msgr.selected=null;
    if(sel&&!bkCal.day)bkCal.day=sel.date;
    bkCal.day=bkCal.day||localDate();
    if(!bkCal.month||(sel&&!sel.date.startsWith(bkCal.month)&&msgr.focus!==sel.appointmentId))bkCal.month=(sel?sel.date:bkCal.day).slice(0,7);
    if(sel)msgr.focus=sel.appointmentId;
    const [y,m]=bkCal.month.split('-').map(Number),first=new Date(y,m-1,1).getDay(),count=new Date(y,m,0).getDate();
    const monthText=new Date(y,m-1,1).toLocaleDateString('en-SG',{month:'long',year:'numeric'});
    const shown=a=>!BK_CLOSED.includes(a.status)||a.appointmentId===msgr.selected;
    const cells=Array.from({length:count},(_,i)=>{
        const d=`${bkCal.month}-${String(i+1).padStart(2,'0')}`,day=list.filter(a=>a.date===d&&shown(a)).sort((a,b)=>a.time.localeCompare(b.time));
        return `<div class="day bk-cal-day ${d===bkCal.day?'selected':''} ${d===localDate()?'today':''}" data-bk="cal-day" data-date="${d}" role="button" tabindex="0" aria-label="${date(d)}, ${day.length} booking${day.length===1?'':'s'}"><b>${i+1}</b>${day.slice(0,3).map(bkCalPill).join('')}${day.length>3?`<small class="muted">+${day.length-3} more</small>`:''}${day.length?`<span class="bk-cal-dots" aria-hidden="true">${day.map(a=>`<i class="${bkStatus(a,'customer').cls}"></i>`).join('')}</span>`:''}</div>`;
    }).join('');
    const dayList=list.filter(a=>a.date===bkCal.day).sort((a,b)=>a.time.localeCompare(b.time));
    const needs=list.filter(a=>bkNeedsMe(a,'customer'));
    const calendarPanel=`<section class="panel bk-cal">
        ${needs.length?`<div class="bk-cal-needs"><strong>${needs.length} booking${needs.length===1?' needs':'s need'} you</strong>${needs.map(a=>`<button type="button" class="text-btn" data-bk="open" data-id="${esc(a.appointmentId)}" data-raw>${esc(a.businessName||'')} · ${bkWhen(a)}</button>`).join('')}</div>`:''}
        <div class="section-title" style="margin-top:0"><button type="button" class="btn secondary small" data-bk="cal-month" data-delta="-1" aria-label="Previous month">‹</button><h2>${monthText}</h2><button type="button" class="btn secondary small" data-bk="cal-month" data-delta="1" aria-label="Next month">›</button></div>
        <div class="calendar bk-calendar">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<span class="weekday">${d}</span>`).join('')}${Array.from({length:first},()=>'<span class="day blank"></span>').join('')}${cells}</div>
        <div class="bk-cal-list"><h3>${date(bkCal.day)}</h3>${dayList.map(a=>{const st=bkStatus(a,'customer');return `<button type="button" class="bk-cal-row ${a.appointmentId===msgr.selected?'active':''} ${BK_CLOSED.includes(a.status)?'closed':''}" data-bk="open" data-id="${esc(a.appointmentId)}"><span class="bk-cal-time">${bkAmPm(a.time)}</span><span class="bk-cal-row-text"><strong data-raw>${esc(a.businessName||'')}</strong><small data-raw>${a.type==='pickup'?'Order pickup · ':''}${esc(a.service)}</small></span><span class="bk-chip ${st.cls}">${st.label}</span></button>`}).join('')||`<p class="muted">${list.length?'Nothing booked on this day.':'Book a visit or an order pickup from any storefront. It will show up here.'}</p>`}</div>
    </section>`;
    return `<div class="bk-cal-wrap ${sel?'has-detail':''}">${calendarPanel}${sel?`<section class="panel bk-cal-detail">${messengerDetail(sel,'customer')}</section>`:''}</div>`;
}
const renderBeforeBookings=renderPage;
renderPage=function(){
    const content=$('#content');
    if(content&&groveReady&&!groveLoadError&&mode==='customer'&&route==='bookings'){
        content.innerHTML=bookingsPage();paintMessenger();paintAccountMenu();bkPaintBadges();return;
    }
    renderBeforeBookings();bkPaintBadges();
};
function bkPaintBadges(){
    document.querySelectorAll('.bk-badge').forEach(el=>el.remove());
    if(authStatus!=='signed-in'||!groveReady)return;
    const add=(href,n)=>{if(!n)return;document.querySelectorAll(`.nav a[href="${href}"]`).forEach(a=>a.insertAdjacentHTML('beforeend',`<span class="bk-badge" aria-label="${n} need attention">${n}</span>`))};
    add('#/customer/bookings',bkAttention('customer'));
    if(state.isBusiness)add('#/owner/dashboard',bkAttention('owner'));
}
// Keep people's own words exactly as typed (the old copy-polisher rewrites words like "demo")
const polishCopyBeforeBookings=polishCopy;
polishCopy=function(){
    const keep=[];document.querySelectorAll('[data-raw]').forEach(el=>{const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);while(w.nextNode())keep.push([w.currentNode,w.currentNode.textContent])});
    polishCopyBeforeBookings();keep.forEach(([n,t])=>{n.textContent=t});
};

/* ---------------------------------------------------------------- owner: Overview
   Appointment manager on the left, today's appointments on the right,
   then the four numbers in one row, then the business picture (income chart). */
// Open orders to collect (product) and appointments not yet confirmed by both sides (service) (23 Oct)
const bkOpenOrder=a=>a.type==='pickup'&&a.status==='Confirmed'&&a.date>=localDate();
function appointmentManager(){
    // 30 Oct: an order leaves "Waiting for you" once the owner clicks Got it; it then sits on Today's purchases
    const pending=bkMine('owner').filter(a=>a.status==='Pending'||(bkOpenOrder(a)&&!a.seenOwnerAt))
        .sort((x,y)=>((bkNeedsMe(y,'owner')||bkNewOrder(y))-(bkNeedsMe(x,'owner')||bkNewOrder(x)))||(x.date+x.time).localeCompare(y.date+y.time));
    return `<section class="panel bk-manager"><div class="section-title" style="margin-top:0"><div><div class="eyebrow">APPOINTMENT MANAGER</div><h2>Waiting for you</h2></div><span class="pill">${pending.length}</span></div>${pending.length?pending.map(a=>bkRow(a)).join(''):'<p class="muted">All caught up. Orders and booking requests will appear here.</p>'}</section>`;
}
// Today: orders that were collected and paid (product), confirmed appointments (service)
function todaysAppointments(){
    const today=localDate(),product=bkType(state.business)==='product';
    const list=bkMine('owner').filter(a=>a.date===today&&(a.type==='pickup'?a.status==='Completed'||(a.status==='Confirmed'&&!!a.seenOwnerAt):['Confirmed','Completed'].includes(a.status))).sort((x,y)=>x.time.localeCompare(y.time));
    return `<section class="panel bk-today"><div class="section-title" style="margin-top:0"><div><div class="eyebrow">TODAY · ${esc(date(today)).toUpperCase()}</div><h2>${product?'Today’s purchases':'Today’s appointments'}</h2></div><a class="text-btn" href="#/owner/calendar">View calendar</a></div>${list.map(a=>bkRow(a,{showDate:false})).join('')||`<p class="muted">${product?'No orders collected yet today.':'No confirmed appointments today.'}</p>`}</section>`;
}
function bkRow(a,{showDate=true}={}){
    const st=bkStatus(a,'owner'),extra=a.type==='pickup'?(a.status==='Completed'?(a.amountSpent!=null?`Paid ${money(a.amountSpent)}`:''):`Collecting at ${bkAmPm(a.time)}`):'';
    return `<div class="list-row bk-row ${BK_CLOSED.includes(a.status)?'closed':''}"><div><strong data-raw>${showDate?esc(bkWhen(a)):bkAmPm(a.time)} · ${esc(a.name)}</strong><p><span class="bk-chip ${st.cls}">${st.label}</span>${extra?' '+extra:''}</p><p data-raw>${esc(a.service)}</p></div><div class="bk-row-actions"><button class="text-btn" data-bk="edit" data-id="${esc(a.appointmentId)}">Edit</button>${bkOwnerCanLog(a)?`<button class="btn small secondary" data-owner-log="${esc(a.appointmentId)}">Log visit</button>`:''}${bkNeedsMe(a,'owner')?`<button class="btn small" data-bk="confirm" data-id="${esc(a.appointmentId)}">Confirm</button>`:''}${bkNewOrder(a)?`<button class="btn small" data-bk="seen" data-id="${esc(a.appointmentId)}">Got it</button>`:''}</div></div>`;
}
const dashboardBeforeBookings=dashboard;
dashboard=function(){
    const t=document.createElement('template');t.innerHTML=dashboardBeforeBookings();
    const stats=t.content.querySelector('.stats'),grid=t.content.querySelector('.grid2');
    grid?.querySelector('.owner-feature')?.remove();grid?.classList.add('single');
    if(stats){
        const top=document.createElement('div');top.className='overview-top';
        top.innerHTML=appointmentManager()+todaysAppointments();
        stats.before(top);
        if(grid)stats.after(grid);   // the business picture sits under the four numbers
    }
    return t.innerHTML;
};

/* ---------------------------------------------------------------- owner: Calendar day list */
let showCancelled=false;
const calendarBeforeBookings=calendar;
calendar=function(){
    const t=document.createElement('template');t.innerHTML=calendarBeforeBookings();
    const mine=state.appointments.filter(a=>a.atMyBusiness);
    t.content.querySelectorAll('.day[data-date]').forEach(btn=>{
        const n=mine.filter(a=>a.date===btn.dataset.date&&(a.status==='Pending'||a.status==='Confirmed')).length;
        btn.querySelector('.event-dot')?.remove();
        if(n)btn.insertAdjacentHTML('beforeend',`<span class="event-dot">${n} booking${n===1?'':'s'}</span>`);
        btn.setAttribute('aria-label',`${date(btn.dataset.date)}, ${n} bookings`);
    });
    const day=t.content.querySelector('.calendar-day');
    if(day){
        const all=mine.filter(a=>a.date===selectedDate).sort((x,y)=>x.time.localeCompare(y.time));
        const hidden=all.filter(a=>a.status==='Cancelled'||a.status==='Declined').length;
        const list=showCancelled?all:all.filter(a=>a.status!=='Cancelled'&&a.status!=='Declined');
        day.innerHTML=`<div class="section-title" style="margin-top:0"><h2>${date(selectedDate)}</h2></div><label class="toggle-row bk-cancel-toggle"><span>Show cancelled appointments${hidden?` <small class="muted">(${hidden})</small>`:''}</span><input type="checkbox" role="switch" class="switch" data-bk="show-cancelled" ${showCancelled?'checked':''}></label>`+
            (list.map(a=>bkRow(a,{showDate:false})).join('')||'<p class="muted">A little breathing room. Nothing booked on this day.</p>');
    }
    return t.innerHTML;
};

/* Owner's "+ New appointment": past customers get it as a request to confirm; walk-ins are confirmed straight away */
openAppointmentForm=function(){
    const people=new Map();
    state.customers.forEach(c=>{if(c.name&&!people.has(c.name))people.set(c.name,c.userId||'')});
    state.appointments.filter(a=>a.atMyBusiness&&a.name).forEach(a=>{if(!people.has(a.name)||(!people.get(a.name)&&a.customerUserId))people.set(a.name,a.customerUserId||'')});
    const names=[...people.keys()].sort((a,b)=>a.localeCompare(b));
    showModal(`<div class="modal-body"><h2>New appointment</h2><form id="appointment-form" data-raw><div class="field"><label for="name">Customer</label><input id="name" name="name" list="past-customers" autocomplete="off" required placeholder="${names.length?'Start typing a name…':'Customer name'}"><datalist id="past-customers">${names.map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist><small class="muted">Past customers with an account get it as a request to confirm. Anyone else is booked straight away.</small></div>
        <div class="field"><label for="appt-type">Booking type</label><select id="appt-type" name="type">${Object.entries(BK_TYPES).map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select></div>
        ${field('Service / order','service')}<div class="form-grid">${field('Date','date',selectedDate<localDate()?localDate():selectedDate,'date')}<div class="field"><label for="time">Time</label><select id="time" name="time">${BK_ALL_TIMES.map(t=>`<option value="${t}" ${t==='10:00'?'selected':''}>${bkAmPm(t)}</option>`).join('')}</select></div></div>
        <button class="btn">Add appointment</button></form></div>`);
    $('#appointment-form').dataset.people=JSON.stringify(Object.fromEntries(people));
    $('#name')?.focus();
};
formHandlers['appointment-form']=async(d,form)=>{
    const people=JSON.parse(form.dataset.people||'{}'),customerUserId=people[String(d.name||'').trim()]||'';
    const {appointment}=await GroveAPI.bookAppointment({customerName:d.name,service:d.service,type:d.type,date:d.date,time:d.time,...(customerUserId?{customerUserId}:{})});
    bkReplace(appointment);moveCalendarTo(d.date);closeModal();await loadDashboard();renderPage();
    toast(customerUserId?`Sent to ${d.name} · it’s confirmed once they accept`:'Appointment added');
};

/* ---------------------------------------------------------------- owner: opening hours calendar (My storefront, right column, 23 Oct)
   Works like a phone calendar: drag on an empty part of a day to add open hours, drag a block to move it
   (to another day too), drag its top or bottom edge to change the times, × removes it. A click adds an hour.
   On a phone, tap an empty time to add 2 hours, then drag the block.
   "Regular" is one week that repeats. "Irregular" is a strip of real dates from this week on: scroll it
   sideways (trackpad, Shift + mouse wheel, the wheel over the dates, or ‹ Today ›). Both are kept; the one
   chosen is what customers see. */
const SCHED_ROW=20,SCHED_SLOTS=48,SCHED_COL=58,SCHED_DAYS=119;   // px per half hour; half hours a day; px per dated column; days shown
let sched=null;   // {for: businessId, mode, hours: {mon: [[from, to]]}, dates: {date: [[from, to]]}}
let schedDrag=null;
function bkMonday(d){return bkAddDays(d,-BK_WEEK.indexOf(bkDayKey(d)))}
function schedFrom(b){
    const copy=o=>Object.fromEntries(Object.entries(o||{}).map(([k,v])=>[k,bkNorm(v).map(x=>[...x])]).filter(([,v])=>v.length));
    return {for:b?.businessId,mode:b?.hoursMode==='irregular'?'irregular':'regular',hours:copy(b?.hours),dates:copy(b?.dates)};
}
const schedKeys=()=>sched.mode==='regular'?[...BK_WEEK]:Array.from({length:SCHED_DAYS},(_,i)=>bkAddDays(bkMonday(localDate()),i));
const schedStore=()=>sched.mode==='regular'?sched.hours:sched.dates;
// Save one day's spans, merging any that overlap or touch
function schedPut(key,spans){
    const m=spans.map(([a,b])=>[bkMinutes(a),bkMinutes(b)]).filter(([a,b])=>b>a).sort((x,y)=>x[0]-y[0]),out=[];
    for(const [a,b] of m){const l=out[out.length-1];if(l&&a<=l[1])l[1]=Math.max(l[1],b);else out.push([a,b])}
    const store=schedStore();if(out.length)store[key]=out.map(([a,b])=>[bkTime(a),bkTime(b)]);else delete store[key];
}
function schedBlock(k,i,[a,b]){
    const top=bkMinutes(a)/30*SCHED_ROW,h=(bkMinutes(b)-bkMinutes(a))/30*SCHED_ROW;
    return `<div class="sched-block" data-key="${k}" data-i="${i}" style="top:${top}px;height:${h}px"><i class="sched-grip top" data-grip="top"></i><span>${bkShort(a)}–<br>${bkShort(b)}</span><button type="button" class="sched-x" data-sched="del" aria-label="Remove ${bkAmPm(a)} to ${bkAmPm(b)}">×</button><i class="sched-grip bottom" data-grip="bottom"></i></div>`;
}
function schedPanel(){
    const keys=schedKeys(),store=schedStore(),today=localDate(),dated=sched.mode==='irregular';
    const head=keys.map((k,i)=>{
        if(!dated)return `<span class="sched-dh">${BK_DAY_NAMES[k].slice(0,3)}</span>`;
        const x=new Date(k+'T12:00:00'),month=i===0||x.getDate()===1?x.toLocaleDateString('en-SG',{month:'short'}):'';
        return `<span class="sched-dh ${k===today?'today':''} ${k<today?'past':''}"><small>${month||'&nbsp;'}</small>${x.toLocaleDateString('en-SG',{weekday:'short'})}<b>${x.getDate()}</b></span>`;
    }).join('');
    const times=Array.from({length:23},(_,i)=>`<span style="top:${(i+1)*2*SCHED_ROW}px">${bkShort(bkTime((i+1)*60))}</span>`).join('');
    const cols=keys.map(k=>`<div class="sched-col ${dated&&k<today?'past':''}" data-key="${k}">${bkNorm(store[k]).map((sp,i)=>schedBlock(k,i,sp)).join('')}</div>`).join('');
    const nav=dated?`<div class="sched-nav"><button type="button" class="btn secondary small" data-sched="scroll" data-delta="-7" aria-label="Previous week">‹</button><button type="button" class="btn secondary small" data-sched="today">Today</button><button type="button" class="btn secondary small" data-sched="scroll" data-delta="7" aria-label="Next week">›</button></div>`:'';
    return `<section class="panel hours-panel" id="hours-panel"><div class="hours-panel-head"><h2>Opening hours</h2><div class="sched-mode" role="group" aria-label="Schedule type">${[['regular','Regular'],['irregular','Irregular']].map(([m,l])=>`<button type="button" data-sched="mode" data-mode="${m}" aria-pressed="${sched.mode===m}">${l}</button>`).join('')}</div></div>${nav}
        <div class="sched-scroll ${dated?'dated':''}"><div class="sched-grid" style="grid-template-columns:40px repeat(${keys.length},${dated?SCHED_COL+'px':'minmax(0,1fr)'})"><span class="sched-corner"></span>${head}<div class="sched-times" style="height:${SCHED_SLOTS*SCHED_ROW}px">${times}</div>${cols}</div></div>
        <div class="sched-foot"><button type="button" class="text-btn" data-sched="clear">Clear all</button><button type="button" class="btn small" data-sched="save">Save opening hours</button></div></section>`;
}
// Scroll the dated strip so today (or the given date) is the first column
function schedScrollTo(day){
    const n=$('#hours-panel .sched-scroll.dated');if(!n)return;
    const i=schedKeys().indexOf(day);if(i>=0)n.scrollLeft=i*SCHED_COL;
}
function schedPaint(keep=true){
    const p=$('#hours-panel');if(!p)return;
    const old=p.querySelector('.sched-scroll'),top=old?.scrollTop,left=old?.scrollLeft;
    p.outerHTML=schedPanel();
    const n=$('#hours-panel .sched-scroll');if(!n)return;
    n.scrollTop=keep&&top!=null?top:16*SCHED_ROW;
    if(keep&&left!=null)n.scrollLeft=left;else schedScrollTo(localDate());
}
const editorBeforeHours=editor;
editor=function(){
    const t=document.createElement('template');t.innerHTML=editorBeforeHours();
    if(!sched||sched.for!==state.business.businessId)sched=schedFrom(state.business);
    // No Customer preview (23 Oct): the opening hours sit right under the QR code
    const right=t.content.querySelector('.grid2 > section');
    right?.querySelector('.editor-preview')?.remove();
    right?.querySelector(':scope > p.subtle')?.remove();
    right?.insertAdjacentHTML('beforeend',schedPanel());
    return t.innerHTML;
};
// Open the calendar at 8am (and the dated strip at today)
const renderBeforeSched=renderPage;
renderPage=function(){renderBeforeSched();const n=$('#hours-panel .sched-scroll');if(n){n.scrollTop=16*SCHED_ROW;schedScrollTo(localDate())}};
// The mouse wheel over the dates scrolls the strip sideways
document.addEventListener('wheel',e=>{
    const n=e.target.closest?.('#hours-panel .sched-scroll.dated');if(!n||!e.target.closest('.sched-dh,.sched-corner'))return;
    e.preventDefault();n.scrollLeft+=e.deltaY||e.deltaX;
},{passive:false});
// ...and dragging the date row with the mouse pans it left and right
let schedPan=null;
document.addEventListener('pointerdown',e=>{
    const n=e.target.closest?.('#hours-panel .sched-scroll.dated');if(!n||e.button>0||!e.target.closest('.sched-dh,.sched-corner'))return;
    schedPan={n,x:e.clientX,left:n.scrollLeft};e.preventDefault();
});
document.addEventListener('pointermove',e=>{if(schedPan)schedPan.n.scrollLeft=schedPan.left-(e.clientX-schedPan.x)});
document.addEventListener('pointerup',()=>{schedPan=null});

const schedSlotAt=(col,y)=>Math.max(0,Math.min(SCHED_SLOTS-1,Math.floor((y-col.getBoundingClientRect().top)/SCHED_ROW)));
const schedColAtX=x=>[...document.querySelectorAll('#hours-panel .sched-col')].find(c=>{const r=c.getBoundingClientRect();return x>=r.left&&x<r.right});
function schedGhost(){
    const d=schedDrag,label=`${bkShort(bkTime(d.a*30))}–<br>${bkShort(bkTime(d.b*30))}`;
    d.el.style.top=d.a*SCHED_ROW+'px';d.el.style.height=(d.b-d.a)*SCHED_ROW+'px';
    const span=d.el.querySelector('span');if(span)span.innerHTML=label;else d.el.innerHTML=label;
}
document.addEventListener('pointerdown',e=>{
    if(!sched||e.button>0||e.target.closest?.('.sched-x'))return;
    const col=e.target.closest?.('#hours-panel .sched-col');if(!col)return;
    const block=e.target.closest('.sched-block');
    if(block){
        const [a,b]=bkNorm(schedStore()[block.dataset.key])[Number(block.dataset.i)].map(t=>bkMinutes(t)/30);
        schedDrag={kind:e.target.dataset.grip||'move',key:block.dataset.key,i:Number(block.dataset.i),a,b,grab:schedSlotAt(col,e.clientY)-a,el:block,moved:false};
        block.classList.add('dragging');
    }else{
        if(col.classList.contains('past'))return;
        const slot=schedSlotAt(col,e.clientY);
        // A finger on an empty time may be scrolling: add a block only on a tap (pointerup without moving)
        if(e.pointerType==='touch'){schedDrag={kind:'tap',key:col.dataset.key,slot,x:e.clientX,y:e.clientY};return}
        const el=document.createElement('div');el.className='sched-block ghost';col.append(el);
        schedDrag={kind:'new',key:col.dataset.key,anchor:slot,a:slot,b:slot+1,el,moved:false};schedGhost();
    }
    e.preventDefault();
    try{e.target.setPointerCapture(e.pointerId)}catch{}
});
document.addEventListener('pointermove',e=>{
    const d=schedDrag;if(!d)return;
    if(d.kind==='tap'){if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>8)schedDrag=null;return}
    let col=d.el.parentElement;
    if(d.kind==='move'){const over=schedColAtX(e.clientX);if(over&&over!==col&&!over.classList.contains('past')){over.append(d.el);col=over}}
    const slot=schedSlotAt(col,e.clientY);
    if(d.kind==='new'){d.a=Math.min(d.anchor,slot);d.b=Math.max(d.anchor,slot)+1}
    else if(d.kind==='top')d.a=Math.min(slot,d.b-1);
    else if(d.kind==='bottom')d.b=Math.max(slot+1,d.a+1);
    else{const len=d.b-d.a,a=Math.max(0,Math.min(SCHED_SLOTS-len,slot-d.grab));d.a=a;d.b=a+len}
    d.moved=true;schedGhost();
});
document.addEventListener('pointerup',()=>{
    const d=schedDrag;if(!d)return;schedDrag=null;
    const store=schedStore(),add=(key,a,b)=>schedPut(key,[...bkNorm(store[key]),[bkTime(a*30),bkTime(b*30)]]);
    if(d.kind==='tap'){const a=Math.min(d.slot,SCHED_SLOTS-4);add(d.key,a,a+4)}
    else if(d.kind==='new'){if(!d.moved)d.b=Math.min(SCHED_SLOTS,d.a+2);add(d.key,d.a,d.b)}   // a click adds an hour
    else if(d.moved){
        schedPut(d.key,bkNorm(store[d.key]).filter((_,j)=>j!==d.i));
        add(d.el.parentElement.dataset.key,d.a,d.b);
    }
    schedPaint();
});
document.addEventListener('pointercancel',()=>{if(schedDrag){schedDrag=null;schedPaint()}});
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-sched]');if(!el||!sched)return;
    e.preventDefault();e.stopImmediatePropagation();
    const k=el.dataset.sched,strip=$('#hours-panel .sched-scroll.dated');
    if(k==='mode'){sched.mode=el.dataset.mode;schedPaint(false)}
    if(k==='scroll'&&strip)strip.scrollBy({left:Number(el.dataset.delta)*SCHED_COL,behavior:'smooth'});
    if(k==='today')schedScrollTo(localDate());
    if(k==='del'){const b=el.closest('.sched-block');schedPut(b.dataset.key,bkNorm(schedStore()[b.dataset.key]).filter((_,j)=>j!==Number(b.dataset.i)));schedPaint()}
    if(k==='clear'){if(sched.mode==='regular')sched.hours={};else sched.dates={};schedPaint()}
    if(k==='save')once('sched-save',async()=>{
        const {business}=await GroveAPI.updateBusiness(schedPayload());
        upsertBusiness(business);Object.assign(state.business,{hours:business.hours||{},hoursMode:business.hoursMode||'regular',dates:business.dates||{}});
        toast(bkHasHours(state.business)?'Opening hours saved':'Opening hours saved. Customers can’t book or order until you add some.');
    });
},true);
// What Save sends (also sent by "Save storefront"); dates before today are dropped
function schedPayload(){return {hoursMode:sched.mode,hours:sched.hours,dates:Object.fromEntries(Object.entries(sched.dates).filter(([d])=>d>=localDate()))}}

/* ---------------------------------------------------------------- keep conversations fresh while open */
function bkSignature(){return state.appointments.map(a=>a.appointmentId+a.lastActivityAt+a.status).join('|')}
function bkWatching(){return !!$('#msgr-host')||(mode==='owner'&&['dashboard','calendar'].includes(route))}
function bkRefresh(){
    if(authStatus!=='signed-in'||!groveReady||busy.size)return;
    const before=bkSignature(),owner=mode==='owner'||($('#msgr-host')?.dataset.side==='owner');
    (owner?loadDashboard():loadMe()).then(()=>{
        if(bkSignature()===before)return;
        if($('#msgr-host')){paintMessenger();bkPaintBadges()}   // keeps the edit form in step with the other side
        else if(!$('#modal').open)renderPage();
    }).catch(()=>{});
}
// New requests and replies show up without a page reload: when you open a booking screen, and every 20 s while it's open
window.addEventListener('hashchange',()=>setTimeout(()=>{if(bkWatching())bkRefresh()},0));
setInterval(()=>{if(!document.hidden&&bkWatching())bkRefresh()},20000);

/* ---------------------------------------------------------------- owner: log a booking's visit (29 Oct)
   From Overview, the Calendar or the booking popup. The order as booked sets the amount; without one the owner
   types it. A customer with an account gets the visit in their chain (and its cash back); a walk-in doesn't. */
function bkOwnerLog(id){
    const a=state.appointments.find(x=>x.appointmentId===id);if(!a)return;
    const lines=a.lines||[],total=lines.reduce((t,l)=>t+Number(l.price)*Number(l.quantity),0);
    const order=lines.length?`<table class="plain-table owner-log-lines"><tbody>${lines.map(l=>`<tr><td>${Number(l.quantity)} × ${esc(l.name)}</td><td class="num">${money(Number(l.price)*Number(l.quantity))}</td></tr>`).join('')}</tbody><tfoot><tr><th scope="row">Total</th><td class="num">${money(total)}</td></tr></tfoot></table>`
        :`<p data-raw>${esc(a.service)}</p><div class="field"><label for="owner-log-amount">Amount paid (S$)</label><input id="owner-log-amount" name="amount" type="text" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" value="${a.estimate!=null?Number(a.estimate).toFixed(2):''}" required></div>`;
    showModal(`<div class="modal-body"><div class="eyebrow">LOG A VISIT</div><h2 data-raw>${esc(a.name||'Customer')}</h2><p class="muted">${a.type==='pickup'?'Order to collect':'Appointment'} · ${esc(bkWhen(a))}</p><form id="owner-log-form" data-id="${esc(a.appointmentId)}">${order}<p class="subtle">${a.customerUserId?'It’s added to their visits and chain, with any cash back it earns.':'A walk-in: it’s saved as a visit in your records.'}</p><button class="btn full">Log visit</button></form></div>`);
}
formHandlers['owner-log-form']=async(d,form)=>{
    const a=state.appointments.find(x=>x.appointmentId===form.dataset.id);if(!a)return;
    if(!a.lines?.length&&!/^\d+(\.\d{1,2})?$/.test(String(d.amount||'').trim()))throw new GroveAPI.ApiError(400,'Enter the amount paid, like 12.50.');
    await GroveAPI.recordVisit(state.business.businessId,{appointmentId:a.appointmentId,...(a.lines?.length?{}:{amount:String(d.amount).trim()})});
    closeModal();await loadDashboard();renderPage();bkPaintBadges();
    toast(`Visit logged for ${a.name||'your customer'}`);
};
window.addEventListener('click',e=>{
    const el=e.target.closest('[data-owner-log]');if(!el)return;
    e.preventDefault();e.stopImmediatePropagation();bkOwnerLog(el.dataset.ownerLog);
},true);
