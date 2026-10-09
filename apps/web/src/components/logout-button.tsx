"use client";
import { LogOut } from "lucide-react";
import { post } from "./api";
import { useRouter } from "next/navigation";
export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-white"
      onClick={async () => {
        await post("auth/logout", {});
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut size={16} />
      Sign out
    </button>
  );
}
