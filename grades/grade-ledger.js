/* Grade Ledger — weighted grade calculator. Needs the markup in index.html (root #grade-ledger). */
(function(){
const LETTERS=[["A+",98.5,97],["A",94.5,93],["A-",91,90],["B+",88,87],["B",84.5,83],["B-",81,80],["C+",78,77],["C",74.5,73],["C-",71,70],["D+",68,67],["D",64.5,63],["D-",61,60],["F",50,0]];
const letterVal=l=>{const f=LETTERS.find(x=>x[0]===l);return f?f[1]:null};
const toLetter=p=>{for(const [l,,min] of LETTERS) if(p>=min) return l;return "F"};
const root=document.getElementById("grade-ledger");
const $=id=>document.getElementById("gl-"+id);

let mode="percent";
let rows=[];
const example=()=>[
  {name:"Homework",g:"92",l:"A-",e:"46",p:"50",w:"20"},
  {name:"Midterm",g:"81",l:"B-",e:"81",p:"100",w:"30"},
  {name:"Project",g:"88",l:"B+",e:"44",p:"50",w:"20"},
  {name:"",g:"",l:"",e:"",p:"",w:""}
];
rows=example();

function header(){
  const h=mode==="points"
    ?["Assignment","Points earned","Points possible",""]
    :["Assignment",mode==="letter"?"Grade (letter)":"Grade (%)","Weight",""];
  $("thead-row").innerHTML=h.map(t=>`<th>${t}</th>`).join("");
  $("mode-note").textContent=mode==="points"?"Rows are weighted by points possible.":"Leave weights blank to weight rows equally.";
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function renderRows(){
  header();
  $("rows").innerHTML=rows.map((r,i)=>{
    const name=`<td><input id="gl-n${i}" data-i="${i}" data-k="name" type="text" value="${esc(r.name)}" placeholder="Assignment ${i+1}" aria-label="Assignment ${i+1} name"></td>`;
    let mid;
    if(mode==="points") mid=`<td><input id="gl-e${i}" data-i="${i}" data-k="e" type="number" step="any" value="${esc(r.e)}" aria-label="Points earned"></td><td><input id="gl-p${i}" data-i="${i}" data-k="p" type="number" step="any" value="${esc(r.p)}" aria-label="Points possible"></td>`;
    else if(mode==="letter") mid=`<td><select id="gl-l${i}" data-i="${i}" data-k="l" aria-label="Letter grade"><option value="">--</option>${LETTERS.map(([l])=>`<option${r.l===l?" selected":""}>${l}</option>`).join("")}</select></td><td><input id="gl-w${i}" data-i="${i}" data-k="w" type="number" step="any" value="${esc(r.w)}" aria-label="Weight"></td>`;
    else mid=`<td><input id="gl-g${i}" data-i="${i}" data-k="g" type="number" step="any" value="${esc(r.g)}" aria-label="Grade percent"></td><td><input id="gl-w${i}" data-i="${i}" data-k="w" type="number" step="any" value="${esc(r.w)}" aria-label="Weight"></td>`;
    return `<tr>${name}${mid}<td><button type="button" class="x" data-del="${i}" aria-label="Remove row">×</button></td></tr>`;
  }).join("");
  totals();
}
function totals(c){
  c=c||compute();
  const pend=c.sumPend>0?` <span class="note">+ ${trim(c.sumPend)} to come</span>`:"";
  const tw=mode==="points"
    ?`<td>Total</td><td>${fmt(c.sumE)}</td><td>${trim(c.sumP)}${pend}</td><td></td>`
    :`<td>Total</td><td></td><td>${trim(c.anyW?c.sumW:0)}${pend}</td><td></td>`;
  $("totals").innerHTML=tw;
}
const num=v=>{if(v===""||v==null)return null;const n=Number(v);return isFinite(n)?n:null};
function dec(){return Number($("decimals").value)}
function fmt(n,d){if(n==null||!isFinite(n))return "—";d=d??dec();return Number(n.toFixed(d)).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}
function trim(n){return n==null||!isFinite(n)?"—":String(Number(n.toFixed(2)))}

function compute(){
  const items=[],pending=[];let sumE=0,sumP=0;
  rows.forEach((r,i)=>{
    const label=r.name.trim()||`Assignment ${i+1}`;
    if(mode==="points"){
      const e=num(r.e),p=num(r.p);
      if(p!=null&&p>0){
        if(e!=null){items.push({g:e/p*100,w:p});sumE+=e;sumP+=p}
        else pending.push({name:label,w:p});
      }
    }else{
      const g=mode==="letter"?(r.l?letterVal(r.l):null):num(r.g);
      const w=num(r.w);
      if(g!=null) items.push({g,w});
      else if(w!=null&&w>0) pending.push({name:label,w});
    }
  });
  const anyW=mode==="points"||items.some(x=>x.w!=null&&x.w>0)||pending.length>0;
  items.forEach(x=>{if(!anyW)x.w=1;else if(x.w==null)x.w=0});
  const sumW=items.reduce((a,x)=>a+x.w,0);
  const sumWG=items.reduce((a,x)=>a+x.w*x.g,0);
  const sumPend=pending.reduce((a,x)=>a+x.w,0);
  const avg=sumW>0?sumWG/sumW:null;
  return {items,pending,sumW,sumWG,sumPend,avg,anyW,sumE,sumP};
}

let last=null;
function calculate(){
  const c=compute();
  totals(c);
  const T=num($("target").value);

  if(c.avg==null){
    $("r-avg").textContent="—";
    $("r-work").textContent=c.pending.length?"No scored items yet.":"Enter at least one grade.";
  }else{
    $("r-avg").innerHTML=`${fmt(c.avg)}%<span class="grade-chip">${toLetter(c.avg)}</span>`;
    const terms=c.items.map(x=>`${trim(x.w)}×${trim(x.g)}`).join(" + ");
    $("r-work").textContent=`(${terms}) ÷ ${trim(c.sumW)} = ${fmt(c.avg)}`;
  }

  /* Remaining weight: pending rows, plus any unassigned share of 100% when weights are percentages */
  const buckets=c.pending.map(p=>({...p,kind:"todo"}));
  let unassigned=0;
  if(mode!=="points"&&c.anyW){
    unassigned=Math.max(0,100-c.sumW-c.sumPend);
    if(unassigned>1e-9) buckets.push({name:"Unassigned",w:unassigned,kind:"free"});
  }
  const Wrem=buckets.reduce((a,b)=>a+b.w,0);
  const Wtot=c.sumW+Wrem;
  const unit=mode==="points"?" pts":"%";

  let need=null,needNote="";
  const rem=$("remain");
  if(!c.anyW||Wtot<=0){
    rem.hidden=true;
    needNote=c.anyW?"":"Add weights to see what's needed.";
  }else{
    rem.hidden=false;
    if(Wrem<=1e-9){
      needNote="Every weighted item already has a score.";
      $("rem-sum").textContent="Nothing left — the grade above is final.";
    }else{
      $("rem-sum").textContent=`${trim(Wrem)}${unit} of ${trim(Wtot)}${unit} still to come`;
      if(T!=null){
        need=(T*Wtot-c.sumWG)/Wrem;
        needNote=`average across the remaining ${trim(Wrem)}${unit} to reach ${trim(T)}%`+(need>100?" — above 100%, out of reach":need<=0?" — target already locked in":"");
      }else needNote="Set a target average above.";
    }
    /* bar + legend */
    const seg=(w,cls,title)=>`<span class="${cls}" style="flex:${w} 0 0" title="${esc(title)}"></span>`;
    let bar=c.sumW>0?seg(c.sumW,"done",`Scored ${trim(c.sumW)}${unit}`):"";
    buckets.forEach(b=>bar+=seg(b.w,b.kind,`${b.name} ${trim(b.w)}${unit}`));
    $("bar").innerHTML=bar;
    const needTxt=need==null?"":need>100?`<span class="warn">${fmt(need)}%</span>`:need<=0?"done":`${fmt(need)}%`;
    const li=(cls,name,w,nd,style)=>`<li><span class="sw ${cls}" style="${style||""}"></span><span class="nm">${esc(name)}</span><span class="wt">${trim(w)}${unit}</span><span class="nd">${nd}</span></li>`;
    let lg=c.sumW>0?li("","Scored so far",c.sumW,c.avg!=null?fmt(c.avg)+"%":"","background:var(--ink)"):"";
    buckets.forEach((b,i)=>{
      const bg=b.kind==="free"?"background:repeating-linear-gradient(45deg,var(--rule) 0 3px,transparent 3px 6px);border:1px solid var(--rule)"
        :(c.sumW>0?i+1:i)%2===1?"background:color-mix(in srgb,var(--pen) 65%,var(--sheet))":"background:var(--pen)";
      lg+=li("",b.name,b.w,needTxt,bg);
    });
    $("legend").innerHTML=lg;
    /* range + projection */
    const mn=c.sumWG/Wtot, mx=(c.sumWG+100*Wrem)/Wtot;
    $("rng-min").textContent=`${fmt(mn)}% ${toLetter(mn)}`;
    $("rng-max").textContent=`${fmt(mx)}% ${toLetter(mx)}`;
    const A=num($("assume").value);
    const pr=A==null?null:(c.sumWG+A*Wrem)/Wtot;
    $("proj").textContent=pr==null?"—":`${fmt(pr)}% (${toLetter(pr)})`;
  }
  $("r-need").textContent=need==null?"—":fmt(need)+"%";
  $("r-need-note").textContent=needNote;
  $("r-need-note").className="note"+(need!=null&&need>100?" warn":"");
  last=c.avg==null?null:{avg:c.avg,letter:toLetter(c.avg),need,target:T,pending:c.pending.length};
}

function snapshot(){
  return {mode,rows:rows.map(r=>({...r})),target:$("target").value,decimals:$("decimals").value,assume:$("assume").value};
}
function restore(s){
  mode=s.mode||"percent";rows=(s.rows&&s.rows.length?s.rows:[{name:"",g:"",l:"",e:"",p:"",w:""}]).map(r=>({name:"",g:"",l:"",e:"",p:"",w:"",...r}));
  $("target").value=s.target??"";$("decimals").value=String(s.decimals??"2");
  if(s.assume!=null&&s.assume!=="") $("assume").value=s.assume;
  root.querySelectorAll(".seg button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.mode===mode)));
  renderRows();calculate();
}

$("rows").addEventListener("input",e=>{const t=e.target;if(t.dataset.i==null)return;rows[+t.dataset.i][t.dataset.k]=t.value;calculate()});
$("rows").addEventListener("change",e=>{const t=e.target;if(t.dataset.i==null)return;rows[+t.dataset.i][t.dataset.k]=t.value;calculate()});
$("target").addEventListener("input",calculate);
$("assume").addEventListener("input",calculate);
$("rows").addEventListener("click",e=>{const i=e.target.dataset.del;if(i==null)return;rows.splice(+i,1);if(!rows.length)rows.push({name:"",g:"",l:"",e:"",p:"",w:""});renderRows()});
$("add-row").onclick=()=>{rows.push({name:"",g:"",l:"",e:"",p:"",w:""});renderRows();$("n"+(rows.length-1)).focus()};
root.querySelectorAll(".seg button").forEach(b=>b.onclick=()=>{mode=b.dataset.mode;root.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));renderRows();calculate()});
$("calc").onclick=calculate;
$("decimals").onchange=calculate;
$("reset").onclick=()=>{rows=Array.from({length:4},()=>({name:"",g:"",l:"",e:"",p:"",w:""}));$("target").value="";renderRows();calculate();$("save-name").value=""};

/* ---- final exam ---- */
function finalCalc(){
  const cur=num($("f-cur").value),tgt=num($("f-tgt").value),w=num($("f-w").value);
  if(cur==null||tgt==null||w==null||w<=0||w>100){$("f-out").textContent="—";$("f-work").textContent="Enter all three values; weight must be between 0 and 100.";return}
  const need=(tgt-cur*(1-w/100))/(w/100);
  $("f-out").textContent=fmt(need)+"%";
  $("f-work").textContent=`(${tgt} − ${cur} × (100% − ${w}%)) ÷ ${w}% = ${fmt(need)}`;
}
$("f-calc").onclick=finalCalc;
$("f-reset").onclick=()=>{["f-cur","f-tgt","f-w"].forEach(id=>$(id).value="");$("f-out").textContent="—";$("f-work").textContent=""};

/* ---- saving ----
   Storage goes through an adapter so a host (plugin, extension, Drive, your own API)
   can replace it. Set window.GradeLedgerStorage BEFORE this script loads:
     {
       label:  "Saved to your Google Drive",            // shown beside "Saved results"
       list:   async () => [record, ...],                // newest first
       add:    async (record) => "new-id",               // returns the id it stored under
       remove: async (id) => {}
     }
   A record is { name, savedAt, avg, letter, need, target, pending, state }.
   Without an adapter, results are kept in this browser's localStorage. */
let saved=[];let confirmDel=null;
const LS="grade-ledger-saved";
const localAdapter={
  label:"Saved in this browser",
  async list(){let l=[];try{l=JSON.parse(localStorage.getItem(LS)||"[]")}catch(e){}return Array.isArray(l)?l.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0)):[]},
  async add(rec){const l=await this.list();const id="l"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);l.unshift({id,...rec});localStorage.setItem(LS,JSON.stringify(l));return id},
  async remove(id){const l=(await this.list()).filter(x=>x.id!==id);localStorage.setItem(LS,JSON.stringify(l))}
};
const store=window.GradeLedgerStorage||localAdapter;

