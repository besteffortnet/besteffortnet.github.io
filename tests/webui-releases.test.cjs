const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('webui-releases.js','utf8'),data=JSON.parse(fs.readFileSync('webui-release-history.json','utf8'));
class Node {constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.textContent='';this.dataset={};}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,v){this[k]=v}append(...v){this.children.push(...v)}replaceChildren(...v){this.children=v}}
const root=new Node('root');root.dataset.theme='light';const button=new Node('button'),status=new Node('status'),list=new Node('ol');
const doc={documentElement:root,getElementById:id=>({theme:button,status,versions:list})[id],createElement:n=>new Node(n),createDocumentFragment:()=>new Node('fragment'),createTextNode:t=>({textContent:t})};
const stored={};const ctx={document:doc,localStorage:{setItem(k,v){stored[k]=v}},fetch:async()=>({ok:true,json:async()=>data}),Intl,Date};
vm.runInNewContext(source,ctx);
setImmediate(()=>{
 assert.equal(status.textContent,`${data.versions.length}件の履歴`);
 assert.equal(list.children[0].children.length,data.versions.length);
 assert.deepEqual(data.versions.slice(1).map(x=>Date.parse(x.timestamp)),data.versions.slice(1).map(x=>Date.parse(x.timestamp)).sort((a,b)=>b-a));
 assert(data.versions.every(x=>x.actor&&x.timestamp&&x.ref&&x.summary));
 assert(data.versions.some(x=>x.actor==='未記録'));
 assert.equal(button.attrs['aria-label'],'ダークモードに切り替え');button.click();assert.equal(root.dataset.theme,'dark');assert.equal(stored['webui.theme'],'dark');assert.equal(button.attrs['aria-label'],'ライトモードに切り替え');
 const first=list.children[0].children[0];assert.match(first.children[0].textContent,/2026\.10\.30\.1/);
 const command=first.children.at(-1).children.find(x=>x.tag==='code').textContent;assert.match(command,/--repo \. --worktree-path \.+\/webui-restore-2026\.10\.30\.1 --branch restore\/webui-2026\.10\.30\.1/);
 console.log('history render, order and theme checks passed');
});
const invalidStatus=new Node('status'), invalidList=new Node('ol'), invalidButton=new Node('button'), invalidRoot=new Node('root');invalidRoot.dataset.theme='light';
const invalidDoc={documentElement:invalidRoot,getElementById:id=>({theme:invalidButton,status:invalidStatus,versions:invalidList})[id],createElement:n=>new Node(n),createDocumentFragment:()=>new Node('fragment'),createTextNode:t=>({textContent:t})};
vm.runInNewContext(source,{document:invalidDoc,localStorage:{setItem(){}},fetch:async()=>({ok:true,json:async()=>({schema:1,versions:[{...data.versions[0],version:'bad;echo unsafe'}]})}),Intl,Date});
setImmediate(()=>{assert.match(invalidStatus.textContent,/読み込めません/);assert.equal(invalidList.children.length,0);console.log('invalid version cannot generate a shell command');});
