(function(){
  'use strict';

  const FALLBACK = [
    {id:'gmail',name:'Gmail',group:'Google Workspace',description:'Email, search, threads, labels and mailbox actions.'},
    {id:'google-sheets',name:'Google Sheets',group:'Google Workspace',description:'Read, write and manage spreadsheets.'},
    {id:'google-docs',name:'Google Docs',group:'Google Workspace',description:'Create, read and edit Google documents.'},
    {id:'google-calendar',name:'Google Calendar',group:'Google Workspace',description:'Events, schedules, attendees and calendars.'},
    {id:'google-drive',name:'Google Drive',group:'Google Workspace',description:'Files, folders, search and sharing.'},
    {id:'google-meet',name:'Google Meet',group:'Google Workspace',description:'Meetings, spaces and conference workflows.'},
    {id:'google-chat',name:'Google Chat',group:'Google Workspace',description:'Spaces, messages and conversations.'},
    {id:'google-admin',name:'Google Admin',group:'Google Workspace',description:'Workspace administration and directory operations.'},
    {id:'microsoft-word',name:'Microsoft Word',group:'Microsoft 365',description:'Documents, content and Word workflows.'},
    {id:'microsoft-excel',name:'Microsoft Excel',group:'Microsoft 365',description:'Workbooks, ranges, tables and formulas.'},
    {id:'microsoft-powerpoint',name:'Microsoft PowerPoint',group:'Microsoft 365',description:'Presentations, slides and PowerPoint workflows.'},
    {id:'microsoft-outlook',name:'Microsoft Outlook (Mail & Calendar)',group:'Microsoft 365',description:'Email, contacts and calendar operations.'},
    {id:'microsoft-teams',name:'Microsoft Teams',group:'Microsoft 365',description:'Chats, teams, channels and collaboration.'},
    {id:'microsoft-onedrive',name:'Microsoft OneDrive',group:'Microsoft 365',description:'Files and folders in OneDrive.'},
    {id:'microsoft-sharepoint',name:'Microsoft SharePoint',group:'Microsoft 365',description:'Sites, lists, libraries and collaboration.'},
    {id:'microsoft-onenote',name:'Microsoft OneNote',group:'Microsoft 365',description:'Notebooks, sections and notes.'},
    {id:'supabase',name:'Supabase',group:'Developer & Cloud',description:'Database, projects and backend workflows.'},
    {id:'github',name:'GitHub',group:'Developer & Cloud',description:'Repositories, issues, pull requests and code workflows.'},
    {id:'gitlab',name:'GitLab',group:'Developer & Cloud',description:'Projects, repositories, issues and CI workflows.'},
    {id:'aws',name:'AWS / Amazon Web Services',group:'Developer & Cloud',description:'AWS cloud workflows exposed by Composio.'},
    {id:'google-cloud',name:'Google Cloud Console',group:'Developer & Cloud',description:'Google Cloud project and platform workflows available through Composio.'}
  ];

  let state = {plugins:[],group:'All',query:'',loading:false};

  function el(id){ return document.getElementById(id); }
  function esc(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }
  function initials(name){
    return String(name || 'Plugin').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0,2).map(function(x){return x.charAt(0);}).join('').toUpperCase() || 'P';
  }
  function auth(){
    try{
      if(!window.firebase || !firebase.apps || !firebase.apps.length) return null;
      return firebase.auth();
    }catch(e){ return null; }
  }
  function headers(token){
    return {'Content-Type':'application/json','Authorization':'Bearer '+token};
  }
  function list(){
    return state.plugins.length ? state.plugins : FALLBACK.map(function(p){
      return Object.assign({},p,{configured:null,connected:false,enabled:false});
    });
  }
  function notice(message,error){
    var n=el('pluginNotice');
    if(!n) return;
    if(!message){ n.hidden=true; n.classList.remove('error'); n.textContent=''; return; }
    n.hidden=false; n.classList.toggle('error',!!error); n.textContent=message;
  }
  function updateAccessUI(){
    var all=list(), connected=all.filter(function(p){return !!p.connected;}).length;
    var active=all.filter(function(p){return !!p.enabled && !!p.connected;}).length;

    var side=el('sidebarPluginCount'); if(side) side.textContent=String(active);
    var summary=el('pluginsSummary'); if(summary) summary.textContent=active+' active · '+connected+' connected';

    var status=el('codePluginStatus'), statusText=status && status.querySelector('span:nth-child(2)');
    if(statusText) statusText.textContent=active ? active+' plugin'+(active===1?'':'s')+' active' : 'No plugins enabled';
    if(status) status.classList.toggle('active',active>0);
    var countText=el('codePluginCountText'); if(countText) countText.textContent=active+' connected';

    var stack=el('codePluginStack');
    if(stack){
      var activeList=all.filter(function(p){return !!p.enabled && !!p.connected;}).slice(0,5);
      if(activeList.length){
        stack.innerHTML=activeList.map(function(p){
          var logo=p.logo ? '<img src="'+esc(p.logo)+'" alt="" loading="lazy">' : '<span class="trux-code-mini-initials">'+esc(initials(p.name))+'</span>';
          return '<div class="trux-code-plugin-row">'+logo+'<b>'+esc(p.name)+'</b><small>CONNECTED</small></div>';
        }).join('');
      }else{
        stack.innerHTML='<div class="trux-code-plugin-placeholder"><span class="trux-code-placeholder-orb">✦</span><div><b>Connect your workspace</b><small>Add apps from Plugins and TruX-Code will receive their live Composio tools automatically.</small></div></div>';
      }
    }
  }
  function setGroup(group){
    state.group=group || 'All';
    document.querySelectorAll('[data-plugin-group]').forEach(function(b){
      b.classList.toggle('active',b.getAttribute('data-plugin-group')===state.group);
    });
    render();
  }
  function filter(value){
    state.query=String(value || '').trim().toLowerCase();
    render();
  }
  function card(p){
    var connected=!!p.connected, enabled=!!p.enabled && connected, unavailable=p.configured===false;
    var logo=p.logo || p.fallbackLogo
      ? '<img src="'+esc(p.logo || p.fallbackLogo)+'" alt="" loading="lazy">'
      : '<span class="trux-plugin-fallback-initials">'+esc(initials(p.name))+'</span>';
    var badge=connected
      ? '<span class="trux-plugin-state connected">Connected</span>'
      : (unavailable ? '<span class="trux-plugin-state">Unavailable</span>' : '<span class="trux-plugin-state">Not connected</span>');
    var action;
    if(unavailable){
      action='<button class="trux-plugin-unavailable" type="button" disabled>Not available in Composio</button>';
    }else if(enabled){
      action='<button class="trux-plugin-primary trux-plugin-added" type="button" disabled><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg><span>Added</span></button><button class="trux-plugin-remove" type="button" onclick="togglePluginAccess('+JSON.stringify(p.id)+',false)">Remove</button>';
    }else if(connected){
      action='<button class="trux-plugin-primary trux-plugin-add" type="button" onclick="togglePluginAccess('+JSON.stringify(p.id)+',true)" aria-label="Add '+esc(p.name)+' to TruX" title="Add '+esc(p.name)+' to TruX"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Add</span></button>';
    }else{
      action='<button class="trux-plugin-primary trux-plugin-add" type="button" onclick="connectTruxPlugin('+JSON.stringify(p.id)+',this)" aria-label="Connect '+esc(p.name)+'" title="Connect '+esc(p.name)+'"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Connect</span></button>';
    }
    return '<article class="trux-plugin-card"><div class="trux-plugin-card-top"><div class="trux-plugin-brand"><div class="trux-plugin-logo">'+logo+'</div><div class="trux-plugin-name"><b>'+esc(p.name)+'</b><small>'+esc(p.group || 'Integration')+'</small></div></div>'+badge+'</div><p class="trux-plugin-description">'+esc(p.description || 'Connect this service to TruX.')+'</p><div class="trux-plugin-card-actions">'+action+'</div></article>';
  }
  function render(){
    updateAccessUI();
    var grid=el('pluginsGrid'); if(!grid) return;
    if(state.loading){
      grid.innerHTML='<div class="trux-plugin-loading"></div>'.repeat(9);
      return;
    }
    var q=state.query;
    var filtered=list().filter(function(p){
      var groupOk=state.group==='All' || p.group===state.group;
      var textOk=!q || [p.name,p.description,p.group].join(' ').toLowerCase().indexOf(q)>=0;
      return groupOk && textOk;
    });
    grid.innerHTML=filtered.length ? filtered.map(card).join('') : '<div style="grid-column:1/-1;padding:46px;text-align:center;color:var(--txt-4);font-size:13px">No plugins match your search.</div>';
  }
  async function load(options){
    state.loading=true; render();
    try{
      var a=auth(), u=a && a.currentUser;
      if(!u){
        state.plugins=FALLBACK.map(function(p){return Object.assign({},p,{configured:null,connected:false,enabled:false});});
        notice('Sign in to connect plugins and give TruX permission to use them.',false);
        return;
      }
      var token=await u.getIdToken();
      var response=await fetch('/api/plugins',{headers:headers(token),cache:'no-store'});
      var data=await response.json().catch(function(){return {};});
      if(!response.ok) throw new Error(data.error || 'Plugin catalog could not be loaded.');
      state.plugins=Array.isArray(data.plugins) ? data.plugins : [];
      notice(data.configured===false ? 'Composio is not configured on the server. Add COMPOSIO_API_KEY to the Cloud Run environment.' : '',false);
    }catch(e){
      state.plugins=FALLBACK.map(function(p){return Object.assign({},p,{configured:null,connected:false,enabled:false});});
      notice(e && e.message ? e.message : 'Plugin catalog could not be loaded.',true);
    }finally{
      state.loading=false; render();
    }
  }
  async function connect(pluginId,button){
    var a=auth(); if(!a || !a.currentUser){
      if(typeof window.openLoginWall==='function') return window.openLoginWall();
      return;
    }
    var plugin=list().find(function(p){return p.id===pluginId;}) || FALLBACK.find(function(p){return p.id===pluginId;});
    if(!plugin) return;
    if(button){button.disabled=true;button.textContent='Connecting…';}
    notice('Opening the secure Composio connection flow for '+plugin.name+'…',false);
    try{
      var token=await a.currentUser.getIdToken();
      var response=await fetch('/api/plugins/connect',{method:'POST',headers:headers(token),body:JSON.stringify({pluginId:pluginId})});
      var data=await response.json().catch(function(){return {};});
      if(!response.ok) throw new Error(data.error || 'Could not start the connection.');
      if(!data.redirectUrl) throw new Error('Composio did not return a connection URL.');
      location.assign(data.redirectUrl);
    }catch(e){
      notice(e && e.message ? e.message : 'Could not connect this plugin.',true);
      if(button){button.disabled=false;button.textContent='Connect & Add';}
    }
  }
  async function toggle(pluginId,enabled){
    var a=auth(); if(!a || !a.currentUser){
      if(typeof window.openLoginWall==='function') return window.openLoginWall();
      return;
    }
    try{
      var token=await a.currentUser.getIdToken();
      var response=await fetch('/api/plugins/enable',{method:'POST',headers:headers(token),body:JSON.stringify({pluginId:pluginId,enabled:!!enabled})});
      var data=await response.json().catch(function(){return {};});
      if(!response.ok) throw new Error(data.error || 'Could not update plugin access.');
      await load({silent:true});
      notice(enabled ? 'Plugin added to TruX tool access.' : 'Plugin removed from TruX tool access. Its Composio connection remains available.',false);
    }catch(e){ notice(e && e.message ? e.message : 'Could not update plugin access.',true); }
  }
  function open(){
    document.body.classList.add('plugins-page-active');
    if(typeof window.closeSidebar==='function') window.closeSidebar();
    if(typeof window.closeAttachmentMenu==='function') window.closeAttachmentMenu();
    if(typeof window.closeModelDropdown==='function') window.closeModelDropdown();
    render(); load();
    document.getElementById('pluginsSidebarButton')?.classList.add('active');
  }
  function close(){
    document.body.classList.remove('plugins-page-active');
    document.getElementById('pluginsSidebarButton')?.classList.remove('active');
    if(typeof window.renderSidebar==='function') window.renderSidebar();
  }
  function callback(){
    var params=new URLSearchParams(location.search);
    if(params.get('trux_plugins')!=='1') return;
    try{history.replaceState({},document.title,location.pathname+location.hash);}catch(e){}
    open();
  }

  window.filterPlugins=filter;
  window.setPluginGroup=setGroup;
  window.loadPlugins=load;
  window.connectTruxPlugin=connect;
  window.togglePluginAccess=toggle;
  window.openPluginsPage=open;
  window.closePluginsPage=close;
  window.handlePluginCallback=callback;

  function boot(){
    var a=auth();
    if(a){
      a.onAuthStateChanged(function(){
        updateAccessUI();
        if(paramsHasPlugins()) callback();
      });
      if(paramsHasPlugins()) callback();
    }else{
      setTimeout(boot,500);
    }
  }
  function paramsHasPlugins(){ return new URLSearchParams(location.search).get('trux_plugins')==='1'; }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