function renderSaved(){
  const ul=$("saved");
  if(!saved.length){ul.innerHTML=`<li class="empty" style="display:block">No saved results yet. Calculate a grade above, give it a name and press Save result.</li>`;return}
  ul.innerHTML=saved.map(s=>{
    const d=new Date(s.savedAt);
    const modeName={percent:"Percentage",letter:"Letters",points:"Points"}[s.state.mode]||"";
    const conf=confirmDel===s.id;
    return `<li><div><div class="t">${esc(s.name)}</div><div class="m">${fmt(s.avg)}% (${esc(s.letter)}) · ${modeName} · ${s.state.rows.filter(r=>r.g||r.l||r.e).length} items${s.pending?` · ${s.pending} to come`:""}${s.need!=null?` · need ${fmt(s.need)}% for ${esc(s.target)}%`:""} · ${d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}</div></div>
      <div class="acts">${conf?`<span class="note">Delete?</span><button type="button" class="btn danger" data-yes="${esc(s.id)}">Delete</button><button type="button" class="btn" data-no="1">Keep</button>`:`<button type="button" class="btn" data-open="${esc(s.id)}">Open</button><button type="button" class="btn" data-del-s="${esc(s.id)}">Delete</button>`}</div></li>`;
  }).join("");
}
$("saved").addEventListener("click",async e=>{
  const t=e.target;
  if(t.dataset.open){const s=saved.find(x=>x.id===t.dataset.open);if(s){restore(s.state);$("save-name").value=s.name;root.scrollIntoView({behavior:"smooth"});flash(`Opened “${s.name}”.`)}}
  else if(t.dataset.delS){confirmDel=t.dataset.delS;renderSaved()}
  else if(t.dataset.no){confirmDel=null;renderSaved()}
  else if(t.dataset.yes){const id=t.dataset.yes;confirmDel=null;await removeSaved(id)}
});
function flash(msg,bad){const el=$("toast");el.textContent=msg;el.className="toast"+(bad?" warn":"");clearTimeout(flash.t);flash.t=setTimeout(()=>el.textContent="",4000)}

