import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combine className inputs then de-duplicate/merge conflicting Tailwind classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
