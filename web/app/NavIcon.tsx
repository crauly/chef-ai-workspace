import type {ReactNode} from "react";
type Name="home"|"recipes"|"draft"|"settings";
export default function NavIcon({name}:{name:Name}){
 const paths:Record<Name,ReactNode>={
  home:<><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/></>,
  recipes:<><path d="M12 7v14"/><path d="M12 7C9 5 5 5 3 6v14c3-1 6-1 9 1"/><path d="M12 7c3-2 7-2 9-1v14c-3-1-6-1-9 1"/></>,
  draft:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></>,
  settings:<><path d="M10.3 2h3.4l.6 2.5 2 .8 2.2-1.3 2.4 2.4-1.3 2.2.8 2L23 11.2v3.4l-2.5.6-.8 2 1.3 2.2-2.4 2.4-2.2-1.3-2 .8-.6 2.5h-3.4l-.6-2.5-2-.8-2.2 1.3-2.4-2.4 1.3-2.2-.8-2L1 14.6v-3.4l2.5-.6.8-2L3 6.4 5.4 4l2.2 1.3 2-.8z" transform="translate(0 -1) scale(.95)"/><circle cx="12" cy="12" r="3"/></>
 };
 return <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
