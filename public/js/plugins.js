/* Plugins page (Composio-connected apps). */
(function(){
  'use strict';

  const FALLBACK = [
    {id:'gmail',name:'Gmail',group:'Google Workspace',logo:'https://cdn.simpleicons.org/gmail',description:'Email, search, labels, threads and mailbox actions.'},
    {id:'google-sheets',name:'Google Sheets',group:'Google Workspace',logo:'https://cdn.simpleicons.org/googlesheets',description:'Read and update spreadsheets, ranges and tables.'},
    {id:'google-docs',name:'Google Docs',group:'Google Workspace',logo:'https://cdn.simpleicons.org/googledocs',description:'Create, read and edit Google documents.'},
    {id:'google-calendar',name:'Google Calendar',group:'Google Workspace',logo:'https://cdn.simpleicons.org/googlecalendar',description:'Create, search and manage calendar events.'},
    {id:'google-drive',name:'Google Drive',group:'Google Workspace',logo:'https://cdn.simpleicons.org/googledrive',description:'Search, read and manage Drive files and folders.'},
    {id:'google-meet',name:'Google Meet',group:'Google Workspace',logo:'https://cdn.simpleicons.org/googlemeet',description:'Create meetings and work with conference details, transcripts and recordings.'},
    {id:'microsoft-excel',name:'Microsoft Excel',group:'Microsoft 365',logo:'https://cdn.simpleicons.org/microsoftexcel',description:'Work with workbooks, worksheets, ranges, tables and charts.'},
    {id:'microsoft-teams',name:'Microsoft Teams',group:'Microsoft 365',logo:'https://cdn.simpleicons.org/microsoftteams',description:'Teams, chats, channels and collaboration.'},
    {id:'microsoft-outlook',name:'Microsoft Outlook',group:'Microsoft 365',logo:'https://cdn.simpleicons.org/microsoftoutlook',description:'Email, calendar and contact workflows.'},
    {id:'microsoft-onedrive',name:'Microsoft OneDrive',group:'Microsoft 365',logo:'https://cdn.simpleicons.org/microsoftonedrive',description:'Search, read, upload and manage cloud files.'},
    {id:'github',name:'GitHub',group:'Developer',logo:'https://cdn.simpleicons.org/github',description:'Repositories, issues, pull requests and code workflows.'},
    {id:'slack',name:'Slack',group:'Work & Collaboration',logo:'https://cdn.simpleicons.org/slack',description:'Channels, messages, threads and team collaboration.'},
    {id:'notion',name:'Notion',group:'Work & Collaboration',logo:'https://cdn.simpleicons.org/notion',description:'Pages, databases, notes and workspace content.'}
  ];

  let state = {plugins:[],group:'All',query:'',loading:false};
  let workspacePlaceholder = null;

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
  async function authenticatedFetch(url, options, user){
    if(typeof truxAuthenticatedFetch === 'function'){
      return truxAuthenticatedFetch(url, options || {}, user);
    }
    var init = options || {};
    var target = user || (auth() && auth().currentUser);
    if(!target) throw new Error('Sign in to continue.');
    async function run(forceRefresh){
      var token = await target.getIdToken(!!forceRefresh);
      var requestHeaders = new Headers(init.headers || {});
      requestHeaders.set('Authorization','Bearer '+token);
      return fetch(url,Object.assign({},init,{headers:requestHeaders}));
    }
    var response = await run(false);
    if(response.status===401 && auth() && auth().currentUser && auth().currentUser.uid===target.uid){
      response = await run(true);
    }
    return response;
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
    var active=connected;

    var side=el('sidebarPluginCount'); if(side) side.textContent=String(active);
    var summary=el('pluginsSummary'); if(summary) summary.textContent=active+' active · '+connected+' connected';

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
    var connected=!!p.connected, unavailable=p.connectable===false;
    var logo=p.logo || p.fallbackLogo
      ? '<img src="'+esc(p.logo || p.fallbackLogo)+'" alt="" loading="lazy">'
      : '<span class="trux-plugin-fallback-initials">'+esc(initials(p.name))+'</span>';
    var badge=connected
      ? '<span class="trux-plugin-state connected">Connected</span>'
      : (unavailable ? '<span class="trux-plugin-state">Unavailable</span>' : '<span class="trux-plugin-state">Not connected</span>');
    var action;
    if(unavailable){
      action='<button class="trux-plugin-connect" type="button" disabled aria-label="Connect '+esc(p.name)+'">Connect</button>';
    }else if(connected){
      action='<button class="trux-plugin-connect danger" type="button" data-plugin-disconnect="'+esc(p.id)+'" aria-label="Disconnect '+esc(p.name)+'">Disconnect</button>';
    }else{
      action='<button class="trux-plugin-connect" type="button" data-plugin-add="'+esc(p.id)+'" aria-label="Connect '+esc(p.name)+'">Connect</button>';
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
        state.plugins=FALLBACK.map(function(p){return Object.assign({},p,{configured:null,connectable:true,connected:false,enabled:false});});
        notice('Sign in to connect plugins and give TruX permission to use them.',false);
        return;
      }
      var response=await authenticatedFetch('/api/plugins',{cache:'no-store'},u);
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
  async function addOrConnectPlugin(pluginId,button){
    var existing=list().find(function(p){return p.id===pluginId;});
    if(existing && existing.connected) return disconnect(pluginId,button);
    return connect(pluginId,button);
  }

  async function connect(pluginId,button){
    var a=auth(); if(!a || !a.currentUser){
      if(typeof window.openLoginWall==='function') return window.openLoginWall();
      return;
    }
    var plugin=list().find(function(p){return p.id===pluginId;}) || FALLBACK.find(function(p){return p.id===pluginId;});
    if(!plugin) return;
    if(button){button.disabled=true;button.textContent='Connecting…';button.setAttribute('aria-busy','true');}
    notice('Opening the secure Composio connection flow for '+plugin.name+'…',false);
    try{
      var response=await authenticatedFetch('/api/plugins/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pluginId:pluginId})},a.currentUser);
      var data=await response.json().catch(function(){return {};});
      if(!response.ok) throw new Error(data.error || 'Could not start the connection.');
      if(!data.redirectUrl) throw new Error('Composio did not return a connection URL.');
      location.assign(data.redirectUrl);
    }catch(e){
      notice(e && e.message ? e.message : 'Could not connect this plugin.',true);
      if(button){button.disabled=false;button.textContent='Connect';button.removeAttribute('aria-busy');}
    }
  }
  async function disconnect(pluginId,button){
    var a=auth(); if(!a || !a.currentUser){
      if(typeof window.openLoginWall==='function') return window.openLoginWall();
      return;
    }
    var plugin=list().find(function(p){return p.id===pluginId;});
    if(!plugin) return;
    if(!confirm('Disconnect '+plugin.name+' from TruX?')) return;
    if(button){button.disabled=true;button.textContent='Disconnecting…';button.setAttribute('aria-busy','true');}
    notice('Disconnecting '+plugin.name+'…',false);
    try{
      var response=await authenticatedFetch('/api/plugins/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pluginId:pluginId})},a.currentUser);
      var data=await response.json().catch(function(){return {};});
      if(!response.ok) throw new Error(data.error || 'Could not disconnect the plugin.');
      await load({silent:true});
      notice('Disconnected '+plugin.name+'.',false);
    }catch(e){
      notice(e && e.message ? e.message : 'Could not disconnect the plugin.',true);
      if(button){button.disabled=false;button.textContent='Disconnect';button.removeAttribute('aria-busy');}
    }
  }
  function open(){
    const workspace = el('pluginsWorkspace');
    if(workspace && workspace.parentNode !== document.body){
      if(!workspacePlaceholder){
        workspacePlaceholder = document.createComment('TruX Plugins workspace position');
        workspace.parentNode.insertBefore(workspacePlaceholder, workspace);
      }
      document.body.appendChild(workspace);
    }
    document.body.classList.add('plugins-page-active');
    if(typeof window.closeSidebar==='function') window.closeSidebar();
    if(typeof window.closeAttachmentMenu==='function') window.closeAttachmentMenu();
    if(typeof window.closeModelDropdown==='function') window.closeModelDropdown();
    render(); load();
    document.getElementById('pluginsSidebarButton')?.classList.add('active');
  }
  function close(){
    document.body.classList.remove('plugins-page-active');
    const workspace = el('pluginsWorkspace');
    if(workspace && workspacePlaceholder && workspacePlaceholder.parentNode){
      workspacePlaceholder.parentNode.insertBefore(workspace, workspacePlaceholder);
      workspacePlaceholder.parentNode.removeChild(workspacePlaceholder);
      workspacePlaceholder = null;
    }
    document.getElementById('pluginsSidebarButton')?.classList.remove('active');
    if(typeof window.renderSidebar==='function') window.renderSidebar();
  }
  function callback(){
    var params=new URLSearchParams(location.search);
    if(params.get('trux_plugins')!=='1') return;
    try{history.replaceState({},document.title,location.pathname+location.hash);}catch(e){}
    open();
    load({silent:true});
  }

  window.filterPlugins=filter;
  window.setPluginGroup=setGroup;
  window.loadPlugins=load;
  window.connectTruxPlugin=connect;
  window.disconnectTruxPlugin=disconnect;
  window.addOrConnectPlugin=addOrConnectPlugin;
  window.openPluginsPage=open;
  window.closePluginsPage=close;
  window.handlePluginCallback=callback;

  function boot(){
    if(!window.__truxPluginControlsBound){
      document.addEventListener('click', function(event){
      var add=event.target && event.target.closest ? event.target.closest('[data-plugin-add]') : null;
      if(add){ event.preventDefault(); event.stopPropagation(); addOrConnectPlugin(add.getAttribute('data-plugin-add'), add); return; }
      var disconnectBtn=event.target && event.target.closest ? event.target.closest('[data-plugin-disconnect]') : null;
      if(disconnectBtn){ event.preventDefault(); event.stopPropagation(); disconnect(disconnectBtn.getAttribute('data-plugin-disconnect'), disconnectBtn); return; }
      var openBtn=event.target && event.target.closest ? event.target.closest('[data-open-plugins]') : null;
      if(openBtn){ event.preventDefault(); event.stopPropagation(); open(); return; }
      }, true);
      window.__truxPluginControlsBound=true;
    }
    var a=auth();
    if(a){
      a.onAuthStateChanged(function(){
        updateAccessUI();
        load({silent:true});
        if(paramsHasPlugins()) callback();
      });
      load({silent:true});
      // Keep Code's integration indicator fresh after connections change in
      // another tab/window or after returning from the Composio flow.
      if(!window.__truxPluginRefreshTimer){
        window.__truxPluginRefreshTimer=setInterval(function(){
          if(document.body.classList.contains('plugins-page-active')){
            load({silent:true});
          }
        },12000);
      }
      window.addEventListener('focus',function(){ load({silent:true}); },{passive:true});
      if(paramsHasPlugins()) callback();
    }else{
      setTimeout(boot,500);
    }
  }
  function paramsHasPlugins(){ return new URLSearchParams(location.search).get('trux_plugins')==='1'; }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
