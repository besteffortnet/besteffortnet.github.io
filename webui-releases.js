(() => {
  'use strict';
  const root=document.documentElement, button=document.getElementById('theme');
  function updateLabel(){const label=root.dataset.theme==='dark'?'ライトモードに切り替え':'ダークモードに切り替え';button.setAttribute('aria-label',label);button.title=label;}
  updateLabel();button.addEventListener('click',()=>{const next=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=next;updateLabel();try{localStorage.setItem('webui.theme',next)}catch{}});
  const list=document.getElementById('versions'),status=document.getElementById('status');
  const el=(name,text)=>{const node=document.createElement(name);if(text!==undefined)node.textContent=text;return node;};
  async function load(){
    try{
      const response=await fetch('webui-release-history.json',{cache:'no-store'});if(!response.ok)throw new Error('履歴を取得できません');
      const data=await response.json();if(data.schema!==1||!Array.isArray(data.versions))throw new Error('履歴形式が不正です');
      const fragment=document.createDocumentFragment();
      for(const version of data.versions){
        if(typeof version.version!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version.version))||typeof version.ref!=='string'||!(/^[0-9a-f]{40}$/.test(version.ref)||version.ref==='webui-apps-v2026.10.30.1')||typeof version.summary!=='string'||typeof version.actor!=='string')throw new Error('履歴に不正な項目があります');
        const date=new Date(version.timestamp);if(Number.isNaN(date.getTime()))throw new Error('履歴の日時が不正です');
        const li=el('li'),heading=el('h2','版 '+version.version),meta=el('p');
        const time=el('time',new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date));time.dateTime=version.timestamp;meta.append(time,document.createTextNode(' · 担当：'+version.actor));
        const detail=el('p',version.summary),files=el('p','変更対象：'+(Array.isArray(version.files)?version.files.join('、'):'未記録'));
        const source=el('a','GitHubで実装差分を確認');source.href='https://github.com/besteffortnet/besteffortnet.github.io/'+(/^[0-9a-f]{40}$/.test(version.ref)?'commit/':'tree/')+encodeURIComponent(version.ref);source.target='_blank';source.rel='noopener noreferrer';
        const disclosure=el('details'),summary=el('summary','この版へ戻す方法'),explain=el('p','リポジトリで以下を実行すると、対象版の復元用作業ツリーを新規作成します。既存の変更や公開サイトには触れません。');
        const code=el('code','python3 tools/prepare-webui-restore.py '+version.ref+' --repo . --worktree-path ../webui-restore-'+version.version+' --branch restore/webui-'+version.version),next=el('p','生成された差分を確認し、案内に従ってプルリクエストを作成・反映してください。');disclosure.append(summary,explain,code,next);li.append(heading,meta,detail,files,source,disclosure);fragment.append(li);
      }
      list.replaceChildren(fragment);status.textContent=data.versions.length+'件の履歴';
    }catch(error){status.textContent='履歴を読み込めませんでした。再読み込みしてください。';}
  }
  load();
})();
