(function(){
  'use strict';

  var TOKEN_KEY='dof_api_token';
  var PROFILE_KEY='dof_api_profile';
  var PAGE_SIZE=12;

  var DEFAULT_CONTENT={
    heroTitle1Ar:'حيث يلتقي التصوير',
    heroTitle2Ar:'بالفرصة',
    heroTitle1En:'Where Photography',
    heroTitle2En:'Meets Opportunity',
    heroDescAr:'تواصل مع مصورين موهوبين واستكشف معارض مذهلة واحجز جلستك المثالية.',
    heroDescEn:'Connect with talented photographers, explore stunning portfolios, and book your perfect session.',
    footerAboutAr:'المنصة المتكاملة للمصورين والعملاء.',
    footerAboutEn:'The complete platform for photographers and clients.'
  };
  var DEFAULT_SETTINGS={
    registrationOpen:true,
    maintenanceMode:false,
    trialDays:7,
    maxFreePortfolioPhotos:6,
    basicPlanPriceEgp:400,
    premiumPlanPriceEgp:600,
    subscriptionPriceEgp:400
  };

  window.S={
    tab:'overview',admin:null,loading:false,error:'',
    customerPage:1,customerSearch:'',
    photoPage:1,photoSearch:'',photoStatus:'all',photoSubscription:'',
    bookingPage:1,bookingSearch:'',bookingStatus:'all',
    reportPage:1,reportStatus:'open',
    supportPage:1,supportStatus:'open',supportActiveId:null,
    subscriptionPage:1,subscriptionSearch:'',subscriptionStatus:'all',
    manualPaymentPage:1,manualPaymentStatus:'pending',manualPaymentRequests:[],manualPaymentTotal:0,
    notifPage:1,logPage:1,
    revenueRange:'monthly',visitRange:'monthly',
    overview:null,customers:[],customerTotal:0,
    photographers:[],photoTotal:0,
    bookings:[],bookingTotal:0,
    reports:[],reportTotal:0,
    supportConversations:[],supportTotal:0,supportMessages:[],
    subscriptions:[],subscriptionTotal:0,
    categories:[],
    notifications:[],notificationTotal:0,
    logs:[],logTotal:0,
    analytics:null,
    content:Object.assign({},DEFAULT_CONTENT),
    settings:Object.assign({},DEFAULT_SETTINGS),
    revenueData:{daily:[],weekly:[],monthly:[]},
    visitData:{daily:[],weekly:[],monthly:[]}
  };

  window.TABS=[
    {id:'overview',icon:'fa-table-cells-large',label:'نظرة عامة'},
    {id:'revenue',icon:'fa-chart-line',label:'الإيرادات'},
    {id:'visits',icon:'fa-eye',label:'الزيارات'},
    {id:'customers',icon:'fa-users',label:'العملاء'},
    {id:'photographers',icon:'fa-camera-retro',label:'المصورون'},
    {id:'bookings',icon:'fa-bookmark',label:'الحجوزات'},
    {id:'reports',icon:'fa-flag',label:'البلاغات'},
    {id:'support',icon:'fa-headset',label:'الدعم'},
    {id:'subscriptions',icon:'fa-crown',label:'الاشتراكات'},
    {id:'manual-payments',icon:'fa-money-bill-wave',label:'الدفعات اليدوية'},
    {id:'categories',icon:'fa-tags',label:'الأقسام'},
    {id:'content',icon:'fa-file-lines',label:'المحتوى'},
    {id:'notifications',icon:'fa-bell',label:'الإشعارات'},
    {id:'settings',icon:'fa-gear',label:'الإعدادات'},
    {id:'logs',icon:'fa-clock-rotate-left',label:'سجل النشاط'}
  ];

  function token(){try{return localStorage.getItem(TOKEN_KEY)||'';}catch(e){return'';}}
  function saveAuth(session,profile){
    try{
      if(session&&session.access_token)localStorage.setItem(TOKEN_KEY,session.access_token);
      if(profile)localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));
    }catch(e){}
  }
  function clearAuth(){try{localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(PROFILE_KEY);}catch(e){}}
  function readProfile(){try{var raw=localStorage.getItem(PROFILE_KEY);return raw?JSON.parse(raw):null;}catch(e){return null;}}
  function params(obj){
    var p=new URLSearchParams();
    Object.keys(obj||{}).forEach(function(k){if(obj[k]!==undefined&&obj[k]!==null&&obj[k]!==''&&obj[k]!=='all')p.set(k,obj[k]);});
    var qs=p.toString();return qs?'?'+qs:'';
  }
  async function api(path,options){
    options=options||{};
    var headers=Object.assign({'Content-Type':'application/json'},options.headers||{});
    var t=token();if(t)headers.Authorization='Bearer '+t;
    var res=await fetch(path,{method:options.method||'GET',headers:headers,body:options.body?JSON.stringify(options.body):undefined});
    var text=await res.text();
    var data=text?JSON.parse(text):{};
    if(!res.ok){
      var err=new Error((data.error&&data.error.message)||'Request failed');
      err.status=res.status;
      throw err;
    }
    return data;
  }
  function h(v){
    return String(v==null?'':v).replace(/[&<>"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  function fmt(n){return Number(n||0).toLocaleString('ar-EG');}
  function fmtMoney(n){return fmt(n)+' ج.م';}
  function fmtDate(d){if(!d)return'-';return new Date(d).toLocaleDateString('ar-EG',{year:'numeric',month:'short',day:'numeric'});}
  function fmtDateTime(d){if(!d)return'-';return new Date(d).toLocaleDateString('ar-EG',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
  function timeAgo(iso){
    if(!iso)return'-';
    var diff=Date.now()-new Date(iso).getTime();
    var m=Math.floor(diff/60000);
    if(m<1)return'الآن';if(m<60)return m+' د';
    var hr=Math.floor(m/60);if(hr<24)return hr+' س';
    var dy=Math.floor(hr/24);if(dy<7)return dy+' ي';
    return fmtDate(iso);
  }
  function statusBadge(st){
    var map={pending:'badge-pending',confirmed:'badge-confirmed',cancelled:'badge-cancelled',completed:'badge-active',active:'badge-active',inactive:'badge-inactive',suspended:'badge-suspended',hidden:'badge-inactive',open:'badge-pending',reviewing:'badge-featured',closed:'badge-active',failed:'badge-cancelled',overdue:'badge-pending'};
    var label={pending:'قيد الانتظار',confirmed:'مؤكد',cancelled:'ملغي',completed:'مكتمل',active:'نشط',inactive:'غير نشط',suspended:'موقوف',hidden:'مخفي',open:'مفتوح',reviewing:'قيد المراجعة',closed:'مغلق',failed:'فشل',overdue:'متأخر'};
    return '<span class="badge '+(map[st]||'badge-inactive')+'">'+h(label[st]||st||'-')+'</span>';
  }
  window.statusBadge=statusBadge;
  function smallStat(icon,label,value,sub,color){
    return '<div class="stat-card"><div class="flex items-center gap-3 mb-4"><div class="stat-icon" style="background:var(--accent-glow);color:var(--accent)"><i class="fas '+icon+'"></i></div><span class="text-muted" style="font-size:13px;font-weight:500">'+label+'</span></div><div style="font-size:26px;font-weight:700;margin-bottom:4px" class="font-display">'+value+'</div><div style="font-size:12px;color:'+color+';font-weight:500">'+sub+'</div></div>';
  }
  function empty(icon,title,body){
    return '<div class="empty-state"><i class="fas '+icon+'"></i><h3>'+title+'</h3>'+(body?'<p style="font-size:13px">'+body+'</p>':'')+'</div>';
  }
  function loading(){
    return '<div class="card p-8 text-center"><i class="fas fa-spinner fa-spin text-gold mb-3"></i><div class="text-muted">جاري تحميل البيانات...</div></div>';
  }
  function errorBox(msg){
    return '<div class="card p-8 text-center"><i class="fas fa-triangle-exclamation mb-3" style="color:var(--danger);font-size:24px"></i><div class="mb-4">'+h(msg||'تعذر تحميل البيانات')+'</div><button class="btn btn-primary btn-sm" onclick="reloadTab()">إعادة المحاولة</button></div>';
  }
  function pages(total,page){
    return Math.max(1,Math.ceil(Number(total||0)/PAGE_SIZE));
  }
  function pagination(current,total,fn){
    var max=pages(total,current);if(max<=1)return'';
    var html='<div class="pagination">';
    html+='<button '+(current<=1?'disabled':'')+' onclick="'+fn+'('+(current-1)+')"><i class="fas fa-chevron-right" style="font-size:11px"></i></button>';
    for(var i=1;i<=max;i++){
      if(max>7&&i>2&&i<max-1&&Math.abs(i-current)>1){if(i===3||i===max-2)html+='<button disabled>...</button>';continue;}
      html+='<button class="'+(i===current?'active':'')+'" onclick="'+fn+'('+i+')">'+i+'</button>';
    }
    html+='<button '+(current>=max?'disabled':'')+' onclick="'+fn+'('+(current+1)+')"><i class="fas fa-chevron-left" style="font-size:11px"></i></button></div>';
    return html;
  }

  function showLogin(message){
    S.admin=null;
    var dash=document.getElementById('admin-dashboard');
    var login=document.getElementById('login-screen');
    if(dash)dash.classList.add('hidden');
    if(login)login.classList.remove('hidden');
    if(message)showToast(message,'error');
  }
  function showDashboard(profile){
    S.admin=profile;
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('admin-dashboard').classList.remove('hidden');
    document.getElementById('sb-name').textContent=profile.display_name||profile.email||'Admin';
    document.getElementById('sb-avatar').textContent=(profile.display_name||profile.email||'A').charAt(0);
    document.getElementById('sb-role').textContent='مشرف عام';
    buildSidebar();
    switchTab(S.tab||'overview');
    loadNotifications(true).catch(function(){});
  }

  async function handleAdminLogin(e){
    e.preventDefault();
    var email=document.getElementById('admin-email').value.trim();
    var pass=document.getElementById('admin-pass').value;
    var err=document.getElementById('login-error');
    var btn=document.getElementById('login-btn');
    if(err)err.classList.add('hidden');
    btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> جارٍ التحقق...';
    try{
      var data=await api('/api/auth/login',{method:'POST',body:{email:email,password:pass}});
      if(!data.profile||data.profile.role!=='admin')throw new Error('هذا الحساب لا يملك صلاحية الإدارة');
      saveAuth(data.session,data.profile);
      showDashboard(data.profile);
      showToast('مرحباً '+(data.profile.display_name||''),'success');
    }catch(ex){
      clearAuth();
      if(err){err.textContent=ex.message||'فشل تسجيل الدخول';err.classList.remove('hidden');}
    }finally{
      btn.disabled=false;btn.innerHTML='<i class="fas fa-arrow-right-to-bracket"></i> تسجيل الدخول';
    }
  }
  async function restoreSession(){
    if(!token())return showLogin();
    try{
      var me=await api('/api/me');
      if(!me.profile||me.profile.role!=='admin')throw new Error('هذا الحساب لا يملك صلاحية الإدارة');
      saveAuth({access_token:token()},me.profile);
      showDashboard(me.profile);
    }catch(e){
      clearAuth();
      showLogin();
    }
  }
  function handleAdminLogout(){
    clearAuth();
    showLogin();
    showToast('تم تسجيل الخروج','info');
  }
  function canDo(){return !!S.admin;}

  function buildSidebar(){
    var nav=document.getElementById('sidebar-nav');if(!nav)return;
    nav.innerHTML=TABS.map(function(t){
      return '<div class="sidebar-link'+(S.tab===t.id?' active':'')+'" data-tab="'+t.id+'" onclick="switchTab(\''+t.id+'\')"><i class="fas '+t.icon+'"></i><span>'+t.label+'</span></div>';
    }).join('');
  }
  function switchTab(id){
    var tab=TABS.find(function(t){return t.id===id;});
    if(!tab)return;
    S.tab=id;S.error='';
    document.querySelectorAll('.sidebar-link').forEach(function(el){el.classList.toggle('active',el.dataset.tab===id);});
    var title=document.getElementById('page-title');if(title)title.textContent=tab.label;
    buildSidebar();
    renderTab();
    loadTab(id).catch(function(e){S.error=e.message;S.loading=false;renderTab();if(e.status===401||e.status===403){clearAuth();showLogin(e.message);}});
    if(window.innerWidth<1024){
      document.getElementById('admin-sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').classList.add('hidden');
    }
  }
  function toggleSidebar(){
    document.getElementById('admin-sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('hidden');
  }
  function checkMobile(){
    var btn=document.getElementById('menu-btn');
    if(btn)btn.style.display=window.innerWidth<1024?'flex':'none';
  }
  function renderTab(){
    var c=document.getElementById('tab-content');if(!c)return;
    if(S.loading){c.innerHTML=loading();return;}
    if(S.error){c.innerHTML=errorBox(S.error);return;}
    var renderers={
      overview:renderOverview,revenue:renderRevenue,visits:renderVisits,customers:renderCustomers,
      photographers:renderPhotographers,bookings:renderBookings,reports:renderReports,
      support:renderSupport,subscriptions:renderSubscriptions,'manual-payments':renderManualPayments,categories:renderCategories,content:renderContent,notifications:renderNotifications,
      settings:renderSettings,logs:renderLogs
    };
    c.innerHTML='<div class="scale-in">'+(renderers[S.tab]||renderOverview)()+'</div>';
    updateNotifBadge();
    setTimeout(function(){
      if(S.tab==='overview'&&window.drawChart){
        drawChart('mini-revenue',S.revenueData.monthly.slice(-6),'#C4915C');
      }
      if(S.tab==='revenue'&&window.drawChart)drawChart('revenue-chart',S.revenueData[S.revenueRange]||[],'#C4915C');
    },60);
  }
  async function loadTab(id){
    S.loading=true;renderTab();
    if(id==='overview')await loadOverview();
    else if(id==='revenue')await loadAnalytics(S.revenueRange);
    else if(id==='visits')await loadAnalytics(S.visitRange);
    else if(id==='customers')await loadCustomers();
    else if(id==='photographers')await loadPhotographers();
    else if(id==='bookings')await loadBookings();
    else if(id==='reports')await loadReports();
    else if(id==='support')await loadSupport();
    else if(id==='subscriptions')await loadSubscriptions();
    else if(id==='manual-payments')await loadManualPayments();
    else if(id==='categories')await loadCategories();
    else if(id==='content')await loadContent();
    else if(id==='settings')await loadSettings();
    else if(id==='notifications')await loadNotifications(false);
    else if(id==='logs')await loadLogs();
    S.loading=false;renderTab();
  }
  function reloadTab(){loadTab(S.tab).catch(function(e){S.error=e.message;S.loading=false;renderTab();});}
  var reloadTimer=null;
  function queueTabLoad(){
    clearTimeout(reloadTimer);
    reloadTimer=setTimeout(function(){reloadTab();},350);
  }

  async function loadOverview(){
    var data=await api('/api/admin/overview');
    S.overview=data;
    S.revenueData.monthly=(data.series&&data.series.monthlyRevenue)||[];
    S.revenueData.daily=(data.series&&data.series.dailyRevenue)||[];
  }
  async function loadAnalytics(range){
    var data=await api('/api/admin/analytics'+params({range:range}));
    S.analytics=data;
    S.revenueData[range]=data.revenueSeries||[];
    S.visitData[range]=data.visitSeries||[];
  }
  async function loadCustomers(){
    var data=await api('/api/admin/users'+params({role:'client',search:S.customerSearch,page:S.customerPage,pageSize:PAGE_SIZE}));
    S.customers=data.users||[];S.customerTotal=data.total||0;
  }
  async function loadPhotographers(){
    var data=await api('/api/admin/photographers'+params({search:S.photoSearch,status:S.photoStatus,subscription:S.photoSubscription,page:S.photoPage,pageSize:PAGE_SIZE}));
    S.photographers=data.photographers||[];S.photoTotal=data.total||0;
  }
  async function loadBookings(){
    var data=await api('/api/admin/bookings'+params({search:S.bookingSearch,status:S.bookingStatus,page:S.bookingPage,pageSize:PAGE_SIZE}));
    S.bookings=data.bookings||[];S.bookingTotal=data.total||0;
  }
  async function loadReports(){
    var data=await api('/api/admin/reports'+params({status:S.reportStatus,page:S.reportPage,pageSize:PAGE_SIZE}));
    S.reports=data.reports||[];S.reportTotal=data.total||0;
  }
  async function loadSupport(){
    var data=await api('/api/admin/support'+params({status:S.supportStatus,page:S.supportPage,pageSize:PAGE_SIZE}));
    S.supportConversations=data.conversations||[];S.supportTotal=data.total||0;
    if(S.supportActiveId&&!S.supportConversations.some(function(c){return c.id===S.supportActiveId;})){
      S.supportActiveId=null;
    }
    if(!S.supportActiveId&&S.supportConversations.length)S.supportActiveId=S.supportConversations[0].id;
    if(S.supportActiveId)await loadSupportMessages(S.supportActiveId);
    else S.supportMessages=[];
  }
  async function loadSupportMessages(id){
    if(!id){S.supportMessages=[];return;}
    var data=await api('/api/admin/support/'+id+'/messages');
    S.supportMessages=data.messages||[];
  }
  async function loadSubscriptions(){
    var data=await api('/api/admin/subscriptions'+params({search:S.subscriptionSearch,status:S.subscriptionStatus,page:S.subscriptionPage,pageSize:PAGE_SIZE}));
    S.subscriptions=data.subscriptions||[];S.subscriptionTotal=data.total||0;
  }
  async function loadCategories(){
    var data=await api('/api/admin/categories');
    S.categories=data.categories||[];
  }
  async function loadContent(){
    var data=await api('/api/admin/content');
    S.content=Object.assign({},DEFAULT_CONTENT,data.content||{});
  }
  async function loadSettings(){
    var data=await api('/api/admin/settings');
    S.settings=Object.assign({},DEFAULT_SETTINGS,data.settings||{});
  }
  async function loadNotifications(silent){
    try{
      var data=await api('/api/admin/notifications'+params({page:S.notifPage,pageSize:30}));
      S.notifications=data.notifications||[];S.notificationTotal=data.total||0;updateNotifBadge();
      if(!silent&&S.tab==='notifications')renderTab();
    }catch(e){if(!silent)throw e;}
  }
  async function loadLogs(){
    var data=await api('/api/admin/audit-logs'+params({page:S.logPage,pageSize:50}));
    S.logs=data.logs||[];S.logTotal=data.total||0;
  }

  function renderOverview(){
    var m=(S.overview&&S.overview.metrics)||{};
    var logs=(S.overview&&S.overview.latestLogs)||[];
    var users=(S.overview&&S.overview.latestUsers)||[];
    return '<div class="grid grid-4 gap-5 mb-8 stagger">'+
      smallStat('fa-money-bill-wave','إجمالي قيمة الحجوزات',fmtMoney(m.grossBookingValue),'حجوزات غير ملغاة','var(--success)')+
      smallStat('fa-users','المستخدمون',fmt(m.totalUsers),'عملاء '+fmt(m.clients)+' / مصورون '+fmt(m.photographers),'var(--accent)')+
      smallStat('fa-camera-retro','المصورون النشطون',fmt(m.activePhotographers),'موقوفون '+fmt(m.suspendedPhotographers),'var(--warn)')+
      smallStat('fa-flag','البلاغات المفتوحة',fmt(m.openReports),'تحتاج مراجعة','var(--danger)')+
    '</div>'+
    '<div class="grid grid-2 gap-6 mb-8" style="grid-template-columns:1fr 1fr">'+
      '<div class="card p-6"><div class="flex justify-between items-center mb-5"><h3 class="font-display font-bold" style="font-size:17px">الإيرادات</h3><button class="btn btn-ghost btn-sm" onclick="switchTab(\'revenue\')">عرض التفاصيل</button></div><div style="height:220px;position:relative"><canvas id="mini-revenue"></canvas></div></div>'+
      '<div class="card p-6"><div class="flex justify-between items-center mb-5"><h3 class="font-display font-bold" style="font-size:17px">الاشتراكات</h3><button class="btn btn-ghost btn-sm" onclick="switchTab(\'subscriptions\')">عرض الكل</button></div>'+
        '<div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr">'+
        smallStat('fa-crown','نشطة',fmt(m.activeSubscriptions),'إيراد '+fmtMoney(m.subscriptionRevenue),'var(--success)')+
        smallStat('fa-clock','معلقة/فاشلة',fmt((m.pendingSubscriptions||0)+(m.failedSubscriptions||0)),'تحتاج متابعة','var(--warn)')+
        '</div></div>'+
    '</div>'+
    '<div class="grid grid-2 gap-6" style="grid-template-columns:1fr 1fr">'+
      '<div class="card p-6"><div class="flex justify-between items-center mb-5"><h3 class="font-display font-bold" style="font-size:17px">أحدث المستخدمين</h3><button class="btn btn-ghost btn-sm" onclick="switchTab(\'customers\')">العملاء</button></div>'+
      (users.length?'<div class="space-y-3">'+users.map(function(u){return '<div class="flex items-center justify-between p-3 rounded-md" style="background:var(--bg2);border:1px solid var(--border)"><div><div style="font-size:13px;font-weight:600">'+h(u.display_name)+'</div><div class="text-dim" style="font-size:12px">'+h(u.email)+'</div></div>'+statusBadge(u.role)+'</div>';}).join('')+'</div>':empty('fa-users','لا يوجد مستخدمون'))+'</div>'+
      '<div class="card p-6"><div class="flex justify-between items-center mb-5"><h3 class="font-display font-bold" style="font-size:17px">النشاط الأخير</h3><button class="btn btn-ghost btn-sm" onclick="switchTab(\'logs\')">عرض الكل</button></div>'+
      (logs.length?logs.slice(0,8).map(logRow).join(''):empty('fa-clock','لا يوجد نشاط مسجل'))+'</div>'+
    '</div>';
  }
  function renderRevenue(){
    var data=S.revenueData[S.revenueRange]||[];
    var total=data.reduce(function(s,d){return s+Number(d.value||0);},0);
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">تحليل الإيرادات</h2><p class="text-muted mt-1" style="font-size:14px">إجمالي الفترة: <span class="gradient-text" style="font-weight:700">'+fmtMoney(total)+'</span></p></div><button class="btn btn-primary btn-sm" onclick="exportRevenue()"><i class="fas fa-download"></i>تصدير CSV</button></div>'+
    '<div class="card p-6 mb-6"><div class="flex flex-wrap items-center justify-between gap-4 mb-5"><h3 class="font-display font-bold" style="font-size:17px">قيمة الحجوزات</h3><div class="tab-filter"><button class="'+(S.revenueRange==='daily'?'active':'')+'" onclick="setRevenueRange(\'daily\')">يومي</button><button class="'+(S.revenueRange==='weekly'?'active':'')+'" onclick="setRevenueRange(\'weekly\')">أسبوعي</button><button class="'+(S.revenueRange==='monthly'?'active':'')+'" onclick="setRevenueRange(\'monthly\')">شهري</button></div></div><div style="height:320px;position:relative"><canvas id="revenue-chart"></canvas></div></div>'+
    '<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>الفترة</th><th>الإيرادات</th></tr></thead><tbody>'+data.map(function(d){return '<tr><td>'+h(d.label)+'</td><td style="font-weight:700;color:var(--accent)">'+fmtMoney(d.value)+'</td></tr>';}).join('')+'</tbody></table></div>';
  }
  function renderVisits(){
    return '<div class="mb-6"><h2 class="font-display" style="font-size:26px;font-weight:700">إحصائيات الزيارات</h2><p class="text-muted mt-1" style="font-size:14px">لم يتم إضافة تتبع زيارات حقيقي بعد.</p></div>'+
    '<div class="card">'+empty('fa-chart-line','لا توجد بيانات زيارات حقيقية','تم تعطيل الأرقام العشوائية. أضف جدول analytics_events لاحقاً لعرض الزيارات هنا.')+'</div>';
  }
  function renderCustomers(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">إدارة العملاء</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.customerTotal)+' عميل</p></div><button class="btn btn-primary btn-sm" onclick="exportCustomers()"><i class="fas fa-download"></i>تصدير</button></div>'+
    '<div class="search-bar mb-6" style="max-width:360px"><i class="fas fa-search"></i><input class="input" style="padding-right:42px;font-size:13px" placeholder="بحث بالاسم أو البريد أو الهاتف..." value="'+h(S.customerSearch)+'" oninput="S.customerSearch=this.value;S.customerPage=1;queueTabLoad()"></div>'+
    (S.customers.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>العميل</th><th>الهاتف</th><th>الحجوزات</th><th>المصروف</th><th>تاريخ الانضمام</th><th>إجراءات</th></tr></thead><tbody>'+S.customers.map(function(c){return '<tr><td><div class="flex items-center gap-3"><div class="avatar-initial sm" style="background:var(--accent-glow);color:var(--accent)">'+h((c.displayName||'?').charAt(0))+'</div><div><div style="font-size:13px;font-weight:600">'+h(c.displayName)+'</div><div class="text-dim" style="font-size:12px">'+h(c.email)+'</div></div></div></td><td>'+h(c.phone||'-')+'</td><td>'+fmt(c.bookingCount)+'</td><td style="font-weight:700;color:var(--accent)">'+fmtMoney(c.grossValue)+'</td><td>'+fmtDate(c.createdAt)+'</td><td><button class="btn-icon" onclick="viewUserDetail(\''+c.id+'\')" title="تفاصيل"><i class="fas fa-eye" style="font-size:12px"></i></button></td></tr>';}).join('')+'</tbody></table></div>':empty('fa-users','لا يوجد عملاء'))+
    pagination(S.customerPage,S.customerTotal,'goCustomerPage');
  }
  function renderPhotographers(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">إدارة المصورين</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.photoTotal)+' مصور</p></div><button class="btn btn-primary btn-sm" onclick="exportPhotographers()"><i class="fas fa-download"></i>تصدير</button></div>'+
    '<div class="flex flex-wrap gap-3 mb-6"><div class="search-bar" style="max-width:360px;flex:1"><i class="fas fa-search"></i><input class="input" style="padding-right:42px;font-size:13px" placeholder="بحث بالاسم أو التخصص أو المنطقة..." value="'+h(S.photoSearch)+'" oninput="S.photoSearch=this.value;S.photoPage=1;queueTabLoad()"></div><select class="input" style="width:auto" onchange="S.photoStatus=this.value;S.photoPage=1;reloadTab()"><option value="all">كل الحالات</option><option value="published" '+(S.photoStatus==='published'?'selected':'')+'>منشور</option><option value="hidden" '+(S.photoStatus==='hidden'?'selected':'')+'>مخفي</option><option value="suspended" '+(S.photoStatus==='suspended'?'selected':'')+'>موقوف</option></select></div>'+
    (S.photographers.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>المصور</th><th>التخصص</th><th>المنطقة</th><th>الحجوزات</th><th>الإيرادات</th><th>الاشتراك</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>'+S.photographers.map(function(p){return '<tr><td><div class="flex items-center gap-3"><div class="avatar-initial sm" style="background:var(--accent-glow);color:var(--accent)">'+h((p.display_name||'?').charAt(0))+'</div><div><div style="font-size:13px;font-weight:600">'+h(p.display_name)+'</div><div class="text-dim" style="font-size:12px">'+h(p.email||'')+'</div></div></div></td><td>'+h(p.specialty||'-')+'</td><td>'+h(p.region||'-')+'</td><td>'+fmt(p.booking_count)+'</td><td style="font-weight:700;color:var(--accent)">'+fmtMoney(p.grossRevenue)+'</td><td>'+statusBadge(p.subscription_status)+'</td><td>'+statusBadge(p.status)+'</td><td><div class="flex gap-2"><button class="btn-icon" onclick="viewPhotoDetail(\''+p.id+'\')" title="تفاصيل"><i class="fas fa-eye" style="font-size:12px"></i></button><button class="btn-icon '+(p.is_suspended?'':'danger')+'" onclick="togglePhotoStatus(\''+p.id+'\')" title="'+(p.is_suspended?'تفعيل':'إيقاف')+'"><i class="fas '+(p.is_suspended?'fa-check':'fa-ban')+'" style="font-size:12px"></i></button><button class="btn-icon" onclick="togglePhotoPublished(\''+p.id+'\')" title="'+(p.is_published?'إخفاء':'نشر')+'"><i class="fas '+(p.is_published?'fa-eye-slash':'fa-eye')+'" style="font-size:12px"></i></button>'+((p.subscription_status==='active'||p.subscription_status==='overdue')?'<button class="btn-icon danger" onclick="cancelPhotographerSubscription(\''+p.id+'\')" title="إلغاء الاشتراك فقط"><i class="fas fa-times-circle" style="font-size:12px"></i></button>':'')+'<button class="btn-icon danger" onclick="fraudSuspendPhotographer(\''+p.id+'\')" title="إلغاء الاشتراك وإيقاف الحساب للاحتيال"><i class="fas fa-user-lock" style="font-size:12px"></i></button></div></td></tr>';}).join('')+'</tbody></table></div>':empty('fa-camera-retro','لا يوجد مصورون'))+
    pagination(S.photoPage,S.photoTotal,'goPhotoPage');
  }
  function renderBookings(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">الحجوزات</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.bookingTotal)+' حجز</p></div><button class="btn btn-primary btn-sm" onclick="exportBookings()"><i class="fas fa-download"></i>تصدير</button></div>'+
    '<div class="flex flex-wrap gap-3 mb-6"><div class="search-bar" style="max-width:360px;flex:1"><i class="fas fa-search"></i><input class="input" style="padding-right:42px;font-size:13px" placeholder="بحث بالعميل أو المصور أو الخدمة..." value="'+h(S.bookingSearch)+'" oninput="S.bookingSearch=this.value;S.bookingPage=1;queueTabLoad()"></div><select class="input" style="width:auto" onchange="S.bookingStatus=this.value;S.bookingPage=1;reloadTab()"><option value="all">كل الحالات</option><option value="pending" '+(S.bookingStatus==='pending'?'selected':'')+'>قيد الانتظار</option><option value="confirmed" '+(S.bookingStatus==='confirmed'?'selected':'')+'>مؤكد</option><option value="completed" '+(S.bookingStatus==='completed'?'selected':'')+'>مكتمل</option><option value="cancelled" '+(S.bookingStatus==='cancelled'?'selected':'')+'>ملغي</option></select></div>'+
    (S.bookings.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>العميل</th><th>المصور</th><th>الخدمة</th><th>التاريخ</th><th>القيمة</th><th>الحالة</th><th>تحديث</th></tr></thead><tbody>'+S.bookings.map(function(b){return '<tr><td><div style="font-weight:600">'+h(b.client_name||b.client?.display_name||'-')+'</div><div class="text-dim" style="font-size:12px">'+h(b.client_phone||b.client?.phone||'')+'</div></td><td>'+h(b.photographer?.display_name||'-')+'</td><td>'+h(b.packages?.name||'-')+'</td><td>'+fmtDate(b.booking_date)+'<div class="text-dim" style="font-size:12px">'+h((b.start_time||'').slice(0,5))+'</div></td><td style="font-weight:700;color:var(--accent)">'+fmtMoney(b.value)+'</td><td>'+statusBadge(b.status)+'</td><td><select class="input" style="width:145px" onchange="updateBookingAdminStatus(\''+b.id+'\',this.value)"><option value="">اختر</option><option value="pending">قيد الانتظار</option><option value="confirmed">مؤكد</option><option value="completed">مكتمل</option><option value="cancelled">ملغي</option></select></td></tr>';}).join('')+'</tbody></table></div>':empty('fa-bookmark','لا توجد حجوزات'))+
    pagination(S.bookingPage,S.bookingTotal,'goBookingPage');
  }
  function renderReports(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">البلاغات</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.reportTotal)+' بلاغ</p></div></div>'+
    '<div class="tab-filter mb-6 inline-flex"><button class="'+(S.reportStatus==='open'?'active':'')+'" onclick="S.reportStatus=\'open\';S.reportPage=1;reloadTab()">مفتوح</button><button class="'+(S.reportStatus==='reviewing'?'active':'')+'" onclick="S.reportStatus=\'reviewing\';S.reportPage=1;reloadTab()">قيد المراجعة</button><button class="'+(S.reportStatus==='closed'?'active':'')+'" onclick="S.reportStatus=\'closed\';S.reportPage=1;reloadTab()">مغلق</button><button class="'+(S.reportStatus==='all'?'active':'')+'" onclick="S.reportStatus=\'all\';S.reportPage=1;reloadTab()">الكل</button></div>'+
    (S.reports.length?'<div class="space-y-4">'+S.reports.map(function(r){return '<div class="card p-5"><div class="flex flex-wrap justify-between gap-4"><div><div class="flex items-center gap-2 mb-2">'+statusBadge(r.status)+'<span class="text-dim" style="font-size:12px">'+fmtDateTime(r.created_at)+'</span></div><div style="font-weight:700;margin-bottom:6px">'+h(r.reason)+'</div><div class="text-muted" style="font-size:13px">المبلّغ: '+h(r.reporter?.display_name||'غير معروف')+' • المبلّغ عنه: '+h(r.reported?.display_name||'غير محدد')+'</div></div><div class="flex gap-2"><button class="btn btn-secondary btn-sm" onclick="updateReportStatus(\''+r.id+'\',\'reviewing\')">مراجعة</button><button class="btn btn-primary btn-sm" onclick="updateReportStatus(\''+r.id+'\',\'closed\')">إغلاق</button>'+(r.reported&&r.reported.role==='photographer'?'<button class="btn btn-danger btn-sm" onclick="suspendReported(\''+r.reported.id+'\')">إيقاف</button>':'')+'</div></div></div>';}).join('')+'</div>':empty('fa-flag','لا توجد بلاغات'))+
    pagination(S.reportPage,S.reportTotal,'goReportPage');
  }
  function renderSupport(){
    var active=S.supportConversations.find(function(c){return c.id===S.supportActiveId;})||S.supportConversations[0]||null;
    if(active&&S.supportActiveId!==active.id)S.supportActiveId=active.id;
    var list=S.supportConversations.length?S.supportConversations.map(function(c){
      var activeClass=c.id===S.supportActiveId?' active':'';
      return '<button type="button" class="support-admin-item'+activeClass+'" onclick="openSupportThread(\''+c.id+'\')">'+
        '<span class="support-admin-avatar">'+h((c.user_name||'?').charAt(0))+'</span>'+
        '<span class="support-admin-meta"><strong>'+h(c.user_name||'User')+'</strong><small>'+h(c.user_email||c.user_role||'')+'</small><em>'+h(c.last_message||'لا توجد رسائل بعد')+'</em></span>'+
        '<span class="support-admin-side">'+statusBadge(c.status)+'<small>'+timeAgo(c.last_message_at||c.created_at)+'</small></span>'+
      '</button>';
    }).join(''):'<div class="p-6">'+empty('fa-headset','لا توجد محادثات دعم')+'</div>';
    var messages=active?S.supportMessages:[];
    var thread=active?'<div class="support-admin-thread-head"><div><h3>'+h(active.user_name||'User')+'</h3><p>'+h(active.user_email||'')+' · '+h(active.user_role||'')+'</p></div><div class="flex gap-2">'+(active.status==='closed'?'<button class="btn btn-secondary btn-sm" onclick="setSupportStatus(\''+active.id+'\',\'open\')"><i class="fas fa-lock-open"></i>إعادة فتح</button>':'<button class="btn btn-secondary btn-sm" onclick="setSupportStatus(\''+active.id+'\',\'closed\')"><i class="fas fa-check"></i>إغلاق</button>')+'</div></div>'+
      '<div class="support-admin-messages">'+(messages.length?messages.map(function(m){
        var mine=m.sender_role==='admin';
        return '<div class="support-admin-msg '+(mine?'mine':'theirs')+'"><div><span>'+h(m.content)+'</span><small>'+h(m.sender_name||'')+' · '+fmtDateTime(m.created_at)+'</small></div></div>';
      }).join(''):'<div class="support-admin-empty"><i class="fas fa-comments"></i><p>لا توجد رسائل في هذه المحادثة.</p></div>')+'</div>'+
      (active.status==='closed'?'<div class="support-admin-closed">هذه المحادثة مغلقة. أعد فتحها للرد.</div>':'<form class="support-admin-compose" onsubmit="sendSupportReply(event)"><input class="input" id="support-reply-input" placeholder="اكتب رد الدعم..."><button class="btn btn-primary"><i class="fas fa-paper-plane"></i>إرسال</button></form>')
      :'<div class="support-admin-empty"><i class="fas fa-headset"></i><p>اختر محادثة دعم لعرض الرسائل.</p></div>';
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">دعم العملاء</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.supportTotal)+' محادثة</p></div></div>'+
      '<div class="tab-filter mb-6 inline-flex"><button class="'+(S.supportStatus==='open'?'active':'')+'" onclick="S.supportStatus=\'open\';S.supportPage=1;S.supportActiveId=null;reloadTab()">مفتوح</button><button class="'+(S.supportStatus==='closed'?'active':'')+'" onclick="S.supportStatus=\'closed\';S.supportPage=1;S.supportActiveId=null;reloadTab()">مغلق</button><button class="'+(S.supportStatus==='all'?'active':'')+'" onclick="S.supportStatus=\'all\';S.supportPage=1;S.supportActiveId=null;reloadTab()">الكل</button></div>'+
      '<div class="support-admin-layout"><div class="support-admin-list">'+list+'</div><div class="support-admin-thread">'+thread+'</div></div>'+pagination(S.supportPage,S.supportTotal,'goSupportPage');
  }
  function renderSubscriptions(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">الاشتراكات</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.subscriptionTotal)+' سجل</p></div></div>'+
    '<div class="flex flex-wrap gap-3 mb-6"><div class="search-bar" style="max-width:360px;flex:1"><i class="fas fa-search"></i><input class="input" style="padding-right:42px;font-size:13px" placeholder="بحث بالمصور أو رقم الطلب..." value="'+h(S.subscriptionSearch)+'" oninput="S.subscriptionSearch=this.value;S.subscriptionPage=1;queueTabLoad()"></div><select class="input" style="width:auto" onchange="S.subscriptionStatus=this.value;S.subscriptionPage=1;reloadTab()"><option value="all">كل الحالات</option><option value="pending" '+(S.subscriptionStatus==='pending'?'selected':'')+'>معلق</option><option value="active" '+(S.subscriptionStatus==='active'?'selected':'')+'>نشط</option><option value="overdue" '+(S.subscriptionStatus==='overdue'?'selected':'')+'>متأخر</option><option value="cancelled" '+(S.subscriptionStatus==='cancelled'?'selected':'')+'>ملغي</option><option value="failed" '+(S.subscriptionStatus==='failed'?'selected':'')+'>فشل</option></select></div>'+
    (S.subscriptions.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>المصور</th><th>الخطة</th><th>المبلغ</th><th>الحالة</th><th>ينتهي في</th><th>الطلب</th><th>تحديث</th></tr></thead><tbody>'+S.subscriptions.map(function(s){var plan=s.plan_code||s.photographerProfile?.subscription_plan||'basic';return '<tr><td><div style="font-weight:600">'+h(s.photographer?.display_name||'-')+'</div><div class="text-dim" style="font-size:12px">'+h(s.photographer?.email||'')+'</div></td><td><span class="badge badge-active">'+h(String(plan).toUpperCase())+'</span></td><td style="font-weight:700;color:var(--accent)">'+fmtMoney(s.amount)+'</td><td>'+statusBadge(s.status)+'</td><td>'+fmtDate(s.current_period_end)+'</td><td class="text-dim" style="font-size:12px">'+h(s.merchant_order_id||s.provider_order_id||'-')+'</td><td><select class="input" style="width:130px" onchange="updateSubscriptionStatus(\''+s.id+'\',this.value)"><option value="">اختر</option><option value="active">نشط</option><option value="pending">معلق</option><option value="overdue">متأخر</option><option value="cancelled">ملغي</option><option value="failed">فشل</option></select></td></tr>';}).join('')+'</tbody></table></div>':empty('fa-crown','لا توجد اشتراكات'))+
    pagination(S.subscriptionPage,S.subscriptionTotal,'goSubscriptionPage');
  }
  function renderCategories(){
    var rows=S.categories||[];
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">إدارة الأقسام</h2><p class="text-muted mt-1" style="font-size:14px">إضافة وتعديل أقسام المصورين التي تظهر في التسجيل والاستكشاف.</p></div></div>'+
    '<form onsubmit="saveCategory(event)" class="card p-6 mb-6 space-y-4"><input type="hidden" id="cat-id">'+
    '<div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr"><div><label>الاسم بالعربية</label><input class="input" id="cat-name-ar" required placeholder="مثال: تصوير أعراس"></div><div><label>English name</label><input class="input" id="cat-name-en" dir="ltr" required placeholder="Wedding Photography"></div></div>'+
    '<div class="flex flex-wrap gap-2"><button class="btn btn-primary"><i class="fas fa-floppy-disk"></i>حفظ القسم</button><button type="button" class="btn btn-secondary" onclick="resetCategoryForm()">قسم جديد</button></div></form>'+
    (rows.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>العربي</th><th>English</th><th>الرابط</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>'+rows.map(function(c){return '<tr><td style="font-weight:700">'+h(c.nameAr||c.name_ar||'-')+'</td><td dir="ltr">'+h(c.nameEn||c.name_en||'-')+'</td><td class="text-dim">'+h(c.slug||'-')+'</td><td>'+statusBadge(c.isActive===false?'inactive':'active')+'</td><td><div class="flex gap-2"><button class="btn-icon" onclick="editCategory(\''+h(c.id)+'\')" title="تعديل"><i class="fas fa-pen" style="font-size:12px"></i></button>'+(c.isActive===false?'<button class="btn-icon" onclick="reactivateCategory(\''+h(c.id)+'\')" title="تفعيل"><i class="fas fa-check" style="font-size:12px"></i></button>':'<button class="btn-icon danger" onclick="removeCategory(\''+h(c.id)+'\')" title="إخفاء"><i class="fas fa-ban" style="font-size:12px"></i></button>')+'</div></td></tr>';}).join('')+'</tbody></table></div>':empty('fa-tags','لا توجد أقسام')) ;
  }
  function renderContent(){
    var c=S.content;
    return '<div class="mb-6"><h2 class="font-display" style="font-size:26px;font-weight:700">إدارة المحتوى</h2><p class="text-muted mt-1" style="font-size:14px">هذه الحقول تظهر في الصفحة الرئيسية بعد الحفظ.</p></div>'+
    '<form onsubmit="saveContent(event)" class="card p-6 space-y-5"><div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr"><div><label>العنوان الأول (عربي)</label><input class="input" id="ct-heroTitle1Ar" value="'+h(c.heroTitle1Ar)+'"></div><div><label>العنوان الثاني (عربي)</label><input class="input" id="ct-heroTitle2Ar" value="'+h(c.heroTitle2Ar)+'"></div></div>'+
    '<div><label>الوصف (عربي)</label><textarea class="input" id="ct-heroDescAr">'+h(c.heroDescAr)+'</textarea></div>'+
    '<div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr"><div><label>Title 1 (English)</label><input class="input" id="ct-heroTitle1En" dir="ltr" value="'+h(c.heroTitle1En)+'"></div><div><label>Title 2 (English)</label><input class="input" id="ct-heroTitle2En" dir="ltr" value="'+h(c.heroTitle2En)+'"></div></div>'+
    '<div><label>Description (English)</label><textarea class="input" id="ct-heroDescEn" dir="ltr">'+h(c.heroDescEn)+'</textarea></div>'+
    '<div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr"><div><label>نبذة الفوتر (عربي)</label><input class="input" id="ct-footerAboutAr" value="'+h(c.footerAboutAr)+'"></div><div><label>Footer about (English)</label><input class="input" id="ct-footerAboutEn" dir="ltr" value="'+h(c.footerAboutEn)+'"></div></div>'+
    '<button class="btn btn-primary"><i class="fas fa-floppy-disk"></i>حفظ المحتوى</button></form>';
  }
  function renderSettings(){
    var s=S.settings;
    return '<div class="mb-6"><h2 class="font-display" style="font-size:26px;font-weight:700">إعدادات النظام</h2><p class="text-muted mt-1" style="font-size:14px">إعدادات مؤثرة في التسجيل والاشتراك.</p></div>'+
    '<form onsubmit="saveSettings(event)" class="card p-6 space-y-5"><div class="grid grid-3 gap-4"><div><label>أيام التجربة</label><input class="input" id="st-trialDays" type="number" min="0" value="'+h(s.trialDays)+'"></div><div><label>حد صور الخطة المجانية</label><input class="input" id="st-maxFreePortfolioPhotos" type="number" min="1" value="'+h(s.maxFreePortfolioPhotos)+'"></div><div><label>سعر Basic الشهري (ج.م)</label><input class="input" id="st-basicPlanPriceEgp" type="number" min="1" value="'+h(s.basicPlanPriceEgp||s.subscriptionPriceEgp||400)+'"></div><div><label>سعر Premium الشهري (ج.م)</label><input class="input" id="st-premiumPlanPriceEgp" type="number" min="1" value="'+h(s.premiumPlanPriceEgp||600)+'"></div></div>'+
    '<div class="grid grid-2 gap-4" style="grid-template-columns:1fr 1fr"><label class="flex items-center justify-between p-4 rounded-md" style="background:var(--bg2);border:1px solid var(--border)"><span><strong>فتح التسجيل</strong><br><span class="text-dim" style="font-size:12px">إتاحة إنشاء حسابات جديدة</span></span><input type="checkbox" id="st-registrationOpen" '+(s.registrationOpen?'checked':'')+'></label><label class="flex items-center justify-between p-4 rounded-md" style="background:var(--bg2);border:1px solid var(--border)"><span><strong>وضع الصيانة</strong><br><span class="text-dim" style="font-size:12px">حقل محفوظ للاستخدام لاحقاً</span></span><input type="checkbox" id="st-maintenanceMode" '+(s.maintenanceMode?'checked':'')+'></label></div>'+
    '<button class="btn btn-primary"><i class="fas fa-floppy-disk"></i>حفظ الإعدادات</button></form>';
  }
  function renderNotifications(){
    var unread=S.notifications.filter(function(n){return !n.read_at;}).length;
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">الإشعارات</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(unread)+' غير مقروءة</p></div>'+(unread?'<button class="btn btn-secondary btn-sm" onclick="markAllRead()"><i class="fas fa-check-double"></i>قراءة الكل</button>':'')+'</div>'+
    '<div class="card overflow-hidden">'+(S.notifications.length?S.notifications.map(function(n){return '<div class="notification-item '+(n.read_at?'':'unread')+'" onclick="markRead(\''+n.id+'\')"><div class="log-icon '+(n.type==='moderation'?'lg-warning':'lg-info')+'"><i class="fas '+(n.type==='moderation'?'fa-triangle-exclamation':'fa-info')+'"></i></div><div class="flex-1"><div style="font-size:14px;font-weight:600">'+h(n.title)+'</div><p class="text-muted" style="font-size:13px">'+h(n.message)+'</p></div><div class="text-dim" style="font-size:11px;white-space:nowrap">'+timeAgo(n.created_at)+'</div></div>';}).join(''):empty('fa-bell-slash','لا توجد إشعارات'))+'</div>'+pagination(S.notifPage,S.notificationTotal,'goNotifPage');
  }
  function logRow(l){
    var typeMap={success:'lg-success',warning:'lg-warning',danger:'lg-danger',info:'lg-info'};
    return '<div class="log-item"><div class="log-icon '+(typeMap[l.type]||'lg-info')+'"><i class="fas fa-info"></i></div><div class="flex-1"><div style="font-size:13px">'+h(l.action)+'</div><div class="text-dim" style="font-size:11px">'+h(l.entity_type||'system')+(l.entity_id?' #'+h(l.entity_id):'')+'</div></div><div class="log-time">'+timeAgo(l.created_at)+'</div></div>';
  }
  function renderLogs(){
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">سجل النشاط</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.logTotal)+' سجل</p></div><button class="btn btn-primary btn-sm" onclick="exportLogs()"><i class="fas fa-download"></i>تصدير</button></div>'+
    '<div class="card overflow-hidden"><div style="max-height:650px;overflow-y:auto">'+(S.logs.length?S.logs.map(logRow).join(''):empty('fa-clock','لا يوجد نشاط مسجل'))+'</div></div>'+pagination(S.logPage,S.logTotal,'goLogPage');
  }

  function viewUserDetail(id){
    var c=S.customers.find(function(x){return x.id===id;});if(!c)return;
    openModal('<div class="flex justify-between items-center mb-6"><h3 class="font-display" style="font-size:20px;font-weight:700">تفاصيل العميل</h3><button onclick="closeModal()" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;padding:4px"><i class="fas fa-xmark"></i></button></div>'+
    '<div class="space-y-3" style="font-size:13px"><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الاسم</span><span>'+h(c.displayName)+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">البريد</span><span>'+h(c.email)+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الهاتف</span><span>'+h(c.phone||'-')+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الحجوزات</span><span>'+fmt(c.bookingCount)+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">المصروف</span><span>'+fmtMoney(c.grossValue)+'</span></div></div>',true);
  }
  function viewPhotoDetail(id){
    var p=S.photographers.find(function(x){return x.id===id;});if(!p)return;
    openModal('<div class="flex justify-between items-center mb-6"><h3 class="font-display" style="font-size:20px;font-weight:700">تفاصيل المصور</h3><button onclick="closeModal()" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;padding:4px"><i class="fas fa-xmark"></i></button></div>'+
    '<div class="text-center mb-6"><div class="avatar-initial xl" style="background:var(--accent-glow);color:var(--accent);margin:0 auto 12px">'+h((p.display_name||'?').charAt(0))+'</div><h4 class="font-display" style="font-size:18px;font-weight:700">'+h(p.display_name)+'</h4><p style="color:var(--accent);font-size:14px">'+h(p.specialty||'')+'</p></div>'+
    '<div class="grid grid-2 gap-4 mb-6" style="grid-template-columns:1fr 1fr">'+smallStat('fa-bookmark','الحجوزات',fmt(p.booking_count),'إجمالي','var(--accent)')+smallStat('fa-money-bill','الإيرادات',fmtMoney(p.grossRevenue),'غير ملغاة','var(--success)')+'</div>'+
    '<div class="space-y-3" style="font-size:13px"><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الرابط</span><span>'+h(p.custom_link||'-')+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الباقات</span><span>'+fmt(p.packageCount)+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">صور المعرض</span><span>'+fmt(p.portfolioPhotoCount)+'</span></div><div class="flex justify-between p-3 rounded-md" style="background:var(--bg2)"><span class="text-muted">الحالة</span>'+statusBadge(p.status)+'</div></div>',true);
  }
  async function togglePhotoStatus(id){
    var p=S.photographers.find(function(x){return x.id===id;});if(!p)return;
    var next=!p.is_suspended;
    if(!confirm(next?'إيقاف هذا المصور وإخفاؤه من البحث؟':'إعادة تفعيل هذا المصور؟'))return;
    await api('/api/admin/photographers/'+id+'/moderation',{method:'PATCH',body:{isSuspended:next,reason:'admin_console'}});
    showToast(next?'تم إيقاف المصور':'تم تفعيل المصور',next?'warning':'success');
    reloadTab();
  }
  async function togglePhotoPublished(id){
    var p=S.photographers.find(function(x){return x.id===id;});if(!p)return;
    var next=!p.is_published;
    await api('/api/admin/photographers/'+id+'/moderation',{method:'PATCH',body:{isPublished:next,reason:'admin_console'}});
    showToast(next?'تم نشر الملف':'تم إخفاء الملف','success');
    reloadTab();
  }
  async function cancelPhotographerSubscription(id){
    var p=S.photographers.find(function(x){return x.id===id;});if(!p)return;
    var reason=prompt('سبب إلغاء الاشتراك (اختياري):','');
    if(reason===null)return; // user cancelled
    if(!confirm('إلغاء اشتراك المصور وإرجاعه للباقة المجانية فقط؟'))return;
    await api('/api/admin/photographers/'+id+'/cancel-subscription',{method:'POST',body:{reason:reason,suspendAccount:false}});
    showToast('تم إلغاء الاشتراك وإرجاع المصور للباقة المجانية','warning');
    reloadTab();
  }
  async function fraudSuspendPhotographer(id){
    var p=S.photographers.find(function(x){return x.id===id;});if(!p)return;
    var reason=prompt('سبب إيقاف الحساب للاشتباه بالاحتيال:','fraud');
    if(reason===null)return;
    if(!confirm('إلغاء الاشتراك وإيقاف حساب المصور بالكامل؟'))return;
    await api('/api/admin/photographers/'+id+'/cancel-subscription',{method:'POST',body:{reason:reason||'fraud',suspendAccount:true}});
    showToast('تم إلغاء الاشتراك وإيقاف الحساب','warning');
    reloadTab();
  }
  async function updateBookingAdminStatus(id,status){
    if(!status)return;
    if(!confirm('تحديث حالة الحجز إلى '+status+'؟')){reloadTab();return;}
    await api('/api/admin/bookings/'+id+'/status',{method:'PATCH',body:{status:status}});
    showToast('تم تحديث الحجز','success');
    reloadTab();
  }
  async function updateReportStatus(id,status){
    await api('/api/admin/reports/'+id,{method:'PATCH',body:{status:status}});
    showToast('تم تحديث البلاغ','success');
    reloadTab();
  }
  async function openSupportThread(id){
    S.supportActiveId=id;
    S.loading=true;renderTab();
    try{
      await loadSupportMessages(id);
      S.loading=false;renderTab();
      setTimeout(function(){
        var box=document.querySelector('.support-admin-messages');
        if(box)box.scrollTop=box.scrollHeight;
      },40);
    }catch(e){
      S.error=e.message;S.loading=false;renderTab();
    }
  }
  async function sendSupportReply(e){
    e.preventDefault();
    if(!S.supportActiveId)return;
    var input=document.getElementById('support-reply-input');
    var text=input?input.value.trim():'';
    if(!text)return;
    if(input)input.disabled=true;
    try{
      await api('/api/admin/support/'+S.supportActiveId+'/messages',{method:'POST',body:{content:text}});
      if(input)input.value='';
      await loadSupport();
      showToast('تم إرسال الرد','success');
    }catch(err){
      showToast(err.message||'تعذر إرسال الرد','error');
    }finally{
      if(input)input.disabled=false;
      renderTab();
    }
  }
  async function setSupportStatus(id,status){
    await api('/api/admin/support/'+id,{method:'PATCH',body:{status:status}});
    showToast(status==='closed'?'تم إغلاق المحادثة':'تم إعادة فتح المحادثة','success');
    S.supportActiveId=id;
    reloadTab();
  }
  async function suspendReported(id){
    if(!confirm('إيقاف الحساب المبلّغ عنه؟'))return;
    await api('/api/admin/photographers/'+id+'/moderation',{method:'PATCH',body:{isSuspended:true,reason:'report_action'}});
    showToast('تم إيقاف الحساب','warning');
  }
  async function updateSubscriptionStatus(id,status){
    if(!status)return;
    var body={status:status};
    if(status==='active'){
      var due=new Date();due.setMonth(due.getMonth()+1);
      body.currentPeriodEnd=due.toISOString();
    }
    await api('/api/admin/subscriptions/'+id,{method:'PATCH',body:body});
    showToast('تم تحديث الاشتراك','success');
    reloadTab();
  }
  function resetCategoryForm(){
    var id=document.getElementById('cat-id');
    var ar=document.getElementById('cat-name-ar');
    var en=document.getElementById('cat-name-en');
    if(id)id.value='';
    if(ar)ar.value='';
    if(en)en.value='';
  }
  function editCategory(id){
    var c=(S.categories||[]).find(function(row){return row.id===id;});
    if(!c)return;
    document.getElementById('cat-id').value=c.id;
    document.getElementById('cat-name-ar').value=c.nameAr||c.name_ar||'';
    document.getElementById('cat-name-en').value=c.nameEn||c.name_en||'';
    document.getElementById('cat-name-ar').focus();
  }
  async function saveCategory(e){
    e.preventDefault();
    var id=document.getElementById('cat-id').value;
    var body={
      nameAr:document.getElementById('cat-name-ar').value.trim(),
      nameEn:document.getElementById('cat-name-en').value.trim()
    };
    if(!body.nameAr||!body.nameEn){showToast('اكتب اسم القسم بالعربية والإنجليزية','error');return;}
    if(id)await api('/api/admin/categories/'+id,{method:'PATCH',body:body});
    else await api('/api/admin/categories',{method:'POST',body:body});
    resetCategoryForm();
    showToast('تم حفظ القسم','success');
    reloadTab();
  }
  async function removeCategory(id){
    if(!confirm('إخفاء هذا القسم من التسجيل والفلاتر؟ سيبقى مرتبطاً بالسجلات القديمة.'))return;
    await api('/api/admin/categories/'+id,{method:'DELETE'});
    showToast('تم إخفاء القسم','warning');
    reloadTab();
  }
  async function reactivateCategory(id){
    await api('/api/admin/categories/'+id,{method:'PATCH',body:{isActive:true}});
    showToast('تم تفعيل القسم','success');
    reloadTab();
  }
  async function saveContent(e){
    e.preventDefault();
    var content={
      heroTitle1Ar:document.getElementById('ct-heroTitle1Ar').value,
      heroTitle2Ar:document.getElementById('ct-heroTitle2Ar').value,
      heroDescAr:document.getElementById('ct-heroDescAr').value,
      heroTitle1En:document.getElementById('ct-heroTitle1En').value,
      heroTitle2En:document.getElementById('ct-heroTitle2En').value,
      heroDescEn:document.getElementById('ct-heroDescEn').value,
      footerAboutAr:document.getElementById('ct-footerAboutAr').value,
      footerAboutEn:document.getElementById('ct-footerAboutEn').value
    };
    var data=await api('/api/admin/content',{method:'PUT',body:{content:content}});
    S.content=data.content||content;
    showToast('تم حفظ المحتوى','success');
  }
  async function saveSettings(e){
    e.preventDefault();
    var settings={
      registrationOpen:document.getElementById('st-registrationOpen').checked,
      maintenanceMode:document.getElementById('st-maintenanceMode').checked,
      trialDays:Number(document.getElementById('st-trialDays').value||0),
      maxFreePortfolioPhotos:Number(document.getElementById('st-maxFreePortfolioPhotos').value||1),
      basicPlanPriceEgp:Number(document.getElementById('st-basicPlanPriceEgp').value||1),
      premiumPlanPriceEgp:Number(document.getElementById('st-premiumPlanPriceEgp').value||1)
    };
    var data=await api('/api/admin/settings',{method:'PUT',body:{settings:settings}});
    S.settings=data.settings||settings;
    showToast('تم حفظ الإعدادات','success');
  }
  async function markRead(id){
    await api('/api/admin/notifications/'+id,{method:'PATCH'});
    await loadNotifications(false);
  }
  async function markAllRead(){
    await api('/api/admin/notifications/read-all',{method:'PATCH'});
    await loadNotifications(false);
    showToast('تم قراءة جميع الإشعارات','info');
  }

  function exportRows(filename,headers,rows){
    if(window.exportCSV)exportCSV(filename,headers,rows);
  }
  function exportRevenue(){var data=S.revenueData[S.revenueRange]||[];exportRows('revenue_'+S.revenueRange+'.csv',['الفترة','الإيرادات'],data.map(function(d){return[d.label,d.value];}));}
  function exportCustomers(){exportRows('customers.csv',['الاسم','البريد','الهاتف','الحجوزات','المصروف'],S.customers.map(function(c){return[c.displayName,c.email,c.phone,c.bookingCount,c.grossValue];}));}
  function exportPhotographers(){exportRows('photographers.csv',['الاسم','البريد','التخصص','المنطقة','الحالة','الإيرادات'],S.photographers.map(function(p){return[p.display_name,p.email,p.specialty,p.region,p.status,p.grossRevenue];}));}
  function exportBookings(){exportRows('bookings.csv',['العميل','المصور','الخدمة','التاريخ','الحالة','القيمة'],S.bookings.map(function(b){return[b.client_name,b.photographer&&b.photographer.display_name,b.packages&&b.packages.name,b.booking_date,b.status,b.value];}));}
  function exportLogs(){exportRows('activity_logs.csv',['الإجراء','الكيان','الوقت'],S.logs.map(function(l){return[l.action,l.entity_type,l.created_at];}));}

  function setRevenueRange(range){S.revenueRange=range;reloadTab();}
  function goCustomerPage(p){S.customerPage=p;reloadTab();}
  function goPhotoPage(p){S.photoPage=p;reloadTab();}
  function goBookingPage(p){S.bookingPage=p;reloadTab();}
  function goReportPage(p){S.reportPage=p;reloadTab();}
  function goSupportPage(p){S.supportPage=p;reloadTab();}
  function goSubscriptionPage(p){S.subscriptionPage=p;reloadTab();}
  function goNotifPage(p){S.notifPage=p;reloadTab();}
  function goLogPage(p){S.logPage=p;reloadTab();}
  function globalSearch(q){
    if(S.tab==='customers'){S.customerSearch=q;S.customerPage=1;}
    else if(S.tab==='photographers'){S.photoSearch=q;S.photoPage=1;}
    else if(S.tab==='bookings'){S.bookingSearch=q;S.bookingPage=1;}
    else if(S.tab==='subscriptions'){S.subscriptionSearch=q;S.subscriptionPage=1;}
    queueTabLoad();
  }
  function updateNotifBadge(){
    var unread=S.notifications.filter(function(n){return !n.read_at;}).length;
    var b=document.getElementById('notif-badge');
    if(b){b.textContent=unread;b.style.display=unread>0?'flex':'none';}
  }
  function addLog(){}

  Object.assign(window,{
    handleAdminLogin:handleAdminLogin,handleAdminLogout:handleAdminLogout,canDo:canDo,
    buildSidebar:buildSidebar,switchTab:switchTab,toggleSidebar:toggleSidebar,checkMobile:checkMobile,
    renderTab:renderTab,reloadTab:reloadTab,queueTabLoad:queueTabLoad,globalSearch:globalSearch,
    updateNotifBadge:updateNotifBadge,addLog:addLog,setRevenueRange:setRevenueRange,
    goCustomerPage:goCustomerPage,goPhotoPage:goPhotoPage,goBookingPage:goBookingPage,goReportPage:goReportPage,goSupportPage:goSupportPage,
    goSubscriptionPage:goSubscriptionPage,goNotifPage:goNotifPage,goLogPage:goLogPage,
    viewUserDetail:viewUserDetail,viewPhotoDetail:viewPhotoDetail,togglePhotoStatus:togglePhotoStatus,togglePhotoPublished:togglePhotoPublished,
    updateBookingAdminStatus:updateBookingAdminStatus,updateReportStatus:updateReportStatus,suspendReported:suspendReported,
    openSupportThread:openSupportThread,sendSupportReply:sendSupportReply,setSupportStatus:setSupportStatus,
    updateSubscriptionStatus:updateSubscriptionStatus,cancelPhotographerSubscription:cancelPhotographerSubscription,
    fraudSuspendPhotographer:fraudSuspendPhotographer,resetCategoryForm:resetCategoryForm,editCategory:editCategory,
    saveCategory:saveCategory,removeCategory:removeCategory,reactivateCategory:reactivateCategory,
    saveContent:saveContent,saveSettings:saveSettings,
    markRead:markRead,markAllRead:markAllRead,
    exportRevenue:exportRevenue,exportCustomers:exportCustomers,exportPhotographers:exportPhotographers,exportBookings:exportBookings,exportLogs:exportLogs
  });

  checkMobile();
  restoreSession();
  setInterval(function(){
    if(document.visibilityState==='hidden'||!S.admin)return;
    loadNotifications(true).catch(function(){});
    if(S.tab==='overview')loadOverview().then(renderTab).catch(function(){});
    if(S.tab==='support')loadSupport().then(renderTab).catch(function(){});
  },60000);

  /* ===== MANUAL PAYMENTS ===== */
  async function loadManualPayments(){
    var data=await api('/api/admin/manual-payments'+params({status:S.manualPaymentStatus,page:S.manualPaymentPage,pageSize:PAGE_SIZE}));
    S.manualPaymentRequests=data.requests||[];
    S.manualPaymentTotal=data.total||0;
  }
  function renderManualPayments(){
    var pending=S.manualPaymentRequests.filter(function(r){return r.status==='pending';}).length;
    return '<div class="flex flex-wrap items-center justify-between gap-4 mb-6"><div><h2 class="font-display" style="font-size:26px;font-weight:700">الدفعات اليدوية</h2><p class="text-muted mt-1" style="font-size:14px">'+fmt(S.manualPaymentTotal)+' طلب • '+fmt(pending)+' معلق</p></div></div>'+
    '<div class="tab-filter mb-6 inline-flex"><button class="'+(S.manualPaymentStatus==='pending'?'active':'')+'" onclick="S.manualPaymentStatus=\'pending\';S.manualPaymentPage=1;reloadTab()">معلق</button><button class="'+(S.manualPaymentStatus==='approved'?'active':'')+'" onclick="S.manualPaymentStatus=\'approved\';S.manualPaymentPage=1;reloadTab()">مقبول</button><button class="'+(S.manualPaymentStatus==='rejected'?'active':'')+'" onclick="S.manualPaymentStatus=\'rejected\';S.manualPaymentPage=1;reloadTab()">مرفوض</button><button class="'+(S.manualPaymentStatus==='all'?'active':'')+'" onclick="S.manualPaymentStatus=\'all\';S.manualPaymentPage=1;reloadTab()">الكل</button></div>'+
    (S.manualPaymentRequests.length?'<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>المصور</th><th>الباقة</th><th>طريقة الدفع</th><th>اسم المرسل</th><th>رقم العملية</th><th>الإيصال</th><th>الحالة</th><th>التاريخ</th><th>إجراءات</th></tr></thead><tbody>'+S.manualPaymentRequests.map(function(r){
      var photo=r.photographer||{};
      var plan=r.plan||{};
      var photoName=photo.display_name||'غير معروف';
      var planName=(plan.name_ar||plan.code||'').toUpperCase();
      var planPrice=plan.price_egp||0;
      var paymentMethodLabels={vodafone_cash:'Vodafone Cash',instapay:'InstaPay',bank_transfer:'حوالة بنكية'};
      var methodLabel=paymentMethodLabels[r.payment_method]||r.payment_method;
      var statusBadgeHtml='';
      if(r.status==='pending')statusBadgeHtml='<span class="badge badge-pending">مفعل - ينتظر المراجعة</span>';
      else if(r.status==='approved')statusBadgeHtml='<span class="badge badge-active">مقبول</span>';
      else if(r.status==='rejected')statusBadgeHtml='<span class="badge badge-cancelled">مرفوض</span>';
      var receiptLink=r.receipt_url?'<a href="'+h(r.receipt_url)+'" target="_blank" class="text-gold" style="text-decoration:underline;font-size:12px">عرض</a>':'<span class="text-dim">-</span>';
      var actions='';
      if(r.status==='pending'){
        actions='<div class="flex gap-2"><button class="btn-success btn-xs" onclick="reviewManualPayment(\''+r.id+'\',\'approve\')"><i class="fas fa-check"></i>اعتماد</button><button class="btn-danger btn-xs" onclick="reviewManualPayment(\''+r.id+'\',\'reject\')"><i class="fas fa-times"></i>رفض وإلغاء</button></div>';
      }else{
        actions='<button class="btn-icon danger" onclick="deleteManualPaymentRequest(\''+r.id+'\')" title="حذف"><i class="fas fa-trash-alt" style="font-size:12px"></i></button>';
      }
      return '<tr><td><div style="font-weight:600">'+h(photoName)+'</div><div class="text-dim" style="font-size:12px">'+h(photo.email||'')+'</div></td><td><span class="badge badge-featured">'+h(planName)+'</span><div class="text-dim" style="font-size:11px">'+planPrice+' ج.م</div></td><td class="text-muted" style="font-size:13px">'+h(methodLabel)+'</td><td style="font-size:13px">'+h(r.sender_name||'-')+'</td><td class="text-muted" style="font-size:12px;font-family:monospace">'+h(r.transaction_ref||'-')+'</td><td>'+receiptLink+'</td><td>'+statusBadgeHtml+'</td><td class="text-dim" style="font-size:12px">'+timeAgo(r.created_at)+'</td><td>'+actions+'</td></tr>';
    }).join('')+'</tbody></table></div>':empty('fa-money-bill-wave','لا توجد طلبات دفع يدوي'))+
    pagination(S.manualPaymentPage,S.manualPaymentTotal,'goManualPaymentPage');
  }
  async function reviewManualPayment(id,action){
    var actionText=action==='approve'?'قبول':'رفض';
    var reason='';
    if(action==='reject'){
      reason=prompt('سبب الرفض وإلغاء الاشتراك (اختياري):');
      if(reason===null)return;
    }
    if(!confirm(action==='reject'?'رفض هذا الإيصال وإلغاء الاشتراك المرتبط؟':'اعتماد هذا الإيصال بدون تفعيل إضافي؟'))return;
    try{
      await api('/api/admin/manual-payments/'+id+'/review',{method:'PATCH',body:{action:action,rejectionReason:reason||null}});
      showToast(action==='approve'?'تم اعتماد الإيصال':'تم رفض الإيصال وإلغاء الاشتراك','success');
      reloadTab();
    }catch(e){
      showToast(e.message||'فشل '+actionText+' الطلب','error');
    }
  }
  async function deleteManualPaymentRequest(id){
    if(!confirm('حذف هذا الطلب نهائياً؟'))return;
    try{
      await api('/api/admin/manual-payments/'+id,{method:'DELETE'});
      showToast('تم حذف الطلب','info');
      reloadTab();
    }catch(e){
      showToast(e.message||'فشل حذف الطلب','error');
    }
  }
  function goManualPaymentPage(p){S.manualPaymentPage=p;reloadTab();}

  Object.assign(window,{
    loadManualPayments:loadManualPayments,
    renderManualPayments:renderManualPayments,
    reviewManualPayment:reviewManualPayment,
    deleteManualPaymentRequest:deleteManualPaymentRequest,
    goManualPaymentPage:goManualPaymentPage
  });
})();
