/* Mermaid and SVG diagrams with fallbacks and editor. */
function getTruxMermaidCandidates(raw){
  const original=String(raw||"").trim();
  const normalized=normalizeTruxMermaidSource(original);
  const repaired=repairTruxMermaidSource(normalized);
  return [...new Set([normalized,repaired,original].filter(Boolean))];
}
function renderTruxFallbackFlowchart(raw,svgSlot,stage){
  const source=normalizeTruxMermaidSource(raw);
  if(!/^(?:flowchart|graph)\b/i.test(source)||!svgSlot||!stage)return null;
  const NS="http://www.w3.org/2000/svg",nodes=new Map(),edges=[];
  const tokenPattern=/([A-Za-z_][\w-]*)\s*(\(\([^)\n]*\)\)|\(\[[^\]\n]*\]\)|\[[^\]\n]*\]|\{[^}\n]*\}|\([^)\n]*\))?/g;
  const hasEdge=/(?:-->|---|-.->|==>|--o|--x)/;
  const lines=source.split("\n");
  for(const rawLine of lines.slice(1)){
    const line=rawLine.trim();
    if(!line||line.startsWith("%%")||/^(?:subgraph|end|style|classDef|class|linkStyle|click|direction|accTitle|accDescr)\b/i.test(line))continue;
    const scan=line.replace(/--\s*[^-\n]+?\s*-->/g,"-->").replace(/-->\s*\|[^|]*\|/g,"-->");
    const matches=Array.from(scan.matchAll(tokenPattern)),ids=[];
    for(const m of matches){
      const id=m[1],shape=m[2]||"";
      let label=id,kind="rect";
      if(shape.startsWith("((")){label=shape.slice(2,-2);kind="circle";}
      else if(shape.startsWith("([")){label=shape.slice(2,-2);kind="round";}
      else if(shape.startsWith("[")){label=shape.slice(1,-1);}
      else if(shape.startsWith("{")){label=shape.slice(1,-1);kind="diamond";}
      else if(shape.startsWith("(")){label=shape.slice(1,-1);kind="round";}
      label=String(label).replace(/^["']|["']$/g,"").replace(/\\(["'])/g,"$1").trim()||id;
      if(!nodes.has(id))nodes.set(id,{id,label,kind});
      else if(shape&&nodes.get(id).label===id)Object.assign(nodes.get(id),{label,kind});
      ids.push(id);
    }
    if(hasEdge.test(scan)&&ids.length>1){
      for(let i=0;i<ids.length-1;i++){
        if(ids[i]!==ids[i+1]&&!edges.some(e=>e.from===ids[i]&&e.to===ids[i+1]))edges.push({from:ids[i],to:ids[i+1]});
      }
    }
  }
  if(!nodes.size)return null;
  const incoming=new Map(),outgoing=new Map();
  for(const id of nodes.keys()){incoming.set(id,0);outgoing.set(id,[]);}
  for(const e of edges){if(incoming.has(e.to)&&outgoing.has(e.from)){incoming.set(e.to,incoming.get(e.to)+1);outgoing.get(e.from).push(e.to);}}
  const level=new Map(),queue=[];
  for(const id of nodes.keys())if(incoming.get(id)===0){level.set(id,0);queue.push(id);}
  if(!queue.length){const first=nodes.keys().next().value;level.set(first,0);queue.push(first);}
  for(let i=0;i<queue.length;i++)for(const next of outgoing.get(queue[i])||[])if(!level.has(next)){level.set(next,(level.get(queue[i])||0)+1);queue.push(next);}
  for(const id of nodes.keys())if(!level.has(id))level.set(id,0);
  const grouped=new Map();
  for(const item of nodes.values()){const l=level.get(item.id)||0;if(!grouped.has(l))grouped.set(l,[]);grouped.get(l).push(item);}
  const layers=[...grouped.keys()].sort((a,b)=>a-b),fontSize=24,nodeGap=32,layerGap=86,margin=60;
  const wrapLabel=value=>{const out=[];let row="";for(const word of String(value).split(/\s+/)){if(row&&(row+" "+word).length>22){out.push(row);row=word;}else row=row?row+" "+word:word;}if(row)out.push(row);return out.length?out:[String(value)];};
  const dims=new Map();
  for(const item of nodes.values()){const rows=wrapLabel(item.label);dims.set(item.id,{rows,w:Math.max(150,Math.min(330,Math.max(...rows.map(x=>x.length))*fontSize*.62+42)),h:Math.max(68,rows.length*30+28)});}
  const rowWidths=layers.map(l=>grouped.get(l).reduce((sum,item)=>sum+dims.get(item.id).w,0)+nodeGap*Math.max(0,grouped.get(l).length-1));
  const width=Math.max(1440,...rowWidths.map(w=>w+margin*2));
  const height=margin*2+layers.reduce((sum,l)=>sum+Math.max(...grouped.get(l).map(item=>dims.get(item.id).h)),0)+layerGap*Math.max(0,layers.length-1);
  const positions=new Map();let y=margin;
  for(const l of layers){
    const items=grouped.get(l),rowH=Math.max(...items.map(item=>dims.get(item.id).h));
    let x=(width-rowWidths[layers.indexOf(l)])/2;
    for(const item of items){const d=dims.get(item.id);positions.set(item.id,{x:x+d.w/2,y:y+rowH/2,w:d.w,h:d.h,rows:d.rows,kind:item.kind});x+=d.w+nodeGap;}
    y+=rowH+layerGap;
  }
  const svg=document.createElementNS(NS,"svg");
  svg.setAttribute("xmlns",NS);svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("role","img");svg.setAttribute("aria-label","Diagram");
  svg.style.background="#151515";svg.style.backgroundColor="#151515";
  const defs=document.createElementNS(NS,"defs"),marker=document.createElementNS(NS,"marker"),arrow=document.createElementNS(NS,"path");
  marker.setAttribute("id","trux-fallback-arrow-"+(++truxMermaidRenderSequence));marker.setAttribute("markerWidth","10");marker.setAttribute("markerHeight","8");marker.setAttribute("refX","9");marker.setAttribute("refY","4");marker.setAttribute("orient","auto");
  arrow.setAttribute("d","M0,0 L10,4 L0,8 z");arrow.setAttribute("fill","#b4b4b4");marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
  const arrowRef="url(#"+marker.id+")";
  for(const e of edges){
    const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)continue;
    const x1=a.x,y1=a.y+a.h/2,x2=b.x,y2=b.y-b.h/2,mid=(y1+y2)/2;
    const pathNode=document.createElementNS(NS,"path");
    pathNode.setAttribute("class","flowchart-link");pathNode.setAttribute("d","M "+x1+" "+y1+" C "+x1+" "+mid+", "+x2+" "+mid+", "+x2+" "+y2);
    pathNode.setAttribute("fill","none");pathNode.setAttribute("stroke","#b4b4b4");pathNode.setAttribute("stroke-width","2.4");pathNode.setAttribute("marker-end",arrowRef);svg.appendChild(pathNode);
  }
  for(const item of nodes.values()){
    const p=positions.get(item.id),g=document.createElementNS(NS,"g");
    g.setAttribute("class","node");
    const title=document.createElementNS(NS,"title");title.textContent=item.id;g.appendChild(title);
    let shape;
    if(item.kind==="diamond"){
      shape=document.createElementNS(NS,"polygon");shape.setAttribute("points",p.x+","+(p.y-p.h/2)+" "+(p.x+p.w/2)+","+p.y+" "+p.x+","+(p.y+p.h/2)+" "+(p.x-p.w/2)+","+p.y);
    }else{
      shape=document.createElementNS(NS,item.kind==="circle"?"ellipse":"rect");
      if(item.kind==="circle"){shape.setAttribute("cx",p.x);shape.setAttribute("cy",p.y);shape.setAttribute("rx",p.w/2);shape.setAttribute("ry",p.h/2);}
      else{shape.setAttribute("x",p.x-p.w/2);shape.setAttribute("y",p.y-p.h/2);shape.setAttribute("width",p.w);shape.setAttribute("height",p.h);shape.setAttribute("rx",item.kind==="round"?"22":"10");}
    }
    shape.setAttribute("fill","#151515");shape.setAttribute("stroke","#818181");shape.setAttribute("stroke-width","2");g.appendChild(shape);
    const textNode=document.createElementNS(NS,"text");textNode.setAttribute("text-anchor","middle");textNode.setAttribute("fill","#d8d8d8");textNode.setAttribute("font-family","Arial,sans-serif");textNode.setAttribute("font-size",String(fontSize));
    const startY=p.y-((p.rows.length-1)*15);
    p.rows.forEach((line,i)=>{const tspan=document.createElementNS(NS,"tspan");tspan.setAttribute("x",String(p.x));tspan.setAttribute("y",String(startY+i*30));tspan.textContent=line;textNode.appendChild(tspan);});
    g.appendChild(textNode);svg.appendChild(g);
  }
  svgSlot.replaceChildren(svg);stage.style.width=width+"px";stage.style.minWidth=width+"px";
  return svg;
}
function truxFallbackSvg(width,height,label){
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("xmlns","http://www.w3.org/2000/svg");svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("role","img");svg.setAttribute("aria-label",label||"Diagram");svg.style.background="#151515";svg.style.backgroundColor="#151515";return svg;
}
function truxFallbackEl(parent,tag,attrs,text){
  const node=document.createElementNS("http://www.w3.org/2000/svg",tag);
  Object.entries(attrs||{}).forEach(([key,value])=>node.setAttribute(key,String(value)));
  if(text!==undefined&&text!==null)node.textContent=String(text);
  parent.appendChild(node);return node;
}
function truxFallbackText(svg,x,y,text,size=20,anchor="start",fill="#d8d8d8",weight="400"){
  return truxFallbackEl(svg,"text",{x,y,"font-family":"Arial,sans-serif","font-size":size,"text-anchor":anchor,fill,"font-weight":weight},text);
}
function truxFallbackInstall(svg,slot,stage){
  const width=Number(svg.getAttribute("width"))||1440;
  svg.style.setProperty("width","100%","important");svg.style.setProperty("min-width","100%","important");svg.style.setProperty("max-width","none","important");svg.style.setProperty("height","auto","important");svg.style.setProperty("min-height","460px","important");
  slot.replaceChildren(svg);stage.style.width=Math.max(1280,width)+"px";stage.style.minWidth=Math.max(1280,width)+"px";stage.style.minHeight=Math.max(460,Number(svg.getAttribute("height"))||460)+"px";return svg;
}
function renderTruxFallbackSequence(source,slot,stage){
  const rows=normalizeTruxMermaidSource(source).split("\n").slice(1),actors=new Map(),messages=[];
  for(const row of rows){
    let m=row.trim().match(/^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/i);
    if(m){if(!actors.has(m[1]))actors.set(m[1],(m[2]||m[1]).trim());continue;}
    m=row.trim().match(/^([\w.-]+)\s*(-->>|->>|-->|->|--x|--o|<<--|<<->)\s*([\w.-]+)\s*:\s*(.*)$/);
    if(m){if(!actors.has(m[1]))actors.set(m[1],m[1]);if(!actors.has(m[3]))actors.set(m[3],m[3]);messages.push({from:m[1],arrow:m[2],to:m[3],label:m[4]});}
    else if(/^note\s+(?:over|left of|right of)\b/i.test(row.trim()))messages.push({note:row.trim().replace(/^note\s+/i,"")});
  }
  if(!actors.size)return null;
  const list=[...actors.keys()],width=Math.max(1440,180+list.length*210),height=Math.max(460,150+messages.length*76+55),xPos=new Map();
  list.forEach((id,i)=>xPos.set(id,90+(width-180)*(list.length===1?0.5:i/Math.max(1,list.length-1))));
  const svg=truxFallbackSvg(width,height,"Sequence diagram"),defs=truxFallbackEl(svg,"defs",{});
  const markerId="trux-seq-arrow-"+(++truxMermaidRenderSequence),marker=truxFallbackEl(defs,"marker",{id:markerId,markerWidth:10,markerHeight:8,refX:9,refY:4,orient:"auto"});
  truxFallbackEl(marker,"path",{d:"M0,0 L10,4 L0,8 z",fill:"#b4b4b4"});
  list.forEach(id=>{
    const x=xPos.get(id);truxFallbackEl(svg,"rect",{x:x-76,y:34,width:152,height:48,rx:8,fill:"#1b1b1b",stroke:"#818181","stroke-width":2});
    truxFallbackText(svg,x,64,actors.get(id),19,"middle","#e2e2e2","600");
    truxFallbackEl(svg,"line",{x1:x,y1:82,x2:x,y2:height-28,stroke:"#777","stroke-width":1.6,"stroke-dasharray":"7 7"});
  });
  messages.forEach((msg,i)=>{
    const y=128+i*76;
    if(msg.note){
      truxFallbackEl(svg,"rect",{x:Math.max(24,width/2-150),y:y-18,width:300,height:42,rx:6,fill:"#202020",stroke:"#747474"});
      truxFallbackText(svg,width/2,y+8,msg.note.replace(/^over\s+/i,""),16,"middle");return;
    }
    const x1=xPos.get(msg.from),x2=xPos.get(msg.to),left=Math.min(x1,x2),right=Math.max(x1,x2),reverse=x1>x2;
    const line=truxFallbackEl(svg,"line",{x1:x1,y1:y,x2:x2,y2:y,stroke:"#b4b4b4","stroke-width":2,"marker-end":"url(#"+markerId+")"});
    if(msg.arrow.includes("--"))line.setAttribute("stroke-dasharray","7 5");
    if(msg.arrow==="--x"){truxFallbackEl(svg,"line",{x1:x2-7,y1:y-7,x2:x2+7,y2:y+7,stroke:"#b4b4b4","stroke-width":2});truxFallbackEl(svg,"line",{x1:x2+7,y1:y-7,x2:x2-7,y2:y+7,stroke:"#b4b4b4","stroke-width":2});}
    truxFallbackText(svg,(left+right)/2,y-10,msg.label||"",17,"middle");
  });
  return truxFallbackInstall(svg,slot,stage);
}
function renderTruxFallbackPie(source,slot,stage){
  const entries=normalizeTruxMermaidSource(source).split("\n").slice(1).map(line=>{
    const m=line.trim().match(/^["']?(.+?)["']?\s*:\s*(-?\d+(?:\.\d+)?)/);return m?{label:m[1].replace(/^["']|["']$/g,"").trim(),value:Number(m[2])}:null;
  }).filter(x=>x&&Number.isFinite(x.value)&&x.value>=0);
  if(!entries.length)return null;
  const total=entries.reduce((sum,x)=>sum+x.value,0);if(total<=0)return null;
  const width=1440,height=Math.max(500,entries.length*44+100),cx=330,cy=height/2,r=190,svg=truxFallbackSvg(width,height,"Pie chart");
  const colors=["#dedede","#bdbdbd","#9a9a9a","#777777","#5d5d5d","#424242","#eeeeee","#858585","#a8a8a8","#686868"];
  let angle=-Math.PI/2;
  entries.forEach((item,i)=>{
    const portion=item.value/total,next=angle+portion*Math.PI*2,large=next-angle>Math.PI?1:0;
    if(portion>=.999999)truxFallbackEl(svg,"circle",{cx,cy,r,fill:colors[i%colors.length],stroke:"#151515","stroke-width":2});
    else{
      const x1=cx+r*Math.cos(angle),y1=cy+r*Math.sin(angle),x2=cx+r*Math.cos(next),y2=cy+r*Math.sin(next);
      const d="M "+cx+" "+cy+" L "+x1+" "+y1+" A "+r+" "+r+" 0 "+large+" 1 "+x2+" "+y2+" Z";
      truxFallbackEl(svg,"path",{d,fill:colors[i%colors.length],stroke:"#151515","stroke-width":2});
    }
    angle=next;
    const ly=90+i*42;
    truxFallbackEl(svg,"rect",{x:620,y:ly-18,width:20,height:20,rx:3,fill:colors[i%colors.length]});
    truxFallbackText(svg,655,ly,item.label,20,"start");
    truxFallbackText(svg,1380,ly,String(item.value)+(item.value/total>0?"  ("+(item.value/total*100).toFixed(1)+"%)":""),18,"end","#bdbdbd");
  });
  return truxFallbackInstall(svg,slot,stage);
}
function renderTruxFallbackTimeline(source,slot,stage){
  const lines=normalizeTruxMermaidSource(source).split("\n").slice(1),events=[];let section="";
  for(const raw of lines){
    const line=raw.trim();if(!line||/^(?:title|accTitle|accDescr)\b/i.test(line))continue;
    const sec=line.match(/^section\s+(.+)$/i);if(sec){section=sec[1];continue;}
    const m=line.match(/^([^:]+?)\s*:\s*(.+)$/);
    if(m)events.push({date:m[1].trim(),label:m[2].trim(),section});
    else if(events.length)events[events.length-1].label+=" · "+line.replace(/^:\s*/,"");
  }
  if(!events.length)return null;
  const width=1440,height=Math.max(460,180+events.length*90),svg=truxFallbackSvg(width,height,"Timeline diagram"),x=115;
  truxFallbackEl(svg,"line",{x1:x,y1:86,x2:x,y2:height-48,stroke:"#777","stroke-width":3});
  events.forEach((e,i)=>{
    const y=112+i*90;
    truxFallbackEl(svg,"circle",{cx:x,cy:y,r:9,fill:"#d8d8d8",stroke:"#151515","stroke-width":3});
    truxFallbackText(svg,155,y-8,e.date,18,"start","#bdbdbd","600");
    truxFallbackText(svg,330,y+18,e.label,20,"start","#e1e1e1");
    if(e.section)truxFallbackText(svg,1310,y-8,e.section,14,"end","#888");
  });
  return truxFallbackInstall(svg,slot,stage);
}
function renderTruxFallbackGantt(source,slot,stage){
  const lines=normalizeTruxMermaidSource(source).split("\n").slice(1),tasks=[];let section="";
  for(const raw of lines){
    const line=raw.trim();if(!line||/^(?:title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|accTitle|accDescr)\b/i.test(line))continue;
    const sec=line.match(/^section\s+(.+)$/i);if(sec){section=sec[1];continue;}
    const at=line.indexOf(":");if(at<1)continue;
    const name=line.slice(0,at).trim(),rest=line.slice(at+1).trim(),date=rest.match(/\d{4}-\d{2}-\d{2}/),dur=rest.match(/(\d+(?:\.\d+)?)\s*(d|w|h|m)\b/i);
    let duration=dur?Number(dur[1])*(/w/i.test(dur[2])?7:/h/i.test(dur[2])?1/24:/m/i.test(dur[2])?1/1440:1):3;
    tasks.push({name,section,start:date?Date.parse(date[0])/86400000:null,duration:Math.max(.25,duration),raw:rest});
  }
  if(!tasks.length)return null;
  let nextDay=0;
  tasks.forEach(t=>{if(t.start==null)t.start=nextDay;nextDay=Math.max(nextDay,t.start+t.duration)+.25;});
  const minDay=Math.min(...tasks.map(t=>t.start)),maxDay=Math.max(...tasks.map(t=>t.start+t.duration)),scale=30,left=330,top=110,rowH=66;
  const width=Math.max(1440,left+Math.max(1,maxDay-minDay)*scale+150),height=top+tasks.length*rowH+40,svg=truxFallbackSvg(width,height,"Gantt timeline");
  truxFallbackText(svg,30,52,"Task schedule",24,"start","#e6e6e6","600");
  truxFallbackEl(svg,"line",{x1:left,y1:top-18,x2:width-45,y2:top-18,stroke:"#555","stroke-width":1});
  tasks.forEach((t,i)=>{
    const y=top+i*rowH,x=left+(t.start-minDay)*scale,w=Math.max(14,t.duration*scale);
    if(t.section&&(!i||tasks[i-1].section!==t.section))truxFallbackText(svg,30,y-12,t.section,14,"start","#8c8c8c","600");
    truxFallbackText(svg,30,y+24,t.name,18,"start","#d7d7d7");
    truxFallbackEl(svg,"rect",{x,y,width:w,height:28,rx:6,fill:/done|complete/i.test(t.raw)?"#858585":"#c4c4c4",stroke:"#ededed","stroke-width":1});
  });
  return truxFallbackInstall(svg,slot,stage);
}
function renderTruxFallbackXyChart(source,slot,stage){
  const lines=normalizeTruxMermaidSource(source).split("\n"),series=[],cats=[];
  for(const row of lines){
    let m=row.match(/^\s*x-axis\s+(?:["'][^"']*["']\s*)?\[([^\]]+)\]/i);
    if(m)cats.push(...m[1].split(",").map(x=>x.trim().replace(/^["']|["']$/g,"")));
    m=row.match(/^\s*(bar|line)\s+\[([^\]]+)\]/i);
    if(m)series.push({type:m[1].toLowerCase(),values:m[2].split(",").map(x=>Number(x.trim())).filter(Number.isFinite)});
  }
  if(!series.length||!series.some(x=>x.values.length))return null;
  const values=series.flatMap(x=>x.values),min=Math.min(0,...values),max=Math.max(1,...values),width=1440,height=560,left=110,right=65,top=75,bottom=100,plotW=width-left-right,plotH=height-top-bottom,svg=truxFallbackSvg(width,height,"Data chart");
  const mapY=v=>top+(max-v)/(max-min||1)*plotH;
  for(let i=0;i<=5;i++){const value=min+(max-min)*i/5,y=mapY(value);truxFallbackEl(svg,"line",{x1:left,y1:y,x2:width-right,y2:y,stroke:"#343434","stroke-width":1});truxFallbackText(svg,left-14,y+6,String(Number(value.toFixed(2))),15,"end","#a0a0a0");}
  truxFallbackEl(svg,"line",{x1:left,y1:top,x2:left,y2:top+plotH,stroke:"#999","stroke-width":2});
  truxFallbackEl(svg,"line",{x1:left,y1:top+plotH,x2:width-right,y2:top+plotH,stroke:"#999","stroke-width":2});
  const count=Math.max(cats.length,...series.map(x=>x.values.length),1),band=plotW/count;
  if(!cats.length)for(let i=0;i<count;i++)cats.push(String(i+1));
  const palette=["#dedede","#999999","#bdbdbd","#747474"];
  series.forEach((item,si)=>{
    if(item.type==="bar"){
      const bw=Math.min(42,band*.7/series.length);
      item.values.forEach((v,i)=>{const x=left+band*(i+.5)+(si-(series.length-1)/2)*bw,y=mapY(v);truxFallbackEl(svg,"rect",{x:x-bw*.42,y,width:bw*.84,height:Math.max(1,top+plotH-y),rx:3,fill:palette[si%palette.length]});});
    }else{
      const points=item.values.map((v,i)=>({x:left+band*(i+.5),y:mapY(v)}));
      for(let i=1;i<points.length;i++)truxFallbackEl(svg,"line",{x1:points[i-1].x,y1:points[i-1].y,x2:points[i].x,y2:points[i].y,stroke:palette[si%palette.length],"stroke-width":4,"stroke-linecap":"round"});
      points.forEach(p=>truxFallbackEl(svg,"circle",{cx:p.x,cy:p.y,r:6,fill:palette[si%palette.length],stroke:"#151515","stroke-width":2}));
    }
    truxFallbackText(svg,left+si*145,35,item.type,16,"start",palette[si%palette.length],"600");
  });
  cats.slice(0,count).forEach((label,i)=>truxFallbackText(svg,left+band*(i+.5),top+plotH+30,label,15,"middle","#bdbdbd"));
  return truxFallbackInstall(svg,slot,stage);
}
function renderTruxFallbackQuadrant(source,slot,stage){
  const lines=normalizeTruxMermaidSource(source).split("\n"),points=[],quadrants=[];
  let xLabel="X",yLabel="Y";
  for(const row of lines){
    let m=row.match(/^\s*x-axis\s+(.+?)\s*-->\s*(.+)$/i);if(m)xLabel=m[1].replace(/^["']|["']$/g,"")+" — "+m[2].replace(/^["']|["']$/g,"");
    m=row.match(/^\s*y-axis\s+(.+?)\s*-->\s*(.+)$/i);if(m)yLabel=m[1].replace(/^["']|["']$/g,"")+" — "+m[2].replace(/^["']|["']$/g,"");
    m=row.match(/^\s*quadrant-([1-4])\s+(.+)$/i);if(m)quadrants[Number(m[1])-1]=m[2].trim();
    m=row.match(/^\s*point\s+["']?(.+?)["']?\s*:\s*\[?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]?/i);if(m)points.push({label:m[1].replace(/^["']|["']$/g,""),x:Number(m[2]),y:Number(m[3])});
  }
  if(!points.length)return null;
  const width=1440,height=600,left=150,top=70,pw=width-280,ph=height-170,cx=left+pw/2,cy=top+ph/2,svg=truxFallbackSvg(width,height,"Quadrant chart");
  truxFallbackEl(svg,"rect",{x:left,y:top,width:pw/2,height:ph/2,fill:"#1c1c1c"});truxFallbackEl(svg,"rect",{x:cx,y:top,width:pw/2,height:ph/2,fill:"#181818"});
  truxFallbackEl(svg,"rect",{x:left,y:cy,width:pw/2,height:ph/2,fill:"#181818"});truxFallbackEl(svg,"rect",{x:cx,y:cy,width:pw/2,height:ph/2,fill:"#1c1c1c"});
  truxFallbackEl(svg,"line",{x1:cx,y1:top,x2:cx,y2:top+ph,stroke:"#777","stroke-width":2});truxFallbackEl(svg,"line",{x1:left,y1:cy,x2:left+pw,y2:cy,stroke:"#777","stroke-width":2});
  truxFallbackText(svg,cx,26,xLabel,16,"middle","#bdbdbd");truxFallbackText(svg,30,top+ph/2,yLabel,16,"middle","#bdbdbd");
  const centers=[{x:cx+pw/4,y:top+26},{x:left+pw/4,y:top+26},{x:left+pw/4,y:top+ph-12},{x:cx+pw/4,y:top+ph-12}];
  quadrants.forEach((label,i)=>{if(label)truxFallbackText(svg,centers[i].x,centers[i].y,label,17,"middle","#888","600");});
  points.forEach((p,i)=>{const x=left+Math.max(0,Math.min(1,p.x))*pw,y=top+(1-Math.max(0,Math.min(1,p.y)))*ph;truxFallbackEl(svg,"circle",{cx:x,cy:y,r:8,fill:"#dedede",stroke:"#151515","stroke-width":3});truxFallbackText(svg,x+13,y-10,p.label,16,"start","#e0e0e0");});
  return truxFallbackInstall(svg,slot,stage);
}
function truxFallbackGraphSource(raw,type){
  const source=normalizeTruxMermaidSource(raw),lines=source.split("\n").slice(1),nodes=[],edges=[],byId=new Map();
  const clean=value=>String(value||"").replace(/[\[\]{}]/g," ").replace(/["']/g,"").replace(/\s+/g," ").trim().slice(0,120);
  const add=(id,label)=>{id=String(id||"").replace(/[^A-Za-z0-9_-]/g,"_")||("N"+(nodes.length+1));if(!byId.has(id)){const item={id,label:clean(label)||id};byId.set(id,item);nodes.push(item);}else if(label&&byId.get(id).label===id)byId.get(id).label=clean(label);return id;};
  const link=(a,b,label)=>{a=add(a,a);b=add(b,b);if(a!==b&&!edges.some(e=>e.from===a&&e.to===b))edges.push({from:a,to:b,label:clean(label)});};
  if(/^stateDiagram/i.test(source)){
    for(const line0 of lines){const line=line0.trim();const m=line.match(/^(.+?)\s+(?:-->|--\s*>|-\.\->|==>)\s*(.+?)(?:\s*:\s*(.+))?$/);if(!m)continue;const a=m[1].replace(/^\[\*\]$/,"Start"),b=m[2].replace(/^\[\*\]$/,"Final");link(a,a);link(b,b);link(a,b,m[3]);}
  }else if(/^classDiagram/i.test(source)){
    let current=null;
    for(const line0 of lines){const line=line0.trim();let m=line.match(/^class\s+([\w.]+)(?:\s*\{)?/i);if(m){current=add(m[1],m[1]);continue;}if(current&&line==="}"){current=null;continue;}if(current&&line){byId.get(current).label=clean(byId.get(current).label+" · "+line.replace(/[+~-]/g,"").replace(/\([^)]*\)/g,""));continue;}
      m=line.match(/^([\w.]+)\s*(<\|--|--\|>|<\.\.|\.{2}|[*o]?--|--[*o]?|-->|<--)\s*([\w.]+)(?:\s*:\s*(.*))?/);if(m)link(m[1],m[3],m[4]||m[2]);}
  }else if(/^erDiagram/i.test(source)){
    let current=null;for(const line0 of lines){const line=line0.trim();let m=line.match(/^([\w-]+)\s*\{$/);if(m){current=add(m[1],m[1]);continue;}if(line==="}"){current=null;continue;}if(current&&line&&!line.startsWith("%%")){byId.get(current).label=clean(byId.get(current).label+" · "+line.replace(/\s+/g," "));continue;}
      m=line.match(/^([\w-]+)\s+([|o}{.]+)--([|o}{.]+)\s+([\w-]+)(?:\s*:\s*(.*))?$/);if(m)link(m[1],m[4],m[5]||"relationship");}
  }else if(/^mindmap/i.test(source)){
    const stack=[];for(const line0 of lines){if(!line0.trim())continue;const indent=(line0.match(/^\s*/)||[""])[0].replace(/\t/g,"  ").length,label=clean(line0.trim().replace(/^root\s*\(\((.*?)\)\)$/i,"$1").replace(/^\(\((.*?)\)\)$/,"$1").replace(/^[()]+|[()]+$/g,""));if(!label)continue;while(stack.length&&stack[stack.length-1].indent>=indent)stack.pop();const id="M"+(nodes.length+1);add(id,label);if(stack.length)link(stack[stack.length-1].id,id);stack.push({id,indent});}
  }else if(/^journey/i.test(source)){
    let idx=0;for(const line0 of lines){const line=line0.trim();if(!line||/^(?:title|section)\b/i.test(line))continue;const m=line.match(/^(.+?):\s*(\d+)\s*:\s*(.*)$/);if(m){const id="J"+(++idx);add(id,m[1]+" · score "+m[2]+" · "+m[3]);if(idx>1)link("J"+(idx-1),id);}}
  }else if(/^architecture-beta/i.test(source)){
    for(const line0 of lines){const line=line0.trim();let m=line.match(/^(?:service|group|junction|container)\s+([\w-]+)(?:\([^)]*\))?\s*\[([^\]]+)\]/i);if(m)add(m[1],m[2]);m=line.match(/([\w-]+):[NESW]\s*--\s*[NESW]:([\w-]+)/i);if(m)link(m[1],m[2]);}
  }else if(/^sankey-beta/i.test(source)){
    for(const line0 of lines){const m=line0.trim().match(/^([^,]+),([^,]+),\s*([\d.]+)/);if(m)link(m[1],m[2],m[3]);}
  }else if(/^block-beta/i.test(source)){
    for(const line0 of lines){const line=line0.trim();let m=line.match(/^block\s+([\w-]+)(?:\[([^\]]+)\])?/i);if(m)add(m[1],m[2]||m[1]);m=line.match(/^([\w-]+)\s*(?:-->|---|<--)\s*([\w-]+)/);if(m)link(m[1],m[2]);}
  }else if(/^gitgraph/i.test(source)){
    let previous=null,i=0;for(const line0 of lines){const line=line0.trim();const m=line.match(/^commit(?:\s+id:\s*([\w-]+))?(?:\s*:\s*["']?([^"']+)["']?)?/i);if(m){const id=m[1]||("Commit_"+(++i));add(id,m[2]||id);if(previous)link(previous,id);previous=id;}}
  }else{
    for(const line0 of lines){const line=line0.trim();const m=line.match(/^([\w-]+)\s*(-->|---|<--)\s*([\w-]+)(?:\s*:\s*(.*))?/);if(m)link(m[1],m[3],m[4]);}
  }
  if(!nodes.length)return null;
  if(!edges.length&&nodes.length>1)for(let i=1;i<nodes.length;i++)link(nodes[i-1].id,nodes[i].id);
  let output="flowchart TD\n";
  for(const node of nodes)output+=node.id+"["+node.label+"]\n";
  let relCount=0;
  for(const edge of edges){
    if(edge.label){
      const relationId="REL_"+(++relCount);
      output+=relationId+"["+clean(edge.label)+"]\n";
      output+=edge.from+" --> "+relationId+"\n"+relationId+" --> "+edge.to+"\n";
    }else output+=edge.from+" --> "+edge.to+"\n";
  }
  return output;
}
function renderTruxFallbackDiagram(raw,slot,stage){
  const source=normalizeTruxMermaidSource(raw);
  if(/^(?:flowchart|graph)\b/i.test(source))return renderTruxFallbackFlowchart(source,slot,stage);
  if(/^sequenceDiagram\b/i.test(source))return renderTruxFallbackSequence(source,slot,stage);
  if(/^pie\b/i.test(source))return renderTruxFallbackPie(source,slot,stage);
  if(/^timeline\b/i.test(source))return renderTruxFallbackTimeline(source,slot,stage);
  if(/^gantt\b/i.test(source))return renderTruxFallbackGantt(source,slot,stage);
  if(/^xychart-beta\b/i.test(source))return renderTruxFallbackXyChart(source,slot,stage);
  if(/^quadrantChart\b/i.test(source))return renderTruxFallbackQuadrant(source,slot,stage);
  if(/^(?:stateDiagram(?:-v2)?|classDiagram|erDiagram|mindmap|journey|architecture-beta|sankey-beta|block-beta|gitGraph|requirementDiagram|zenuml)\b/i.test(source)){
    const graph=truxFallbackGraphSource(source,source.split(/\s/)[0]);
    return graph?renderTruxFallbackFlowchart(graph,slot,stage):null;
  }
  return null;
}
const TRUX_SVG_ELEMENTS = new Set([
  "svg","g","defs","path","line","polyline","polygon","rect","circle","ellipse","text","tspan","textpath","title","desc",
  "clippath","mask","lineargradient","radialgradient","stop","marker","pattern","symbol","use",
  "filter","fegaussianblur","feoffset","femerge","femergenode","fecolormatrix","fecomponenttransfer",
  "fefunca","fefuncr","fefuncg","fefuncb","feblend","feflood","fecomposite","fedropshadow"
]);
const TRUX_SVG_ATTRIBUTES = new Set((
  "xmlns viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points transform " +
  "fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray " +
  "stroke-dashoffset stroke-opacity stroke-miterlimit opacity vector-effect pathLength font-family font-size " +
  "font-style font-weight text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing " +
  "textLength lengthAdjust dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform " +
  "spreadMethod fx fy fr clip-path clip-rule mask maskUnits maskContentUnits marker-start marker-mid marker-end " +
  "markerUnits markerWidth markerHeight refX refY orient patternUnits patternContentUnits patternTransform href " +
  "filter filterUnits primitiveUnits in in2 result stdDeviation type values operator k1 k2 k3 k4 scale slope " +
  "intercept tableValues mode flood-color flood-opacity color-interpolation-filters baseFrequency numOctaves " +
  "seed stitchTiles edgeMode lighting-color surfaceScale diffuseConstant specularConstant specularExponent " +
  "azimuth elevation xml:space role aria-label"
).split(/\s+/).map(x=>x.toLowerCase()));
const TRUX_SVG_TAG_NAMES = {textpath:"textPath",clippath:"clipPath",lineargradient:"linearGradient",radialgradient:"radialGradient",fegaussianblur:"feGaussianBlur",feoffset:"feOffset",femerge:"feMerge",femergenode:"feMergeNode",fecolormatrix:"feColorMatrix",fecomponenttransfer:"feComponentTransfer",fefunca:"feFuncA",fefuncr:"feFuncR",fefuncg:"feFuncG",fefuncb:"feFuncB",feblend:"feBlend",feflood:"feFlood",fecomposite:"feComposite",fedropshadow:"feDropShadow"};
function normalizeTruxSvgSource(raw){
  let source=String(raw||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").trim();
  const fence=String.fromCharCode(96).repeat(3);
  source=source.replace(new RegExp("^\\s*"+fence+"(?:svg|xml)?[ \\t]*\\n?","i"),"")
    .replace(new RegExp("\\n?\\s*"+fence+"\\s*$"),"").trim();
  const start=source.search(/<(?:[A-Za-z_][\w.-]*:)?svg\b/i);
  if(start>0)source=source.slice(start).trim();
  return source;
}
function isTruxSvgDrawing(raw){
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:[A-Za-z_][\w.-]*:)?svg\b/i.test(normalizeTruxSvgSource(raw));
}
function isTruxDiagram(lang, code) {
  const label=String(lang||"").trim().toLowerCase(), source=String(code||"").trim();
  if(label==="mermaid" || label==="svg") return true;
  if(label==="xml" && isTruxSvgDrawing(source)) return true;
  if(!label && isTruxSvgDrawing(source)) return true;
  return /^(?:flowchart|graph|sequencediagram|classdiagram|statediagram(?:-v2)?|erdiagram|journey|gantt|pie(?:\s|$)|mindmap|timeline|quadrantchart|xychart-beta|block-beta|architecture-beta|gitgraph|sankey-beta|zenuml|requirementdiagram)\b/i.test(source);
}
function sanitizeTruxSvgNode(sourceNode, context, depth){
  if(depth>64)throw new Error("SVG drawing nesting is too deep");
  if(sourceNode.nodeType===3)return document.createTextNode(sourceNode.nodeValue||"");
  if(sourceNode.nodeType!==1)return null;
  if(++context.nodes>12000)throw new Error("SVG drawing has too many elements");
  const tag=String(sourceNode.localName||sourceNode.nodeName||"").toLowerCase();
  if(!TRUX_SVG_ELEMENTS.has(tag))return null;
  const clean=document.createElementNS(context.namespace,TRUX_SVG_TAG_NAMES[tag]||tag);
  for(const attribute of Array.from(sourceNode.attributes||[])){
    const name=String(attribute.name||"");
    const lower=name.toLowerCase();
    let value=String(attribute.value||"").trim();
    if(!TRUX_SVG_ATTRIBUTES.has(lower)||value.length>16000)continue;
    if(lower==="href" && !/^#[A-Za-z_][\w.-]*$/.test(value))continue;
    if(lower==="id" && !/^[A-Za-z_][\w.-]*$/.test(value))continue;
    if(/url\s*\(/i.test(value)){
      const urls=value.match(/url\s*\([^)]*\)/gi)||[];
      if(!urls.length||urls.some(item=>!/^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/i.test(item.trim())))continue;
    }else if(/(?:javascript:|data:|https?:\/\/|\/\/)/i.test(value)){
      continue;
    }
    if(lower==="viewbox"){
      const parts=value.split(/[\s,]+/).map(Number);
      if(parts.length!==4||!parts.every(Number.isFinite)||parts[2]<=0||parts[3]<=0)continue;
    }
    clean.setAttribute(name,value);
  }
  for(const child of Array.from(sourceNode.childNodes||[])){
    const safeChild=sanitizeTruxSvgNode(child,context,depth+1);
    if(safeChild)clean.appendChild(safeChild);
  }
  return clean;
}
function renderTruxSvgDrawing(raw, slot, stage){
  if(!slot||!stage)throw new Error("Drawing surface is unavailable");
  const source=normalizeTruxSvgSource(raw);
  if(!source||source.length>350000)throw new Error("SVG source is empty or exceeds the drawing size limit");
  const parsed=new DOMParser().parseFromString(source,"image/svg+xml");
  const sourceRoot=parsed.documentElement;
  if(!sourceRoot||String(sourceRoot.localName||"").toLowerCase()!=="svg"||parsed.querySelector("parsererror")){
    throw new Error("The SVG drawing is invalid XML or has no SVG root");
  }
  const namespace="http://www.w3.org/2000/svg";
  const context={namespace,nodes:0};
  const svg=sanitizeTruxSvgNode(sourceRoot,context,0);
  if(!svg||String(svg.localName||"").toLowerCase()!=="svg")throw new Error("The SVG drawing could not be sanitized");
  const numberLength=(value,fallback)=>{
    const text=String(value||"").trim();
    if(!text||/%$/.test(text))return fallback;
    const n=Number.parseFloat(text);
    return Number.isFinite(n)&&n>0&&n<=50000?n:fallback;
  };
  let vx=0,vy=0,vw=numberLength(sourceRoot.getAttribute("width"),1600),vh=numberLength(sourceRoot.getAttribute("height"),900);
  const rawViewBox=String(sourceRoot.getAttribute("viewBox")||"").trim();
  const vb=rawViewBox.split(/[\s,]+/).map(Number);
  if(vb.length===4&&vb.every(Number.isFinite)&&vb[2]>0&&vb[3]>0&&vb[2]<=50000&&vb[3]<=50000){
    vx=vb[0];vy=vb[1];vw=vb[2];vh=vb[3];
  }
  svg.setAttribute("xmlns",namespace);
  svg.setAttribute("viewBox",[vx,vy,vw,vh].join(" "));
  svg.setAttribute("width",String(vw));
  svg.setAttribute("height",String(vh));
  svg.setAttribute("role","img");
  if(!svg.getAttribute("aria-label"))svg.setAttribute("aria-label","Custom vector drawing");
  svg.style.background="#151515";
  svg.style.backgroundColor="#151515";
  svg.style.setProperty("width","100%","important");
  svg.style.setProperty("min-width","100%","important");
  svg.style.setProperty("max-width","none","important");
  svg.style.setProperty("height","auto","important");
  svg.style.setProperty("min-height","460px","important");
  svg.style.overflow="visible";
  const drawable=Array.from(svg.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse,text,use"))
    .filter(node=>!node.closest("defs,clippath,mask,marker,pattern,symbol,filter"));
  if(!drawable.length)throw new Error("The SVG contains no visible drawing elements");
  const coversCanvas=(node)=>{
    const x=Number.parseFloat(node.getAttribute("x")||"0"),y=Number.parseFloat(node.getAttribute("y")||"0");
    const w=String(node.getAttribute("width")||""),h=String(node.getAttribute("height")||"");
    const covers=(raw,viewSize)=>/%$/.test(raw)?Number.parseFloat(raw)>=99:Number.parseFloat(raw)>=viewSize*.99;
    return Math.abs(x-vx)<1&&Math.abs(y-vy)<1&&covers(w,vw)&&covers(h,vh);
  };
  let background=Array.from(svg.children).find(node=>String(node.localName||"").toLowerCase()==="rect"&&coversCanvas(node));
  if(background){
    background.setAttribute("fill","#151515");
    background.setAttribute("stroke","none");
    background.setAttribute("class","trux-canvas-background");
    svg.insertBefore(background,svg.firstChild);
  }else{
    background=document.createElementNS(namespace,"rect");
    background.setAttribute("x",String(vx));background.setAttribute("y",String(vy));
    background.setAttribute("width",String(vw));background.setAttribute("height",String(vh));
    background.setAttribute("fill","#151515");background.setAttribute("stroke","none");
    background.setAttribute("class","trux-canvas-background");
    svg.insertBefore(background,svg.firstChild);
  }
  const stageWidth=Math.max(1440,Math.min(2200,vw));
  const stageHeight=Math.max(460,Math.min(3200,stageWidth*vh/vw));
  stage.style.width=stageWidth+"px";
  stage.style.minWidth=stageWidth+"px";
  stage.style.minHeight=stageHeight+"px";
  slot.replaceChildren(svg);
  return svg;
}
function buildTruxDiagramCard(source,pending=false) {
  return '<div class="trux-diagram" data-trux-diagram'+(pending?' data-trux-diagram-pending="true"':'')+'>'+
    '<div class="trux-diagram-toolbar"><button type="button" data-trux-diagram-action="edit" aria-label="Edit diagram source">Edit diagram</button></div>'+
    '<div class="trux-diagram-editor" hidden><textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Editable vector drawing or diagram source"></textarea>'+
    '<div class="trux-diagram-editor-actions"><button type="button" data-trux-diagram-action="cancel">Cancel</button><button type="button" data-trux-diagram-action="apply">Apply changes</button></div></div>'+
    '<div class="trux-diagram-stage"><div class="trux-diagram-svg"></div>'+
    '<img class="trux-diagram-cursor" src="/icon-grey.svg" alt="" aria-hidden="true" draggable="false"></div>'+
    '<pre class="trux-diagram-source" hidden>'+escapeHtml(String(source||""))+'</pre>'+
    '<div class="trux-diagram-error" hidden></div></div>';
}
function toggleTruxDiagramEditor(button){
  const card=button&&button.closest(".trux-diagram");if(!card)return;
  const editor=card.querySelector(".trux-diagram-editor"),textarea=editor&&editor.querySelector("textarea"),source=card.querySelector(".trux-diagram-source");
  if(!editor||!textarea||!source)return;
  textarea.value=source.textContent||"";
  editor.hidden=false;
  textarea.focus();
}
function cancelTruxDiagramEditor(button){
  const card=button&&button.closest(".trux-diagram");if(!card)return;
  const editor=card.querySelector(".trux-diagram-editor");if(editor)editor.hidden=true;
}
function applyTruxDiagramEditor(button){
  const card=button&&button.closest(".trux-diagram");if(!card)return;
  const editor=card.querySelector(".trux-diagram-editor"),textarea=editor&&editor.querySelector("textarea");
  const source=card.querySelector(".trux-diagram-source"),svgSlot=card.querySelector(".trux-diagram-svg");
  const errorNode=card.querySelector(".trux-diagram-error"),cursor=card.querySelector(".trux-diagram-cursor");
  if(!textarea||!source||!svgSlot)return;
  const value=normalizeTruxMermaidSource(textarea.value);
  if(!value){if(errorNode){errorNode.hidden=false;errorNode.textContent="Add a diagram declaration and content before applying.";}return;}
  source.textContent=value;
  if(editor)editor.hidden=true;
  if(errorNode){errorNode.hidden=true;errorNode.textContent="";}
  svgSlot.replaceChildren();
  if(cursor)cursor.hidden=false;
  delete card.dataset.truxDiagramPending;delete card.dataset.truxDiagramRendered;delete card.dataset.truxDiagramRendering;
  delete card.dataset.truxDiagramFailed;delete card.dataset.truxDiagramFallback;delete card.dataset.truxDiagramRetry;
  renderTruxDiagramElement(card);
}
document.addEventListener("click",function(event){
  const button=event.target&&event.target.closest?event.target.closest("[data-trux-diagram-action]"):null;
  if(!button)return;
  const action=button.getAttribute("data-trux-diagram-action");
  if(action==="edit")toggleTruxDiagramEditor(button);
  else if(action==="cancel")cancelTruxDiagramEditor(button);
  else if(action==="apply")applyTruxDiagramEditor(button);
});
function getTruxMermaidApi(){
  const root=window.mermaid;
  if(root?.default && typeof root.default.render==="function") return root.default;
  if(root && typeof root.render==="function") return root;
  return null;
}
async function waitForTruxMermaidApi(element){
  let api=getTruxMermaidApi();
  if(api||!element?.isConnected)return api;
  const primaryScript=document.querySelector('script[src*="mermaid.min.js"]');
  let primaryFailed=false;
  if(primaryScript)primaryScript.addEventListener("error",()=>{primaryFailed=true},{once:true});
  const deadline=Date.now()+15000;
  while(!api&&element.isConnected&&!primaryFailed&&Date.now()<deadline){
    await new Promise(resolve=>window.setTimeout(resolve,100));
    api=getTruxMermaidApi();
  }
  if(api||!element.isConnected)return api;
  // The deferred jsDelivr bundle can fail or arrive after the app's inline script.
  // Try a second CDN once rather than permanently failing every diagram in this turn.
  if(!truxMermaidFallbackPromise){
    truxMermaidFallbackPromise=new Promise(resolve=>{
      const script=document.createElement("script");
      script.src="https://unpkg.com/mermaid@11/dist/mermaid.min.js";
      script.async=true;
      script.onload=()=>resolve(getTruxMermaidApi());
      script.onerror=()=>resolve(null);
      document.head.appendChild(script);
    });
  }
  return await truxMermaidFallbackPromise;
}
function truxSvgLength(shape){try{return typeof shape.getTotalLength==="function"?Math.max(0,shape.getTotalLength()):0}catch(_){return 0}}
function truxSvgPointToStage(svg,stage,p){
  const r=svg.getBoundingClientRect(),s=stage.getBoundingClientRect(),v=svg.viewBox&&svg.viewBox.baseVal;
  return {x:r.left-s.left+(p.x-(v?v.x:0))*r.width/Math.max(1,v&&v.width?v.width:r.width),
    y:r.top-s.top+(p.y-(v?v.y:0))*r.height/Math.max(1,v&&v.height?v.height:r.height)};
}
function animateTruxDiagramDrawing(stage,svg,cursor){
  const labels=Array.from(svg.querySelectorAll("text,foreignObject,.edgeLabel,.nodeLabel,.cluster-label"));
  labels.forEach(x=>x.style.visibility="hidden");
  const shapes=Array.from(svg.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse"))
    .filter(x=>!x.classList.contains("trux-canvas-background")&&
      !x.closest("defs,marker,.edgeLabel,.labelBkg,.label-container")&&truxSvgLength(x)>0);
  const edges=shapes.filter(x=>/(edge|flowchart-link|messageLine|transition|mindmap-link|relationship|dependency|section)/i.test(
    String(x.getAttribute("class")||"")+" "+String(x.parentElement?.getAttribute("class")||"")));
  const nodes=shapes.filter(x=>!edges.includes(x)&&!!x.closest(".node,.cluster,.actor,.section"));
  const ordered=(edges.length?edges:shapes).concat(edges.length?nodes:[]);
  const segments=ordered.map(shape=>{
    const dash=shape.style.strokeDasharray,offset=shape.style.strokeDashoffset;
    const originalFillOpacity=shape.style.fillOpacity,originalStroke=shape.style.stroke,originalStrokeWidth=shape.style.strokeWidth;
    let computedStroke="none",computedFill="none";
    try{const computed=window.getComputedStyle(shape);computedStroke=computed.stroke;computedFill=computed.fill;}catch(_){}
    const hasFill=!!computedFill&&computedFill!=="none"&&computedFill!=="rgba(0, 0, 0, 0)";
    const needsTemporaryStroke=(!computedStroke||computedStroke==="none"||computedStroke==="rgba(0, 0, 0, 0)");
    if(hasFill)shape.style.fillOpacity="0";
    if(needsTemporaryStroke){shape.style.stroke=hasFill?computedFill:"#b4b4b4";shape.style.strokeWidth=originalStrokeWidth||"2";}
    const length=truxSvgLength(shape);
    shape.style.strokeDasharray=length+" "+length;shape.style.strokeDashoffset=String(length);shape.style.transition="none";
    return {shape,length,duration:Math.max(160,Math.min(520,length*1.35)),dash,offset,
      originalFillOpacity,originalStroke,originalStrokeWidth,hasFill,needsTemporaryStroke};
  }).filter(x=>x.length>0);
  if(!segments.length){cursor.hidden=true;labels.forEach(x=>x.style.visibility="");return}
  function restoreSegment(seg){
    seg.shape.style.strokeDasharray=seg.dash;seg.shape.style.strokeDashoffset=seg.offset;seg.shape.style.transition="";
    if(seg.hasFill)seg.shape.style.fillOpacity=seg.originalFillOpacity;
    if(seg.needsTemporaryStroke){seg.shape.style.stroke=seg.originalStroke;seg.shape.style.strokeWidth=seg.originalStrokeWidth;}
  }
  const started=performance.now();
  function finish(){segments.forEach(restoreSegment);labels.forEach(x=>x.style.visibility="");cursor.hidden=true}
  function tick(now){
    if(!stage.isConnected||!svg.isConnected)return;
    let elapsed=now-started,active=null;
    for(const seg of segments){
      if(elapsed<=seg.duration){active=seg;break}
      restoreSegment(seg);elapsed-=seg.duration;
    }
    if(!active){finish();return}
    const p=Math.max(0,Math.min(1,elapsed/active.duration));active.shape.style.strokeDashoffset=String(active.length*(1-p));
    try{const pos=truxSvgPointToStage(svg,stage,active.shape.getPointAtLength(active.length*p));
      cursor.style.transform="translate("+(pos.x-cursor.offsetWidth/2)+"px,"+(pos.y-cursor.offsetHeight/2)+"px)"}catch(_){}
    requestAnimationFrame(tick);
  }
  try{const pos=truxSvgPointToStage(svg,stage,segments[0].shape.getPointAtLength(0));
    cursor.style.transform="translate("+(pos.x-cursor.offsetWidth/2)+"px,"+(pos.y-cursor.offsetHeight/2)+"px)"}catch(_){}
  requestAnimationFrame(tick);
}

async function renderTruxDiagramElement(element){
  if(!element||!element.isConnected||element.dataset.truxDiagramPending==="true"||element.dataset.truxDiagramRendered==="true"||element.dataset.truxDiagramRendering==="true"||element.dataset.truxDiagramFailed==="true")return;
  element.dataset.truxDiagramRendering="true";
  const sourceNode=element.querySelector(".trux-diagram-source"),svgSlot=element.querySelector(".trux-diagram-svg");
  const stage=element.querySelector(".trux-diagram-stage"),cursor=element.querySelector(".trux-diagram-cursor");
  const source=sourceNode?sourceNode.textContent:"";
  try{
    if(isTruxSvgDrawing(source)){
      const drawing=renderTruxSvgDrawing(source,svgSlot,stage);
      if(!element.isConnected)return;
      element.dataset.truxDiagramRendered="true";
      delete element.dataset.truxDiagramRendering;
      requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,drawing,cursor)});
      return;
    }
    const mermaidApi=await waitForTruxMermaidApi(element);
    if(!element.isConnected)return;
    if(!mermaidApi)throw Error("Mermaid renderer could not be loaded from either CDN");
    if(!source.trim())throw Error("Mermaid source is empty");
    if(!window.__truxMermaidInitialized){
      mermaidApi.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{
        background:"#151515",primaryColor:"#151515",primaryTextColor:"#d8d8d8",primaryBorderColor:"#818181",
        lineColor:"#b4b4b4",secondaryColor:"#151515",tertiaryColor:"#151515",mainBkg:"#151515",
        clusterBkg:"#151515",clusterBorder:"#515151",edgeLabelBackground:"#151515",
        noteBkgColor:"#151515",noteTextColor:"#d8d8d8",noteBorderColor:"#818181",
        textColor:"#d8d8d8",fontFamily:"Arial, sans-serif",fontSize:"26px"
      },flowchart:{htmlLabels:false,useMaxWidth:false,curve:"basis",nodeSpacing:100,rankSpacing:120,diagramPadding:36}});
      window.__truxMermaidInitialized=true;
    }
    // Mermaid keeps shared parser/render state; serialize renders so diagrams that
    // arrive together during streaming cannot collide intermittently.
    const renderJob=async()=>{
      let lastError=null;
      for(const candidate of getTruxMermaidCandidates(source)){
        try{
          // Validate before render, then try the next normalized variant on parser errors.
          if(typeof mermaidApi.parse==="function") await mermaidApi.parse(candidate);
          const result=await mermaidApi.render("trux-mermaid-"+(++truxMermaidRenderSequence),candidate);
          return {result,source:candidate};
        }catch(error){lastError=error;}
      }
      throw lastError||Error("Mermaid rejected all normalized source variants");
    };
    const renderPromise=truxMermaidRenderQueue.then(renderJob,renderJob);
    truxMermaidRenderQueue=renderPromise.then(()=>undefined,()=>undefined);
    const rendered=await renderPromise;
    const result=rendered.result;
    if(!element.isConnected)return;if(!svgSlot||!stage||!cursor)throw Error("Diagram surface unavailable");
    svgSlot.innerHTML=result.svg;const svg=svgSlot.querySelector("svg");if(!svg)throw Error("Mermaid returned no SVG");
    // Override Mermaid's generated max-width/width values; keep full-resolution content visible in the large stage.
    svg.style.setProperty("width","100%","important");
    svg.style.setProperty("min-width","100%","important");
    svg.style.setProperty("max-width","none","important");
    svg.style.setProperty("height","auto","important");
    svg.style.setProperty("min-height","460px","important");
    svg.style.background="#151515";svg.style.backgroundColor="#151515";
    element.dataset.truxDiagramRendered="true";delete element.dataset.truxDiagramRendering;
    if(typeof result.bindFunctions==="function")result.bindFunctions(svgSlot);
    requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,svg,cursor)});
  }catch(error){
    if(!element.isConnected)return;
    const fallbackSvg=renderTruxFallbackDiagram(source,svgSlot,stage);
    if(fallbackSvg){
      element.dataset.truxDiagramRendered="true";
      element.dataset.truxDiagramFallback="flowchart";
      delete element.dataset.truxDiagramRendering;
      requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,fallbackSvg,cursor)});
      console.warn("TruX used native SVG flowchart fallback:",String(error&&error.message||error||"Mermaid error"));
      return;
    }
    delete element.dataset.truxDiagramRendering;
    const retries=Number(element.dataset.truxDiagramRetry||0);
    if(retries<2){
      element.dataset.truxDiagramRetry=String(retries+1);
      window.setTimeout(()=>renderTruxDiagramElement(element),300*(retries+1));
      console.warn("TruX diagram render retry",retries+1,error);
      return;
    }
    element.dataset.truxDiagramFailed="true";
    if(cursor)cursor.hidden=true;
    const errorNode=element.querySelector(".trux-diagram-error");
    if(errorNode){
      const reason=String(error&&error.message||error||"Unknown rendering error").replace(/\s+/g," ").trim().slice(0,220);
      errorNode.hidden=false;
      errorNode.textContent="Diagram render error: "+(reason||"Unknown Mermaid error");
    }
    console.warn("TruX diagram render failed:",{message:String(error&&error.message||error||"Unknown error"),sourceLength:source.length});
  }
}
function renderTruxDiagrams(root){
  if(!root||typeof root.querySelectorAll!=="function")return;
  const diagrams=[];if(root instanceof Element&&root.matches(".trux-diagram[data-trux-diagram]"))diagrams.push(root);
  root.querySelectorAll(".trux-diagram[data-trux-diagram]").forEach(el=>diagrams.push(el));
  diagrams.forEach(renderTruxDiagramElement);
}

/*
 * allowOpenFence: when streaming, the tail of the text may contain a
 * fence that hasn't been closed yet. We render that as a live
 * "writing file…" card instead of leaking backticks into the chat.
 */
