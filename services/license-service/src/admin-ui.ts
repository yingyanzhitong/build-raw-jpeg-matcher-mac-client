const adminHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>摄影修图师助手 · 授权管理</title>
  <link rel="stylesheet" href="/admin/app.css">
  <script type="module" src="/admin/app.js"></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">L</span>
      <div>
        <strong>摄影修图师助手</strong>
        <span>授权控制台</span>
      </div>
    </div>
    <div class="topbar-actions">
      <div class="environment"><i></i> <span id="admin-username">管理员</span></div>
      <button class="quiet" id="logout" type="button">退出登录</button>
    </div>
  </header>

  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">LICENSE OPERATIONS</p>
        <h1>设备授权</h1>
        <p>生成销售 token，跟踪单设备绑定，并处理撤销与换机重置。</p>
      </div>
      <div class="hero-actions"><button class="secondary" id="open-api-keys">API Key</button><button class="primary" id="open-generate">生成 token</button></div>
    </section>

    <section class="metrics" aria-label="授权统计">
      <article><span>授权总数</span><strong id="metric-total">—</strong></article>
      <article><span>已绑定</span><strong id="metric-bound">—</strong></article>
      <article><span>待激活</span><strong id="metric-unbound">—</strong></article>
      <article><span>已撤销</span><strong id="metric-revoked">—</strong></article>
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>许可证列表</h2>
          <p>数据库仅保存 token HMAC 摘要与末四位。</p>
        </div>
        <div class="filters">
          <label class="search">
            <span class="sr-only">搜索</span>
            <input id="search" placeholder="搜索备注、末四位或许可证 ID">
          </label>
          <select id="status-filter" aria-label="状态筛选">
            <option value="">全部状态</option>
            <option value="active">有效</option>
            <option value="revoked">已撤销</option>
            <option value="bound">已绑定</option>
            <option value="unbound">待激活</option>
          </select>
        </div>
      </header>
      <div class="table-wrap">
        <table>
          <thead><tr><th>许可证</th><th>状态</th><th>设备</th><th>最近活动</th><th><span class="sr-only">操作</span></th></tr></thead>
          <tbody id="license-rows"></tbody>
        </table>
        <div class="empty" id="empty" hidden>没有符合条件的许可证。</div>
      </div>
      <footer class="panel-foot">
        <span id="result-count">正在读取…</span>
        <div><button class="quiet" id="previous" disabled>上一页</button><button class="quiet" id="next" disabled>下一页</button></div>
      </footer>
    </section>
  </main>

  <dialog id="generate-dialog">
    <form method="dialog" class="dialog-card" id="generate-form">
      <header><div><p class="eyebrow">NEW LICENSES</p><h2>批量生成 token</h2></div><button value="cancel" class="icon-button" aria-label="关闭">×</button></header>
      <label>数量<input id="generate-count" type="number" min="1" max="100" value="10" required></label>
      <label>备注<input id="generate-note" maxlength="120" placeholder="例如：2026 年 7 月摄影班"></label>
      <p class="notice">明文 token 只在这次响应中出现。关闭前请复制或导出 CSV。</p>
      <footer><button value="cancel" class="secondary">取消</button><button value="default" class="primary" id="generate-submit">生成</button></footer>
    </form>
  </dialog>

  <dialog id="tokens-dialog">
    <section class="dialog-card token-result">
      <header><div><p class="eyebrow">ONE-TIME RESULT</p><h2>请立即保存 token</h2></div></header>
      <p class="notice warning">关闭后无法再次查看这些明文 token。</p>
      <textarea id="generated-tokens" readonly aria-label="新生成的 token"></textarea>
      <footer><button class="secondary" id="export-csv">导出 CSV</button><button class="primary" id="copy-tokens">复制全部</button><button class="quiet" id="close-tokens">完成</button></footer>
    </section>
  </dialog>

  <dialog id="api-keys-dialog">
    <section class="dialog-card api-key-dialog">
      <header><div><p class="eyebrow">ISSUANCE API</p><h2>API Key 配置</h2></div><button class="icon-button" id="close-api-keys" aria-label="关闭">×</button></header>
      <form id="api-key-form"><label>名称<input id="api-key-name" maxlength="80" placeholder="例如：商城自动发货" required></label><button class="primary" id="api-key-submit" type="submit">创建 API Key</button></form>
      <p class="notice">Key 仅用于服务端调用，下发 token 的接口为 <code>POST /api/v1/tokens</code>。创建后只显示一次，请立即保存。</p>
      <div class="api-key-list" id="api-key-list"></div>
    </section>
  </dialog>

  <dialog id="api-key-result-dialog">
    <section class="dialog-card token-result">
      <header><div><p class="eyebrow">ONE-TIME SECRET</p><h2>请立即保存 API Key</h2></div></header>
      <p class="notice warning">关闭后无法再次查看该 API Key。请求时使用 <code>Authorization: Bearer …</code>。</p>
      <textarea id="generated-api-key" readonly aria-label="新 API Key"></textarea>
      <footer><button class="primary" id="copy-api-key">复制 API Key</button><button class="quiet" id="close-api-key-result">完成</button></footer>
    </section>
  </dialog>

  <dialog id="confirm-dialog">
    <form method="dialog" class="dialog-card" id="confirm-form">
      <header><div><p class="eyebrow" id="confirm-eyebrow">CONFIRM</p><h2 id="confirm-title">确认操作</h2></div><button value="cancel" class="icon-button" aria-label="关闭">×</button></header>
      <p id="confirm-message"></p>
      <footer><button value="cancel" class="secondary">取消</button><button value="default" class="danger" id="confirm-submit">确认</button></footer>
    </form>
  </dialog>

  <dialog id="events-dialog">
    <section class="dialog-card">
      <header><div><p class="eyebrow">AUDIT TRAIL</p><h2 id="events-title">激活记录</h2></div><button class="icon-button" id="close-events" aria-label="关闭">×</button></header>
      <div class="event-list" id="event-list"></div>
    </section>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>`;

const adminCss = String.raw`:root{
  color:#18202a;background:#eef1f4;font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-synthesis:none;--ink:#18202a;--muted:#68717c;--line:#d9dfe5;--paper:#fff;--blue:#1769c2;--red:#b42318
}
*{box-sizing:border-box}body{margin:0;min-width:900px;background:
  linear-gradient(rgba(45,57,70,.035) 1px,transparent 1px),
  linear-gradient(90deg,rgba(45,57,70,.035) 1px,transparent 1px),#eef1f4;background-size:32px 32px}
button,input,select,textarea{font:inherit}.topbar{height:62px;display:flex;align-items:center;justify-content:space-between;padding:0 34px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.9);backdrop-filter:blur(16px)}
.brand{display:flex;align-items:center;gap:11px}.brand-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:9px;background:#18212b;color:#8bc5ff;font:700 15px/1 ui-monospace,monospace}.brand div{display:grid}.brand strong{font-size:13px}.brand div span{font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}.topbar-actions{display:flex;align-items:center;gap:12px}.topbar-actions .quiet{height:31px}.environment{font:600 11px/1 ui-monospace,monospace;color:var(--muted)}.environment i{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#1f9d55;box-shadow:0 0 0 3px rgba(31,157,85,.12)}
main{width:min(1240px,calc(100% - 64px));margin:48px auto 72px}.hero{display:flex;align-items:flex-end;justify-content:space-between}.hero-actions{display:flex;gap:8px}.eyebrow{margin:0 0 8px;color:#4676a7;font:700 10px/1 ui-monospace,monospace;letter-spacing:.13em}.hero h1{margin:0;font-size:34px;line-height:1.1;letter-spacing:-.035em}.hero p:last-child{margin:10px 0 0;color:var(--muted)}button{border:0;border-radius:7px;cursor:pointer;font-weight:650;transition:background .15s,border-color .15s,transform .15s}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #6aa8e8;outline-offset:2px}.primary,.secondary,.danger,.quiet{height:37px;padding:0 14px}.primary{color:#fff;background:var(--blue);box-shadow:0 1px 2px rgba(12,55,101,.18)}.primary:hover{background:#105cac}.secondary{color:var(--ink);border:1px solid var(--line);background:var(--paper)}.quiet{color:#4c5662;border:1px solid var(--line);background:#f7f8fa}.danger{color:#fff;background:var(--red)}button:disabled{cursor:not-allowed;opacity:.45}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0 16px}.metrics article{display:grid;gap:8px;padding:18px 20px;border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(28,39,51,.03)}.metrics span{color:var(--muted);font-size:11px}.metrics strong{font:650 25px/1 ui-monospace,monospace;letter-spacing:-.04em}
.panel{overflow:hidden;border:1px solid var(--line);border-radius:10px;background:var(--paper);box-shadow:0 10px 35px rgba(35,45,56,.06)}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:20px 22px;border-bottom:1px solid var(--line)}.panel h2{margin:0;font-size:15px}.panel-head p{margin:3px 0 0;color:var(--muted);font-size:11px}.filters{display:flex;gap:8px}.filters input{width:280px}.filters input,.filters select,.dialog-card input{height:36px;border:1px solid var(--line);border-radius:6px;background:#fafbfc;padding:0 11px;color:var(--ink)}.filters select{min-width:125px}.table-wrap{min-height:350px}table{width:100%;border-collapse:collapse}th{height:39px;padding:0 18px;background:#f7f8fa;color:#717b86;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.07em}td{height:65px;padding:10px 18px;border-top:1px solid #e7ebef;vertical-align:middle}.license-id{display:grid;gap:3px}.license-id strong{font:650 12px/1.2 ui-monospace,monospace}.license-id span,.device span{color:var(--muted);font-size:11px}.device{display:grid;gap:3px}.device code{font:600 11px/1.2 ui-monospace,monospace}.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid;border-radius:999px;font-size:10px;font-weight:700}.pill:before{width:6px;height:6px;border-radius:50%;background:currentColor;content:""}.pill.active{color:#26734d;border-color:#b9dbc9;background:#f0faf4}.pill.unbound{color:#4f667c;border-color:#cfdae4;background:#f5f8fa}.pill.revoked{color:#a33b32;border-color:#e8c7c2;background:#fff5f3}.row-actions{display:flex;justify-content:flex-end;gap:6px}.row-actions button{height:30px;padding:0 9px;border:1px solid var(--line);background:#fff;color:#4e5965;font-size:11px}.row-actions .revoke{color:var(--red)}.empty{padding:86px;text-align:center;color:var(--muted)}.panel-foot{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}.panel-foot div{display:flex;gap:7px}
dialog{width:min(520px,calc(100% - 32px));padding:0;border:0;border-radius:11px;background:transparent;box-shadow:0 30px 90px rgba(14,22,32,.28)}dialog::backdrop{background:rgba(19,28,38,.48);backdrop-filter:blur(3px)}.dialog-card{display:grid;gap:18px;margin:0;padding:24px;border:1px solid rgba(255,255,255,.5);border-radius:11px;background:#fff}.dialog-card header{display:flex;align-items:start;justify-content:space-between}.dialog-card h2{margin:0;font-size:20px;letter-spacing:-.02em}.dialog-card label{display:grid;gap:7px;font-size:11px;font-weight:700}.dialog-card input{width:100%}.dialog-card footer{display:flex;justify-content:flex-end;gap:8px}.icon-button{width:30px;height:30px;background:#f2f4f6;color:#68717c;font-size:19px}.notice{margin:0;padding:10px 12px;border:1px solid #dbe3ea;border-radius:6px;background:#f6f8fa;color:#5d6874;font-size:11px}.notice.warning{border-color:#ead8ad;background:#fff9e9;color:#765b13}.token-result textarea{height:270px;resize:none;border:1px solid var(--line);border-radius:7px;padding:12px;background:#f7f8fa;font:12px/1.8 ui-monospace,monospace}.api-key-list{display:grid;max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:7px}.api-key-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:12px;border-top:1px solid #e7ebef}.api-key-row:first-child{border-top:0}.api-key-row strong{display:block;font-size:12px}.api-key-row span{display:block;margin-top:3px;color:var(--muted);font:10px/1.45 ui-monospace,monospace}.api-key-row button{height:30px;padding:0 9px;border:1px solid var(--line);background:#fff;color:var(--red);font-size:11px}.api-key-row .revoked-key{color:#a33b32}.api-key-empty{padding:32px;text-align:center;color:var(--muted);font-size:11px}.event-list{display:grid;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:7px}.event-row{display:grid;grid-template-columns:110px 1fr auto;gap:12px;padding:11px 12px;border-top:1px solid #e7ebef}.event-row:first-child{border-top:0}.event-row strong{font-size:11px}.event-row span{color:var(--muted);font:10px/1.45 ui-monospace,monospace}.event-empty{padding:42px;text-align:center;color:var(--muted);font-size:11px}.toast{position:fixed;right:24px;bottom:24px;max-width:380px;padding:11px 14px;border:1px solid #283643;border-radius:7px;background:#18212b;color:#fff;box-shadow:0 12px 32px rgba(14,22,32,.2);font-size:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}`;

const adminJs = String.raw`const state={offset:0,limit:25,total:0,tokens:[],apiKeys:[],action:null};
const $=(selector)=>document.querySelector(selector);
const rows=$("#license-rows"),empty=$("#empty"),toast=$("#toast");
const formatTime=(value)=>value?new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value*1000)):"—";
function notify(message){toast.textContent=message;toast.hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>toast.hidden=true,2600)}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(response.status===401){location.replace("/admin/login");throw new Error("登录已失效")}if(!response.ok)throw new Error(body.error?.message||"请求失败");return body}
function cellText(cell,text,className){const node=document.createElement("span");node.textContent=text;if(className)node.className=className;cell.append(node);return node}
function renderRow(license){
  const tr=document.createElement("tr");
  const identity=tr.insertCell();identity.className="license-id";const strong=document.createElement("strong");strong.textContent=license.id;identity.append(strong);
  cellText(identity,(license.note||"无备注")+" · •••• "+license.tokenLast4);
  const status=tr.insertCell();const pill=document.createElement("span");
  const stateName=license.status==="revoked"?"revoked":license.deviceSuffix?"active":"unbound";
  pill.className="pill "+stateName;pill.textContent=stateName==="revoked"?"已撤销":stateName==="active"?"已绑定":"待激活";status.append(pill);
  const device=tr.insertCell();device.className="device";cellText(device,license.deviceSuffix?"…"+license.deviceSuffix:"未绑定","device-code");cellText(device,license.platform||"—");
  const activity=tr.insertCell();cellText(activity,formatTime(license.lastRenewedAt||license.activatedAt||license.createdAt));
  const actions=tr.insertCell();actions.className="row-actions";
  const events=document.createElement("button");events.textContent="记录";events.onclick=()=>openEvents(license);actions.append(events);
  if(license.deviceSuffix){const reset=document.createElement("button");reset.textContent="解除绑定";reset.onclick=()=>confirmAction("reset",license);actions.append(reset)}
  if(license.status!=="revoked"){const revoke=document.createElement("button");revoke.textContent="撤销";revoke.className="revoke";revoke.onclick=()=>confirmAction("revoke",license);actions.append(revoke)}
  tr.dataset.id=license.id;return tr
}
function renderApiKey(apiKey){
  const row=document.createElement("div");row.className="api-key-row";
  const details=document.createElement("div");const title=document.createElement("strong");title.textContent=apiKey.name;details.append(title);
  const meta=document.createElement("span");meta.textContent=apiKey.keyPrefix+"…"+apiKey.keyLast4+" · "+(apiKey.status==="active"?"有效":"已撤销")+" · 最近使用 "+formatTime(apiKey.lastUsedAt);if(apiKey.status!=="active")meta.className="revoked-key";details.append(meta);row.append(details);
  if(apiKey.status==="active"){const revoke=document.createElement("button");revoke.textContent="撤销";revoke.onclick=()=>confirmApiKeyRevoke(apiKey);row.append(revoke)}
  return row
}
async function loadApiKeys(){
  try{const data=await api("/admin/api/api-keys");state.apiKeys=data.items;const list=$("#api-key-list");if(data.items.length)list.replaceChildren(...data.items.map(renderApiKey));else{const item=document.createElement("p");item.className="api-key-empty";item.textContent="还没有 API Key。创建后可供商城或自动发货系统调用。";list.replaceChildren(item)}}catch(error){notify(error.message)}
}
async function load(){
  const query=new URLSearchParams({offset:String(state.offset),limit:String(state.limit)});
  const search=$("#search").value.trim(),status=$("#status-filter").value;if(search)query.set("query",search);if(status)query.set("status",status);
  try{
    const data=await api("/admin/api/licenses?"+query);state.total=data.total;
    rows.replaceChildren(...data.items.map(renderRow));empty.hidden=data.items.length>0;
    $("#result-count").textContent="共 "+data.total+" 份授权";$("#previous").disabled=state.offset===0;$("#next").disabled=state.offset+state.limit>=data.total;
    for(const key of ["total","bound","unbound","revoked"])$("#metric-"+key).textContent=String(data.metrics[key]);
  }catch(error){notify(error.message)}
}
function confirmAction(action,license){
  state.action={action,id:license.id};$("#confirm-eyebrow").textContent=action==="reset"?"DEVICE RESET":"REVOKE LICENSE";
  $("#confirm-title").textContent=action==="reset"?"解除设备绑定":"撤销这份授权";
  $("#confirm-message").textContent=action==="reset"?"绑定代次会递增，原 token 可以激活新设备；旧设备将在下次联网时失效。":"撤销后设备将在下次联网检查时失效。";
  $("#confirm-submit").textContent=action==="reset"?"确认重置":"确认撤销";$("#confirm-dialog").showModal()
}
function confirmApiKeyRevoke(apiKey){
  state.action={action:"revoke-api-key",id:apiKey.id};$("#confirm-eyebrow").textContent="REVOKE API KEY";
  $("#confirm-title").textContent="撤销 API Key";$("#confirm-message").textContent="撤销后，使用此 Key 的下发 token 请求会立即被拒绝。";
  $("#confirm-submit").textContent="确认撤销";$("#confirm-dialog").showModal()
}
async function openEvents(license){
  $("#events-title").textContent="激活记录 · •••• "+license.tokenLast4;const list=$("#event-list");list.replaceChildren();
  try{
    const data=await api("/admin/api/licenses/"+license.id+"/events");
    if(!data.items.length){const empty=document.createElement("p");empty.className="event-empty";empty.textContent="尚无审计记录。";list.append(empty)}
    else for(const event of data.items){const row=document.createElement("div");row.className="event-row";cellText(row,event.eventType);cellText(row,event.actor+(event.deviceSuffix?" · …"+event.deviceSuffix:""));cellText(row,formatTime(event.createdAt));list.append(row)}
    $("#events-dialog").showModal()
  }catch(error){notify(error.message)}
}
$("#open-generate").onclick=()=>$("#generate-dialog").showModal();
$("#generate-form").onsubmit=async(event)=>{
  if(event.submitter?.value==="cancel")return;
  event.preventDefault();const button=$("#generate-submit");button.disabled=true;
  try{const data=await api("/admin/api/licenses/generate",{method:"POST",body:JSON.stringify({count:Number($("#generate-count").value),note:$("#generate-note").value})});state.tokens=data.tokens;$("#generated-tokens").value=data.tokens.map(item=>item.token).join("\n");$("#generate-dialog").close();$("#tokens-dialog").showModal();await load()}catch(error){notify(error.message)}finally{button.disabled=false}
};
$("#copy-tokens").onclick=async()=>{await navigator.clipboard.writeText(state.tokens.map(item=>item.token).join("\n"));notify("已复制全部 token")};
$("#export-csv").onclick=()=>{const lines=["license_id,token,note",...state.tokens.map(item=>[item.id,item.token,item.note].map(value=>'"'+String(value).replaceAll('"','""')+'"').join(","))];const link=document.createElement("a");link.href=URL.createObjectURL(new Blob(["\uFEFF"+lines.join("\n")],{type:"text/csv;charset=utf-8"}));link.download="licensed-tokens-"+new Date().toISOString().slice(0,10)+".csv";link.click();URL.revokeObjectURL(link.href)};
$("#close-tokens").onclick=()=>{state.tokens=[];$("#generated-tokens").value="";$("#tokens-dialog").close()};
$("#open-api-keys").onclick=async()=>{$("#api-keys-dialog").showModal();await loadApiKeys()};
$("#close-api-keys").onclick=()=>$("#api-keys-dialog").close();
$("#api-key-form").onsubmit=async(event)=>{event.preventDefault();const button=$("#api-key-submit");button.disabled=true;try{const data=await api("/admin/api/api-keys",{method:"POST",body:JSON.stringify({name:$("#api-key-name").value})});$("#api-key-name").value="";$("#generated-api-key").value=data.key;$("#api-keys-dialog").close();$("#api-key-result-dialog").showModal()}catch(error){notify(error.message)}finally{button.disabled=false}};
$("#copy-api-key").onclick=async()=>{await navigator.clipboard.writeText($("#generated-api-key").value);notify("已复制 API Key")};
$("#close-api-key-result").onclick=()=>{$("#generated-api-key").value="";$("#api-key-result-dialog").close()};
$("#close-events").onclick=()=>$("#events-dialog").close();
$("#confirm-form").onsubmit=async(event)=>{if(event.submitter?.value==="cancel")return;event.preventDefault();if(!state.action)return;const button=$("#confirm-submit");button.disabled=true;try{if(state.action.action==="revoke-api-key"){await api("/admin/api/api-keys/"+state.action.id+"/revoke",{method:"POST",body:"{}"});notify("API Key 已撤销");await loadApiKeys()}else{await api("/admin/api/licenses/"+state.action.id+"/"+state.action.action,{method:"POST",body:"{}"});notify(state.action.action==="reset"?"设备绑定已解除":"许可证已撤销");await load()}$("#confirm-dialog").close()}catch(error){notify(error.message)}finally{button.disabled=false;state.action=null}};
let searchTimer;$("#search").oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.offset=0;load()},260)};$("#status-filter").onchange=()=>{state.offset=0;load()};$("#previous").onclick=()=>{state.offset=Math.max(0,state.offset-state.limit);load()};$("#next").onclick=()=>{state.offset+=state.limit;load()};
$("#logout").onclick=async()=>{try{await api("/admin/api/logout",{method:"POST",body:"{}"})}finally{location.replace("/admin/login")}};
api("/admin/api/session").then(session=>{$("#admin-username").textContent=session.username;load()}).catch(()=>{});`;

const adminLoginHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>登录 · 摄影修图师助手授权管理</title>
  <link rel="stylesheet" href="/admin/login.css">
  <script type="module" src="/admin/login.js"></script>
</head>
<body>
  <main class="login-shell">
    <section class="login-copy">
      <p class="eyebrow">LICENSE OPERATIONS</p>
      <h1>摄影修图师助手</h1>
      <p>管理单设备授权、换机重置与销售 token。</p>
    </section>
    <section class="login-card">
      <header>
        <span class="brand-mark" aria-hidden="true">L</span>
        <div><strong>授权控制台</strong><span>管理员登录</span></div>
      </header>
      <form id="login-form">
        <label>账号<input id="username" name="username" autocomplete="username" minlength="3" maxlength="64" required autofocus></label>
        <label>密码<input id="password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required></label>
        <p class="error" id="login-error" role="alert" hidden></p>
        <button id="login-submit" type="submit">登录</button>
      </form>
      <p class="security-note">登录状态仅保存在安全 Cookie 中，12 小时后自动失效。</p>
    </section>
  </main>
</body>
</html>`;

const adminLoginCss = String.raw`:root{
  color:#18202a;background:#e9edf1;font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-synthesis:none;--ink:#18202a;--muted:#68717c;--line:#d6dde4;--blue:#1769c2
}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:
  radial-gradient(circle at 12% 12%,rgba(91,157,220,.17),transparent 33%),
  linear-gradient(rgba(45,57,70,.04) 1px,transparent 1px),
  linear-gradient(90deg,rgba(45,57,70,.04) 1px,transparent 1px),#e9edf1;background-size:auto,32px 32px,32px 32px}
button,input{font:inherit}.login-shell{display:grid;grid-template-columns:minmax(300px,520px) 390px;align-items:center;justify-content:center;gap:110px;min-height:100vh;padding:48px}.login-copy{align-self:center}.eyebrow{margin:0 0 14px;color:#4676a7;font:700 11px/1 ui-monospace,monospace;letter-spacing:.15em}.login-copy h1{max-width:480px;margin:0;font-size:48px;line-height:1.04;letter-spacing:-.045em}.login-copy>p:last-child{max-width:450px;margin:18px 0 0;color:var(--muted);font-size:16px}
.login-card{padding:30px;border:1px solid rgba(255,255,255,.85);border-radius:13px;background:rgba(255,255,255,.94);box-shadow:0 26px 75px rgba(27,40,54,.14)}.login-card header{display:flex;align-items:center;gap:12px;margin-bottom:26px}.brand-mark{display:grid;width:39px;height:39px;place-items:center;border-radius:10px;background:#18212b;color:#8bc5ff;font:700 16px/1 ui-monospace,monospace}.login-card header div{display:grid}.login-card header strong{font-size:15px}.login-card header span:last-child{color:var(--muted);font-size:11px}
form{display:grid;gap:16px}label{display:grid;gap:7px;color:#46515d;font-size:11px;font-weight:700}input{height:42px;padding:0 12px;border:1px solid var(--line);border-radius:7px;background:#fafbfc;color:var(--ink)}input:focus-visible,button:focus-visible{outline:2px solid #6aa8e8;outline-offset:2px}button{height:42px;border:0;border-radius:7px;background:var(--blue);color:#fff;cursor:pointer;font-weight:700;box-shadow:0 2px 4px rgba(12,55,101,.2)}button:disabled{cursor:not-allowed;opacity:.55}.error{margin:0;padding:9px 11px;border:1px solid #ebc7c2;border-radius:6px;background:#fff4f2;color:#9e352d;font-size:11px}.security-note{margin:18px 0 0;color:#7a8490;font-size:10px;text-align:center}
@media(max-width:900px){.login-shell{grid-template-columns:minmax(280px,390px);gap:34px}.login-copy h1{font-size:36px}}`;

const adminLoginJs = String.raw`const form=document.querySelector("#login-form"),errorNode=document.querySelector("#login-error"),button=document.querySelector("#login-submit");
form.addEventListener("submit",async(event)=>{
  event.preventDefault();button.disabled=true;errorNode.hidden=true;
  try{
    const response=await fetch("/admin/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:form.username.value,password:form.password.value})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error?.message||"登录失败");
    location.replace("/admin/");
  }catch(error){errorNode.textContent=error.message;errorNode.hidden=false;form.password.select()}
  finally{button.disabled=false}
});`;

export function adminUiResponse(pathname: string) {
  if (pathname === "/admin/app.css") {
    return new Response(adminCss, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "private, max-age=300",
      },
    });
  }
  if (pathname === "/admin/app.js") {
    return new Response(adminJs, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "private, max-age=300",
      },
    });
  }
  return new Response(adminHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function adminLoginResponse(pathname: string) {
  if (pathname === "/admin/login.css") {
    return new Response(adminLoginCss, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (pathname === "/admin/login.js") {
    return new Response(adminLoginJs, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return new Response(adminLoginHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
