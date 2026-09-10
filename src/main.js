import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { AdMob, RewardAdPluginEvents } from '@capacitor-community/admob';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const TEST_REWARDED = 'ca-app-pub-3940256099942544/5224354917';
const native = Capacitor.isNativePlatform();

const state = {
  bytes: null, pdf: null, fileName: 'edited_document.pdf', page: 1, scale: 1,
  tool: 'select', zoom: 1, edits: new Map(), annotations: new Map(),
  history: [], future: [], selected: null, dirty: false, renderToken: 0,
  adReady: false
};

const $ = (s) => document.querySelector(s);
const app = $('#app');

app.innerHTML = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><div class="logo">P</div><div><b>PDF Editor</b><span id="status">Private · Offline</span></div></div>
    <div class="top-actions">
      <button class="icon" id="undo" title="Undo">↶</button><button class="icon" id="redo" title="Redo">↷</button>
      <button class="primary" id="open">Open PDF</button><input id="file" type="file" accept="application/pdf" hidden>
      <button class="primary save" id="save" disabled>Save & Share</button>
    </div>
  </header>
  <div class="toolbar" id="toolbar">
    <button data-tool="select" class="tool active">↖ <span>Select</span></button>
    <button data-tool="text" class="tool">T <span>Text</span></button>
    <button data-tool="highlight" class="tool">▰ <span>Highlight</span></button>
    <button data-tool="draw" class="tool">✎ <span>Draw</span></button>
    <button data-tool="rect" class="tool">□ <span>Shape</span></button>
    <button data-tool="image" class="tool">▧ <span>Image</span></button>
    <button data-tool="signature" class="tool">✓ <span>Sign</span></button>
    <button data-tool="pages" class="tool">▤ <span>Pages</span></button>
    <button data-tool="search" class="tool">⌕ <span>Search</span></button>
    <button data-tool="more" class="tool">⋯ <span>More</span></button>
  </div>
  <main class="workspace">
    <aside class="sidebar" id="thumbs"></aside>
    <section class="viewer" id="viewer">
      <div id="empty" class="empty"><div class="empty-icon">PDF</div><h2>Edit PDFs privately</h2><p>Everything is processed on your device. No upload required.</p><button class="primary big" id="open2">Choose a PDF</button></div>
      <div class="page-wrap" id="pageWrap" hidden>
        <div class="page" id="page"><canvas id="canvas"></canvas><div id="overlay"></div></div>
      </div>
    </section>
  </main>
  <footer class="bottom" id="bottom" hidden>
    <button id="prev">‹</button><span id="counter">1 / 1</span><button id="next">›</button>
    <span class="sep"></span><button id="zoomOut">−</button><span id="zoomLabel">100%</span><button id="zoomIn">+</button>
    <span class="sep"></span><button id="rotate">⟳</button><button id="fit">Fit</button>
  </footer>
