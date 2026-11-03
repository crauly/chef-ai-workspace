"use client";
import NavIcon from "../NavIcon";
import {useEffect,useState} from "react";
import SupplierManager from "../SupplierManager";
import UnitManager from "../UnitManager";
import IngredientManager from "../IngredientManager";
import SourcingSuggestions from "../SourcingSuggestions";
import PlateSettingsSection from "../PlateSettingsSection";
import PriceBell from "../PriceBell";
import {type Locale} from "../i18n";

type Tab="ingredient"|"supplier"|"unit"|"sourcing"|"plate";
const tabs:Tab[]=["ingredient","supplier","unit","sourcing","plate"];
const names:Record<Tab,{ja:string;en:string}>={
 ingredient:{ja:"食材ライブラリ",en:"Ingredient Library"},
 supplier:{ja:"仕入れ先管理",en:"Suppliers"},
 unit:{ja:"単位管理",en:"Units"},
 sourcing:{ja:"購入先候補",en:"Sourcing Suggestions"},
 plate:{ja:"盛り付け用の皿",en:"Plate Library"},
};
function SettingsGlyph({tab}:{tab:Tab}){
 const paths:Record<Tab,React.ReactNode>={
  ingredient:<><path d="M4 7h16l-2 13H6L4 7Z"/><path d="m8 7 4-5 4 5M3 11h18"/></>,
  supplier:<><path d="M3 7h12v12H3zM15 11h4l3 4v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></>,
  unit:<><path d="M3 8h18M5 5v14h14V5M9 8v4M13 8v3M17 8v4"/></>,
  sourcing:<><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5M8 11h6M11 8v6"/></>,
  plate:<><ellipse cx="12" cy="12" rx="9" ry="9"/><circle cx="12" cy="12" r="5"/></>,
 };
 return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[tab]}</svg>;
}
export default function SettingsPage(){
 const [locale,setLocale]=useState<Locale>("ja");
 const [tab,setTab]=useState<Tab>("ingredient");
 const [helpOpen,setHelpOpen]=useState(false);
 useEffect(()=>{
  const stored=localStorage.getItem("chef-ui-locale");
  if(stored==="ja"||stored==="en-US"){setLocale(stored);document.documentElement.lang=stored;}
  const section=new URLSearchParams(window.location.search).get("section");
  if(tabs.includes(section as Tab))setTab(section as Tab);
 },[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 const ja=locale==="ja";
 const choose=(next:Tab)=>{setHelpOpen(false);setTab(next);window.history.replaceState(null,"",next==="ingredient"?"/settings":"/settings?section="+next);};
 return <main id="top" className="settings-page">
  <header className="chef-header"><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><PriceBell locale={locale}/><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">Japanese</option><option value="en-US">English</option></select></label></div><div className="chef-brand"><img src="/chef-ai-mark.svg" alt="" width="58" height="58"/><h1>Chef AI</h1></div></header>
  <a href="/" className="settings-back">{ja?"← レシピ一覧へ戻る":"← Back to recipes"}</a>
  <div className="settings-layout">
   <aside className="settings-sidebar" aria-label={ja?"設定メニュー":"Settings menu"}>
    <h2>{ja?"設定":"Settings"}</h2>
    <nav className="settings-side-items" aria-label={ja?"設定項目":"Settings sections"}>
     {tabs.map(entry=><button type="button" key={entry} className={entry===tab?"is-selected":""} aria-current={entry===tab?"page":undefined} onClick={()=>choose(entry)}>
      <SettingsGlyph tab={entry}/><span>{ja?names[entry].ja:names[entry].en}</span>
     </button>)}
    </nav>
   </aside>
   <div className="settings-mobile-picker">
    <label>{ja?"設定項目":"Settings section"}
     <select value={tab} onChange={e=>choose(e.target.value as Tab)}>
      {tabs.map(entry=><option value={entry} key={entry}>{ja?names[entry].ja:names[entry].en}</option>)}
     </select>
    </label>
   </div>
   <section className="settings-main-panel" aria-labelledby="settings-panel-title">
    <div className="settings-panel-heading"><h2 id="settings-panel-title" className="settings-panel-title">{ja?names[tab].ja:names[tab].en}</h2>
     <button type="button" className="secondary settings-help-button" aria-expanded={helpOpen} onClick={()=>setHelpOpen(v=>!v)}>{ja?"使い方":"Help"}</button>
    </div>
    {helpOpen&&<p className="settings-help" role="note">{tab==="ingredient"?(ja?"食材を検索し、価格・仕入れ先を確認できます。編集から価格の変更と仕入れ先の追加ができます。":"Search ingredients, review prices and suppliers, and open Edit to update prices or link a supplier."):tab==="supplier"?(ja?"仕入れ先を登録・編集します。食材との紐付けは食材ライブラリから行います。":"Manage suppliers here; link them to ingredients from the Ingredient Library."):tab==="unit"?(ja?"単位の名称と別名を管理します。":"Manage unit names and aliases."):tab==="sourcing"?(ja?"食材IDから購入候補を確認します。":"Find purchasing suggestions by ingredient ID."):(ja?"皿を登録し、画像生成に使用する標準の皿を指定できます。":"Register plates and choose a default for image generation.")}</p>}
    {tab==="ingredient"&&<IngredientManager locale={locale}/>}
    {tab==="supplier"&&<SupplierManager locale={locale}/>}
    {tab==="unit"&&<UnitManager locale={locale}/>}
    {tab==="sourcing"&&<SourcingSuggestions locale={locale}/>}
    {tab==="plate"&&<PlateSettingsSection locale={locale}/>}
   </section>
  </div>
  <nav aria-label={ja?"主要":"Primary"} className="bottom-nav">
   <a href="/"><NavIcon name="home"/><span>{ja?"ホーム":"Home"}</span></a>
   <a href="/#recipes"><NavIcon name="recipes"/><span>{ja?"レシピ":"Recipes"}</span></a>
   <a href="/" className="bottom-nav-mic settings-voice-link" aria-label={ja?"音声操作画面へ戻る":"Go to voice controls"}><svg viewBox="0 0 24 24" aria-hidden="true" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg></a>
   <a href="/#open-draft"><NavIcon name="draft"/><span>{ja?"下書き":"Draft"}</span></a>
   <a href="/settings" aria-current="page" aria-label={ja?"管理・設定":"Management and settings"}><NavIcon name="settings"/><span>{ja?"設定":"Settings"}</span></a>
  </nav>
 </main>;
}
