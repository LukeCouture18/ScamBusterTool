import type { JSX } from "react";
// Client entry for the suite acceptance test: the real shell and the real tool screens, routed by path.
import { createRoot } from "react-dom/client";
import { PlatformShell } from "@/components/platform-shell";
import { SuiteHome } from "@/components/suite/home";
import { FinderTool } from "@/components/suite/finder";
import { HunterTool, LoggerTool, ReportsTool, WalletsTool } from "@/components/suite/tools";
import { AdvancedHub } from "@/components/suite/advanced";
import { usePathname } from "next/navigation";

const PAGES: Record<string, () => JSX.Element> = { "/": SuiteHome, "/finder": FinderTool, "/wallets": WalletsTool, "/logger": LoggerTool, "/reports": ReportsTool, "/hunter": HunterTool, "/advanced": AdvancedHub };
function MissingPage(){return <div className="mip-page"><h1>Not part of this test</h1></div>;}
function Router() { const path = usePathname(); const Page = PAGES[path] ?? MissingPage; return <Page />; }
createRoot(document.getElementById("root")!).render(<PlatformShell><Router /></PlatformShell>);
