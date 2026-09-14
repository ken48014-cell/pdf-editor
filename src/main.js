import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
const $ = (s) => document.querySelector(s);
const native = Capacitor.isNativePlatform();

const state = {
  bytes: null, pdf: null, fileName: 'document', page: 1,
  zoom: 1, fitScale: 1, scale: 1, tool: 'select',
  edits: new Map(), annotations: new Map(), rotations: new Map(),
  history: [], future: [], dirty: false, renderToken: 0,
  gesture: null, imageBytes: new Map(), signatureBytes: new Map()
};

$('#app').innerHTML = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><div class="logo">P</div><div><b>Free PDF Editor</b><small>Offline • On device</small></div></div>
    <div class="top-actions">
      <button class="icon" id="undo" aria-label="Undo">↶</button>
      <button class="icon" id="redo" aria-label="Redo">↷</button>
      <button class="btn secondary" id="open">Open</button>
      <button class="btn primary" id="save" disabled>Save</button>
      <input id="file" type="file" accept="application/pdf" hidden>
    </div>
  </header>
  <nav class="toolbar" id="toolbar">
    <button class="tool active" data-tool="select"><strong>↖</strong><span>Select</span></button>
    <button class="tool" data-tool="text"><strong>T</strong><span>Text</span></button>
    <button class="tool" data-tool="highlight"><strong>▰</strong><span>Highlight</span></button>
    <button class="tool" data-tool="draw"><strong>✎</strong><span>Draw</span></button>
    <button class="tool" data-tool="rect"><strong>□</strong><span>Shape</span></button>
    <button class="tool" data-tool="image"><strong>▧</strong><span>Image</span></button>
    <button class="tool" data-tool="signature"><strong>✓</strong><span>Sign</span></button>
    <button class="tool" data-tool="pages"><strong>▤</strong><span>Pages</span></button>
    <button class="tool" data-tool="search"><strong>⌕</strong><span>Search</span></button>
    <button class="tool" data-tool="more"><strong>•••</strong><span>More</span></button>
  </nav>
  <main class="workspace">
    <aside class="sidebar" id="thumbs"></aside>
    <section class="viewer" id="viewer">
      <div class="empty" id="empty"><div class="empty-icon">PDF</div><h2>Edit PDFs on your phone</h2><p>Text, highlights, drawing, images, signatures and page tools. Everything stays on your device until you share or save.</p><button class="btn primary big" id="open2">Choose PDF</button></div>
      <div class="page-wrap" id="pageWrap" hidden>
        <div class="page" id="page"><canvas id="canvas"></canvas><div id="overlay"></div></div>
      </div>
    </section>
  </main>
  <footer class="bottom" id="bottom" hidden>
    <button id="prev" aria-label="Previous page">‹</button><span id="counter">1 / 1</span><button id="next" aria-label="Next page">›</button>
    <span class="sep"></span><button id="zoomOut">−</button><button id="zoomLabel" class="zoom-label">100%</button><button id="zoomIn">+</button><button id="fit">Fit</button>
  </footer>
