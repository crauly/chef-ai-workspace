import type { Metadata } from "next";
import "./style.css";
export const metadata: Metadata = { title: "Chef AI Workspace", description: "Recipe library and deterministic costing" };
export default function RootLayout({children}: Readonly<{children:React.ReactNode}>){
 return <html lang="ja"><body>{children}</body></html>;
}