async function refresh(){
  try{saved=await store.list();$("store-note").textContent=store.label||""}
  catch(err){$("store-note").textContent="Couldn't load saved results";saved=[]}
  renderSaved();
}
async function save(){
  calculate();
  if(!last){flash("Enter at least one grade before saving.",true);return}
  const name=$("save-name").value.trim()||`Result ${new Date().toLocaleDateString()}`;
  const rec={name,savedAt:Date.now(),avg:last.avg,letter:last.letter,need:last.need,target:last.target,pending:last.pending,state:snapshot()};
  $("save").disabled=true;
  try{await store.add(rec);await refresh();flash(`Saved “${name}”.`)}
  catch(err){flash("Couldn't save: "+(err&&err.message||"try again."),true)}
  finally{$("save").disabled=false}
}
async function removeSaved(id){
  try{await store.remove(id);await refresh();flash("Deleted.")}
  catch(err){flash("Couldn't delete: "+(err&&err.message||"try again."),true);renderSaved()}
}
$("save").onclick=save;

/* Export / import as JSON (an array of records) */
$("export").onclick=()=>{
  const data=JSON.stringify(saved.map(({id,...r})=>r),null,2);
  const url=URL.createObjectURL(new Blob([data],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download="grade-ledger-results.json";
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$("import").onclick=()=>$("import-file").click();
$("import-file").onchange=async e=>{
  const f=e.target.files[0];e.target.value="";if(!f)return;
  try{
    const list=JSON.parse(await f.text());
    if(!Array.isArray(list))throw new Error("expected a list of saved results");
    let n=0;
    for(const r of list){if(r&&r.state&&Array.isArray(r.state.rows)){const {id,...rec}=r;await store.add(rec);n++}}
    await refresh();flash(`Imported ${n} result${n===1?"":"s"}.`);
  }catch(err){flash("Couldn't import that file: "+(err.message||"not valid JSON"),true)}
};

window.GradeLedger={refresh,calculate,snapshot,restore};
renderRows();calculate();finalCalc();refresh();
})();