</div>
<div class="modal" id="modal" hidden><div class="modal-card"><div class="modal-head"><b id="modalTitle"></b><button id="modalClose">×</button></div><div id="modalBody"></div></div></div>
<div class="toast" id="toast"></div>
<input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp" hidden>
`;

function toast(msg, type='info') { const e=$('#toast'); e.textContent=msg; e.dataset.type=type; e.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>e.classList.remove('show'),2800); }
function snapshotValue(value){
  if(value instanceof Uint8Array) return {__bytes:Array.from(value)};
  if(Array.isArray(value)) return value.map(snapshotValue);
  if(value && typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value)) out[k]=snapshotValue(v);
    return out;
  }
  return value;
}
function restoreValue(value){
  if(Array.isArray(value)) return value.map(restoreValue);
  if(value && typeof value==='object'){
    if(Array.isArray(value.__bytes)) return new Uint8Array(value.__bytes);
    const out={};
    for(const [k,v] of Object.entries(value)) out[k]=restoreValue(v);
    return out;
  }
  return value;
}
function cloneData(){ return JSON.stringify({edits:snapshotValue([...state.edits]),annotations:snapshotValue([...state.annotations]),rotations:snapshotValue([...state.rotations])}); }
function restoreData(s){ const x=JSON.parse(s); state.edits=new Map(restoreValue(x.edits)); state.annotations=new Map(restoreValue(x.annotations)); state.rotations=new Map(restoreValue(x.rotations||[])); }
function checkpoint(){ state.history.push(cloneData()); if(state.history.length>60)state.history.shift(); state.future=[]; state.dirty=true; updateButtons(); }
function undo(){ if(!state.history.length)return; state.future.push(cloneData()); restoreData(state.history.pop()); render(); updateButtons(); }
function redo(){ if(!state.future.length)return; state.history.push(cloneData()); restoreData(state.future.pop()); render(); updateButtons(); }
function updateButtons(){ $('#undo').disabled=!state.history.length; $('#redo').disabled=!state.future.length; $('#save').disabled=!state.pdf; }
function pageData(map){ return map.get(state.page)||[]; }
function setTool(t){ state.tool=t; document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t)); $('#overlay')?.setAttribute('data-tool',t); if(t==='pages')return showPages(); if(t==='search')return showSearch(); if(t==='more')return showMore(); if(t==='image')return pickImage(); if(t==='signature')return showSignature(); if(t==='select')toast('Tap existing text to edit or use the page normally'); else if(t==='text')toast('Tap anywhere on the PDF to add text'); else if(t==='draw')toast('Draw with your finger'); else if(t==='highlight')toast('Drag over an area to highlight'); else if(t==='rect')toast('Drag to draw a rectangle'); }

document.querySelectorAll('.tool').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
$('#undo').onclick=undo; $('#redo').onclick=redo; $('#open').onclick=()=>$('#file').click(); $('#open2').onclick=()=>$('#file').click(); $('#file').onchange=async e=>{const f=e.target.files?.[0];e.target.value='';if(f)await loadFile(f)};
$('#prev').onclick=()=>goPage(state.page-1); $('#next').onclick=()=>goPage(state.page+1);
$('#zoomOut').onclick=()=>setZoom(state.zoom-.1); $('#zoomIn').onclick=()=>setZoom(state.zoom+.1); $('#fit').onclick=()=>{state.zoom=1;render()}; $('#zoomLabel').onclick=()=>{state.zoom=1;render()}; $('#modalClose').onclick=closeModal; $('#save').onclick=exportPdf;

function setZoom(z){ state.zoom=Math.max(.5,Math.min(4,Math.round(z*10)/10)); render(); }
async function loadFile(file){
  try{
    state.bytes=await file.arrayBuffer(); state.pdf=await pdfjsLib.getDocument({data:state.bytes.slice(0)}).promise;
    state.fileName=file.name.replace(/\.pdf$/i,'')||'document'; state.page=1; state.zoom=1; state.edits.clear(); state.annotations.clear(); state.rotations.clear(); state.imageBytes.clear(); state.signatureBytes.clear(); state.history=[]; state.future=[]; state.dirty=false;
    $('#empty').hidden=true; $('#pageWrap').hidden=false; $('#bottom').hidden=false; updateButtons(); await render(); await renderThumbs(); toast(`${state.pdf.numPages} page${state.pdf.numPages===1?'':'s'} loaded`,'ok');
  }catch(e){console.error(e);toast('Could not open PDF: '+(e?.message||e),'error')}
}
async function goPage(n){if(!state.pdf||n<1||n>state.pdf.numPages)return;state.page=n;await render();await renderThumbs();}

async function render(){
  if(!state.pdf)return; const token=++state.renderToken; const p=await state.pdf.getPage(state.page); if(token!==state.renderToken)return;
  const viewer=$('#viewer'); const rotation=state.rotations.get(state.page)||0; const base=p.getViewport({scale:1,rotation});
  const available=Math.max(220,viewer.clientWidth-24); const fit=Math.min(available/base.width,1.5); state.fitScale=fit; state.scale=fit*state.zoom;
  const vp=p.getViewport({scale:state.scale,rotation}); const canvas=$('#canvas'); const ctx=canvas.getContext('2d',{alpha:false});
  canvas.width=Math.max(1,Math.ceil(vp.width)); canvas.height=Math.max(1,Math.ceil(vp.height)); canvas.style.width=vp.width+'px'; canvas.style.height=vp.height+'px'; $('#page').style.width=vp.width+'px'; $('#page').style.height=vp.height+'px';
  await p.render({canvasContext:ctx,viewport:vp}).promise; if(token!==state.renderToken)return;
  $('#overlay').innerHTML=''; $('#counter').textContent=`${state.page} / ${state.pdf.numPages}`; $('#zoomLabel').textContent=Math.round(state.zoom*100)+'%';
  const text=await p.getTextContent(); text.items.forEach(item=>addTextHit(item,vp)); pageData(state.edits).forEach(addEditNode); pageData(state.annotations).forEach(addAnnotationNode);
}
function addTextHit(item,vp){
  if(!item.str?.trim())return; const tx=pdfjsLib.Util.transform(vp.transform,item.transform); const h=Math.max(9,Math.hypot(tx[2],tx[3]));
  const n=document.createElement('div'); n.className='text-hit'; n.textContent=item.str; n.dataset.text='1'; n.dataset.x=item.transform[4]; n.dataset.y=item.transform[5]; n.dataset.w=item.width||20; n.dataset.size=Math.max(6,Math.hypot(item.transform[2],item.transform[3]));
  n.style.left=tx[4]+'px'; n.style.top=(tx[5]-h)+'px'; n.style.width=Math.max(12,item.width*state.scale)+'px'; n.style.height=Math.max(12,h*1.25)+'px'; $('#overlay').appendChild(n);
}
function editExisting(node){
  if(node.contentEditable==='true')return; const old=node.textContent; node.contentEditable='true'; node.classList.add('editing'); node.focus();
  const r=document.createRange();r.selectNodeContents(node);const s=getSelection();s.removeAllRanges();s.addRange(r);
  const finish=()=>{node.contentEditable='false';node.classList.remove('editing');if(node.textContent!==old){checkpoint();const list=pageData(state.edits);list.push({type:'replace',x:+node.dataset.x,y:+node.dataset.y,w:+node.dataset.w,size:+node.dataset.size,text:node.textContent});state.edits.set(state.page,list);node.classList.add('changed');toast('Replacement queued for export','ok')}};
  node.onblur=finish; node.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();node.blur()}};
}
function addEditNode(e){
  if(e.type!=='addText'&&e.type!=='replace')return; const n=document.createElement('div'); n.className=e.type==='addText'?'added-text':'replacement'; n.textContent=e.text;
  const pageHeight=$('#page').clientHeight/state.scale;
  n.style.left=e.x*state.scale+'px';
  n.style.top=(e.type==='replace' ? pageHeight-e.y-e.size*1.05 : e.y-e.size)*state.scale+'px';
  n.style.fontSize=Math.max(8,e.size*state.scale)+'px'; n.dataset.edit='1';
  if(e.type==='addText'){
    n.contentEditable='true'; n.spellcheck=false;
    n.onblur=()=>{
      const next=n.textContent;
      if(!next.trim()){
        const list=pageData(state.edits); const i=list.indexOf(e);
        if(i>=0){ checkpoint(); list.splice(i,1); state.edits.set(state.page,list); }
        render(); return;
      }
      if(next!==e.text){ checkpoint(); e.text=next; state.dirty=true; updateButtons(); }
    };
  }
  $('#overlay').appendChild(n);
}
function pagePoint(clientX,clientY){const r=$('#page').getBoundingClientRect();return{x:Math.max(0,Math.min((clientX-r.left)/state.scale, r.width/state.scale)),y:Math.max(0,Math.min((clientY-r.top)/state.scale,r.height/state.scale))};}

// All drawing/edit gestures live on the overlay. This prevents the overlay from swallowing pointer events and makes tools work on touch screens.
$('#overlay').addEventListener('pointerdown',e=>{
  if(!state.pdf)return; const hit=e.target;
  if(state.tool==='select'){ if(hit.classList.contains('text-hit')){e.stopPropagation();editExisting(hit)} return; }
  if(state.tool==='text'){ if(hit.dataset?.edit)return; const p=pagePoint(e.clientX,e.clientY); checkpoint(); const item={type:'addText',x:p.x,y:p.y,size:14,text:'New text'}; pageData(state.edits).push(item);state.edits.set(state.page,pageData(state.edits));render().then(()=>{const n=[...$('#overlay').querySelectorAll('.added-text')].at(-1);if(n){n.focus();const r=document.createRange();r.selectNodeContents(n);const s=getSelection();s.removeAllRanges();s.addRange(r)}});return; }
  if(['draw','highlight','rect'].includes(state.tool)){e.preventDefault();e.stopPropagation();const p=pagePoint(e.clientX,e.clientY);state.gesture={start:p,last:p,points:[p],pointerId:e.pointerId};$('#overlay').setPointerCapture(e.pointerId);drawPreview();}
});
$('#overlay').addEventListener('pointermove',e=>{if(!state.gesture||e.pointerId!==state.gesture.pointerId)return;e.preventDefault();const p=pagePoint(e.clientX,e.clientY);state.gesture.last=p;if(state.tool==='draw')state.gesture.points.push(p);drawPreview();});
$('#overlay').addEventListener('pointerup',finishGesture); $('#overlay').addEventListener('pointercancel',finishGesture);
function finishGesture(e){if(!state.gesture||e.pointerId!==state.gesture.pointerId)return;e.preventDefault();const g=state.gesture;state.gesture=null;$('#drawPreview')?.remove();
  if(state.tool==='draw'){if(g.points.length<2)return;checkpoint();pageData(state.annotations).push({type:'freehand',points:g.points});state.annotations.set(state.page,pageData(state.annotations));}
  else{const x=Math.min(g.start.x,g.last.x),y=Math.min(g.start.y,g.last.y),w=Math.abs(g.last.x-g.start.x),h=Math.abs(g.last.y-g.start.y);if(w<4||h<4)return;checkpoint();pageData(state.annotations).push({type:state.tool,x,y,w,h});state.annotations.set(state.page,pageData(state.annotations));} render();
}
function drawPreview(){if(!state.gesture)return;$('#drawPreview')?.remove();const n=document.createElement('canvas');n.id='drawPreview';n.width=$('#page').clientWidth;n.height=$('#page').clientHeight;n.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30';const c=n.getContext('2d');const g=state.gesture;c.lineCap='round';c.lineJoin='round';c.strokeStyle=state.tool==='highlight'?'rgba(250,204,21,.45)':'#2563eb';c.lineWidth=state.tool==='highlight'?18:3;
  if(state.tool==='draw'){c.beginPath();g.points.forEach((p,i)=>i?c.lineTo(p.x*state.scale,p.y*state.scale):c.moveTo(p.x*state.scale,p.y*state.scale));c.stroke();}
  else{const x=Math.min(g.start.x,g.last.x)*state.scale,y=Math.min(g.start.y,g.last.y)*state.scale,w=Math.abs(g.last.x-g.start.x)*state.scale,h=Math.abs(g.last.y-g.start.y)*state.scale;if(state.tool==='highlight'){c.fillStyle='rgba(250,204,21,.28)';c.fillRect(x,y,w,h)}else c.strokeRect(x,y,w,h)} $('#overlay').appendChild(n);
}
function addAnnotationNode(a){
  if(a.type==='freehand'){const n=document.createElement('canvas');n.className='annotation-canvas';n.width=$('#page').clientWidth;n.height=$('#page').clientHeight;n.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10';const c=n.getContext('2d');c.strokeStyle='#2563eb';c.lineWidth=3;c.lineCap='round';c.lineJoin='round';c.beginPath();a.points.forEach((p,i)=>i?c.lineTo(p.x*state.scale,p.y*state.scale):c.moveTo(p.x*state.scale,p.y*state.scale));c.stroke();$('#overlay').appendChild(n);return;}
  if(a.type==='image'||a.type==='signature'){const n=document.createElement('img');n.className='placed-image';n.src=a.src;n.style.left=a.x*state.scale+'px';n.style.top=a.y*state.scale+'px';n.style.width=a.w*state.scale+'px';n.style.height=a.h*state.scale+'px';n.draggable=false;$('#overlay').appendChild(n);return;}
  const n=document.createElement('div');n.className='annotation '+a.type;n.style.left=a.x*state.scale+'px';n.style.top=a.y*state.scale+'px';n.style.width=a.w*state.scale+'px';n.style.height=a.h*state.scale+'px';$('#overlay').appendChild(n);
}

function showModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').hidden=false;} function closeModal(){$('#modal').hidden=true;}
async function renderPageThumb(i,scale=.16){const p=await state.pdf.getPage(i);const vp=p.getViewport({scale,rotation:state.rotations.get(i)||0});const c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return c;}
async function renderThumbs(){const side=$('#thumbs');side.innerHTML='';if(!state.pdf||innerWidth<720)return;for(let i=1;i<=state.pdf.numPages;i++){const b=document.createElement('button');b.className=i===state.page?'selected':'';b.append(await renderPageThumb(i,.13),document.createTextNode(i));b.onclick=()=>goPage(i);side.appendChild(b);}}
async function showPages(){if(!state.pdf)return toast('Open a PDF first');showModal('Pages',`<div class="page-actions"><button id="addBlank" class="btn secondary">Add blank</button><button id="deletePage" class="btn danger">Delete</button><button id="rotatePage" class="btn secondary">Rotate 90°</button><button id="exportPage" class="btn secondary">Export page</button></div><div id="pageGrid" class="thumb-grid">Loading…</div>`);$('#addBlank').onclick=addBlankPage;$('#deletePage').onclick=deleteCurrentPage;$('#rotatePage').onclick=rotateCurrentPage;$('#exportPage').onclick=exportCurrentPage;renderPageGrid();}
async function renderPageGrid(){const grid=$('#pageGrid');if(!grid)return;grid.innerHTML='';for(let i=1;i<=state.pdf.numPages;i++){const b=document.createElement('button');b.className=i===state.page?'selected':'';b.append(await renderPageThumb(i,.16),document.createTextNode('Page '+i));b.onclick=()=>{state.page=i;closeModal();render();renderThumbs()};grid.appendChild(b);}}
async function rebuild(mutator){
  const materialized=await buildPdfBytes();
  const doc=await PDFDocument.load(materialized);
  await mutator(doc);
  state.bytes=await doc.save();
  state.pdf=await pdfjsLib.getDocument({data:state.bytes.slice(0)}).promise;
  state.edits.clear();state.annotations.clear();state.rotations.clear();
  state.history=[];state.future=[];state.dirty=true;
  state.page=Math.min(state.page,state.pdf.numPages);
  await render();await renderThumbs();updateButtons();
}
async function addBlankPage(){try{const ref=state.pdf.getPage(state.page-1);const vp=ref.getViewport({scale:1});await rebuild(doc=>{doc.insertPage(state.page,[vp.width,vp.height])});closeModal();toast('Blank page added','ok')}catch(e){toast('Could not add page: '+e.message,'error')}}
async function deleteCurrentPage(){if(state.pdf.numPages<=1)return toast('A PDF must have at least one page','error');try{await rebuild(doc=>doc.removePage(state.page-1));closeModal();toast('Page deleted','ok')}catch(e){toast('Could not delete page: '+e.message,'error')}}
async function rotateCurrentPage(){checkpoint();state.rotations.set(state.page,((state.rotations.get(state.page)||0)+90)%360);closeModal();await render();await renderThumbs();}
async function exportCurrentPage(){
  try{
    const source=await PDFDocument.load(await buildPdfBytes()),out=await PDFDocument.create();
    const [p]=await out.copyPages(source,[state.page-1]);out.addPage(p);
    await saveBytes(await out.save(),`${state.fileName}-page-${state.page}.pdf`);closeModal();
  }catch(e){toast('Export failed: '+e.message,'error')}
}

function showSearch(){if(!state.pdf)return toast('Open a PDF first');showModal('Search PDF',`<input id="searchInput" class="search" placeholder="Search text…" autocomplete="off"><div id="results" class="results"></div>`);$('#searchInput').oninput=async e=>{const q=e.target.value.trim().toLowerCase(),r=$('#results');r.innerHTML='';if(!q)return;for(let i=1;i<=state.pdf.numPages;i++){const p=await state.pdf.getPage(i),c=await p.getTextContent(),text=c.items.map(x=>x.str).join(' ');if(text.toLowerCase().includes(q)){const b=document.createElement('button');b.textContent='Page '+i+' · '+text.slice(0,140);b.onclick=()=>{state.page=i;closeModal();render()};r.appendChild(b);}}if(!r.children.length)r.textContent='No matches';};}
function showMore(){if(!state.pdf)return toast('Open a PDF first');showModal('More tools',`<div class="more-grid"><button id="info">Document info</button><button id="discard">Discard edits</button><button id="rotate2">Rotate page</button><button id="about">About</button></div>`);$('#info').onclick=async()=>{const d=await PDFDocument.load(state.bytes);showModal('Document info',`<div class="info"><p><b>Pages:</b> ${d.getPageCount()}</p><p><b>Title:</b> ${d.getTitle()||'—'}</p><p><b>Author:</b> ${d.getAuthor()||'—'}</p></div>`)};$('#discard').onclick=()=>{state.edits.clear();state.annotations.clear();state.rotations.clear();state.history=[];state.future=[];state.dirty=false;closeModal();render();toast('Unsaved edits discarded')};$('#rotate2').onclick=()=>rotateCurrentPage();$('#about').onclick=()=>showModal('About','<div class="info"><b>Free PDF Editor</b><p>Offline-first PDF editing for Android. Files remain on the device unless you choose to share them.</p></div>');}

function pickImage(){if(!state.pdf)return toast('Open a PDF first');$('#imageInput').click();}
$('#imageInput').onchange=async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{const bytes=new Uint8Array(await f.arrayBuffer());const url=URL.createObjectURL(f);const img=new Image();img.onload=async()=>{
    try{
      const maxW=Math.min(220,img.naturalWidth),maxH=Math.min(160,img.naturalHeight);
      const ratio=Math.min(maxW/img.naturalWidth,maxH/img.naturalHeight);
      let exportBytes=bytes, exportKind=f.type;
      if(!['image/png','image/jpeg'].includes(exportKind)){
        const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
        c.getContext('2d').drawImage(img,0,0);
        const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
        if(!blob) throw new Error('Could not convert image to PNG');
        exportBytes=new Uint8Array(await blob.arrayBuffer()); exportKind='image/png';
      }
      checkpoint();
      const a={type:'image',src:URL.createObjectURL(new Blob([exportBytes],{type:exportKind})),bytes:exportBytes,kind:exportKind,w:Math.max(20,img.naturalWidth*ratio),h:Math.max(20,img.naturalHeight*ratio),x:30,y:30};
      pageData(state.annotations).push(a); state.annotations.set(state.page,pageData(state.annotations));
      state.imageBytes.set(a,exportBytes); render();
    }catch(err){toast('Could not add image: '+err.message,'error')}
    finally{URL.revokeObjectURL(url);}
  };img.onerror=()=>toast('Could not load image','error');img.src=url;}catch(err){toast('Could not add image: '+err.message,'error')}};
function showSignature(){if(!state.pdf)return toast('Open a PDF first');showModal('Add signature',`<p class="hint">Draw with your finger.</p><canvas id="sigCanvas" class="sig-canvas" width="900" height="300"></canvas><div class="page-actions"><button id="clearSig" class="btn secondary">Clear</button><button id="useSig" class="btn primary">Place signature</button></div>`);const c=$('#sigCanvas'),ctx=c.getContext('2d');ctx.lineWidth=5;ctx.lineCap='round';ctx.lineJoin='round';let drawing=false;const pos=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}};c.onpointerdown=e=>{drawing=true;c.setPointerCapture(e.pointerId);const p=pos(e);ctx.beginPath();ctx.moveTo(p.x,p.y)};c.onpointermove=e=>{if(!drawing)return;const p=pos(e);ctx.lineTo(p.x,p.y);ctx.stroke()};c.onpointerup=()=>drawing=false;c.onpointercancel=()=>drawing=false;$('#clearSig').onclick=()=>ctx.clearRect(0,0,c.width,c.height);$('#useSig').onclick=()=>{const src=c.toDataURL('image/png');checkpoint();const a={type:'signature',src,bytes:dataUrlToBytes(src),kind:'image/png',x:40,y:40,w:220,h:75};pageData(state.annotations).push(a);state.annotations.set(state.page,pageData(state.annotations));state.signatureBytes.set(a,a.bytes);closeModal();render();toast('Signature placed','ok')}}

async function buildPdfBytes(){
  const doc=await PDFDocument.load(state.bytes);
  const font=await doc.embedFont(StandardFonts.Helvetica);
  for(const [no,items] of state.edits){
    const p=doc.getPages()[no-1]; if(!p) continue;
    const H=p.getHeight();
    for(const e of items){
      if(e.type==='replace'){
        p.drawRectangle({x:e.x-1,y:e.y-e.size*.3,width:Math.max(e.w,12)+3,height:e.size*1.25,color:rgb(1,1,1)});
        p.drawText(e.text,{x:e.x,y:e.y-e.size*.12,size:e.size,font,color:rgb(.07,.09,.12)});
      }else if(e.type==='addText'&&e.text.trim()){
        p.drawText(e.text,{x:e.x,y:H-e.y-e.size,size:e.size,font,color:rgb(.07,.09,.12)});
      }
    }
  }
  for(const [no,items] of state.annotations){
    const p=doc.getPages()[no-1]; if(!p) continue;
    const H=p.getHeight();
    for(const a of items){
      if(a.type==='highlight') p.drawRectangle({x:a.x,y:H-a.y-a.h,width:a.w,height:a.h,color:rgb(1,.82,.05),opacity:.35});
      else if(a.type==='rect') p.drawRectangle({x:a.x,y:H-a.y-a.h,width:a.w,height:a.h,borderColor:rgb(.15,.39,.9),borderWidth:2});
      else if(a.type==='freehand'){
        for(let i=1;i<a.points.length;i++){const s=a.points[i-1],q=a.points[i];
          p.drawLine({start:{x:s.x,y:H-s.y},end:{x:q.x,y:H-q.y},thickness:2.5,color:rgb(.15,.39,.9)});
        }
      }else if(a.type==='image'||a.type==='signature'){
        try{
          const bytes=a.bytes||dataUrlToBytes(a.src);
          const im=a.kind==='image/jpeg'?await doc.embedJpg(bytes):await doc.embedPng(bytes);
          p.drawImage(im,{x:a.x,y:H-a.y-a.h,width:a.w,height:a.h});
        }catch(err){console.warn('image export failed',err);}
      }
    }
  }
  for(const [no,deg] of state.rotations){const p=doc.getPages()[no-1];if(p)p.setRotation(degrees(deg));}
  return doc.save();
}
async function exportPdf(){
  if(!state.bytes)return;
  const btn=$('#save');btn.disabled=true;btn.textContent='Saving…';
  try{
    const out=await buildPdfBytes();
    await saveBytes(out,`${state.fileName}-edited.pdf`);
    state.bytes=out;state.pdf=await pdfjsLib.getDocument({data:out.slice(0)}).promise;
    state.edits.clear();state.annotations.clear();state.history=[];state.future=[];state.dirty=false;
    await render();await renderThumbs();toast('PDF saved successfully','ok');
  }catch(e){console.error(e);toast('Save failed: '+(e?.message||e),'error')}
  finally{btn.disabled=!state.pdf;btn.textContent='Save';updateButtons();}
}
function dataUrlToBytes(data){const b64=data.split(',')[1],bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
async function saveBytes(bytes,name){if(native){try{const data=uint8ToBase64(bytes);const path=`PDFEditor/${Date.now()}-${name.replace(/[^a-z0-9._-]/gi,'_')}`;const r=await Filesystem.writeFile({path,data,directory:Directory.Documents,recursive:true});await Share.share({title:name,text:'Edited PDF',url:r.uri,dialogTitle:'Share PDF'});return;}catch(e){console.warn('Native save/share fallback',e);}}const blob=new Blob([bytes],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function uint8ToBase64(u){let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(s);}

// Prevent browser-level page zoom. The PDF viewer itself is the only zoom surface.
document.addEventListener('gesturestart',e=>e.preventDefault(),{passive:false});document.addEventListener('gesturechange',e=>e.preventDefault(),{passive:false});document.addEventListener('gestureend',e=>e.preventDefault(),{passive:false});
window.addEventListener('resize',()=>{if(state.pdf){clearTimeout(window.__resize);window.__resize=setTimeout(()=>render(),120);}});updateButtons();
