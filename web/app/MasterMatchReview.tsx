"use client";
import {useState} from 'react';
export type MasterMatch={name:string;master_name?:string;action:string;ingredient_id?:string|null;material_id?:string;spec?:string|null;candidates?:{id:string;name:string;spec?:string|null;brand?:string|null}[]};
export type EditRequest={base_revision:number;request_id:string;operations:Record<string,string>[];save_version:boolean;ledger?:{kind:string;id:string;name?:string;spec?:string|null}[]};
export function withMasterChoice(body:EditRequest,match:MasterMatch,choice:string,spec:string):EditRequest{
 const material_id=match.material_id!;
 const ingredient_id=choice==='new'?crypto.randomUUID():choice;
 const operations=body.operations.filter(op=>!(op.op==='link_ingredient'&&op.material_id===material_id));
 const quote=[...operations].reverse().find(op=>op.material_id===material_id&&['set_material_price','add_material'].includes(op.op));
 const supplier=[...operations].reverse().find(op=>op.material_id===material_id&&op.op==='set_material_supplier');
 operations.push({op:'link_ingredient',material_id,ingredient_id,price_mode:quote?'override':'inherit',...(quote?{price_jpy:quote.price_jpy,price_quantity:quote.price_quantity,price_unit:quote.price_unit}:{})});
 if(supplier)operations.push({...supplier,offer_id:''});
 return {...body,operations,ledger:[...(body.ledger??[]),{kind:choice==='new'?'new':'reuse',id:ingredient_id,...(choice==='new'?{name:match.name,spec:spec.trim()||null}:{})}]};
}
export default function MasterMatchReview({items,ja,disabled,onChoose}:{items:MasterMatch[];ja:boolean;disabled?:boolean;onChoose:(match:MasterMatch,choice:string,spec:string)=>void}){
 const [choices,setChoices]=useState<Record<string,string>>({}),[specs,setSpecs]=useState<Record<string,string>>({});
 return <section className="master-match-review" aria-label={ja?'食材マスターの照合':'Ingredient master matching'}>
  <p>{ja?`食材 ${items.length}件の登録・再利用を確認してください。`:`Review ${items.length} ingredient master matches.`}</p>
  <ul>{items.map((m,i)=>{const key=m.material_id??m.name;return <li key={key+String(i)}>{m.name}：{m.action==='reuse'?(ja?'既存マスターを再利用':'Reuse existing master'):(m.action==='choose'?(ja?'マスターを選択してください':'Choose a master'):(ja?'新規登録':'Create master'))}{m.master_name&&m.master_name!==m.name&&` → ${m.master_name}`}{m.spec&&` (${m.spec})`}
   {m.action==='choose'&&<div>
    <label>{m.name}{ja?'の食材マスター':' master'}<select disabled={disabled} value={choices[key]??''} onChange={e=>setChoices({...choices,[key]:e.target.value})}><option value="">{ja?'選択してください':'Choose'}</option>{m.candidates?.map(c=><option key={c.id} value={c.id}>{c.name}{c.spec?` / ${c.spec}`:''}{c.brand?` / ${c.brand}`:''}</option>)}<option value="new">{ja?'別の食材として新規登録':'Create a separate ingredient'}</option></select></label>
    {choices[key]==='new'&&<label>{ja?'新規食材の規格':'New specification'}<input maxLength={200} value={specs[key]??''} onChange={e=>setSpecs({...specs,[key]:e.target.value})}/></label>}
    <button type="button" disabled={disabled||!choices[key]} onClick={()=>onChoose(m,choices[key],specs[key]??'')}>{ja?'選択して再照合':'Apply and review'}</button>
   </div>}
  </li>;})}</ul>
 </section>;
}
