import {sourceUrl,type ResearchResult} from "../recipe-price-research";
import type {Locale} from "./i18n";
function observationText(value:unknown){
 if(!value||typeof value!=="object"||Array.isArray(value))return "";
 const row=value as Record<string,unknown>;
 return ["observation_id","amount","currency","package_quantity","package_unit","source","tax_note","shipping_note","observed_at","supplier_id"].flatMap(key=>
  typeof row[key]==="string"||typeof row[key]==="number"?[`${key}: ${row[key]}`]:[]).join(" · ");
}
export default function ResearchEvidence({results,locale}:{results:ResearchResult[];locale:Locale}){
 if(!results.length)return null;
 const ja=locale==="ja";
 return <details open><summary>{ja?"調査根拠・未取得の理由":"Research evidence and unavailable quotes"}</summary>
  <ul>{results.map(item=><li key={item.index}><strong>{item.name}</strong> — {item.description}
   {item.research_status&&<p>{ja?"仕入履歴":"Ledger"}: {item.research_status.ledger} / Web: {item.research_status.web}</p>}
   {item.reference&&<>
    <p>{item.reference.origin} · {item.reference.observation_count??0}{ja?"件":" samples"} · {item.reference.fetched_at??item.reference.observed_to??(ja?"取得日時未確認":"Time unavailable")}</p>
    {item.reference.samples?.length?<ul>{item.reference.samples.map((sample,i)=><li key={i}>
     {sample.name} · {sample.seller} · {item.reference!.currency} {sample.amount} / {sample.package}
     {sample.maker&&` · ${sample.maker}`}{sample.spec&&` · ${sample.spec}`}
     {` · 税: ${sample.tax_note??"未確認"} · 送料: ${sample.shipping_note??"未確認"}`}
     {sample.fetched_at&&` · ${sample.fetched_at}`}
     {sample.url&&sourceUrl(sample.url)&&<a href={sourceUrl(sample.url)!} target="_blank" rel="noopener noreferrer">{ja?"販売ページ":"Seller page"}</a>}
    </li>)}</ul>:null}
    {item.reference.observations?.length?<ul>{item.reference.observations.map((obs,i)=><li key={i}>{observationText(obs)}</li>)}</ul>:null}
    {item.reference.sources?.length?<ul>{item.reference.sources.map((source,i)=>sourceUrl(source.url)?<li key={i}><a href={sourceUrl(source.url)!} target="_blank" rel="noopener noreferrer">{source.title||source.url}</a></li>:null)}</ul>:null}
   </>}
  </li>)}</ul>
 </details>;
}
