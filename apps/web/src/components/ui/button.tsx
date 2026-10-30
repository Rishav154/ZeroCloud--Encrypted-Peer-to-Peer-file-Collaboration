import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
};

export function Button({
  className = "",
  variant = "default",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const style =
    variant === "outline"
      ? "border border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800"
      : "bg-violet-500 text-white hover:bg-violet-400";
  return <button className={`${base} ${style} ${className}`} {...props} />;
}
