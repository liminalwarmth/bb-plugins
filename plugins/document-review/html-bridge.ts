/** Runs inside the opaque sandbox. It has no BB APIs or parent DOM access. */
export function htmlBridgeScript(channel: string): string {
  return `(()=>{const channel=${JSON.stringify(channel)};` + String.raw`
  const send = (type, data={}) => parent.postMessage({channel, type, ...data}, '*');
  const nodes = new Map(); let entries=[], picking=false, selected=null, pointer=null, pending=0, last='', booted=false, dirtyNodes=false;
  const key = el => el && el.closest && el.closest('[data-dr-node]');
  const box = el => { const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; };
  const meaningful = el => key(el.closest('button,a,input,select,textarea,[role=button],img,svg,video,canvas,figure') || el.closest('h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,label,section,article,header,footer,nav,aside,main,form') || el);
  function selection() {
    const s=getSelection();
    if(s && s.rangeCount && !s.isCollapsed && s.toString().trim()) selected=s.getRangeAt(0).cloneRange();
    return selected && selected.commonAncestorContainer.isConnected && selected.toString().trim() ? selected : null;
  }
  function gesture(node, range) {
    const k=node && node.getAttribute('data-dr-node'); if(!k || !nodes.has(k)) return null;
    let selectedText, textRange;
    if(range && node.contains(range.startContainer) && node.contains(range.endContainer)) {
      const prefix=document.createRange(); prefix.selectNodeContents(node); prefix.setEnd(range.startContainer,range.startOffset);
      selectedText=range.toString().slice(0,2000); const start=prefix.toString().length; textRange={start,end:start+selectedText.length};
    }
    const hit=pointer && key(pointer.el);
    return {key:k,box:box(node), ...(selectedText?{selectedText,textRange}:{}), ...(hit?{pointer:{x:pointer.x,y:pointer.y,capturedAt:pointer.capturedAt,hitKey:hit.getAttribute('data-dr-node'),hitBox:box(hit),scrollX,scrollY,width:innerWidth,height:innerHeight}}:{})};
  }
  function target(el, useSelection=true) {
    const range=useSelection?selection():null;
    let ancestor=range && (range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
    ancestor=key(ancestor);
    let node=ancestor && ancestor.contains(el)?ancestor:meaningful(el);
    const anchor=gesture(node,node===ancestor?range:null), choices=[];
    for(let n=node;n && choices.length<5;n=n.parentElement) if(n.hasAttribute('data-dr-node') && !['HTML','SPAN','STRONG','EM','I'].includes(n.tagName)) { const g=gesture(n); if(g)choices.push(g); }
    return {anchor,choices};
  }
  function beginSelection() {
    const r=selection(); if(!r)return false;
    const el=r.commonAncestorContainer.nodeType===1?r.commonAncestorContainer:r.commonAncestorContainer.parentElement;
    const t=target(el); if(!t.anchor)return false; picking=false; document.documentElement.style.cursor=''; send('comment',t);return true;
  }
  function rangeFor(node, entry) {
    if(!entry.textRange || !entry.selectedText)return null;
    const w=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let n,at=0,from=null,to=null;
    while((n=w.nextNode())){const end=at+n.textContent.length;if(!from && entry.textRange.start>=at && entry.textRange.start<end)from={node:n,at:entry.textRange.start-at};if(entry.textRange.end>at && entry.textRange.end<=end){to={node:n,at:entry.textRange.end-at};break;}at=end;}
    if(!from || !to)return null;const r=document.createRange();r.setStart(from.node,from.at);r.setEnd(to.node,to.at);return r.toString()===entry.selectedText?r:null;
  }
  function measure(){
    pending=0;if(dirtyNodes){dirtyNodes=false;nodes.clear();for(const n of document.querySelectorAll('[data-dr-node]'))nodes.set(n.getAttribute('data-dr-node'),n);for(const e of entries)e.range=null;}const boxes=[];
    const add=(r,kind,point,pinOnly)=>{if(boxes.length>=800 || r.width+r.height===0 && !pinOnly || r.left+r.width<0 || r.top+r.height<0 || r.left>innerWidth || r.top>innerHeight)return;boxes.push({left:r.left,top:r.top,width:r.width,height:r.height,kind,...(point?{point}:{}),...(pinOnly?{pinOnly:true}:{})});};
    for(const entry of entries){const node=nodes.get(entry.key);if(!node || !node.isConnected)continue;const bounds=box(node);if(bounds.left+bounds.width<0 || bounds.top+bounds.height<0 || bounds.left>innerWidth || bounds.top>innerHeight)continue;
      if(!entry.range)entry.range=rangeFor(node,entry);const rects=entry.range?Array.from(entry.range.getClientRects()):[];
      if(rects.length){for(const r of rects)add(r,entry.kind);if(entry.point && entry.kind!=='passive')add({left:bounds.left+entry.point.x*bounds.width,top:bounds.top+entry.point.y*bounds.height,width:0,height:0},entry.kind,{x:0,y:0},true);}
      else add(bounds,entry.kind,entry.point);
    }
    const data={boxes,scrollX,scrollY}, json=JSON.stringify(data);if(json!==last){last=json;send('geometry',data);}
  }
  const schedule=()=>{if(!pending)pending=requestAnimationFrame(measure);};
  addEventListener('message',e=>{
    if(e.source!==parent || !e.data || e.data.channel!==channel)return;
    const m=e.data;
    if(m.type==='hello'){if(booted)send('ready');return;}
    if(m.type==='state' && Array.isArray(m.entries)){entries=m.entries.slice(0,1000).map(x=>({...x,range:null}));schedule();}
    if(m.type==='pick'){if(!beginSelection()){picking=true;document.documentElement.style.cursor='crosshair';send('picking');}}
    if(m.type==='cancel'){picking=false;document.documentElement.style.cursor='';}
    if(m.type==='restore' && Number.isFinite(m.top))scrollTo({top:m.top,behavior:'instant'});
    if(m.type==='scroll' && typeof m.key==='string'){const node=nodes.get(m.key);if(node){for(let p=node.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;node.scrollIntoView({block:'center',behavior:'smooth'});}}
  });
  document.addEventListener('pointerdown',e=>{if(e.button===0)selected=null;if(e.target.nodeType===1)pointer={el:e.target,x:e.clientX,y:e.clientY,capturedAt:new Date().toISOString()};},true);
  document.addEventListener('selectionchange',()=>{const s=getSelection();if(s && s.isCollapsed && document.hasFocus())selected=null;else selection();});
  document.addEventListener('mousemove',e=>{if(e.target.nodeType!==1)return;pointer={el:e.target,x:e.clientX,y:e.clientY,capturedAt:new Date().toISOString()};if(picking && !pending)pending=requestAnimationFrame(()=>{pending=0;const t=target(pointer.el,false);if(t.anchor)send('hover',{anchor:t.anchor});});});
  document.addEventListener('contextmenu',e=>{
    if(e.shiftKey){send('clear');return;}pointer={el:e.target,x:e.clientX,y:e.clientY,capturedAt:new Date().toISOString()};const r=selection(), inside=r && Array.from(r.getClientRects()).some(b=>e.clientX>=b.left && e.clientX<=b.right && e.clientY>=b.top && e.clientY<=b.bottom);const t=target(e.target,!!inside);if(!t.anchor)return;e.preventDefault();e.stopImmediatePropagation();picking=false;document.documentElement.style.cursor='';send('context',{...t,x:e.clientX,y:e.clientY});
  },true);
  document.addEventListener('click',e=>{
    send('clear');
    if(picking){e.preventDefault();e.stopImmediatePropagation();picking=false;document.documentElement.style.cursor='';const t=target(e.target);if(t.anchor)send('comment',t);return;}
    const a=e.target.closest && e.target.closest('a[href]');if(a && !a.getAttribute('href').startsWith('#'))e.preventDefault();
    const s=getSelection();if(s && !s.isCollapsed)return;
    const matches=entries.filter(x=>x.id && x.kind!=='change' && x.kind!=='draft' && nodes.get(x.key)?.contains(e.target)).filter(x=>{const r=x.range?Array.from(x.range.getClientRects()):[];return !r.length || r.some(b=>e.clientX>=b.left && e.clientX<=b.right && e.clientY>=b.top && e.clientY<=b.bottom);}).sort((a,b)=>a.size-b.size);
    if(matches[0])send('picked',{id:matches[0].id});
  },true);
  document.addEventListener('submit',e=>e.preventDefault(),true);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){picking=false;document.documentElement.style.cursor='';send('clear');}
    if((e.metaKey||e.ctrlKey)&&e.altKey&&(e.code==='KeyM'||e.key.toLowerCase()==='m')){e.preventDefault();if(!beginSelection()){picking=true;document.documentElement.style.cursor='crosshair';send('picking');}}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();send('checkpoint');}
  },true);
  function boot(){
    for(const node of document.querySelectorAll('[data-dr-node]'))nodes.set(node.getAttribute('data-dr-node'),node);
    booted=true;send('ready');schedule();
    const changes=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'))dirtyNodes=true;else if(records.some(r=>r.type==='characterData'))for(const e of entries)e.range=null;schedule();});changes.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','open']});
    const sizes=new ResizeObserver(schedule);sizes.observe(document.body);
    addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule);document.addEventListener('load',schedule,true);document.addEventListener('toggle',schedule,true);document.addEventListener('transitionend',schedule,true);document.fonts?.ready.then(schedule);
    addEventListener('pagehide',()=>{cancelAnimationFrame(pending);changes.disconnect();sizes.disconnect();},{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();`;
}