</div>
<div class="modal" id="modal" hidden><div class="modal-card"><div class="modal-head"><b id="modalTitle">Pages</b><button id="modalClose">×</button></div><div id="modalBody"></div></div></div>
<div class="toast" id="toast"></div>
<input id="imageInput" type="file" accept="image/*" hidden>
`;

function toast(message, type='info') { const el=$('#toast'); el.textContent=message; el.dataset.type=type; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2800); }
function snapshot(){ return JSON.stringify({edits:[...state.edits], annotations:[...state.annotations]}); }
function restore(s){ const x=JSON.parse(s); state.edits=new Map(x.edits); state.annotations=new Map(x.annotations); }
function checkpoint(){ state.history.push(snapshot()); if(state.history.length>40) state.history.shift(); state.future=[]; state.dirty=true; updateButtons(); }
function undo(){ if(!state.history.length)return; state.future.push(snapshot()); restore(state.history.pop()); render(); updateButtons(); }
function redo(){ if(!state.future.length)return; state.history.push(snapshot()); restore(state.future.pop()); render(); updateButtons(); }
function updateButtons(){ $('#undo').disabled=!state.history.length; $('#redo').disabled=!state.future.length; $('#save').disabled=!state.pdf; }

function setTool(tool){ state.tool=tool; document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool)); if(tool==='pages') showPages(); if(tool==='search') showSearch(); if(tool==='more') showMore(); }
document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
$('#undo').onclick=undo; $('#redo').onclick=redo;
$('#open').onclick=()=>$('#file').click(); $('#open2').onclick=()=>$('#file').click();
$('#file').onchange=async e=>{ if(e.target.files[0]) await loadFile(e.target.files[0]); e.target.value=''; };
$('#prev').onclick=()=>goPage(state.page-1); $('#next').onclick=()=>goPage(state.page+1);
$('#zoomOut').onclick=()=>{state.zoom=Math.max(.6,state.zoom-.1);render()}; $('#zoomIn').onclick=()=>{state.zoom=Math.min(2.5,state.zoom+.1);render()};
$('#fit').onclick=()=>{state.zoom=1;render()}; $('#rotate').onclick=()=>{checkpoint(); const a=state.annotations.get(state.page)||[]; a.push({type:'pageRotate',angle:90}); state.annotations.set(state.page,a); toast('Page rotation queued');};
$('#modalClose').onclick=closeModal;

async function loadFile(file){
  try{ state.bytes=await file.arrayBuffer(); state.pdf=await pdfjsLib.getDocument({data:state.bytes.slice(0)}).promise; state.fileName=file.name.replace(/\.pdf$/i,'')||'document'; state.page=1;state.zoom=1;state.edits.clear();state.annotations.clear();state.history=[];state.future=[];state.dirty=false; $('#empty').hidden=true;$('#pageWrap').hidden=false;$('#bottom').hidden=false; updateButtons(); await render(); toast(`${state.pdf.numPages} page${state.pdf.numPages>1?'s':''} loaded`,'ok'); }
  catch(e){toast('Could not open this PDF: '+e.message,'error');}
}

async function goPage(n){ if(!state.pdf||n<1||n>state.pdf.numPages)return; state.page=n; await render(); }
async function render(){
  if(!state.pdf)return; const token=++state.renderToken; const page=await state.pdf.getPage(state.page); if(token!==state.renderToken)return;
  const base=page.getViewport({scale:1}); const viewerWidth=Math.max(280,$('#viewer').clientWidth-36); const fitScale=Math.min(viewerWidth/base.width,1.45); state.scale=fitScale*state.zoom;
  const vp=page.getViewport({scale:state.scale}); const canvas=$('#canvas'); const ctx=canvas.getContext('2d'); canvas.width=Math.floor(vp.width);canvas.height=Math.floor(vp.height); $('#page').style.width=vp.width+'px';$('#page').style.height=vp.height+'px';
  await page.render({canvasContext:ctx,viewport:vp}).promise; if(token!==state.renderToken)return;
  $('#overlay').innerHTML=''; $('#counter').textContent=`${state.page} / ${state.pdf.numPages}`; $('#zoomLabel').textContent=Math.round(state.zoom*100)+'%';
  const content=await page.getTextContent(); content.items.forEach(item=>addTextNode(item,vp));
  (state.edits.get(state.page)||[]).forEach(addEditNode); (state.annotations.get(state.page)||[]).forEach(addAnnotationNode);
}
function addTextNode(item,vp){
  if(!item.str.trim())return; const tx=pdfjsLib.Util.transform(vp.transform,item.transform); const h=Math.max(8,Math.hypot(tx[2],tx[3])); const node=document.createElement('div'); node.className='text-hit'; node.textContent=item.str; node.style.left=tx[4]+'px';node.style.top=(tx[5]-h)+'px';node.style.width=Math.max(8,item.width*state.scale)+'px';node.style.height=h*1.2+'px';
  node.onclick=(e)=>{e.stopPropagation(); if(state.tool==='select') editExisting(item,node);}; $('#overlay').appendChild(node);
}
function editExisting(item,node){
  node.contentEditable='true'; node.classList.add('editing'); node.focus(); const range=document.createRange();range.selectNodeContents(node);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
  const finish=()=>{node.contentEditable='false';node.classList.remove('editing');if(node.textContent!==item.str){checkpoint();const list=state.edits.get(state.page)||[];list.push({type:'replace',x:item.transform[4],y:item.transform[5],w:item.width,h:item.height||10,size:Math.max(6,Math.hypot(item.transform[2],item.transform[3])),text:node.textContent,old:item.str});state.edits.set(state.page,list);node.classList.add('changed');toast('Text replacement added');}}; node.onblur=finish; node.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();node.blur();}};
}
function canvasPoint(e){const r=$('#page').getBoundingClientRect();return{x:(e.clientX-r.left)/state.scale,y:(e.clientY-r.top)/state.scale};}
$('#page').addEventListener('click',e=>{ if(e.target!==$('#canvas')&&e.target!==$('#overlay'))return; const p=canvasPoint(e); if(state.tool==='text'){checkpoint();const list=state.edits.get(state.page)||[];list.push({type:'addText',x:p.x,y:p.y,text:'New text',size:14,color:'#111827'});state.edits.set(state.page,list);render();setTimeout(()=>{const nodes=[...document.querySelectorAll('.added-text')];nodes.at(-1)?.click()},30);} });

function addEditNode(ed){ if(ed.type==='addText'){const n=document.createElement('div');n.className='added-text';n.textContent=ed.text;n.style.left=ed.x*state.scale+'px';n.style.top=(ed.y-ed.size)*state.scale+'px';n.style.fontSize=ed.size*state.scale+'px';n.contentEditable='true';n.onblur=()=>{ed.text=n.textContent;state.dirty=true};n.onclick=e=>e.stopPropagation();$('#overlay').appendChild(n);} else if(ed.type==='replace'){const n=document.createElement('div');n.className='replacement';n.textContent=ed.text;n.style.left=ed.x*state.scale+'px';n.style.top=(ed.y-ed.size)*state.scale+'px';n.style.fontSize=ed.size*state.scale+'px';$('#overlay').appendChild(n);} }
function addAnnotationNode(a){ if(a.type==='highlight'||a.type==='rect'||a.type==='draw'){const n=document.createElement('div');n.className='annotation '+a.type;n.style.left=a.x*state.scale+'px';n.style.top=a.y*state.scale+'px';n.style.width=a.w*state.scale+'px';n.style.height=a.h*state.scale+'px';if(a.color)n.style.setProperty('--c',a.color);$('#overlay').appendChild(n);} }

let drawing=null;
$('#page').addEventListener('pointerdown',e=>{if(!['draw','highlight','rect'].includes(state.tool))return;if(e.target===document.querySelector('.text-hit'))return;drawing={start:canvasPoint(e),current:canvasPoint(e)};$('#page').setPointerCapture?.(e.pointerId);});
$('#page').addEventListener('pointermove',e=>{if(!drawing)return;drawing.current=canvasPoint(e);const s=drawing.start,c=drawing.current;const x=Math.min(s.x,c.x),y=Math.min(s.y,c.y),w=Math.abs(c.x-s.x),h=Math.abs(c.y-s.y);$('#drawPreview')?.remove();const n=document.createElement('div');n.id='drawPreview';n.className='annotation '+state.tool;n.style.left=x*state.scale+'px';n.style.top=y*state.scale+'px';n.style.width=w*state.scale+'px';n.style.height=h*state.scale+'px';$('#overlay').appendChild(n);});
$('#page').addEventListener('pointerup',()=>{if(!drawing)return;const s=drawing.start,c=drawing.current;const x=Math.min(s.x,c.x),y=Math.min(s.y,c.y),w=Math.abs(c.x-s.x),h=Math.abs(c.y-s.y);$('#drawPreview')?.remove();drawing=null;if(w<3||h<3)return;checkpoint();const list=state.annotations.get(state.page)||[];list.push({type:state.tool,x,y,w,h,color:state.tool==='highlight'?'#facc15':'#2563eb'});state.annotations.set(state.page,list);render();});

function showModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').hidden=false;} function closeModal(){$('#modal').hidden=true;}
async function showPages(){ if(!state.pdf)return toast('Open a PDF first'); showModal('Pages',`<div class="page-actions"><button id="insertPdf" class="primary">Insert PDF</button><button id="addBlank" class="secondary">Add blank page</button><button id="deletePage" class="danger">Delete current</button><button id="extractPage" class="secondary">Export current</button></div><div class="thumb-grid" id="pageGrid">Loading…</div>`);const grid=$('#pageGrid');for(let i=1;i<=state.pdf.numPages;i++){const p=await state.pdf.getPage(i);const vp=p.getViewport({scale:.18});const c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;const item=document.createElement('button');item.className='thumb'+(i===state.page?' selected':'');item.innerHTML=`<span>${i}</span>`;item.prepend(c);item.onclick=()=>{state.page=i;closeModal();render()};grid.appendChild(item);}$('#deletePage').onclick=deleteCurrentPage;$('#extractPage').onclick=exportCurrentPage;$('#addBlank').onclick=addBlankPage;$('#insertPdf').onclick=()=>insertPdfPrompt();}
async function rebuildPdf(mutator){const doc=await PDFDocument.load(state.bytes);await mutator(doc);state.bytes=await doc.save();state.pdf=await pdfjsLib.getDocument({data:state.bytes.slice(0)}).promise;state.edits.clear();state.annotations.clear();state.history=[];state.future=[];state.dirty=true;updateButtons();await render();}
async function deleteCurrentPage(){if(state.pdf.numPages<=1)return toast('A PDF must have at least one page','error');const n=state.page;await rebuildPdf(doc=>{doc.removePage(n-1);});state.page=Math.min(n,state.pdf.numPages);closeModal();toast('Page deleted','ok');}
async function addBlankPage(){const size=state.pdf? (await state.pdf.getPage(state.page)).getViewport({scale:1}):{width:595,height:842};await rebuildPdf(doc=>doc.addPage([size.width,size.height]));closeModal();toast('Blank page added','ok');}
async function insertPdfPrompt(){const inp=document.createElement('input');inp.type='file';inp.accept='application/pdf';inp.onchange=async()=>{if(!inp.files[0])return;const other=await PDFDocument.load(await inp.files[0].arrayBuffer());await rebuildPdf(async doc=>{const pages=await doc.copyPages(other,other.getPageIndices());pages.forEach(p=>doc.addPage(p));});closeModal();toast('PDF inserted','ok')};inp.click();}
async function exportCurrentPage(){const source=await PDFDocument.load(state.bytes);const out=await PDFDocument.create();const [p]=await out.copyPages(source,[state.page-1]);out.addPage(p);await saveBytes(await out.save(),`${state.fileName}-page-${state.page}.pdf`);closeModal();}
function showSearch(){if(!state.pdf)return toast('Open a PDF first');showModal('Search PDF',`<input id="searchInput" class="search" placeholder="Search text…"><div id="searchResults" class="results"></div>`);$('#searchInput').oninput=async e=>{const q=e.target.value.trim().toLowerCase();const r=$('#searchResults');r.innerHTML='';if(!q)return;for(let i=1;i<=state.pdf.numPages;i++){const p=await state.pdf.getPage(i);const c=await p.getTextContent();const text=c.items.map(x=>x.str).join(' ');if(text.toLowerCase().includes(q)){const b=document.createElement('button');b.textContent=`Page ${i} · ${text.slice(Math.max(0,text.toLowerCase().indexOf(q)-40),text.toLowerCase().indexOf(q)+q.length+80)}`;b.onclick=()=>{state.page=i;closeModal();render()};r.appendChild(b);}}if(!r.children.length)r.textContent='No matches';};}
function showMore(){showModal('More tools',`<div class="more-grid"><button id="compress">Optimize PDF</button><button id="metadata">Document info</button><button id="resetEdits">Discard unsaved edits</button><button id="about">About</button></div>`);$('#resetEdits').onclick=()=>{state.edits.clear();state.annotations.clear();state.history=[];state.future=[];closeModal();render();toast('Unsaved edits discarded')};$('#metadata').onclick=async()=>{const d=await PDFDocument.load(state.bytes);showModal('Document info',`<div class="info"><p>Pages: ${d.getPageCount()}</p><p>Title: ${d.getTitle()||'—'}</p><p>Author: ${d.getAuthor()||'—'}</p><p>Subject: ${d.getSubject()||'—'}</p></div>`)};$('#compress').onclick=()=>toast('The PDF engine preserves source objects; a lossless optimize/export is used instead of destructive image recompression.');$('#about').onclick=()=>showModal('About','<div class="info"><b>Free PDF Editor 2.0</b><p>Offline-first PDF editing with PDF.js + pdf-lib.</p><p>Your document stays on the device unless you choose to share it.</p></div>');}

$('#save').onclick=exportPdf;
async function exportPdf(){if(!state.bytes)return;$('#save').disabled=true;$('#save').textContent='Saving…';try{const doc=await PDFDocument.load(state.bytes);const font=await doc.embedFont(StandardFonts.Helvetica);for(const [pageNo,items] of state.edits){const p=doc.getPages()[pageNo-1];for(const e of items){if(e.type==='replace'){p.drawRectangle({x:e.x,y:e.y-e.size*.28,width:Math.max(e.w,10),height:e.size*1.15,color:rgb(1,1,1)});p.drawText(e.text,{x:e.x,y:e.y,size:e.size,font,color:rgb(.07,.09,.12)});}else if(e.type==='addText'){p.drawText(e.text,{x:e.x,y:e.y-e.size,size:e.size,font,color:rgb(.07,.09,.12)});}}}
for(const [pageNo,items] of state.annotations){const p=doc.getPages()[pageNo-1];for(const a of items){if(a.type==='highlight')p.drawRectangle({x:a.x,y:p.getHeight()-a.y-a.h,width:a.w,height:a.h,color:rgb(1,.85,.1),opacity:.32});else if(a.type==='rect')p.drawRectangle({x:a.x,y:p.getHeight()-a.y-a.h,width:a.w,height:a.h,borderColor:rgb(.15,.39,.9),borderWidth:2});else if(a.type==='draw')p.drawLine({start:{x:a.x,y:p.getHeight()-a.y},end:{x:a.x+a.w,y:p.getHeight()-a.y-a.h},thickness:2,color:rgb(.15,.39,.9)});}}
const out=await doc.save();await saveBytes(out,`${state.fileName}-edited.pdf`);state.bytes=out;state.pdf=await pdfjsLib.getDocument({data:out.slice(0)}).promise;state.edits.clear();state.annotations.clear();state.history=[];state.future=[];state.dirty=false;await render();toast('PDF saved successfully','ok');}catch(e){console.error(e);toast('Save failed: '+e.message,'error')}finally{$('#save').disabled=false;$('#save').textContent='Save & Share';}}

async function saveBytes(bytes,name){if(native){try{const base64=uint8ToBase64(bytes);const path=`PDFEditor/${Date.now()}-${name.replace(/[^a-z0-9._-]/gi,'_')}`;const r=await Filesystem.writeFile({path,data:base64,directory:Directory.Documents,recursive:true});await Share.share({title:name,text:'Edited PDF',url:r.uri,dialogTitle:'Share PDF'});return;}catch(e){console.warn('Native save/share fallback',e);}}const blob=new Blob([bytes],{type:'application/pdf'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function uint8ToBase64(bytes){let s='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)s+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(s);}

async function initAds(){if(!native)return;try{await AdMob.initialize({initializeForTesting:true});await AdMob.prepareRewardVideoAd({adId:TEST_REWARDED,isTesting:true});state.adReady=true;}catch(e){console.warn('Ads disabled',e);}}
initAds();
window.addEventListener('resize',()=>{if(state.pdf)render()});
updateButtons();
