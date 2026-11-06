const API='/api';
const LABELS={nature:'Nature',mountains:'Mountains',beach:'By the water',heritage:'Culture & heritage',museum:'Museums',city:'City breaks',adventure:'Adventure',gastronomy:'Food & drink',wellness:'Wellness',religious:'Sacred places'};
const PHOTOS={
 nature:'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1000&q=82',
 mountains:'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1000&q=82',
 beach:'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1000&q=82',
 heritage:'https://images.unsplash.com/photo-1533929736458-ca588d08c8be?auto=format&fit=crop&w=1000&q=82',
 museum:'https://images.unsplash.com/photo-1561214115-f2f134cc4912?auto=format&fit=crop&w=1000&q=82',
 city:'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1000&q=82',
 adventure:'https://images.unsplash.com/photo-1551632811-561732d1e306?auto=format&fit=crop&w=1000&q=82',
 gastronomy:'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=1000&q=82',
 wellness:'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1000&q=82',
 religious:'https://images.unsplash.com/photo-1548013146-72479768bada?auto=format&fit=crop&w=1000&q=82'
};
const state={token:sessionStorage.getItem('wayfarer_token')||'',user:null,items:[],page:1,pages:1,total:0,filters:{q:'',country:'',season:'',price:'',category:'',sort:'popular'},geo:null,bookmarks:new Map(),current:null};
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function imageFor(item){if(item.imageUrl){try{const u=new URL(item.imageUrl,location.origin);if(u.protocol==='https:'||u.origin===location.origin)return u.href;}catch(e){}}return PHOTOS[item.category]||PHOTOS.nature;}
function money(item){const n=Number(item.avgDailyCostUSD);if(Number.isFinite(n)&&n>0)return '$'+Math.round(n)+' / day';return ({1:'Budget friendly',2:'Moderate',3:'Upscale',4:'Luxury'}[item.priceLevel]||'Explore');}
function toast(message,error){const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=message;$('#toast').append(el);setTimeout(()=>el.remove(),3600);}
async function api(path,options){options=options||{};const headers=new Headers(options.headers||{});if(options.body!==undefined)headers.set('Content-Type','application/json');if(state.token)headers.set('Authorization','Bearer '+state.token);let response;try{response=await fetch(API+path,{method:options.method||'GET',headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});}catch(e){throw new Error('The server could not be reached. Check the deployment and try again.');}const body=await response.json().catch(()=>null);if(!response.ok)throw new Error((body&&body.message)||('Request failed ('+response.status+').'));return body;}
function showDialog(id){const d=$(id);if(d&&!d.open)d.showModal();}
function closeDialog(id){const d=$(id);if(d&&d.open)d.close();}
function showAuth(mode){setAuthMode(mode||'login');showDialog('#auth-dialog');}
function authMessage(message,success){$('#auth-message').textContent=message||'';$('#auth-message').classList.toggle('success',!!success);}
function setAuthMode(mode){const register=mode==='register';$('#login-form').hidden=register;$('#register-form').hidden=!register;$('#auth-title').innerHTML=register?'Join the <em>journey.</em>':'Welcome <em>back.</em>';$('#auth-intro').textContent=register?'Create an account to save your favorite places and build a travel shortlist.':'Sign in to save places and keep your travel ideas together.';$$('[data-mode]').forEach(b=>{b.classList.toggle('selected',b.dataset.mode===mode);});authMessage('');}
function displayName(){return state.user&&state.user.profile&&state.user.profile.fullName||state.user&&state.user.email&&state.user.email.split('@')[0]||'Traveler';}
function syncAccount(){const signed=!!(state.token&&state.user);$('#auth-open').hidden=signed;$('#account').hidden=!signed;if(signed){$('#account-name').textContent=displayName().split(' ')[0];$('#avatar').textContent=(displayName()[0]||'W').toUpperCase();}}
function clearSession(){state.token='';state.user=null;state.bookmarks.clear();sessionStorage.removeItem('wayfarer_token');syncAccount();renderCards();toast('You have signed out.');}
async function refreshBookmarks(){if(!state.token){state.bookmarks.clear();return;}try{const r=await api('/users/me/history?type=bookmark&limit=50');state.bookmarks=new Map((r.data||[]).map(x=>[String(x.itemId),String(x._id)]));}catch(e){if(e.message.toLowerCase().includes('token'))clearSession();}}
async function finishLogin(result){state.token=result.token;state.user=result.user;sessionStorage.setItem('wayfarer_token',result.token);await refreshBookmarks();syncAccount();renderCards();closeDialog('#auth-dialog');toast('Welcome, '+displayName().split(' ')[0]+'. Happy exploring.');}
function renderCards(){const grid=$('#cards');grid.setAttribute('aria-busy','false');if(!state.items.length){grid.innerHTML='<div class="empty"><b>⌖</b><h3>No places found just yet.</h3><p>Try a broader search or clear a filter to discover more places.</p><button class="button button-outline" data-action="clear" type="button">Clear filters</button></div>';}else{grid.innerHTML=state.items.map((item,i)=>{const id=String(item._id||'');const saved=state.bookmarks.has(id);const rating=Number(item.stats&&item.stats.avgRating||0);const count=Number(item.stats&&item.stats.ratingCount||0);return '<article class="destination-card"><div class="card-photo"><img src="'+esc(imageFor(item))+'" alt="'+esc(item.name)+'" loading="lazy"><span class="card-tag">'+esc(LABELS[item.category]||'Destination')+'</span><button class="save-button '+(saved?'saved':'')+'" data-action="save" data-id="'+esc(id)+'" type="button" aria-label="Save destination" aria-pressed="'+saved+'">'+(saved?'♥':'♡')+'</button><span class="card-number">NO. '+String(i+1).padStart(2,'0')+'</span></div><div class="card-body"><div class="card-location">'+esc(item.city)+' · '+esc(item.country)+'</div><div class="card-title-row"><h3 class="card-title">'+esc(item.name)+'</h3>'+(count?'<span class="card-rating"><b>★</b> '+rating.toFixed(1)+'</span>':'')+'</div><p class="card-description">'+esc(item.description||'A place waiting to be discovered.')+'</p><div class="card-foot"><span class="card-cost">'+esc(money(item))+'</span><button class="card-open" data-action="detail" data-id="'+esc(id)+'" type="button">Explore place ↗</button></div></div></article>';}).join('');grid.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.classList.add('image-fallback');img.removeAttribute('src');},{once:true}));}
$('#result-count').textContent=state.total+' '+(state.total===1?'place':'places')+' found';$('#result-summary').textContent=state.total?'Showing '+state.items.length+' of '+state.total+' destinations. Follow the places that call to you.':'Try changing your filters — there is always somewhere new to find.';$('#load-more').hidden=!state.items.length||state.page>=state.pages;}
function updateChips(){$$('.chip').forEach(b=>{const active=(b.dataset.category||'')===state.filters.category;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
function readFilters(){state.filters.q=$('#query').value.trim();state.filters.country=$('#country').value;state.filters.season=$('#season').value;state.filters.price=$('#price').value;state.filters.sort=$('#sort').value;}
async function load(page,append){page=page||1;append=!!append;const grid=$('#cards');if(!append){grid.setAttribute('aria-busy','true');grid.innerHTML='<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';}const p=new URLSearchParams({page:String(page),limit:'9',sort:state.filters.sort||'popular'});if(state.filters.q)p.set('q',state.filters.q);if(state.filters.country)p.set('country',state.filters.country);if(state.filters.season)p.set('season',state.filters.season);if(state.filters.category)p.set('category',state.filters.category);if(state.filters.price){p.set('minPrice',state.filters.price);p.set('maxPrice',state.filters.price);}if(state.geo){p.set('lat',String(state.geo.lat));p.set('lon',String(state.geo.lon));p.set('radiusKm','200');if(!state.filters.q)p.set('sort','distance');}
try{const r=await api('/items/search?'+p.toString());state.items=append?state.items.concat(r.data||[]):(r.data||[]);state.page=Number(r.page||page);state.pages=Number(r.totalPages||1);state.total=Number(r.total||0);renderCards();updateChips();}catch(e){state.items=[];state.total=0;grid.setAttribute('aria-busy','false');grid.innerHTML='<div class="empty"><b>!</b><h3>We could not load the destinations.</h3><p>'+esc(e.message)+'</p><button class="button button-outline" type="button" data-action="retry">Try again</button></div>';$('#result-count').textContent='Connection unavailable';$('#result-summary').textContent='The website is available, but destination data needs the API and database.';$('#load-more').hidden=true;}}
function applySearch(){readFilters();load(1,false);}
function clearFilters(){state.filters={q:'',country:'',season:'',price:'',category:'',sort:'popular'};state.geo=null;$('#hero-query').value='';$('#query').value='';$('#country').value='';$('#season').value='';$('#price').value='';$('#sort').value='popular';updateChips();load(1,false);}
async function savePlace(id){if(!state.token){showAuth('login');authMessage('Sign in to save this destination.');return;}try{const existing=state.bookmarks.get(id);if(existing){await api('/interactions/'+encodeURIComponent(existing),{method:'DELETE'});state.bookmarks.delete(id);toast('Removed from your saved places.');}else{const r=await api('/interactions',{method:'POST',body:{itemId:id,type:'bookmark'}});state.bookmarks.set(id,String(r._id));toast('Saved to your places.');}renderCards();if(state.current&&String(state.current._id)===id)renderDetail();}catch(e){toast(e.message,true);}}
async function interaction(id,type,rating){if(!state.token){showAuth('login');authMessage('Sign in to save your activity.');return null;}try{const payload={itemId:id,type:type};if(rating)payload.rating=rating;const r=await api('/interactions',{method:'POST',body:payload});if(type==='visit')toast('Added to your travel history.');if(type==='rating')toast('Thanks for sharing your rating.');return r;}catch(e){toast(e.message,true);return null;}}
async function openDetail(id){try{let item=state.items.find(x=>String(x._id)===id);item=await api('/items/'+encodeURIComponent(id)).catch(()=>item);if(!item)throw new Error('This destination could not be found.');state.current=item;renderDetail();showDialog('#detail-dialog');if(state.token)api('/interactions',{method:'POST',body:{itemId:id,type:'view'}}).catch(()=>{});}catch(e){toast(e.message,true);}}
function renderDetail(){const item=state.current;if(!item)return;const id=String(item._id);const saved=state.bookmarks.has(id);const coord=item.location&&item.location.coordinates;const map=coord?'<a href="https://www.google.com/maps?q='+encodeURIComponent(coord[1]+','+coord[0])+'" target="_blank" rel="noreferrer">Open map ↗</a>':'';const tags=(item.tags||[]).slice(0,7).map(x=>'<span>'+esc(x)+'</span>').join('');const seasons=(item.bestSeasons||[]).map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(', ')||'All year';const days=Number(item.attributes&&item.attributes.recommendedDays||1);$('#detail-content').innerHTML='<div class="detail-photo"><img src="'+esc(imageFor(item))+'" alt="'+esc(item.name)+'"><button class="dialog-close" data-close type="button" aria-label="Close">×</button></div><div class="detail-main"><div class="detail-kicker">'+esc(LABELS[item.category]||'Destination')+' · '+esc(item.city)+' · '+esc(item.country)+'</div><h2 id="detail-title">'+esc(item.name)+'</h2><p>'+esc(item.description||'')+'</p><div class="detail-facts"><div><small>Daily budget</small><b>'+esc(money(item))+'</b></div><div><small>Best season</small><b>'+esc(seasons)+'</b></div><div><small>Suggested stay</small><b>'+days+' '+(days===1?'day':'days')+'</b></div></div><div class="detail-tags">'+tags+'</div><div class="detail-actions"><button class="button button-dark" data-action="visit" data-id="'+esc(id)+'" type="button">I have been here ✓</button><div class="stars"><span>RATE THIS PLACE</span>'+[1,2,3,4,5].map(n=>'<button data-action="rate" data-id="'+esc(id)+'" data-rating="'+n+'" type="button" aria-label="Rate '+n+' out of 5">★</button>').join('')+'</div></div><p>'+map+'</p><button class="text-button" data-action="save" data-id="'+esc(id)+'" type="button">'+(saved?'♥ Remove from saved':'♡ Save this destination')+'</button></div>';const img=$('#detail-content img');img.addEventListener('error',()=>img.classList.add('image-fallback'),{once:true});}
async function openProfile(){
  if(!state.user){showAuth('login');return;}
  try{
    const pair=await Promise.all([
      api('/users/me'),
      api('/users/me/history?type=bookmark&limit=50')
    ]);
    state.user=pair[0];
    const r=pair[1];
    const entries=r.data||[];
    const profile=state.user.profile||{};
    const fullName=profile.fullName||displayName();
    const interests=(profile.interests||[]).map(x=>LABELS[x]||x);
    const savedCities=[...new Set(entries.map(x=>(x.destinationSnapshot&&x.destinationSnapshot.city)||(x.item&&x.item.city)).filter(Boolean))];
    const list=entries.length
      ?entries.slice(0,12).map(x=>{
        const item=x.item||x.destinationSnapshot||{};
        const city=(x.destinationSnapshot&&x.destinationSnapshot.city)||(item.city)||'';
        return '<div class="profile-place"><span>'+esc(item.name||x.destinationSnapshot&&x.destinationSnapshot.name||'Saved destination')+'</span><small>'+esc(city)+'</small></div>';
      }).join('')
      :'<p>Your shortlist is empty. Save a place to keep it close.</p>';
    const interestTags=interests.length
      ?interests.map(x=>'<span class="profile-tag">'+esc(x)+'</span>').join('')
      :'<p>No interests selected yet.</p>';
    const cityTags=savedCities.length
      ?savedCities.map(x=>'<span class="profile-tag">'+esc(x)+'</span>').join('')
      :'<p>Like a destination to start collecting cities here.</p>';
    $('#profile-content').innerHTML=
      '<button class="dialog-close" data-close type="button" aria-label="Close">×</button>'+
      '<small class="dialog-kicker">YOUR WAYFARER ACCOUNT</small>'+
      '<h2 id="profile-title">'+esc(fullName)+'</h2>'+
      '<p>'+esc(state.user.email||'')+'</p>'+
      '<div class="profile-meta"><span><b>Age</b> '+(profile.age?esc(profile.age):'Not provided')+'</span><span><b>Home city</b> '+esc(profile.city||'Not provided')+'</span></div>'+
      '<div class="profile-stats"><div><b>'+Number(r.total||entries.length)+'</b><small>SAVED PLACES</small></div><div><b>'+savedCities.length+'</b><small>CITIES LIKED</small></div></div>'+
      '<div class="profile-list"><h3>Your interests</h3><div class="profile-tags">'+interestTags+'</div></div>'+
      '<div class="profile-list"><h3>Cities in your saved places</h3><div class="profile-tags">'+cityTags+'</div></div>'+
      '<div class="profile-list"><h3>Your shortlist</h3>'+list+'</div>'+
      '<div class="profile-footer"><button class="text-button" data-action="logout" type="button">Sign out</button><button class="button button-dark button-small" data-close type="button">Done</button></div>';
    showDialog('#profile-dialog');
    syncAccount();
  }catch(e){toast(e.message,true);}
}
function locateNearby(){if(!navigator.geolocation){toast('Location search is not available in this browser.',true);return;}toast('Finding places near you…');navigator.geolocation.getCurrentPosition(pos=>{state.geo={lat:pos.coords.latitude,lon:pos.coords.longitude};load(1,false);$('#discover').scrollIntoView({behavior:'smooth'});},err=>toast(err.code===1?'Location permission was not granted.':'Could not determine your location.',true),{timeout:10000,maximumAge:60000});}
function busy(form,on,label){const b=form.querySelector('button[type="submit"]');if(!b)return;if(on){b.dataset.label=b.textContent;b.disabled=true;b.textContent=label;}else{b.disabled=false;if(b.dataset.label)b.textContent=b.dataset.label;}}
$('#hero-search').addEventListener('submit',e=>{e.preventDefault();$('#query').value=$('#hero-query').value;applySearch();$('#discover').scrollIntoView({behavior:'smooth'});});
$('#filters').addEventListener('submit',e=>{e.preventDefault();state.geo=null;applySearch();});
$('#sort').addEventListener('change',()=>{state.filters.sort=$('#sort').value;load(1,false);});
$('#categories').addEventListener('click',e=>{const b=e.target.closest('[data-category]');if(!b)return;state.filters.category=b.dataset.category||'';updateChips();load(1,false);});
$('#clear').addEventListener('click',clearFilters);
$('#load-more').addEventListener('click',()=>load(state.page+1,true));
$('#nearby').addEventListener('click',locateNearby);
$('#auth-open').addEventListener('click',()=>showAuth('login'));
$('#mobile-auth').addEventListener('click',()=>{toggleMenu(false);showAuth('login');});
$('#account').addEventListener('click',openProfile);
$('#menu-toggle').addEventListener('click',()=>toggleMenu($('#mobile-nav').hidden));
function toggleMenu(open){$('#mobile-nav').hidden=!open;$('#menu-toggle').setAttribute('aria-expanded',String(open));}
$('#mobile-nav').addEventListener('click',e=>{if(e.target.closest('a'))toggleMenu(false);});
$$('[data-mode]').forEach(b=>b.addEventListener('click',()=>setAuthMode(b.dataset.mode)));
['#auth-dialog','#detail-dialog','#profile-dialog'].forEach(sel=>$(sel).addEventListener('click',e=>{if(e.target===e.currentTarget||e.target.closest('[data-close]'))e.currentTarget.close();}));
$('#cards').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;if(a==='detail')openDetail(b.dataset.id);if(a==='save')savePlace(b.dataset.id);if(a==='clear')clearFilters();if(a==='retry')load(1,false);});
$('#detail-content').addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const id=b.dataset.id;if(b.dataset.action==='save')savePlace(id);if(b.dataset.action==='visit')interaction(id,'visit');if(b.dataset.action==='rate'){const r=await interaction(id,'rating',Number(b.dataset.rating));if(r){state.current=await api('/items/'+encodeURIComponent(id)).catch(()=>state.current);renderDetail();load(1,false);}}});
$('#profile-content').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b&&b.dataset.action==='logout'){closeDialog('#profile-dialog');clearSession();}});
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;busy(f,true,'Signing in…');authMessage('');try{const r=await api('/auth/login',{method:'POST',body:{email:$('#login-email').value.trim(),password:$('#login-password').value}});await finishLogin(r);f.reset();}catch(err){authMessage(err.message);}finally{busy(f,false);}});
$('#register-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.currentTarget;
  busy(f,true,'Creating account…');
  authMessage('');
  try{
    const interests=$('input[name="register-interest"]:checked').map(input=>input.value);
    const r=await api('/auth/register',{
      method:'POST',
      body:{
        email:$('#register-email').value.trim(),
        password:$('#register-password').value,
        profile:{
          fullName:$('#register-name').value.trim(),
          age:Number($('#register-age').value),
          city:$('#register-city').value.trim(),
          interests
        }
      }
    });
    await finishLogin(r);
    f.reset();
  }catch(err){authMessage(err.message);}
  finally{busy(f,false);}
});
async function bootstrap(){if(!state.token)return;try{state.user=await api('/users/me');await refreshBookmarks();syncAccount();renderCards();}catch(e){state.token='';sessionStorage.removeItem('wayfarer_token');state.user=null;syncAccount();}}
$('#year').textContent=String(new Date().getFullYear());setAuthMode('login');syncAccount();load(1,false);bootstrap();
