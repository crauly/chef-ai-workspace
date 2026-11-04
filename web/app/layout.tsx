import type { Metadata } from "next";
import "./style.css";
import {VoiceProcessingProvider} from "./VoiceProcessingStatus";
export const metadata: Metadata = { title: "Chef AI Workspace", description: "Recipe library and deterministic costing", icons: {icon: "/chef-ai-mark.svg", apple: "/chef-ai-mark.svg"} };
export default function RootLayout({children}: Readonly<{children:React.ReactNode}>){
 return <html lang="ja"><body><VoiceProcessingProvider>{children}</VoiceProcessingProvider></body></html>;
}
