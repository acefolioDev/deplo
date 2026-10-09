import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Box,
  LayoutDashboard,
  Server,
  FolderKanban,
  History,
  BookOpen,
} from "lucide-react";
import { currentUser } from "@/lib/security";
import { LogoutButton } from "@/components/logout-button";
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const nav = [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/servers", label: "Servers", icon: Server },
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/deployments", label: "Deployments", icon: History },
  ];
  return (
    <div className="min-h-screen md:flex">
      <aside className="flex w-full flex-col border-b border-white/[.08] bg-[#0c0f12] md:fixed md:inset-y-0 md:w-60 md:border-b-0 md:border-r">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <span className="rounded-lg bg-emerald-300 p-1.5 text-slate-950">
            <Box size={20} />
          </span>
          <span className="text-xl font-bold tracking-tight">
            deplo<span className="text-emerald-300">.</span>
          </span>
        </div>
        <div className="hidden px-6 pb-5 pt-4 md:block">
          <div className="rounded-lg border border-white/[.08] bg-white/[.025] p-3">
            <div className="text-xs text-slate-500">Workspace</div>
            <div className="mt-1 truncate text-sm font-medium">
              {user.email}
            </div>
          </div>
        </div>
        <nav
          aria-label="Main navigation"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:px-3"
        >
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-400 transition-colors hover:bg-white/[.05] hover:text-white"
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="hidden flex-1 md:block" />
        <div className="hidden border-t border-white/[.08] p-3 md:block">
          <a
            href="/docs"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-white"
          >
            <BookOpen size={16} />
            Documentation
          </a>
          <LogoutButton />
        </div>
      </aside>
      <main className="mx-auto w-full max-w-[1500px] px-5 py-8 md:ml-60 md:px-10 md:py-10">
        <div className="mb-9 flex items-center justify-between border-b border-white/[.06] pb-5">
          <div className="text-xs text-slate-500">
            WORKSPACE <span className="mx-2 text-slate-700">/</span> CONTROL
            PLANE
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Self
            hosted runtime
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
