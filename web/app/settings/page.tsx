"use client";
import {useEffect,useState} from "react";
import SupplierManager from "../SupplierManager";
import SourcingSuggestions from "../SourcingSuggestions";
import PlateSettingsSection from "../PlateSettingsSection";
import PriceBell from "../PriceBell";
import {type Locale} from "../i18n";
export default function SettingsPage(){
 const [locale,setLocale]=useState<Locale>("ja");
 useEffect(()=>{const stored=localStorage.getItem("chef-ui-locale");if(stored==="ja"||stored==="en-US"){setLocale(stored);document.documentElement.lang=stored;}},[]);
 function switchLocale(next:Locale){setLocale(next);localStorage.setItem("chef-ui-locale",next);document.documentElement.lang=next;}
 const ja=locale==="ja";
 return <main id="top" className="settings-page">
  <header className="chef-header"><div className="toolbar"><p className="tag">CHEF AI WORKSPACE</p><PriceBell locale={locale}/><label className="language-picker"><span>Language</span><select aria-label="Display language" value={locale} onChange={e=>switchLocale(e.target.value as Locale)}><option value="ja">Japanese</option><option value="en-US">English</option></select></label></div><div className="chef-brand"><img src="/chef-ai-mark.svg" alt="" width="58" height="58"/><h1>Chef AI</h1></div></header>
  <a href="/" className="settings-back">{ja?"← レシピ一覧へ戻る":"← Back to recipes"}</a>
  <section className="workspace-section workspace-settings-section" aria-labelledby="settings-title">
   <div className="workspace-section-head"><div><h2 id="settings-title">{ja?"管理・設定":"Management & Settings"}</h2><p>{ja?"仕入先・購入先候補・料理画像設定":"Suppliers, sourcing suggestions, and dish image settings"}</p></div></div>
   <div className="workspace-settings-content">
    <SupplierManager locale={locale}/>
    <SourcingSuggestions locale={locale}/>
    <details className="plate-settings"><summary>{ja?"料理画像設定（デフォルト皿）":"Dish image settings (default plate)"}</summary><PlateSettingsSection locale={locale}/></details>
   </div>
  </section>
  <nav aria-label={ja?"主要":"Primary"} className="bottom-nav">
   <a href="/">{ja?"ホーム":"Home"}</a>
   <a href="/#recipes">{ja?"レシピ":"Recipes"}</a>
   <a href="/" className="bottom-nav-mic settings-voice-link" aria-label={ja?"音声操作画面へ戻る":"Go to voice controls"}><svg viewBox="0 0 24 24" aria-hidden="true" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg></a>
   <a href="/">{ja?"下書き":"Draft"}</a>
   <a href="/settings" aria-current="page" aria-label={ja?"管理・設定":"Management and settings"}><span className="bottom-nav-settings-icon" aria-hidden="true">⚙</span><span>{ja?"設定":"Settings"}</span></a>
  </nav>
 </main>;
}
