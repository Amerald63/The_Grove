/* The Grove API client: one function per API Gateway route.
   Every call returns the parsed JSON body or throws GroveAPI.ApiError({status, message}). */
const GroveAPI=(()=>{
    const TOKEN_KEY='grove-token';
    let token=null;
    try{token=localStorage.getItem(TOKEN_KEY)}catch{}

    class ApiError extends Error{
        constructor(status,message,data){super(message);this.status=status;this.data=data}
    }

    const base=()=>String(window.GROVE_CONFIG?.apiBase||'').replace(/\/+$/,'');

    function setToken(value){
        token=value||null;
        try{token?localStorage.setItem(TOKEN_KEY,token):localStorage.removeItem(TOKEN_KEY)}catch{}
    }

    async function request(method,path,body,{auth=true}={}){
        if(!base())throw new ApiError(0,'The Grove isn’t connected to its server yet. Add your API Gateway URL to config.js.');
        const headers={Accept:'application/json'};
        if(body!==undefined)headers['Content-Type']='application/json';
        if(auth&&token)headers.Authorization='Bearer '+token;
        let res;
        try{
            res=await fetch(base()+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
        }catch{
            throw new ApiError(0,'We couldn’t reach The Grove. Check your connection and try again.');
        }
        let data=null;
        try{data=await res.json()}catch{}
        if(!res.ok){
            if(res.status===401&&auth){
                setToken(null);
                window.dispatchEvent(new CustomEvent('grove:signed-out'));
            }
            throw new ApiError(res.status,data?.message||`Something went wrong (error ${res.status}).`,data);
        }
        return data||{};
    }

    const id=v=>encodeURIComponent(v);
    return {
        ApiError,setToken,hasToken:()=>!!token,isConfigured:()=>!!base(),

        // Public
        signup:body=>request('POST','/auth/signup',body,{auth:false}),          // User_Signup
        login:body=>request('POST','/auth/login',body,{auth:false}),            // Login
        listBusinesses:()=>request('GET','/businesses',undefined,{auth:false}), // Get_HBB_Data
        getBusiness:businessId=>request('GET','/businesses/'+id(businessId),undefined,{auth:false}),
        getSchedule:businessId=>request('GET','/businesses/'+id(businessId)+'/schedule',undefined,{auth:false}), // Get_HBB_Data (hours + taken slots, no names)

        // Customer
        getMe:()=>request('GET','/me'),                                         // Get_Customer_Data
        updateMe:body=>request('PATCH','/me',body),                             // Update_User
        recordVisit:(businessId,extra={})=>request('POST','/visits',{businessId,...extra}), // New_Transaction ({amount, appointmentId, useCashback, item})
        getRecommendations:(params={})=>request('GET','/recommendations'+(Object.keys(params).length?'?'+new URLSearchParams(params):'')), // Get_Recommendations ({lat, lng, at})
        startNewChain:()=>request('POST','/chain/new',{}),                      // New_Chain_Session
        bookAppointment:body=>request('POST','/appointments',body),             // New_Appointment
        updateAppointment:(appointmentId,body)=>request('PATCH','/appointments/'+id(appointmentId),body), // Update_Appointment

        // Business owner
        createBusiness:body=>request('POST','/business',body),                  // New_HBB
        updateBusiness:body=>request('PATCH','/business',body),                 // Update_HBB
        getDashboard:(insightDays)=>request('GET','/business/dashboard'+(insightDays!=null?`?insightDays=${insightDays}`:'')),                  // Get_HBB_Dashboard
        addTransaction:body=>request('POST','/business/transactions',body),     // New_Transaction
        updateTransaction:(transactionId,body)=>request('PATCH','/business/transactions/'+id(transactionId),body) // Update_Transaction
    };
})();
