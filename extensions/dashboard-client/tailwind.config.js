/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1600px" },
    },
    extend: {
      colors: {
        background: "hsl(var(--bg))",
        "bg-card": "hsl(var(--bg-card))",
        "bg-elevated": "hsl(var(--bg-elevated))",
        border: "hsl(var(--border))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--foreground))" },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(222 47% 5%)",
          glow: "hsl(var(--primary-glow))",
        },
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        danger: "hsl(var(--danger))",
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(222 47% 5%)" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        heading: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: "0 0 20px -4px hsl(var(--primary-glow) / 0.5)",
        panel: "0 8px 30px -12px hsl(var(--bg) / 0.6)",
      },
    },
  },
  plugins: [],
};
